/**
 * Error handling across a full-stack app's boundaries.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1.  Every throw obeys the status policy (400 never parsed, 422 invalid data).
 *   1b. A code means one status everywhere.
 *   2.  One AppError class with its documented fields.
 *   3.  One four-argument error handler, mounted last.
 *   4.  The code contract: every code translated, no orphans or unused codes, casing.
 *   5.  Credential failures carry `securityEvent: true`.
 *   6.  `params` (sent to the client) carry no request input; `message` (logged) may.
 *   7.  Non-HTTP services do not use AppError.
 *   8.  Exactly one frontend interceptor translates codes, with a fallback (unless `frontend: false`).
 *   9.  A swallowed failure states its reason (../lib/swallowed-errors.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from '../lib/files.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from '../lib/report.ts';
import { stripComments } from '../lib/strip-comments.ts';
import { countSwallows, findSwallowedErrors } from '../lib/swallowed-errors.ts';

export type FullstackErrorHandlingOptions = {
    /** Repository root. */
    root?: string;
    /** The HTTP service's sources. Defaults to `api/src`. */
    apiDir?: string;
    /** Services outside the request cycle: scanned for swallows, barred from AppError. Defaults to `worker/src`. */
    serviceDirs?: string[];
    /** Further directories barred from AppError but not scanned for swallows — a shared package. */
    appErrorBanDirs?: string[];
    /**
     * Whether the frontend is in this repository. Defaults to true. An API on its own passes
     * `false`: its clients translate the codes in their own repositories, so check 8 is skipped.
     */
    frontend?: boolean;
    /** Defaults to `frontend/src`. */
    frontendDir?: string;
    /** Defaults to `api/src/lib/app-error.ts`. */
    appError?: string;
    /** Defaults to `api/src/middleware/error-handler.ts`. */
    handler?: string;
    /** The shared ERROR_CODES module. Defaults to `packages/shared/src/errors.ts`. */
    codes?: string;
    /** Where the Express app is assembled. Defaults to `api/src/index.ts`. */
    entry?: string;
    /** The HTTP client holding the response interceptor. Defaults to `frontend/src/api/client.ts`. */
    client?: string;
    /** Defaults to `frontend/src/i18n/locales`. */
    localeDir?: string;
    /** The status policy table. */
    allowedStatus?: number[];
    /** Codes that legitimately answer 400 — a request that never parsed. */
    parseLevel400?: string[];
    /** The typed failures the handler must map, in order, before 500. */
    handlerBranches?: string[];
    /** Security events whose names carry no signal, so no pattern reaches them. */
    securityEventCodes?: string[];
    /** Codes matching a security pattern that are genuinely routine. */
    notSecurityEvents?: string[];
    /** Files allowed to emit a code without throwing AppError; the handler is added automatically. */
    directCodeEmitters?: string[];
};

type FullstackErrorHandlingInspection = {
    problems: GateFailure[];
    counts: {
        throws: number;
        codes: number;
        /** `[status, throws]`, by status. */
        byStatus: [status: number, throws: number][];
        securityEventCodes: number;
        queueWorkers: number;
        swallows: number;
    };
};

// Codes that must carry `securityEvent: true`, by pattern so new codes enrol themselves. Expiry is deliberately absent: it is routine.
const SECURITY_EVENT_PATTERNS = [
    /^INCORRECT_/,
    /_REQUIRED$/,
    /^(MISSING|INVALID)_.*(TOKEN|CREDENTIALS?|PASSWORD|RECOVERY_CODE|2FA_CODE|AUTH_CODE)/,
    /_TOKEN_INVALID$/,
];

const DEFAULT_ALLOWED_STATUS = [400, 401, 403, 404, 409, 413, 422, 429, 500];

/** Split the arguments of the call whose opening paren is at `open`. */
function callArguments(src: string, open: number): string[] | null {
    let depth = 0;
    let start = open + 1;
    const args: string[] = [];
    for (let i = open; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth -= 1;
            if (depth === 0) {
                args.push(src.slice(start, i));
                return args;
            }
        } else if (ch === ',' && depth === 1) {
            args.push(src.slice(start, i));
            start = i + 1;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            i += 1;
            while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
        }
    }
    return null;
}

