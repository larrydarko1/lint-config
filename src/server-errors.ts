/**
 * Server-error tripwire for an E2E suite that drives the real API.
 * A 5xx is a bug the user meets as a broken page, and a test that only checks
 * what it came to check walks straight past one: the page still renders, the
 * spinner just never stops. So every API response the suite receives is
 * watched, and a 5xx fails the test that received it — with what the API
 * logged for that request, found by its `x-request-id` in the JSON log the API
 * writes (`LOG_FILE`). The failure says why, not only that.
 *
 * `logErrors()` reads the same log for a run's teardown: every error-level line,
 * including the ones no response showed — a socket push its schema refused, a
 * job that died in the background, an error logged inside a request that still
 * answered 2xx.
 */
import { existsSync, readFileSync } from 'node:fs';

/** The part of a Playwright `Response` the recorder reads. */
export type StatusResponseLike = {
    url: () => string;
    status: () => number;
    headers: () => Record<string, string>;
    request: () => { method: () => string };
};

/** The part of a Playwright `BrowserContext` (or `Page`) the recorder listens on. */
export type StatusResponseSource = {
    on: (event: 'response', listener: (response: StatusResponseLike) => void) => unknown;
};

export type ServerErrorRecorderOptions = {
    /** The JSON-lines log the API writes (`LOG_FILE`). Without it, an entry names the request id only. */
    logFile?: string;
    /** Only responses whose path starts with this are watched. Default `/api/`. */
    apiPrefix?: string;
    /** The response header carrying the request id. Default `x-request-id`. */
    requestIdHeader?: string;
    /** The field a log line carries the request id under. Default `requestId`. */
    requestIdKey?: string;
    /** How long to wait for a 5xx's log line: the logger may write it after the response left. Default 2000 ms. */
    logWaitMs?: number;
};

export type ServerErrorRecorder = {
    /** Start watching every API response this context or page receives. */
    watch: (source: StatusResponseSource) => void;
    /** One entry per 5xx since the last drain, with the API's log lines for it; then forget them. */
    drain: () => Promise<string[]>;
};

type ServerError = { route: string; status: number; requestId: string | undefined };

type LogLine = Record<string, unknown>;

/** pino's numeric levels, by name. */
const LEVEL_NAMES: Record<number, string> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};

/** Fields every pino line carries; they say nothing about this failure. */
const ROUTINE_FIELDS = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg', 'v']);

const POLL_MS = 100;

/** Record 5xx responses as they arrive, and explain them from the API's log on `drain()`. */
export function createServerErrorRecorder(options: ServerErrorRecorderOptions = {}): ServerErrorRecorder {
    const {
        logFile,
        apiPrefix = '/api/',
        requestIdHeader = 'x-request-id',
        requestIdKey = 'requestId',
        logWaitMs = 2000,
    } = options;
    const errors: ServerError[] = [];

    const record = (response: StatusResponseLike): void => {
        const status = response.status();
        if (status < 500) return;
        const { pathname } = new URL(response.url());
        if (!pathname.startsWith(apiPrefix)) return;
        errors.push({
            route: `${response.request().method()} ${pathname}`,
            status,
            requestId: response.headers()[requestIdHeader],
        });
    };

    return {
        watch: (source) => {
            source.on('response', record);
        },
        drain: async () => {
            const found = errors.splice(0);
            if (found.length === 0) return [];
            const lines = await linesFor(found, logFile, requestIdKey, logWaitMs);
            return found.map((error) => {
                const head = `${error.route} → ${error.status} (request ${error.requestId ?? 'id not sent'})`;
                if (logFile === undefined) return head;
                const own = error.requestId === undefined ? [] : (lines.get(error.requestId) ?? []);
                if (own.length === 0) return `${head}\n    nothing in ${logFile} for this request`;
                return [head, ...own.map((line) => `    ${describe(line)}`)].join('\n');
            });
        },
    };
}

/**
 * Every line at `minLevel` or above (default: error) in a JSON-lines log, one
 * entry each. A missing file has none.
 */
export function logErrors(logFile: string, minLevel = 50): string[] {
    return readLog(logFile)
        .filter((line) => typeof line['level'] === 'number' && line['level'] >= minLevel)
        .map(describe);
}

/** One log line as text: level, message, then the fields that carry the cause. */
export function describe(line: LogLine): string {
    const level = typeof line['level'] === 'number' ? (LEVEL_NAMES[line['level']] ?? String(line['level'])) : '?';
    const msg = typeof line['msg'] === 'string' ? line['msg'] : '';
    const rest = Object.fromEntries(Object.entries(line).filter(([key]) => !ROUTINE_FIELDS.has(key)));
    const err = rest['err'];
    if (isRecord(err)) rest['err'] = errorSummary(err);
    const fields = Object.keys(rest).length === 0 ? '' : ` ${JSON.stringify(rest)}`;
    return `${level}: ${msg}${fields}`;
}

/** The log lines for each failed request, waiting a little for ones the logger has not flushed yet. */
async function linesFor(
    found: ServerError[],
    logFile: string | undefined,
    requestIdKey: string,
    waitMs: number,
): Promise<Map<string, LogLine[]>> {
    const byRequest = new Map<string, LogLine[]>();
    if (logFile === undefined) return byRequest;
    const wanted = new Set(found.flatMap((error) => (error.requestId === undefined ? [] : [error.requestId])));
    const deadline = Date.now() + waitMs;
    for (;;) {
        byRequest.clear();
        for (const line of readLog(logFile)) {
            const id = line[requestIdKey];
            if (typeof id !== 'string' || !wanted.has(id)) continue;
            byRequest.set(id, [...(byRequest.get(id) ?? []), line]);
        }
        const complete = [...wanted].every((id) => byRequest.has(id));
        if (complete || Date.now() >= deadline) return byRequest;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** Every JSON line of the file; a line that is not JSON (a crash dump, a pretty-printed line) is skipped. */
function readLog(logFile: string): LogLine[] {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, 'utf8')
        .split('\n')
        .flatMap((text) => {
            if (text.trim() === '') return [];
            try {
                const parsed: unknown = JSON.parse(text);
                return isRecord(parsed) ? [parsed] : [];
            } catch {
                return [];
            }
        });
}

/** An error's type, message and the first frame of its stack: enough to find the line. */
function errorSummary(err: Record<string, unknown>): string {
    const type = typeof err['type'] === 'string' ? err['type'] : 'Error';
    const message = typeof err['message'] === 'string' ? err['message'] : '';
    const stack = typeof err['stack'] === 'string' ? err['stack'] : '';
    const frame = stack
        .split('\n')
        .map((part) => part.trim())
        .find((part) => part.startsWith('at '));
    return frame === undefined ? `${type}: ${message}` : `${type}: ${message} (${frame})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
