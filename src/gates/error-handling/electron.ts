/**
 * Error handling at an Electron app's boundaries:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1/2. Every IPC handler contains its own failures. A throw crossing the bridge
 *        reaches the renderer as a flattened string, with no boundary above it.
 *   3.   Process-level backstops for unhandled rejections and exceptions.
 *   4.   `before-quit` releases what closing the window does not. The hook is
 *        required even when nothing needs releasing yet.
 *   5.   A swallowed failure states its reason (../lib/swallowed-errors.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from '../lib/files.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from '../lib/report.ts';
import { stripComments } from '../lib/strip-comments.ts';
import { countSwallows, findSwallowedErrors } from '../lib/swallowed-errors.ts';

export type ElectronErrorHandlingOptions = {
    /** Repository root. */
    root?: string;
    /** Main-process sources. Defaults to `src/main`. */
    mainDir?: string;
    /** Renderer sources, scanned for swallowed failures. Defaults to `src/renderer`. */
    rendererDir?: string;
    /** Where the app lifecycle is wired. Defaults to `src/main/index.ts`. */
    mainIndex?: string;
    /** Services holding a resource the OS does not reclaim on window close; each must be released in `before-quit`. */
    cleanupRequired?: [service: string, why: string][];
};

type ElectronErrorHandlingInspection = {
    problems: GateFailure[];
    counts: { handlers: number; swallows: number };
};

/** The process-level handlers every main process must register, and why. */
const BACKSTOPS: [event: string, why: string][] = [
    [
        'uncaughtException',
        'The last line of defence. Without it a synchronous throw anywhere in the main process exits the app with nothing written down.',
    ],
    [
        'unhandledRejection',
        'Startup and shutdown are `void`ed promise chains, so a rejection in either has no catch and no console a user will see. In the default Node configuration it terminates the process, and the whole diagnostic is that the app closed.',
    ],
];

/**
 * @param [input.root] Repository root.
 * @param [input.mainIndex='src/main/index.ts'] Where the app lifecycle is wired.
 * @param [input.cleanupRequired=[]] Services that must be released in `before-quit`.
 */