/** One named field out of the `options` argument of a `new AppError(...)` call. */
function optionField(args: string[], name: string): string | null {
    const options = args[3]?.trim();
    if (options === undefined || !options.startsWith('{')) return null;
    const fields = callArguments(options, 0);
    if (fields === null) return null;
    for (const field of fields) {
        const match = new RegExp(`^\\s*${name}\\s*:([\\s\\S]*)$`).exec(field);
        if (match !== null) return (match[1] ?? '').trim();
    }
    return null;
}

/**
 * @param [input.root] Repository root.
 * @param [input.apiDir='api/src'] The HTTP service's sources.
 * @param [input.serviceDirs=['worker/src']] Services outside the request cycle.
 * @param [input.appErrorBanDirs=[]] Further directories barred from AppError only.
 * @param [input.frontend=true] Whether the frontend is in this repository.
 * @param [input.allowedStatus] The status policy table.
 * @param [input.parseLevel400=[]] Codes that legitimately answer 400.
 * @param [input.handlerBranches=['AppError','ZodError','MulterError']] The typed
 *   failures the handler must map, in order, before 500.
 * @param [input.securityEventCodes=[]] Security events no pattern reaches.
 * @param [input.notSecurityEvents=[]] Codes matching a pattern that are routine.
 * @param [input.directCodeEmitters=[]] Files allowed to emit a code without AppError.
 */
