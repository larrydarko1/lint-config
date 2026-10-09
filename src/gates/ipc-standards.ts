/**
 * IPC architecture gate — the channel surface between main and renderer.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. The main entry's "IPC handler ownership:" table matches the handlers, both ways.
 *   2. Every channel the preload invokes has a handler.
 *   3. Every event the preload listens for is sent.
 *   4. No handler the preload never calls, no event nobody receives.
 *   5. No `ipcRenderer` passthrough; every channel is a string literal.
 *   6. One `exposeInMainWorld`, typed against the shared contract.
 *   7. Every handler validates every argument.
 *   8. Channels are `domain:action`, both camelCase, the action not repeating the domain.
 * - Rule 7 reads each handler's own body, per argument (`safeParse`/`parse`/`typeof`/
 * `instanceof`/`Array.isArray`/`Number.is*`/`.test`), following an argument into a
 * helper declared in the same file. Handlers are found by receiver: `ipcMain`,
 * `webContents.ipc` and anything typed `IpcMain` (or a `receiverTypes` name), including
 * `handleOnce`/`once`/`sendSync`. A `domain:action` registration on any other receiver fails.
 * - Handlers containing their own failures is error-handling's rule.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { callSites, declaredFunction, functionParts, splitTopLevel, type FunctionParts } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

export type IpcStandardsOptions = Omit<IpcStandardsInput, 'root'> & {
    /** Default: the repo root. */
    root?: string;
};

type IpcStandardsInput = {
    root: string;
    /** Holds the "IPC handler ownership:" table and any inline handlers. Default `src/main/index.ts`. */
    mainIndex?: string;
    /** One file per service; a table row `fs-service` means `<servicesDir>/fs.ts`. Default `src/main/services`. */
    servicesDir?: string;
    /** Default `src/preload/index.ts`. */
    preload?: string;
    /** The shared type file the bridge is typed against. Default `src/schemas/electron.d.ts`. */
    contract?: string;
    /** The type the exposed object must be annotated with. Default `ElectronAPI`. */
    contractType?: string;
    /** Parameter types that mark a handler receiver, for a project's own narrowed `IpcMain`. Default `['IpcMain']`. */
    receiverTypes?: string[];
};

type IpcStandardsInspection = {
    problems: GateFailure[];
    counts: { handlers: number; events: number; preloadChannels: number };
};

/** A call that, given the argument, checks its type or value. */
const VALIDATORS = [
    'safeParse(',
    '.parse(',
    'Array.isArray(',
    '.test(',
    'Number.isInteger(',
    'Number.isFinite(',
    'Number.isSafeInteger(',
];

