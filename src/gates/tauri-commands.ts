/**
 * The chain a Tauri command travels, both ways, tauri.instructions.md's *Commands*:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1.  One `invoke_handler`, with one `generate_handler!`: a second call replaces the first.
 *   2.  Every `#[tauri::command]` is `pub`, lives in `commands/<domain>.rs`, has a name no
 *       other command has, and is registered; everything registered is a command.
 *   3.  A command that can fail returns the app's `Result`, never a `String` error.
 *   4.  `build.rs` lists exactly the registered commands, so each becomes a permission.
 *   5.  Each command's `allow-<name>` is granted, and every `allow-`/`deny-` the
 *       capabilities name is a command or a permission the app defines.
 *   6.  The bridge invokes each command by its literal name, and only registered ones.
 *   7.  Rust emits events through a `pub const` named `domain:action`; the bridge
 *       listens for each by its literal name, and for nothing Rust never emits.
 *   8.  Every code `Error::code()` returns is in the bridge's `ERROR_CODES`.
 *   9.  No `map_err(|e| e.to_string())`: the OS's English, path included, to the UI.
 * - Rust is read with lib/rust.ts, the bridge with strip-comments.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { closingBracket, lexRust, rustItems, splitRustList, stringsIn } from './lib/rust.ts';
import { stripComments } from './lib/strip-comments.ts';
import { readRustFiles, resultError, tauriCommands, type RustFile, type TauriCommand } from './lib/tauri.ts';

export type TauriCommandsOptions = {
    /** Default: the repo root. */
    root?: string;
    /** The Tauri crate. Default `src-tauri`. */
    tauriDir?: string;
    /** Where commands live, one file per domain. Default `<tauriDir>/src/commands`. */
    commandsDir?: string;
    /** The only webview code that calls Tauri. Default `src/bridge`. */
    bridgeDir?: string;
    /** The error every command returns. Default `<tauriDir>/src/error.rs`. */
    errorFile?: string;
    /** The webview's list of codes. Default `src/bridge/errors.ts`, constant `ERROR_CODES`. */
    errorCodes?: { file: string; name: string };
};

type TauriCommandsInput = Omit<TauriCommandsOptions, 'root'> & { root: string };

type TauriCommandsInspection = {
    problems: GateFailure[];
    counts: { commands: number; invokes: number; events: number; codes: number };
};

/** `domain:action`, each part lowerCamelCase, as Electron's channels are. */
const EVENT_NAME = /^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*$/;

/** Emit methods, with the index of their event-name argument. */
const EMITTERS: Record<string, number> = {
    emit: 0,
    emit_filter: 0,
    emit_str: 0,
    emit_to: 1,
    emit_str_to: 1,
    emit_str_filter: 0,
};

