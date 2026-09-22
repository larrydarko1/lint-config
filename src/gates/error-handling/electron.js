/**
 * Error handling at an Electron app's boundaries.
 *
 * An Electron main process has no middleware and no request/response cycle, so the
 * places a failure can escape are different from a server's, and there are only
 * four of them:
 *
 *   1/2. EVERY IPC HANDLER CONTAINS ITS OWN FAILURES. A throw crossing the IPC
 *        bridge arrives in the renderer as a flattened string prefixed "Error
 *        invoking remote method" — no type, no stack, no fields. There is no
 *        boundary above `ipcMain.handle` to catch it, so each handler is its own
 *        boundary. This is the rule that keeps the NEXT handler honest, which is
 *        why it is worth machine-checking when every existing one already complies.
 *   3.   PROCESS-LEVEL BACKSTOPS. Startup and shutdown are `void`ed promise
 *        chains: a rejection in either has no catch and no console the user will
 *        ever see. In Node's default configuration an unhandled rejection
 *        terminates the process, and the entire diagnostic is that the app closed.
 *   4.   SHUTDOWN RELEASES WHAT CLOSING THE WINDOW DOES NOT. `before-quit` is the
 *        only hook that runs while the services still exist. A process that has
 *        closed its window but not exited presents to the user as the app failing
 *        to quit, and to the next launch as a lock already taken. A project with
 *        no native handles today still needs the hook: the first service that
 *        needs releasing should find somewhere to be released from.
 *   5.   A SWALLOWED FAILURE STATES ITS REASON — shared with every other family,
 *        so it lives in ../swallowed-errors.js.
 *
 * Across Fern, Quartz and bamboo this gate differed by 10–38 lines and not one
 * of them was logic: `cleanupRequired` and the handler counts quoted in the
 * comments. So everything below is shared, and that list is the only option.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from '../files.js';
import { createGateReport, plural } from '../report.js';
import { REPO_ROOT } from '../repo-root.js';
import { stripComments } from '../strip-comments.js';
import { countSwallows, findSwallowedErrors } from '../swallowed-errors.js';

/**
 * From `start`, the body of the callback that follows.
 *
 * The body has to be located from the `=>`, not from the first `{`: these handlers
 * annotate their return type inline (`Promise<{ success: boolean }>`), so the first
 * brace after the channel name belongs to the TYPE. Reading from there yields the
 * annotation and then spills into the next handler, which makes every check
 * downstream quietly wrong.
 *
 * @param {string} source
 * @param {number} start
 * @returns {{ body: string, expression: boolean }} `expression: true` for a concise
 *   arrow body (`() => getStatus()`), which has no statements and so no try block.
 */
function callbackBody(source, start) {
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
 *
 * @param {string} body
 * @returns {string}
 */
function outsideTry(body) {
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

        // Consume the trailing catch/finally blocks too, or the `catch` keyword
        // would be left behind and read as unguarded code on the next pass.
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

/** The process-level handlers every main process must register, and why. */
const BACKSTOPS = [
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
 * @param {object} [options]
 * @param {string} [options.root] Repository root.
 * @param {string} [options.mainDir='src/main']
 * @param {string} [options.rendererDir='src/renderer']
 * @param {string} [options.mainIndex='src/main/index.ts'] Where the app lifecycle is wired.
 * @param {[service: string, why: string][]} [options.cleanupRequired=[]] Services holding a
 *   resource the OS does not reclaim when the window closes. Each must be released in
 *   `before-quit`. Empty is a legitimate answer — the hook is still required.
 * @returns {void}
 */
export function checkElectronErrorHandling(options = {}) {
    const {
        root = REPO_ROOT,
        mainDir = 'src/main',
        rendererDir = 'src/renderer',
        mainIndex = 'src/main/index.ts',
        cleanupRequired = [],
    } = options;

    const report = createGateReport({ name: 'Error handling', standard: 'error-handling.instructions.md' });
    const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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

            // Only a handler that can actually fail owes containment. A concise
            // synchronous getter (`() => getStatus()`) reads state already in
            // memory: wrapping it would add a branch no test could ever reach.
            const fallible = !expression && /\bawait\b|\bthrow\b|\bfs\.|readFile|writeFile|existsSync/.test(body);

            if (fallible && !guarded && !envelope) {
                report.fail(
                    `${rel}:${line}`,
                    `\`${channel}\` neither try/catches nor returns a failure envelope`,
                    'A throw crossing IPC arrives as a flattened string prefixed "Error invoking remote method" — no type, no stack, no fields. Catch it and return `{ success: false, error }`.',
                );
                continue;
            }

            if (expression) continue;
            if (/\bthrow\b/.test(outsideTry(body))) {
                report.fail(
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
            report.fail(mainIndex, `registers no \`process.on('${event}')\` handler`, why);
        }
    }

    // ── 4. Shutdown releases the native handles ──────────────────────────────
    if (!/app\.on\(\s*'before-quit'/.test(indexSource)) {
        report.fail(
            mainIndex,
            'has no `before-quit` handler',
            'It is the only hook that runs while the services still exist. Without it nothing a service holds — a model in native memory, an ONNX session, an fs watcher — is ever released.',
        );
    } else {
        const { body: quitBody } = callbackBody(indexSource, indexSource.search(/app\.on\(\s*'before-quit'/));
        for (const [service, why] of cleanupRequired) {
            if (!new RegExp(`${service}\\.cleanup\\(`).test(quitBody)) {
                report.fail(mainIndex, `\`before-quit\` never calls \`${service}.cleanup()\``, `It ${why}`);
            }
        }
    }

    // ── 5. A swallowed failure states its reason ─────────────────────────────
    const scanned = { root, files: [...mainFiles, ...walkFiles(root, rendererDir, { match: /\.(ts|vue)$/ })] };
    for (const { file, what, why } of findSwallowedErrors(scanned)) report.fail(file, what, why);
    const swallows = countSwallows(scanned);

    report.done({
        summary:
            `Error handling check passed — ${plural(handlerCount, 'IPC handler')} containing their own failures, ` +
            `both process backstops present, shutdown releasing ${plural(cleanupRequired.length, 'native handle')}, ` +
            `${plural(swallows, 'swallow')} stating a reason.`,
        notMachineChecked:
            'whether a caught failure is reported to the user or only logged, whether a retry is the right ' +
            'response to it, or whether a service that holds no native handle today still holds none.',
    });
}

export default checkElectronErrorHandling;