/** `name.handle('channel'` on a bare identifier, whatever its type: receiver in 1, channel in 3. */
const REGISTRATION = /(?<![\w$.])([A-Za-z_$][\w$]*)\.(?:handle|handleOnce|on|once)\(\s*(['"])([^'"\\]*)\2/g;

const lineAt = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/** `'fs:read'` → `fs:read`; `null` for anything but a plain string literal. */
function literal(arg: string): string | null {
    const m = /^\s*(['"])([^'"\\]*)\1\s*$/.exec(arg);
    return m === null ? null : (m[2] ?? '');
}

/**
 * Does `body` validate `param` — directly, or by handing it to a function
 * declared in `file` that validates the parameter it arrives as?
 *
 * @param file The whole (comment-stripped) file, to resolve helpers in.
 */
function validates(param: string, body: string, file: string, depth = 0): boolean {
    const named = new RegExp(String.raw`(?<![\w$.])${param.replace(/\$/g, '\\$')}(?![\w$])`);
    if (
        new RegExp(
            String.raw`\btypeof\s+${param.replace(/\$/g, '\\$')}(?![\w$])|(?<![\w$.])${param.replace(/\$/g, '\\$')}\s+instanceof\b`,
        ).test(body)
    ) {
        return true;
    }
    for (const token of VALIDATORS) {
        if (callSites(body, token).some((site) => named.test(site.args))) return true;
    }
    if (depth >= 3) return false;
    for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const helper = declaredFunction(file, m[1] ?? '');
        if (helper === null) continue;
        const site = callSites(body.slice(m.index), `${m[1]}(`)[0];
        if (site === undefined) continue;
        const position = splitTopLevel(site.args, ',').findIndex(
            (arg) => named.test(arg) && arg.replace(/^\.\.\./, '').trim() === param,
        );
        const inner = helper.params[position];
        if (position !== -1 && inner !== undefined && validates(inner, helper.body, file, depth + 1)) return true;
    }
    return false;
}

export function inspectIpcStandards({
    root,
    mainIndex = 'src/main/index.ts',
    servicesDir = 'src/main/services',
    preload = 'src/preload/index.ts',
    contract = 'src/schemas/electron.d.ts',
    contractType = 'ElectronAPI',
    receiverTypes = ['IpcMain'],
}: IpcStandardsInput): IpcStandardsInspection {
    const problems: GateFailure[] = [];
    const fail: (file: string, what: string, why: string) => void = (file, what, why) =>
        problems.push({ file, what, why });
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const empty = { problems, counts: { handlers: 0, events: 0, preloadChannels: 0 } };

    for (const rel of [mainIndex, preload]) {
        if (!exists(rel)) {
            fail(
                rel,
                'does not exist',
                'This gate reads the IPC surface from here. Point the option at the real file.',
            );
        }
    }
    if (problems.length > 0) return empty;

    const serviceFiles = exists(servicesDir)
        ? fs
              .readdirSync(path.join(root, servicesDir))
              .filter((f) => /\.[cm]?ts$/.test(f) && !/\.(?:test|spec)\./.test(f))
              .sort()
              .map((f) => `${servicesDir}/${f}`)
        : [];
    const mainFiles = [mainIndex, ...serviceFiles];
    const typeNames = receiverTypes.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const receiverPattern = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*(?:Electron\\.)?(?:${typeNames})\\b`, 'g');
    const code = new Map(mainFiles.map((rel) => [rel, stripComments(read(rel))]));

    /** channel → owning file, for everything registered with handle/on. */
    const handlers = new Map();
    /** channel → owning file, for everything pushed with webContents.send. */
    const events = new Map();
    const registrations: { rel: string; line: number; channel: string; fn: FunctionParts | null; source: string }[] =
        [];

    for (const rel of mainFiles) {
        const source = code.get(rel) ?? '';
        // `webContents.ipc` is the per-window handler registry, as reachable as ipcMain.
        const receivers = new Set(['ipcMain', 'webContents.ipc']);
        for (const m of source.matchAll(receiverPattern)) receivers.add(m[1] ?? '');

        for (const m of source.matchAll(REGISTRATION)) {
            const [, receiver = '', , channel = ''] = m;
            if (receivers.has(receiver) || !/^[A-Za-z]+:[A-Za-z]+$/.test(channel)) continue;
            fail(
                `${rel}:${lineAt(source, m.index)}`,
                `registers \`${channel}\` on \`${receiver}\`, which is not typed as an IPC receiver`,
                `Handlers are found by the receiver's type, so every rule here skips this one. Annotate \`${receiver}\` as ${receiverTypes.map((t) => `\`${t}\``).join(' or ')}, or add its type to \`receiverTypes\`.`,
            );
        }

        for (const receiver of receivers) {
            for (const method of ['handle', 'handleOnce', 'on', 'once']) {
                for (const site of callSites(source, `${receiver}.${method}(`)) {
                    if (site.index > 0 && /[\w$]/.test(source[site.index - 1] ?? '')) continue;
                    const line = lineAt(source, site.index);
                    const [first = '', ...rest] = splitTopLevel(site.args, ',');
                    const channel = literal(first);
                    if (channel === null) {
                        fail(
                            `${rel}:${line}`,
                            `registers a channel that is not a string literal (\`${first.slice(0, 30)}\`)`,
                            'A channel assembled at runtime is invisible to every rule here — parity, reachability, naming. Spell each channel out, one registration per line.',
                        );
                        continue;
                    }
                    const owner = handlers.get(channel);
                    if (owner !== undefined) {
                        fail(
                            `${rel}:${line}`,
                            `registers \`${channel}\`, which ${owner} already registers`,
                            'The second registration throws at startup for handle(), or silently double-fires for on().',
                        );
                    }
                    handlers.set(channel, rel);
                    const handler = rest.join(', ').trim();
                    const fn =
                        functionParts(handler) ??
                        (/^[A-Za-z_$][\w$]*$/.test(handler) ? declaredFunction(source, handler) : null);
                    registrations.push({ rel, line, channel, fn, source });
                }
            }
        }
        for (const site of callSites(source, 'webContents.send(')) {
            const first = splitTopLevel(site.args, ',')[0] ?? '';
            const channel = literal(first);
            if (channel === null) {
                fail(
                    `${rel}:${lineAt(source, site.index)}`,
                    `sends on a channel that is not a string literal (\`${first.slice(0, 30)}\`)`,
                    'A channel assembled at runtime is invisible to every rule here. Spell it out.',
                );
                continue;
            }
            events.set(channel, rel);
        }
    }

    const preloadCode = stripComments(read(preload));
    /** channel → how the preload uses it. */
    const preloadChannels = new Map();
    for (const kind of ['invoke', 'send', 'sendSync', 'on', 'once']) {
        for (const site of callSites(preloadCode, `ipcRenderer.${kind}(`)) {
            const first = splitTopLevel(site.args, ',')[0] ?? '';
            const channel = literal(first);
            if (channel === null) {
                fail(
                    `${preload}:${lineAt(preloadCode, site.index)}`,
                    `passes \`${first.slice(0, 30)}\` as a channel name instead of a literal`,
                    'A channel taken as an argument is a generic passthrough: the renderer chooses the channel, so the explicit surface stops being a boundary.',
                );
                continue;
            }
            preloadChannels.set(channel, kind === 'on' || kind === 'once' ? 'listen' : 'call');
        }
    }

    // ── 1. Channel documentation parity ───────────────────────────────────────
    const raw = read(mainIndex);
    const heading = raw.indexOf('IPC handler ownership:');
    if (heading === -1) {
        fail(
            mainIndex,
            'has no "IPC handler ownership:" table in its header',
            'It is the only map of which service owns which channels. Without it, finding the owner of a channel means grepping every service.',
        );
    } else {
        const end = raw.indexOf('*/', heading);
        const table = raw.slice(heading, end === -1 ? raw.length : end);
        /** owner file → documented patterns */
        const documented = new Map();
        for (const row of table.split('\n').slice(1)) {
            // Label, then an optional parenthetical qualifier, then the channel list.
            const m = /^\s*\*?\s*([a-zA-Z]+)(?:-service)?(?:\s+\([^)]*\))?\s+→\s+(.+?)\s*$/.exec(row);
            if (m === null) continue;
            const [, label = '', list = ''] = m;
            const owner = label === 'main' ? mainIndex : `${servicesDir}/${label}.ts`;
            documented.set(
                owner,
                list
                    .split(',')
                    .map((p) => p.trim())
                    .filter((p) => p !== ''),
            );
        }
        for (const [owner, patterns] of documented) {
            if (!exists(owner)) {
                fail(
                    mainIndex,
                    `the ownership table names \`${owner}\`, which does not exist`,
                    'The table documents a service that was renamed or removed.',
                );
            }
            for (const pattern of patterns) {
                const matched = [...handlers].some(
                    ([channel, file]) =>
                        file === owner &&
                        (pattern.endsWith('*') ? channel.startsWith(pattern.slice(0, -1)) : channel === pattern),
                );
                if (!matched) {
                    fail(
                        mainIndex,
                        `the ownership table documents \`${pattern}\` for ${path.basename(owner)}, which registers no such channel`,
                        'A stale entry is a map pointing the wrong way. Remove it, or restore the handler it describes.',
                    );
                }
            }
        }
        for (const [channel, owner] of handlers) {
            const patterns = documented.get(owner);
            if (patterns === undefined) {
                fail(
                    mainIndex,
                    `the ownership table has no row for ${path.basename(owner)} (which registers \`${channel}\`)`,
                    'Every file registering a channel needs a row, or the table is not a map of the surface.',
                );
                continue;
            }
            if (!patterns.some((p: string) => (p.endsWith('*') ? channel.startsWith(p.slice(0, -1)) : channel === p))) {
                fail(
                    mainIndex,
                    `\`${channel}\` is registered by ${path.basename(owner)} but no documented pattern covers it`,
                    'Add it to that service’s row in the ownership table. An undocumented channel is one nobody knows is part of the API.',
                );
            }
        }
    }

    // ── 2/3. Both directions of the channel surface ───────────────────────────
    for (const [channel, use] of preloadChannels) {
        if (use === 'listen' && !events.has(channel)) {
            fail(
                preload,
                `listens for \`${channel}\`, which nothing sends`,
                'A listener for a channel no `webContents.send` writes never fires. The feature hangs with no error.',
            );
        } else if (use === 'call' && !handlers.has(channel)) {
            fail(
                preload,
                `calls \`${channel}\`, which has no handler`,
                'The channel name is a string in two files, checked by nothing else. `invoke` rejects with "No handler registered" the first time a user touches the feature.',
            );
        }
    }

    // ── 4. No unreachable handlers, no unreceived events ──────────────────────
    for (const [channel, owner] of handlers) {
        if (preloadChannels.get(channel) !== 'call') {
            fail(
                owner,
                `registers \`${channel}\`, which the preload never calls`,
                'Dead code that is still live attack surface — it stays callable from the renderer. knip cannot see it, because the channel is a string.',
            );
        }
    }
    for (const [channel, owner] of events) {
        if (preloadChannels.get(channel) !== 'listen') {
            fail(
                owner,
                `sends \`${channel}\`, which the preload never listens for`,
                'The push has no receiver. Whatever it was feeding stopped being wired up.',
            );
        }
    }

    // ── 5/6. One typed bridge, no passthrough ─────────────────────────────────
    const exposes = callSites(preloadCode, 'contextBridge.exposeInMainWorld(');
    for (const site of exposes) {
        if (/^\s*ipcRenderer\s*$/.test(splitTopLevel(site.args, ',')[1] ?? '')) {
            fail(
                preload,
                'exposes `ipcRenderer` itself',
                'That hands the renderer every channel at once, plus `removeAllListeners`. The allowlist becomes decoration.',
            );
        }
    }
    if (exposes.length === 0) {
        fail(
            preload,
            'never calls `contextBridge.exposeInMainWorld`',
            'With contextIsolation on, this is the only way the renderer gets an API at all.',
        );
    } else if (exposes.length > 1) {
        fail(
            preload,
            `calls exposeInMainWorld ${exposes.length} times`,
            'One bridge, one contract. A second global is a second surface that nothing types and no gate reads.',
        );
    } else {
        const exposed = (splitTopLevel(exposes[0]?.args ?? '', ',')[1] ?? '').trim();
        const typedAs = new RegExp(String.raw`:\s*${contractType}\s*=|satisfies\s+${contractType}\b`);
        const typed = /^[A-Za-z_$][\w$]*$/.test(exposed)
            ? new RegExp(String.raw`(?:const|let|var)\s+${exposed}\s*:\s*${contractType}\s*=`).test(preloadCode) ||
              new RegExp(String.raw`(?:const|let|var)\s+${exposed}\s*=[\s\S]*?satisfies\s+${contractType}\b`).test(
                  preloadCode,
              )
            : typedAs.test(exposed);
        if (!typed) {
            fail(
                preload,
                `the exposed object is not typed \`${contractType}\``,
                `Annotating it (or \`satisfies ${contractType}\`) is what ties this file to ${contract}, which the renderer's global resolves to. Without it the two sides drift and only fail at runtime.`,
            );
        }
    }
    if (!exists(contract)) {
        fail(
            contract,
            'does not exist',
            `The bridge is typed against it. Without the contract file there is nothing for the preload and the renderer to agree on.`,
        );
    } else if (!new RegExp(String.raw`\b(?:interface|type)\s+${contractType}\b`).test(read(contract))) {
        fail(
            contract,
            `declares no \`${contractType}\``,
            'The preload is typed against this name. Declare it here, or point `contractType` at the name you use.',
        );
    }

    // ── 7. Every handler validates every argument ─────────────────────────────
    for (const { rel, line, channel, fn, source } of registrations) {
        if (fn === null) {
            fail(
                `${rel}:${line}`,
                `\`${channel}\`'s handler cannot be read`,
                'Pass an inline function, or one declared in this file, so its argument checks can be read next to the channel.',
            );
            continue;
        }
        // The first parameter is Electron's event, not renderer input.
        const unchecked = fn.params
            .slice(1)
            .filter((p) => p !== '' && !p.startsWith('_') && !validates(p, fn.body, source));
        if (unchecked.length > 0) {
            fail(
                `${rel}:${line}`,
                `\`${channel}\` uses ${unchecked.map((p) => `\`${p}\``).join(', ')} without validating ${unchecked.length === 1 ? 'it' : 'them'}`,
                'TypeScript types are erased, so a declared `string` is whatever the renderer actually sent. Run it through a schema (`safeParse`) or a `typeof` check before using it — here, or in a function in this file you pass it to.',
            );
        }
    }

    // ── 8. Channel naming ─────────────────────────────────────────────────────
    for (const [channel, owner] of [...handlers, ...events]) {
        const parts = channel.split(':');
        if (parts.length !== 2) {
            fail(
                owner,
                `channel \`${channel}\` is not \`domain:action\``,
                'One colon, two parts. The domain is what groups the channel with its service; without it the surface is a flat list of names.',
            );
            continue;
        }
        const [domain = '', action = ''] = parts;
        if (!/^[a-z][a-zA-Z]*$/.test(domain)) {
            fail(
                owner,
                `channel \`${channel}\` has a non-camelCase domain`,
                'Domains are lowercase-initial camelCase (`file`, `systemPrompt`) so they sort and group predictably.',
            );
        }
        if (!/^[a-z][a-zA-Z]*$/.test(action)) {
            fail(
                owner,
                `channel \`${channel}\` has a non-camelCase action`,
                'Actions are lowercase-initial camelCase (`read`, `openExternal`).',
            );
        }
        if (action.toLowerCase().startsWith(domain.toLowerCase()) && action.length > domain.length) {
            fail(
                owner,
                `channel \`${channel}\` repeats its domain in the action`,
                `\`${domain}:${action.slice(domain.length).replace(/^./, (c: string) => c.toLowerCase())}\` says the same thing.`,
            );
        }
    }

    return {
        problems,
        counts: { handlers: handlers.size, events: events.size, preloadChannels: preloadChannels.size },
    };
}

export function checkIpcStandards({ root = REPO_ROOT, ...rest }: IpcStandardsOptions): void {
    const report = createGateReport({ name: 'IPC standards' });
    const { problems, counts } = inspectIpcStandards({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `IPC OK — ${plural(counts.handlers, 'handler')} and ${plural(counts.events, 'event')}, all documented, reachable, ` +
            `validating every argument and matched by the preload's ${plural(counts.preloadChannels, 'channel')}; one bridge, typed.`,
        notMachineChecked:
            'Whether a schema checks the RIGHT thing (a `z.string()` on a path is still a traversal parameter), whether a handler should exist at all, and whether the renderer uses the result the way the contract says.',
    });
}