/** `.map_err(|e| e.to_string())`, `|e| format!(…)`, `ToString::to_string`, `String::from`. */
const STRINGIFIED_ERROR =
    /\.map_err\(\s*(?:\|\s*(\w+)\s*(?::[^|]*)?\|\s*\{?\s*(?:\1\s*\.\s*to_string\s*\(\s*\)|format!|String::from\s*\(\s*\1\b)|(?:[\w:]*::)?(?:ToString::to_string|String::from)\s*\))/g;

/** The error types that serialise to their English message. */
const FOREIGN_ERRORS =
    /^(?:String|&\s*(?:'\w+\s+)?str|Box\s*<.*>|(?:std::)?io::Error|tauri::Error|anyhow::Error|serde_json::Error)$/;

export function inspectTauriCommands(input: TauriCommandsInput): TauriCommandsInspection {
    const { root, tauriDir = 'src-tauri', bridgeDir = 'src/bridge' } = input;
    const commandsDir = input.commandsDir ?? `${tauriDir}/src/commands`;
    const errorFile = input.errorFile ?? `${tauriDir}/src/error.rs`;
    const errorCodes = input.errorCodes ?? { file: 'src/bridge/errors.ts', name: 'ERROR_CODES' };

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => problems.push({ file, what, why });
    const counts = { commands: 0, invokes: 0, events: 0, codes: 0 };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));

    const srcDir = `${tauriDir}/src`;
    if (!exists(srcDir)) {
        fail(
            srcDir,
            'does not exist',
            'This gate reads the Rust commands from here. Point `tauriDir` at the Tauri crate.',
        );
        return { problems, counts };
    }
    const rust = readRustFiles(root, srcDir);
    const where = (file: RustFile, index: number) => `${file.rel}:${lineAt(file.source, index)}`;

    // ── 2/3. The commands ────────────────────────────────────────────────────
    const commands = tauriCommands(rust);
    for (const { file, item } of commands) {
        const at = `${file.rel}:${item.line}`;
        if (!file.rel.startsWith(`${commandsDir}/`)) {
            fail(
                at,
                `command \`${item.name}\` is outside \`${commandsDir}/\``,
                'Commands live one file per domain under `commands/`, so one folder lists everything the webview can ask Rust to do. A command in `lib.rs` cannot even be `pub`.',
            );
        }
        if (!item.public) {
            fail(
                at,
                `command \`${item.name}\` is not \`pub\``,
                'It is registered by path in `generate_handler!` from `lib.rs`, which needs to reach it.',
            );
        }
        const error = resultError(item.head);
        if (error !== null && error !== '' && (FOREIGN_ERRORS.test(error) || !/(?:^|::)Error$/.test(error))) {
            fail(
                at,
                `command \`${item.name}\` fails with \`${error}\``,
                'A command fails with the app’s `Error`, which crosses to the webview as its code alone. A string, or a library’s error, serialises to its English message — the OS’s, with the path on the user’s disk.',
            );
        }
        if (
            error === '' &&
            file.items.some(
                (it) => it.kind === 'use' && /\bResult\b/.test(it.name) && !/^(?:crate|super|self)::/.test(it.name),
            )
        ) {
            fail(
                at,
                `command \`${item.name}\` returns a \`Result\` imported from outside the crate`,
                'The one-argument `Result` is the app’s own alias, `crate::error::Result`. `tauri::Result` and `anyhow::Result` serialise their error to its English message.',
            );
        }
    }
    counts.commands = commands.length;
    const byName = new Map<string, TauriCommand[]>();
    for (const c of commands) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    const located = (c: TauriCommand) => `${c.file.rel}:${c.item.line}`;
    for (const [name, defs] of byName) {
        const [first, ...others] = defs;
        if (first === undefined || others.length === 0) continue;
        fail(
            located(first),
            `command \`${name}\` is also defined in ${others.map(located).join(', ')}`,
            'Tauri does not namespace commands by module: the webview calls a bare name, and two commands with it collide. Name each for its domain (`read_note`, `list_folder`).',
        );
    }

    // ── 1. One handler ───────────────────────────────────────────────────────
    const registered = new Map<string, string>();
    const handlers = rust.flatMap((file) =>
        [...file.lexed.code.matchAll(/\.invoke_handler\s*\(/g)].map((m) => ({ file, index: m.index })),
    );
    if (handlers.length > 1) {
        for (const h of handlers.slice(1))
            fail(
                where(h.file, h.index),
                'calls `invoke_handler` a second time',
                'Each call replaces the last, so the commands registered first stop existing — with no error, until the webview calls one.',
            );
    }
    for (const file of rust) {
        for (const m of file.lexed.code.matchAll(/\bgenerate_handler!\s*\[/g)) {
            const open = m.index + m[0].length - 1;
            const close = closingBracket(file.lexed.code, open);
            for (const entry of splitRustList(file.lexed.code.slice(open + 1, close === -1 ? undefined : close))) {
                const name = entry.split('::').pop()?.trim() ?? '';
                registered.set(name, where(file, m.index));
            }
        }
    }
    if (commands.length > 0 && registered.size === 0) {
        fail(
            srcDir,
            'has commands but no `generate_handler!`',
            'An unregistered command is unreachable. Register every command in the one `generate_handler!` in `lib.rs`.',
        );
    }
    for (const c of commands) {
        if (!registered.has(c.name))
            fail(
                located(c),
                `command \`${c.name}\` is not in \`generate_handler!\``,
                'It compiles, and the webview’s `invoke` rejects. Register it, or delete it.',
            );
    }
    for (const [name, at] of registered) {
        if (!byName.has(name))
            fail(
                at,
                `\`generate_handler!\` registers \`${name}\`, which is no \`#[tauri::command]\` here`,
                'This gate reads commands from the crate’s `src/`. A command from a dependency belongs to a plugin, with its own permissions.',
            );
    }

    // ── 4. build.rs lists them ───────────────────────────────────────────────
    const buildRel = `${tauriDir}/build.rs`;
    let manifest: string[] | null = null;
    if (exists(buildRel)) {
        const source = read(buildRel);
        const lexed = lexRust(source);
        const call = /\.commands\s*\(\s*(&?\s*\[)?/.exec(lexed.code);
        if (call !== null) {
            if (call[1] !== undefined) {
                const open = call.index + call[0].length - 1;
                manifest = stringsIn(lexed, open, closingBracket(lexed.code, open));
            } else {
                const name = /^\s*([A-Za-z_]\w*)/.exec(lexed.code.slice(call.index + call[0].length))?.[1] ?? '';
                const constant = rustItems(source, lexed).find((it) => it.kind === 'const' && it.name === name);
                manifest = constant === undefined ? null : stringsIn(lexed, constant.keywordStart, constant.end);
            }
        }
    }
    if (manifest === null) {
        if (commands.length > 0)
            fail(
                buildRel,
                'does not list the app’s commands (`AppManifest::new().commands(COMMANDS)`)',
                'Without the list, every registered command is open to every window. With it, each becomes an `allow-<name>` permission a capability has to grant.',
            );
    } else {
        for (const name of manifest)
            if (!registered.has(name))
                fail(
                    buildRel,
                    `lists \`${name}\`, which is not registered`,
                    'It would become a permission for a command that does not exist. Drop it.',
                );
        for (const name of registered.keys())
            if (!manifest.includes(name))
                fail(
                    buildRel,
                    `does not list \`${name}\``,
                    'An unlisted command has no permission, so no capability can grant it and the webview’s call is refused.',
                );
    }

    // ── 5. Capabilities grant them ───────────────────────────────────────────
    const capabilitiesDir = `${tauriDir}/capabilities`;
    const permissionsDir = `${tauriDir}/permissions`;
    const granted = new Map<string, string>();
    for (const rel of walkFiles(root, capabilitiesDir, { match: /\.json$/ })) {
        let data: unknown;
        try {
            data = JSON.parse(read(rel));
        } catch {
            // The security gate reports a capability that cannot be parsed; here it just grants nothing.
            continue;
        }
        const { permissions } = typeof data === 'object' && data !== null ? (data as { permissions?: unknown }) : {};
        for (const p of Array.isArray(permissions) ? (permissions as unknown[]) : []) {
            const { identifier } =
                typeof p === 'object' && p !== null ? (p as { identifier?: unknown }) : { identifier: p };
            if (typeof identifier === 'string') granted.set(identifier, rel);
        }
    }
    // The app's own permission files: sets that bundle command permissions under another name.
    const defined = new Set<string>();
    for (const rel of walkFiles(root, permissionsDir, { match: /\.toml$/, exclude: /\/autogenerated\// })) {
        const text = read(rel);
        for (const m of text.matchAll(/^\s*identifier\s*=\s*"([^"]+)"/gm)) defined.add(m[1] ?? '');
        for (const m of text.matchAll(/"((?:allow|deny)-[a-z0-9-]+)"/g)) granted.set(m[1] ?? '', rel);
    }
    for (const name of registered.keys()) {
        if (!granted.has(`allow-${kebab(name)}`))
            fail(
                capabilitiesDir,
                `no capability grants \`allow-${kebab(name)}\``,
                `Without it every window’s \`invoke('${name}')\` is refused. Grant it in the capability of the window that calls it.`,
            );
    }
    for (const [id, rel] of granted) {
        const m = /^(allow|deny)-(.+)$/.exec(id);
        if (m === null || defined.has(id)) continue;
        if (![...registered.keys()].some((name) => kebab(name) === m[2]))
            fail(
                rel,
                `grants \`${id}\`, which names no registered command`,
                'A stale grant for a command that was renamed or removed. Drop it, or rename it with the command.',
            );
    }

    // ── 6. The bridge calls them ─────────────────────────────────────────────
    const bridge = walkFiles(root, bridgeDir, { match: /\.ts$/ }).map((rel) => ({
        rel,
        code: stripComments(read(rel)),
    }));
    if (bridge.length === 0)
        fail(
            bridgeDir,
            'holds no TypeScript',
            'This gate reads every `invoke` and `listen` from the bridge. Point `bridgeDir` at it.',
        );
    const invoked = new Set<string>();
    for (const { rel, code } of bridge) {
        for (const call of tsCalls(code, 'invoke')) {
            counts.invokes++;
            const at = `${rel}:${lineAt(code, call.index)}`;
            if (call.name === null) {
                fail(
                    at,
                    'calls `invoke` with a name that is not a string literal',
                    "The literal is what review and this gate match against the Rust command. Write it out: `invoke<T>('take_pending_files')`.",
                );
                continue;
            }
            if (call.name.startsWith('plugin:')) continue;
            invoked.add(call.name);
            if (!registered.has(call.name))
                fail(
                    at,
                    `invokes \`${call.name}\`, which Rust does not register`,
                    'The call rejects at runtime. Match the command’s snake_case name exactly, or add the command.',
                );
        }
    }
    for (const name of registered.keys()) {
        if (!invoked.has(name))
            fail(
                registered.get(name) ?? null,
                `\`${name}\` is registered and the bridge never invokes it`,
                'A command the webview cannot reach is surface with no caller. Delete it, or add its function to the bridge.',
            );
    }

    // ── 7. Events, both ways ─────────────────────────────────────────────────
    const constants = new Map<string, { value: string | null; public: boolean; at: string }>();
    for (const file of rust) {
        for (const item of file.items) {
            if (item.kind !== 'const') continue;
            const [value] = stringsIn(file.lexed, item.keywordStart, item.end);
            constants.set(item.name, { value: value ?? null, public: item.public, at: `${file.rel}:${item.line}` });
        }
    }
    const emitted = new Map<string, string>();
    for (const file of rust) {
        for (const m of file.lexed.code.matchAll(/\.(emit(?:_str)?(?:_to|_filter)?)\s*\(/g)) {
            const index = EMITTERS[m[1] ?? ''];
            if (index === undefined) continue;
            const open = m.index + m[0].length - 1;
            const args = splitRustList(file.lexed.code.slice(open + 1, closingBracket(file.lexed.code, open)));
            const arg = args[index] ?? '';
            const at = where(file, m.index);
            if (arg.startsWith('"')) {
                fail(
                    at,
                    'emits an event named by a string literal',
                    'The name is a `pub const` beside the code that emits it, so the emitter and the docs share one spelling. The bridge, in TypeScript, is the only other place it is written.',
                );
                continue;
            }
            const name = arg.replace(/^&/, '').split('::').pop()?.trim() ?? '';
            const constant = constants.get(name);
            const value = constant?.value ?? null;
            if (constant === undefined || value === null) {
                fail(
                    at,
                    `emits \`${arg}\`, which is no \`const\` with a string value in \`src/\``,
                    'This gate matches the event name to the bridge’s `listen`. Declare it as `pub const NAME: &str = "domain:action";`.',
                );
                continue;
            }
            counts.events++;
            emitted.set(value, at);
            if (!constant.public)
                fail(
                    constant.at,
                    `event constant \`${name}\` is not \`pub\``,
                    'It names a contract with the webview. `pub` says so, and lets a second emitter reuse it instead of retyping it.',
                );
            if (!EVENT_NAME.test(value))
                fail(
                    constant.at,
                    `event \`${value}\` is not \`domain:action\` in lowerCamelCase`,
                    'The same shape as an IPC channel (`file:opened`), so the domain groups the events and the action says what happened.',
                );
        }
    }
    const listened = new Set<string>();
    for (const { rel, code } of bridge) {
        for (const fn of ['listen', 'once']) {
            for (const call of tsCalls(code, fn)) {
                const at = `${rel}:${lineAt(code, call.index)}`;
                if (call.name === null) {
                    fail(
                        at,
                        `calls \`${fn}\` with an event name that is not a string literal`,
                        'Write the event out, as Rust’s constant spells it, so the two can be matched.',
                    );
                    continue;
                }
                if (call.name.startsWith('tauri://')) continue;
                listened.add(call.name);
                if (!emitted.has(call.name))
                    fail(
                        at,
                        `listens for \`${call.name}\`, which Rust never emits`,
                        'The handler never runs. Match Rust’s constant exactly, or delete the subscription.',
                    );
            }
        }
    }
    for (const [name, at] of emitted) {
        if (!listened.has(name))
            fail(
                at,
                `emits \`${name}\`, which the bridge never listens for`,
                'Nothing in the webview receives it. Add a subscribe function to the bridge’s events module, or stop emitting it.',
            );
    }

    // ── 8. Error codes reach ERROR_CODES ─────────────────────────────────────
    const usesResult = commands.some((c) => resultError(c.item.head) !== null);
    if (!exists(errorFile)) {
        if (usesResult)
            fail(
                errorFile,
                'does not exist',
                'Commands that fail return the app’s `Error`, which lives here. Point `errorFile` at it.',
            );
    } else {
        const source = read(errorFile);
        const lexed = lexRust(source);
        const code = /\bfn\s+code\s*\(\s*&\s*self\s*\)[^{]*\{/.exec(lexed.code);
        if (code === null) {
            fail(
                errorFile,
                'has no `fn code(&self)`',
                'The error crosses to the webview as a code, which `Serialize` writes from `code()`. Without it there is nothing to match against `ERROR_CODES`.',
            );
        } else {
            const open = code.index + code[0].length - 1;
            const produced = stringsIn(lexed, open, closingBracket(lexed.code, open));
            counts.codes = produced.length;
            const tsRel = errorCodes.file;
            const ts = exists(tsRel) ? stripComments(read(tsRel)) : '';
            const list = new RegExp(String.raw`\b${errorCodes.name}\s*=\s*\[([^\]]*)\]`).exec(ts)?.[1];
            if (list === undefined) {
                fail(
                    tsRel,
                    `has no \`${errorCodes.name} = [...]\``,
                    'The webview’s list of codes is what `toErrorCode` matches a rejection against. Without it every command’s failure reads as `INTERNAL`.',
                );
            } else {
                const known = [...list.matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
                for (const c of new Set(produced)) {
                    if (!known.includes(c))
                        fail(
                            errorFile,
                            `\`code()\` returns \`${c}\`, which \`${errorCodes.name}\` does not list`,
                            'The bridge reads an unknown code as `INTERNAL`, so the user is told something went wrong instead of what. Add it, with its translation in every locale.',
                        );
                }
            }
        }
        const serialize = rustItems(source, lexed).find(
            (it) => it.kind === 'impl' && /(?:^|::)Serialize$/.test(it.trait ?? ''),
        );
        const body =
            serialize?.body === null || serialize === undefined
                ? ''
                : lexed.code.slice(serialize.body.start, serialize.body.end);
        if (serialize === undefined || !body.includes('self.code()') || /to_string\(\)|self\.0|format!/.test(body)) {
            fail(
                errorFile,
                serialize === undefined
                    ? 'has no `impl Serialize for Error`'
                    : '`Serialize` writes more than `self.code()`',
                'The error crosses as its code and nothing else. Its `Display`, `Debug` and wrapped causes hold the OS’s English and the user’s paths, and belong in the log.',
            );
        }
    }

    // ── 9. No stringified errors ─────────────────────────────────────────────
    for (const file of rust) {
        for (const m of file.lexed.code.matchAll(STRINGIFIED_ERROR)) {
            fail(
                where(file, m.index),
                'turns an error into its English message with `map_err`',
                'It is the template’s shortcut, and it sends `No such file or directory (os error 2)` to the UI, untranslated, with the path. Map it to a variant of the app’s `Error`, and log the detail.',
            );
        }
    }

    return { problems, counts };
}

export function checkTauriCommands({ root = REPO_ROOT, ...rest }: TauriCommandsOptions = {}): void {
    const report = createGateReport({ name: 'Tauri commands' });
    const { problems, counts } = inspectTauriCommands({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Tauri commands OK — ${plural(counts.commands, 'command')} registered once, listed in build.rs, granted and invoked by name; ` +
            `${plural(counts.invokes, 'invoke')} naming a registered command; ${plural(counts.events, 'emit')} through a \`domain:action\` constant the bridge listens for; ` +
            `${plural(counts.codes, 'error code')} known to the webview; no error sent as its message.`,
        notMachineChecked:
            'whether a command name starts with its verb, whether the type argument on `invoke<T>` is what Rust returns, whether a command checks the meaning of its arguments (a path against what Rust holds), and every code’s translation (the locale parity test).',
    });
}

const kebab = (name: string) => name.replace(/_/g, '-');

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * Every call of `fn` in TypeScript, with its first argument when that is a string
 * literal. A type argument between the name and the `(` is skipped, nested or not.
 */
function tsCalls(code: string, fn: string): { index: number; name: string | null }[] {
    const out: { index: number; name: string | null }[] = [];
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$])${fn}\s*`, 'g'))) {
        let j = m.index + m[0].length;
        if (code[j] === '<') {
            let depth = 0;
            for (; j < code.length; j++) {
                if (code[j] === '<') depth++;
                else if (code[j] === '>' && code[j - 1] !== '=' && --depth === 0) break;
            }
            j = j + 1;
            while (/\s/.test(code.charAt(j))) j++;
        }
        if (code[j] !== '(') continue;
        const literal = /^\(\s*(['"`])([^'"`$]*)\1\s*[,)]/.exec(code.slice(j));
        out.push({ index: m.index, name: literal?.[2] ?? null });
    }
    return out;
}
