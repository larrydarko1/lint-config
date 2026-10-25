/**
 * Error handling at a Tauri app's boundaries:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1.   A command that can fail logs the failure itself: Tauri has no error
 *        middleware, so the command is the boundary.
 *   2.   The bridge does not log a command's failure again. Rust already did.
 *   3.   A panic hook writes a panic to the log, the process backstop. Clippy denies
 *        panics in the app's own code; a dependency's still reach the user as a
 *        vanished window, and without the hook, nothing says why.
 *   4.   A swallowed failure states its reason, in Rust (`.ok();`, an empty `Err` arm
 *        or `if let Err`) and in the webview (../lib/swallowed-errors.ts).
 * - What a command returns and how its error crosses to the webview are the
 * tauri-commands gate's.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from '../lib/files.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from '../lib/report.ts';
import { closingBracket } from '../lib/rust.ts';
import { stripComments } from '../lib/strip-comments.ts';
import { countSwallows, findSwallowedErrors, isPlaceholderReason } from '../lib/swallowed-errors.ts';
import { readRustFiles, resultError, tauriCommands } from '../lib/tauri.ts';

export type TauriErrorHandlingOptions = {
    /** Repository root. */
    root?: string;
    /** The Tauri crate. Defaults to `src-tauri`. */
    tauriDir?: string;
    /** The webview's sources, scanned for swallowed failures. Defaults to `src`. */
    webviewDir?: string;
    /** The only webview code that calls Tauri. Defaults to `src/bridge`. */
    bridgeDir?: string;
};

type TauriErrorHandlingInspection = {
    problems: GateFailure[];
    counts: { fallible: number; swallows: number };
};