export function inspectElectronErrorHandling(
    input: ElectronErrorHandlingOptions = {},
): ElectronErrorHandlingInspection {
    const {
        root = REPO_ROOT,
        mainDir = 'src/main',
        rendererDir = 'src/renderer',
        mainIndex = 'src/main/index.ts',
        cleanupRequired = [],
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const mainFiles = walkFiles(root, mainDir, { match: /\.ts$/ });

    // ── 1/2. Every IPC handler contains its own failures ─────────────────────
    let handlerCount = 0;

    for (const rel of mainFiles) {
        const source = stripComments(read(rel));

        for (const m of source.matchAll(/\b(?:ipcMain|ipc)\.handle\(\s*'([^']+)'/g)) {
            handlerCount += 1;
            const channel = m[1];
            const { body, expression } = callbackBody(source, m.index + m[0].length);
            const line = source.slice(0, m.index).split('\n').length;

            const guarded = /try\s*\{/.test(body);
            const envelope = /success:\s*false/.test(body);

            // A concise synchronous getter reads in-memory state and cannot fail.
            const fallible = !expression && /\bawait\b|\bthrow\b|\bfs\.|readFile|writeFile|existsSync/.test(body);

            if (fallible && !guarded && !envelope) {
                fail(
                    `${rel}:${line}`,
                    `\`${channel}\` neither try/catches nor returns a failure envelope`,
                    'A throw crossing IPC arrives as a flattened string prefixed "Error invoking remote method" — no type, no stack, no fields. Catch it and return `{ success: false, error }`.',
                );
                continue;
            }

            if (expression) continue;
            if (/\bthrow\b/.test(outsideTry(body))) {
                fail(
                    `${rel}:${line}`,
                    `\`${channel}\` has a \`throw\` outside its try block`,
                    'Usually a guard clause added above the try later. It reads correctly and it is the one path whose error reaches the renderer unstructured.',
                );
            }
        }
    }

    // ── 3. Process-level backstops ───────────────────────────────────────────
    const indexSource = stripComments(read(mainIndex));

    for (const [event, why] of BACKSTOPS) {
        if (!new RegExp(`process\\.on\\(\\s*'${event}'`).test(indexSource)) {
            fail(mainIndex, `registers no \`process.on('${event}')\` handler`, why);
        }
    }

    // ── 4. Shutdown releases the native handles ──────────────────────────────
    if (!/app\.on\(\s*'before-quit'/.test(indexSource)) {
        fail(
            mainIndex,
            'has no `before-quit` handler',
            'It is the only hook that runs while the services still exist. Without it nothing a service holds — a model in native memory, an ONNX session, an fs watcher — is ever released.',
        );
    } else {
        const { body: quitBody } = callbackBody(indexSource, indexSource.search(/app\.on\(\s*'before-quit'/));
        for (const [service, why] of cleanupRequired) {
            if (!new RegExp(`${service}\\.cleanup\\(`).test(quitBody)) {
                fail(mainIndex, `\`before-quit\` never calls \`${service}.cleanup()\``, `It ${why}`);
            }
        }
    }

    // ── 5. A swallowed failure states its reason ─────────────────────────────
    const scanned = { root, files: [...mainFiles, ...walkFiles(root, rendererDir, { match: /\.(ts|vue)$/ })] };
    for (const { file, what, why } of findSwallowedErrors(scanned)) fail(file, what, why);
    const swallows = countSwallows(scanned);

    return { problems, counts: { handlers: handlerCount, swallows } };
}

export function checkElectronErrorHandling(options: ElectronErrorHandlingOptions = {}): void {
    const { cleanupRequired = [] } = options;
    const report = createGateReport({ name: 'Error handling' });
    const { problems, counts } = inspectElectronErrorHandling(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Error handling check passed — ${plural(counts.handlers, 'IPC handler')} containing their own failures, ` +
            `both process backstops present, shutdown releasing ${plural(cleanupRequired.length, 'native handle')}, ` +
            `${plural(counts.swallows, 'swallow')} stating a reason.`,
        notMachineChecked:
            'whether a caught failure is reported to the user or only logged, whether a retry is the right ' +
            'response to it, or whether a service that holds no native handle today still holds none.',
    });
}

/**
 * From `start`, the body of the callback that follows. Located from the `=>`, since the
 * first `{` may belong to an inline return type.
 * @returns `expression: true` for a concise arrow body, which has no try block.
 */
function callbackBody(source: string, start: number): { body: string; expression: boolean } {
    const arrow = source.indexOf('=>', start);
    if (arrow === -1) return { body: '', expression: false };

    let i = arrow + 2;
    while (i < source.length && /\s/.test(source.charAt(i))) i += 1;

    if (source[i] !== '{') {
        // Concise body: up to the comma or paren that closes the handle() call.
        let depth = 0;
        for (let j = i; j < source.length; j += 1) {
            const ch = source.charAt(j);
            if ('([{'.includes(ch)) depth += 1;
            else if (')]}'.includes(ch)) {
                if (depth === 0) return { body: source.slice(i, j), expression: true };
                depth -= 1;
            }
        }
        return { body: source.slice(i), expression: true };
    }

    let depth = 0;
    for (let j = i; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
            depth -= 1;
            if (depth === 0) return { body: source.slice(i + 1, j), expression: false };
        }
    }
    return { body: source.slice(i + 1), expression: false };
}

/**
 * The body with every `try { … } catch { … } finally { … }` removed, so what is
 * left is only the code that runs unguarded.
 */
function outsideTry(body: string): string {
    let out = body;
    for (;;) {
        const at = out.indexOf('try');
        if (at === -1) return out;
        const open = out.indexOf('{', at);
        if (open === -1) return out;

        let depth = 0;
        let end = out.length;
        for (let i = open; i < out.length; i += 1) {
            if (out[i] === '{') depth += 1;
            else if (out[i] === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }

        // Consume the trailing catch/finally blocks too, or `catch` reads as unguarded code.
        const tail = /^\s*(?:catch\s*(?:\([^)]*\))?\s*\{|finally\s*\{)/.exec(out.slice(end));
        if (tail === null) {
            out = out.slice(0, at) + out.slice(end);
            continue;
        }
        let tailDepth = 0;
        let tailEnd = end;
        for (let i = end + tail[0].length - 1; i < out.length; i += 1) {
            if (out[i] === '{') tailDepth += 1;
            else if (out[i] === '}') {
                tailDepth -= 1;
                if (tailDepth === 0) {
                    tailEnd = i + 1;
                    break;
                }
            }
        }
        out = out.slice(0, at) + out.slice(tailEnd);
    }
}