export function inspectFullstackErrorHandling(
    input: FullstackErrorHandlingOptions = {},
): FullstackErrorHandlingInspection {
    const {
        root = REPO_ROOT,
        apiDir = 'api/src',
        serviceDirs = ['worker/src'],
        appErrorBanDirs = [],
        frontend = true,
        frontendDir = 'frontend/src',
        appError = 'api/src/lib/app-error.ts',
        handler = 'api/src/middleware/error-handler.ts',
        codes: codesFile = 'packages/shared/src/errors.ts',
        entry = 'api/src/index.ts',
        client = 'frontend/src/api/client.ts',
        localeDir = 'frontend/src/i18n/locales',
        allowedStatus = DEFAULT_ALLOWED_STATUS,
        parseLevel400 = [],
        handlerBranches = ['AppError', 'ZodError', 'MulterError'],
        securityEventCodes = [],
        notSecurityEvents = [],
        directCodeEmitters = [],
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));
    const code = (rel: string) => stripComments(read(rel));
    const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

    const notTests = (rel: string) => !rel.includes('__tests__');
    const apiFiles = walkFiles(root, apiDir, { match: /\.ts$/, exclude: (r) => !notTests(r) });
    const statusTable = new Set(allowedStatus);
    const parseLevel = new Set(parseLevel400);
    const explicitSecurity = new Set(securityEventCodes);
    const routine = new Set(notSecurityEvents);
    const emitters = [...directCodeEmitters, handler];

    // True when a code must carry `securityEvent: true`.
    const isSecurityEvent = (c: string) =>
        !routine.has(c) && (explicitSecurity.has(c) || SECURITY_EVENT_PATTERNS.some((p) => p.test(c)));

    // Every code in the shared contract, in declaration order.
    const allCodes = exists(codesFile)
        ? [
              ...(/export const ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(read(codesFile))?.[1] ?? '').matchAll(
                  /'([^']+)'/g,
              ),
          ].map((m) => m[1] ?? '')
        : [];

    // ── 1. Every AppError throw obeys the status policy ──────────────────────
    const throws: { rel: string; line: number; status: number; errorCode: string | null; args: string[] }[] = [];
    for (const rel of apiFiles) {
        const src = code(rel);
        for (const m of src.matchAll(/new AppError\(/g)) {
            const args = callArguments(src, m.index + m[0].length - 1);
            if (args === null) continue;
            throws.push({
                rel,
                line: lineOf(src, m.index),
                status: Number(args[0]?.trim()),
                errorCode: /^'([A-Z0-9_]+)'$/.exec(args[1]?.trim() ?? '')?.[1] ?? null,
                args,
            });
        }
    }

    for (const t of throws) {
        const at = `${t.rel}:${t.line}`;
        if (!Number.isInteger(t.status)) {
            fail(
                at,
                'AppError status is not a literal',
                'Pass the status as a number literal — a computed status cannot be checked against the policy table, and this is the one place the table is enforced.',
            );
            continue;
        }
        if (!statusTable.has(t.status)) {
            fail(
                at,
                `status ${t.status} is not in the policy table`,
                `Use one of ${[...statusTable].join(', ')} — see the status code policy. 502/503 are infrastructure responses, not client-facing throws.`,
            );
        }
        if (t.status === 400 && t.errorCode !== null && !parseLevel.has(t.errorCode)) {
            fail(
                at,
                `400 for \`${t.errorCode}\``,
                '400 is for a request that never parsed; a well-formed request carrying invalid data is 422. If this really is a parse-level failure, add the code to `parseLevel400` in this gate with a note.',
            );
        }
        if (t.status === 422 && t.errorCode !== null && parseLevel.has(t.errorCode)) {
            fail(
                at,
                `422 for parse-level \`${t.errorCode}\``,
                'This code is listed as parse-level, which is a 400. Either throw 400 or drop it from `parseLevel400` in this gate.',
            );
        }
    }

    // ── 1b. A code means one thing: one code, one status ─────────────────────
    const statusOf: Map<string, Map<number, string[]>> = new Map();
    for (const t of throws) {
        if (t.errorCode === null || !Number.isInteger(t.status)) continue;
        const seen = statusOf.get(t.errorCode) ?? new Map();
        statusOf.set(t.errorCode, seen);
        seen.set(t.status, [...(seen.get(t.status) ?? []), `${t.rel}:${t.line}`]);
    }
    for (const [errorCode, seen] of statusOf) {
        if (seen.size === 1) continue;
        const [majority, ...others] = [...seen].sort((a, b) => b[1].length - a[1].length);
        if (majority === undefined) continue;
        for (const [status, sites] of others) {
            for (const site of sites) {
                fail(
                    site,
                    `\`${errorCode}\` is thrown as ${status} here but ${majority[0]} in ${majority[1].length} other place(s)`,
                    `A code is a contract the frontend switches on; its status is a property of the code, not of the call site. Use ${majority[0]}, or split this case out into its own code if it genuinely means something different.`,
                );
            }
        }
    }

    // ── 2. The AppError class carries the documented fields, in order ────────
    if (!exists(appError)) {
        fail(appError, 'missing', 'One AppError class is the only way to raise a client-facing HTTP error.');
    } else {
        const src = code(appError);
        if (!/class AppError extends Error/.test(src)) {
            fail(
                appError,
                'AppError does not extend Error',
                'A thrown plain object has no stack trace and no `instanceof` narrowing, and loggers will not serialise it.',
            );
        }
        for (const field of ['status', 'code', 'params', 'logContext', 'securityEvent']) {
            if (!new RegExp(`readonly ${field}[?]?:`).test(src)) {
                fail(
                    appError,
                    `no readonly \`${field}\` field`,
                    'The five fields are the contract with the error handler; a missing one silently stops being logged or sent.',
                );
            }
        }
        if (!/code:\s*ErrorCode/.test(src)) {
            fail(
                appError,
                '`code` is not typed as ErrorCode',
                'Typing it as the shared union is what makes a typo a compile error and guarantees every code that compiles has a translation.',
            );
        }
        const ctor = /constructor\(([\s\S]*?)\)\s*\{/.exec(src)?.[1] ?? '';
        const names = (callArguments(`(${ctor})`, 0) ?? [])
            .map((param) => /^\s*(\w+)/.exec(param)?.[1])
            .filter((name) => name !== undefined);
        const expected = ['status', 'code', 'message', 'options'];
        if (names.join(',') !== expected.join(',')) {
            fail(
                appError,
                `constructor parameters are (${names.join(', ')})`,
                `Must be (${expected.join(', ')}). The three required values are positional; everything optional is named inside \`options\`, so no call site ever passes \`undefined\` to reach the argument it wants.`,
            );
        }
        for (const field of ['params', 'logContext', 'securityEvent']) {
            if (!new RegExp(`\\b${field}\\?:`).test(src)) {
                fail(
                    appError,
                    `\`AppErrorOptions\` has no \`${field}\` field`,
                    'The three optional fields are the contract with the error handler; a missing one silently stops being logged or sent.',
                );
            }
        }
    }

    // ── 3. One error handler, four arguments, mounted last, ordered ──────────
    {
        const src = code(handler);
        const sig = /export function errorHandler\(([\s\S]*?)\)\s*:/.exec(src)?.[1] ?? '';
        const arity = sig.split(',').filter((s) => s.trim() !== '').length;
        if (arity !== 4) {
            fail(
                handler,
                `errorHandler takes ${arity} argument(s)`,
                'Express identifies an error handler ONLY by its 4-argument (err, req, res, next) signature. With any other arity it is registered as ordinary middleware and never sees an error.',
            );
        }
        const order = handlerBranches.map((n) => src.indexOf(`err instanceof ${n}`));
        if (order.some((i) => i === -1)) {
            fail(
                handler,
                'a documented branch is missing',
                `The handler must map ${handlerBranches.join(', ')} before falling through to 500 INTERNAL.`,
            );
        } else if (order.some((v, i) => i > 0 && (order[i - 1] ?? -1) > v)) {
            fail(
                handler,
                'branches are out of order',
                `${handlerBranches.join(' → ')} → generic. AppError is the intentional path and the most frequent; the generic branch is the safety net and must stay last.`,
            );
        }
        if (!/res\.status\(500\)\.json\(\{\s*error:\s*'INTERNAL'\s*\}\)/.test(src)) {
            fail(
                handler,
                'the fallback branch does not answer 500 INTERNAL',
                'Anything unrecognised is a bug: log it in full and return the generic code, never the error itself.',
            );
        }
        if (/res\.[\s\S]{0,40}\berr\.stack\b/.test(src)) {
            fail(handler, 'a stack trace reaches the response', 'Stacks are logged, never sent.');
        }

        const entrySrc = code(entry);
        const uses = [...entrySrc.matchAll(/app\.use\(/g)].map((m) => m.index);
        const mount = entrySrc.indexOf('app.use(errorHandler)');
        if (mount === -1) {
            fail(entry, 'errorHandler is never mounted', 'Register it with app.use(errorHandler) after all routes.');
        } else if (uses.some((i) => i > mount)) {
            const after = lineOf(entrySrc, uses.find((i) => i > mount) ?? mount);
            fail(
                entry,
                `app.use() at line ${after} runs after errorHandler`,
                'The error handler must be the LAST app.use(). Anything mounted after it is unreachable from an error, and the routes it registers throw into nothing.',
            );
        }
    }

    // ── 4. The shared error-code contract ────────────────────────────────────
    {
        if (allCodes.length === 0) {
            fail(
                codesFile,
                'no ERROR_CODES array found',
                'One `as const` array is the single source of truth for the API ↔ frontend contract.',
            );
        }
        for (const c of allCodes) {
            if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(c)) {
                fail(
                    codesFile,
                    `\`${c}\` is not SCREAMING_SNAKE_CASE`,
                    'Codes are a shipped contract; the casing is part of it.',
                );
            }
        }
        for (const c of allCodes.filter((c, i) => allCodes.indexOf(c) !== i)) {
            fail(
                codesFile,
                `\`${c}\` is listed twice`,
                'A duplicate hides the fact that two call sites disagree about what the code means.',
            );
        }

        const apiSrc = apiFiles.map(code).join('\n');
        for (const c of allCodes) {
            if (!apiSrc.includes(`'${c}'`)) {
                fail(
                    codesFile,
                    `\`${c}\` is never thrown or emitted`,
                    'Remove it, or throw it. An unreachable code still costs a translation in every locale and suggests a failure path that does not exist.',
                );
            }
        }

        const known = new Set(allCodes);
        const localePath = path.join(root, localeDir);
        if (fs.existsSync(localePath)) {
            for (const file of fs.readdirSync(localePath).filter((f) => f.endsWith('.json'))) {
                const rel = `${localeDir}/${file}`;
                const dict = JSON.parse(read(rel)).errors ?? {};
                for (const key of Object.keys(dict)) {
                    if (!known.has(key)) {
                        fail(
                            rel,
                            `\`errors.${key}\` translates a code that no longer exists`,
                            'Drop it. An orphaned entry outlives the rename that stranded it and makes the dictionary look like it covers more than it does.',
                        );
                    }
                }
                for (const c of allCodes) {
                    const text = dict[c];
                    if (typeof text !== 'string' || text.trim() === '') {
                        fail(
                            rel,
                            `no translation for \`${c}\``,
                            'A code with no translation reaches the user as raw SCREAMING_SNAKE. Adding a code means adding it to every locale.',
                        );
                    }
                }
            }
        }

        for (const rel of apiFiles) {
            if (emitters.includes(rel)) continue;
            const src = code(rel);
            for (const m of src.matchAll(/error:\s*'(VALIDATION_FAILED|RATE_LIMITED)'/g)) {
                // An explicit disable directly above is the sanctioned way to opt out.
                if (
                    read(rel)
                        .slice(Math.max(0, m.index - 400), m.index)
                        .includes('eslint-disable')
                )
                    continue;
                fail(
                    `${rel}:${lineOf(src, m.index)}`,
                    `emits \`${m[1]}\` directly`,
                    `Only ${emitters.join(' and ')} may emit a code without throwing AppError. Everything else throws.`,
                );
            }
        }
    }

    // ── 5. Credential failures are flagged as security events ────────────────
    for (const t of throws) {
        if (t.errorCode === null || !isSecurityEvent(t.errorCode)) continue;
        if (optionField(t.args, 'securityEvent') !== 'true') {
            fail(
                `${t.rel}:${t.line}`,
                `\`${t.errorCode}\` is thrown without securityEvent`,
                'Pass `securityEvent: true` in the options object so the handler attaches ip + user-agent to the boundary log. If this code is genuinely routine rather than a credential failure, privilege denial or lockout, add it to `notSecurityEvents` in this gate with a note.',
            );
        }
    }

    for (const c of [...explicitSecurity, ...routine]) {
        if (!allCodes.includes(c)) {
            fail(
                codesFile,
                `\`${c}\` is listed in this gate but no longer exists`,
                'Drop it from `securityEventCodes` / `notSecurityEvents` — a stale entry quietly narrows the check.',
            );
        }
    }
    for (const c of explicitSecurity) {
        if (SECURITY_EVENT_PATTERNS.some((p) => p.test(c))) {
            fail(
                codesFile,
                `\`${c}\` is listed explicitly but a pattern already covers it`,
                'Remove the redundant entry — the list is meant to hold only the codes whose names carry no signal.',
            );
        }
    }

    // ── 6. `params` carry no request input ───────────────────────────────────
    for (const t of throws) {
        const params = optionField(t.args, 'params');
        if (params === null || !params.startsWith('{')) continue;
        const hit = /\breq\.(params|body|query|headers)\b|\bidentifier\b|\bfilename\b/.exec(params);
        if (hit !== null) {
            fail(
                `${t.rel}:${t.line}`,
                `\`params\` carries request input (${hit[0]})`,
                'params are sent to the client and interpolated into a translation — that is the reflected-XSS vector. Move it into the `message` argument, which is logged and never leaves the server.',
            );
        }
    }

    // ── 7. The non-HTTP services ─────────────────────────────────────────────
    let queueWorkers = 0;
    const serviceFiles = walkFiles(root, serviceDirs, { match: /\.ts$/, exclude: (r) => !notTests(r) });
    for (const rel of [
        ...serviceFiles,
        ...walkFiles(root, appErrorBanDirs, { match: /\.ts$/, exclude: (r) => !notTests(r) }),
    ]) {
        const src = code(rel);
        for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new Worker\s*[<(]/g)) {
            queueWorkers += 1;
            if (!new RegExp(`${m[1]}\\.on\\(\\s*'failed'`).test(src)) {
                fail(
                    `${rel}:${lineOf(src, m.index)}`,
                    `Worker \`${m[1]}\` has no 'failed' handler`,
                    'There is no global middleware out here. Log failures in the `failed` event — once per attempt, with job context — rather than inside the job function.',
                );
            }
        }
        if (/\bAppError\b/.test(src)) {
            fail(
                rel,
                'uses AppError',
                'AppError is an HTTP concept — a status code, an Express handler, a client-facing translation. A failure out here has none of those. Throw a plain Error, or UnrecoverableError when a retry could never succeed.',
            );
        }
    }

    // ── 8. The frontend end of the contract ──────────────────────────────────
    if (frontend) {
        const src = code(client);
        // Two checks, not one regex, so the key may be built in a variable first.
        if (!/errors\.\$\{/.test(src) || !/i18n\.global\.te\(/.test(src)) {
            fail(
                client,
                'the interceptor does not localise `data.error`',
                'Translate the code once, in the interceptor, so every call site that reads `data.error` gets localised text with no per-site change.',
            );
        }
        if (!/i18n\.global\.t\('errors\.INTERNAL'\)/.test(src)) {
            fail(
                client,
                'no fallback for an unknown code',
                "A SCREAMING_SNAKE code with no translation must fall back to errors.INTERNAL — a raw code must never reach the user's eyes.",
            );
        }
        for (const rel of walkFiles(root, frontendDir, { match: /\.(ts|vue)$/, exclude: (r) => !notTests(r) })) {
            if (/\bAppError\b/.test(code(rel))) {
                fail(
                    rel,
                    'references AppError',
                    'AppError is server-side. The frontend sees codes on the wire, nothing else.',
                );
            }
        }
    }

    // ── 9. A server-side swallow states its reason ───────────────────────────
    const scanned = { root, files: [...apiFiles, ...serviceFiles] };
    for (const { file, what, why } of findSwallowedErrors(scanned)) fail(file, what, why);

    const byStatus = new Map<number, number>();
    for (const t of throws) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    const thrownCodes = new Set(throws.map((t) => t.errorCode).filter((c) => c !== null));

    return {
        problems,
        counts: {
            throws: throws.length,
            codes: thrownCodes.size,
            byStatus: [...byStatus].sort((a, b) => a[0] - b[0]),
            securityEventCodes: [...thrownCodes].filter(isSecurityEvent).length,
            queueWorkers,
            swallows: countSwallows(scanned),
        },
    };
}

export function checkFullstackErrorHandling(options: FullstackErrorHandlingOptions = {}): void {
    const report = createGateReport({ name: 'Error handling' });
    const { problems, counts } = inspectFullstackErrorHandling(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const spread = counts.byStatus.map(([s, n]) => `${s}×${n}`).join(' ');
    report.done({
        summary:
            `Error handling OK — ${plural(counts.throws, 'AppError throw')} across ${plural(counts.codes, 'code')}, ` +
            `all on policy statuses (${spread}) and each code on exactly one of them, one 4-arg handler mounted last ` +
            `with its branches in order, ` +
            `${plural(counts.securityEventCodes, 'credential-failure code')} carrying the ` +
            `securityEvent flag, no request input in wire params, ` +
            `${counts.queueWorkers === 0 ? 'no queue workers' : `${plural(counts.queueWorkers, 'queue worker')} logging failures`}, ` +
            `${plural(counts.swallows, 'swallow')} stating a reason.`,
        notMachineChecked:
            'whether a given failure is operational or a programmer error, whether 401 or 403 is the right one for ' +
            'a case, whether a best-effort call should be best-effort at all, or whether a code is specific enough ' +
            'for the UI to act on.',
    });
}