/** A log call at a level that records a failure: `log::error!`, `warn!`. */
const LOGS_FAILURE = /\b(?:error|warn)!\s*\(/;

/** The Rust shapes that drop an error on the floor. Matched on lexed code, so a comment inside one is blank. */
const RUST_SWALLOWS: [pattern: RegExp, what: string][] = [
    [/\.ok\(\)\s*;/g, '`.ok();` discards an error'],
    [/\bErr\s*\(\s*_\w*\s*\)\s*=>\s*(?:\{\s*\}|\(\s*\))/g, 'an `Err(_)` arm does nothing'],
    [/\bif\s+let\s+Err\s*\([^)]*\)\s*=[^{;]*\{\s*\}/g, 'an `if let Err` block is empty'],
];

/**
 * @param [input.tauriDir='src-tauri'] The Tauri crate.
 * @param [input.webviewDir='src'] The webview's sources.
 * @param [input.bridgeDir='src/bridge'] The only webview code that calls Tauri.
 */
export function inspectTauriErrorHandling(input: TauriErrorHandlingOptions = {}): TauriErrorHandlingInspection {
    const { root = REPO_ROOT, tauriDir = 'src-tauri', webviewDir = 'src', bridgeDir = 'src/bridge' } = input;
    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const srcDir = `${tauriDir}/src`;
    const rust = readRustFiles(root, srcDir);
    if (rust.length === 0) {
        fail(
            srcDir,
            'holds no Rust',
            'This gate reads the commands and the panic hook from here. Point `tauriDir` at the Tauri crate.',
        );
    }

    // ── 1. A failing command logs its own failure ────────────────────────────
    let fallible = 0;
    for (const { name, file, item } of tauriCommands(rust)) {
        if (resultError(item.head) === null || item.body === null) continue;
        const body = file.lexed.code.slice(item.body.start, item.body.end);
        if (!/\?|\bErr\s*\(/.test(body)) continue;
        fallible += 1;
        if (!LOGS_FAILURE.test(body)) {
            fail(
                `${file.rel}:${item.line}`,
                `command \`${name}\` can fail and never logs it`,
                'The webview receives only the code, so the detail exists nowhere unless the command writes it down where it returns the error: `.inspect_err(|err| log::error!(command = "…", err:? = err; "Command failed"))?`.',
            );
        }
    }

    // ── 2. The bridge does not log it again ──────────────────────────────────
    for (const rel of walkFiles(root, bridgeDir, { match: /\.ts$/ })) {
        const code = stripComments(read(rel));
        const exports = [...code.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)];
        for (const [k, m] of exports.entries()) {
            const chunk = code.slice(m.index, exports[k + 1]?.index ?? code.length);
            if (/(?<![\w$])invoke\s*[<(]/.test(chunk) && /\blog\.(?:error|warn)\s*\(/.test(chunk)) {
                fail(
                    `${rel}:${lineAt(code, m.index)}`,
                    `\`${m[1] ?? ''}\` logs the failure of a command it invokes`,
                    'Rust logged it where it failed, with the detail. A second entry from the webview has only the code, and makes one failure read as two.',
                );
            }
        }
    }

    // ── 3. A panic hook ──────────────────────────────────────────────────────
    const hooks = rust.flatMap((file) =>
        [...file.lexed.code.matchAll(/\bpanic::set_hook\s*\(/g)].map((m) => {
            const open = m.index + m[0].length - 1;
            return { file, index: m.index, args: file.lexed.code.slice(open, closingBracket(file.lexed.code, open)) };
        }),
    );
    if (hooks.length === 0) {
        fail(
            `${srcDir}/lib.rs`,
            'installs no panic hook (`std::panic::set_hook`)',
            'A panic in a dependency closes the window, and the default hook writes only to stderr, which a released app has nowhere to show. Install one that logs the panic, then calls the previous hook.',
        );
    }
    for (const { file, index, args } of hooks) {
        if (!LOGS_FAILURE.test(args)) {
            fail(
                `${file.rel}:${lineAt(file.source, index)}`,
                'the panic hook does not log',
                'It is the one place a panic can be written down. `log::error!(panic:% = info; "Panicked")`, then the previous hook.',
            );
        }
    }

    // ── 4. A swallowed failure states its reason ─────────────────────────────
    let rustSwallows = 0;
    for (const file of rust) {
        for (const [pattern, what] of RUST_SWALLOWS) {
            for (const m of file.lexed.code.matchAll(pattern)) {
                rustSwallows += 1;
                const reason = swallowReason(file.source, m.index, m.index + m[0].length);
                if (!isPlaceholderReason(reason)) continue;
                fail(
                    `${file.rel}:${lineAt(file.source, m.index)}`,
                    `${what} without a reason${reason === '' ? '' : ` ("${reason}")`}`,
                    'Say what is dropped and why that is safe, in a comment beside it: "the window is already closing". Clippy refuses `let _ =` on a `Result`, and not these.',
                );
            }
        }
    }
    const scanned = { root, files: walkFiles(root, webviewDir, { match: /\.(ts|vue)$/ }) };
    for (const { file, what, why } of findSwallowedErrors(scanned)) fail(file, what, why);
    const swallows = countSwallows(scanned) + rustSwallows;

    return { problems, counts: { fallible, swallows } };
}

export function checkTauriErrorHandling(options: TauriErrorHandlingOptions = {}): void {
    const report = createGateReport({ name: 'Error handling' });
    const { problems, counts } = inspectTauriErrorHandling(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Error handling check passed — ${plural(counts.fallible, 'fallible command')} logging their own failures, none logged twice by the bridge, ` +
            `a panic hook that logs, ${plural(counts.swallows, 'swallow')} stating a reason.`,
        notMachineChecked:
            'whether a caught failure is reported to the user or only logged, whether a failure logged by a helper the command calls is logged once, and an error replaced by a default (`unwrap_or_default`), which reads the same as an `Option` falling back.',
    });
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * The comment that explains a Rust swallow: inside it, at the end of its line, or on
 * the lines directly above it.
 */
function swallowReason(source: string, start: number, end: number): string {
    const lines = source.split('\n');
    const first = lineAt(source, start) - 1;
    const last = lineAt(source, end) - 1;
    const said = [
        ...lines
            .slice(first, last + 1)
            .join('\n')
            .matchAll(/\/\/(.*)|\/\*([\s\S]*?)\*\//g),
    ].map((m) => m[1] ?? m[2] ?? '');
    for (let k = first - 1; k >= 0 && /^\s*\/\/(?![/!])/.test(lines[k] ?? ''); k--)
        said.unshift((lines[k] ?? '').replace(/^\s*\/\//, ''));
    return said.join(' ').replace(/\s+/g, ' ').trim();
}
