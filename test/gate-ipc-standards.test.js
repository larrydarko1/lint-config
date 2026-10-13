/**
 * The IPC gate against a temp repository shaped like the three desktop apps:
 * a main entry with the ownership table and two inline handlers, two services,
 * a preload bridge, the shared contract and a renderer that uses it.
 * - Rule 9 runs the TypeScript checker, so the tree has a tsconfig. It sets `noLib` and
 * declares the one global it needs, which keeps each program to the fixture's own files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkIpcStandards, inspectIpcStandards } from '../src/gates/ipc-standards.ts';

const MAIN = `/**
 * Main process.
 *
 * IPC handler ownership:
 *   file-service   → file:*, dialog:open
 *   log-service    → log:*
 *   main (inline)  → shell:openExternal
 */
import { ipcMain, shell } from 'electron';

void app.whenReady().then((): void => {
    fileService.register(ipcMain);
    logService.register(ipcMain);

    ipcMain.handle('shell:openExternal', async (_event, url: unknown): Promise<boolean> => {
        if (typeof url !== 'string') return false;
        await shell.openExternal(url);
        return true;
    });
});
`;

const FILE = `import { type IpcMain } from 'electron';

export function register(ipc: IpcMain): void {
    ipc.handle('file:read', async (_event, rawPath: unknown): Promise<Result> => {
        const parsed = FilePathSchema.safeParse({ filePath: rawPath });
        if (!parsed.success) return { success: false, error: 'Invalid path' };
        return read(parsed.data.filePath);
    });

    ipc.handle('file:write', (_event, rawPath: unknown, rawContent: unknown): Result => {
        const parsed = FileWriteSchema.safeParse({ filePath: rawPath, content: rawContent });
        if (!parsed.success) return { success: false, error: 'Invalid' };
        return write(parsed.data);
    });

    ipc.handle('dialog:open', openDialog);
}

async function openDialog(): Promise<Result> {
    return { success: true };
}

export function notifyChanged(win): void {
    win.webContents.send('file:changed', { at: Date.now() });
}
`;

const LOG = `import { type IpcMain } from 'electron';

export function register(ipc: IpcMain): void {
    ipc.on('log:error', (_event, rawEntry: unknown): void => write('error', rawEntry));
    ipc.on('log:info', (_event, rawEntry: unknown): void => write('info', rawEntry));
}

function write(level: LogLevel, rawEntry: unknown): void {
    const parsed = LogEntrySchema.safeParse(rawEntry);
    if (!parsed.success) return;
    log[level](parsed.data.message);
}
`;

const PRELOAD = `import { contextBridge, ipcRenderer } from 'electron';

import type { ElectronAPI } from '@/schemas/electron';

const api: ElectronAPI = {
    log: {
        error: (message: string) => ipcRenderer.send('log:error', { message }),
        info: (message: string) => ipcRenderer.send('log:info', { message }),
    },
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
    openDialog: () => ipcRenderer.invoke('dialog:open'),
    onFileChanged: (cb: () => void) => ipcRenderer.on('file:changed', cb),
};

contextBridge.exposeInMainWorld('electronAPI', api);
`;

const CONTRACT = `export type ElectronAPI = {
    log: {
        error: (message: string) => void;
        info: (message: string) => void;
    };
    openExternal: (url: string) => Promise<boolean>;
    readFile: (filePath: string) => Promise<string>;
};

declare global {
    interface Window {
        electronAPI: ElectronAPI;
    }
}
`;

const RENDERER = `export function boot(): void {
    window.electronAPI.log.error('boot');
    window.electronAPI.log.info('boot');
    void window.electronAPI.openExternal('https://example.com');
    void window.electronAPI.readFile('notes.md');
}
`;

const TSCONFIG = JSON.stringify({
    compilerOptions: { strict: true, noLib: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true },
    include: ['src/renderer', 'src/schemas'],
});

const FILES = {
    'src/main/index.ts': MAIN,
    'src/main/services/file.ts': FILE,
    'src/main/services/log.ts': LOG,
    'src/preload/index.ts': PRELOAD,
    'src/schemas/electron.d.ts': CONTRACT,
    'src/renderer/env.d.ts': 'declare var window: Window;\n',
    'src/renderer/boot.ts': RENDERER,
    'tsconfig.json': TSCONFIG,
};

/** A repository that passes, with `files` merged over it; null deletes one. */
function tree(t, files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-ipc-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries({ ...FILES, ...files })) {
        if (body === null) continue;
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return root;
}

const run = (root, options = {}) => inspectIpcStandards({ root, ...options });
const whats = (root, options) => run(root, options).problems.map((p) => p.what);

const swap = (rel, fixture, from, to) => {
    assert.ok(fixture.includes(from), `fixture does not contain: ${from}`);
    return { [rel]: fixture.replace(from, to) };
};
const main = (from, to) => swap('src/main/index.ts', MAIN, from, to);
const file = (from, to) => swap('src/main/services/file.ts', FILE, from, to);
const log = (from, to) => swap('src/main/services/log.ts', LOG, from, to);
const preload = (from, to) => swap('src/preload/index.ts', PRELOAD, from, to);
const renderer = (from, to) => swap('src/renderer/boot.ts', RENDERER, from, to);

const has = (list, pattern) =>
    list.some((item) => (typeof pattern === 'string' ? item === pattern : pattern.test(item)));

// ── The baseline ─────────────────────────────────────────────────────────────

test('a repository that satisfies every rule passes', (t) => {
    assert.deepEqual(whats(tree(t)), []);
});

test('the counts are what the tree holds', (t) => {
    assert.deepEqual(run(tree(t)).counts, { handlers: 6, events: 1, preloadChannels: 7, bridgeMembers: 4 });
});

test('a missing preload or main entry is reported, not a crash', (t) => {
    assert.deepEqual(whats(tree(t, { 'src/preload/index.ts': null })), ['does not exist']);
    assert.deepEqual(whats(tree(t, { 'src/main/index.ts': null })), ['does not exist']);
});

// ── 1. Ownership table ───────────────────────────────────────────────────────

test('no ownership table fails', (t) => {
    const root = tree(t, main('IPC handler ownership:', 'IPC handlers:'));
    assert.ok(has(whats(root), 'has no "IPC handler ownership:" table in its header'));
});

test('a row for a service that does not exist fails', (t) => {
    const root = tree(t, main(' *   main (inline)', ' *   gone-service   → gone:*\n *   main (inline)'));
    const list = whats(root);
    assert.ok(has(list, 'the ownership table names `src/main/services/gone.ts`, which does not exist'));
    assert.ok(has(list, /documents `gone:\*` for gone\.ts, which registers no such channel/));
});

test('a pattern documented on the WRONG row matches nothing there', (t) => {
    // file:read exists — but file.ts registers it, not log.ts.
    const root = tree(t, main(' *   log-service    → log:*', ' *   log-service    → log:*, file:read'));
    assert.ok(has(whats(root), /documents `file:read` for log\.ts, which registers no such channel/));
});

test('a documented pattern that matches nothing fails', (t) => {
    const root = tree(t, main('file:*, dialog:open', 'file:*, dialog:open, dialog:save'));
    assert.ok(has(whats(root), /documents `dialog:save` for file\.ts, which registers no such channel/));
});

test('a channel no pattern covers fails', (t) => {
    const root = tree(t, main('file:*, dialog:open', 'file:*'));
    assert.ok(has(whats(root), '`dialog:open` is registered by file.ts but no documented pattern covers it'));
});

test('a file with no row at all fails', (t) => {
    const root = tree(t, main(' *   log-service    → log:*\n', ''));
    assert.ok(has(whats(root), /the ownership table has no row for log\.ts/));
});

test('a pattern is owned by ITS service: file:* on the log row does not cover file.ts', (t) => {
    const root = tree(t, main(' *   file-service   → file:*, dialog:open', ' *   file-service   → dialog:open'));
    assert.ok(has(whats(root), '`file:read` is registered by file.ts but no documented pattern covers it'));
});

test('the table is read from any comment indentation', (t) => {
    const root = tree(t, main(' * IPC handler ownership:', '   * IPC handler ownership:'));
    assert.deepEqual(whats(root), []);
});

// ── 2/3/4. Both directions ───────────────────────────────────────────────────

test('a preload call with no handler fails', (t) => {
    const root = tree(t, preload("ipcRenderer.invoke('dialog:open')", "ipcRenderer.invoke('dialog:pick')"));
    const list = whats(root);
    assert.ok(has(list, 'calls `dialog:pick`, which has no handler'));
    assert.ok(has(list, 'registers `dialog:open`, which the preload never calls'));
});

test('a preload listener nothing sends fails', (t) => {
    const root = tree(t, preload("ipcRenderer.on('file:changed'", "ipcRenderer.on('file:moved'"));
    const list = whats(root);
    assert.ok(has(list, 'listens for `file:moved`, which nothing sends'));
    assert.ok(has(list, 'sends `file:changed`, which the preload never listens for'));
});

test('a handler the preload only LISTENS on is still unreachable', (t) => {
    const root = tree(t, preload("ipcRenderer.invoke('dialog:open')", "ipcRenderer.on('dialog:open', () => {})"));
    assert.ok(has(whats(root), 'registers `dialog:open`, which the preload never calls'));
});

test('once, handleOnce and sendSync are part of the surface', (t) => {
    const root = tree(t, {
        ...preload("ipcRenderer.invoke('dialog:open')", "ipcRenderer.sendSync('dialog:open')"),
        ...file("ipc.handle('dialog:open', openDialog)", "ipc.handleOnce('dialog:open', openDialog)"),
    });
    assert.deepEqual(whats(root), []);
});

test('only webContents.send is an event, not any .send(', (t) => {
    const root = tree(t, file("win.webContents.send('file:changed'", "res.send('file:changed'"));
    assert.ok(has(whats(root), 'listens for `file:changed`, which nothing sends'));
});

test('a .on( on something that is not ipcMain is not a handler', (t) => {
    const root = tree(
        t,
        main(
            '    fileService.register(ipcMain);',
            "    fileService.register(ipcMain);\n    mainWindow.on('closed', () => {});",
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('a name that merely ENDS in ipcMain is not the receiver', (t) => {
    const root = tree(
        t,
        main(
            '    fileService.register(ipcMain);',
            "    fileService.register(ipcMain);\n    fakeipcMain.handle('x', () => 0);",
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('webContents.ipc handlers are part of the surface', (t) => {
    const root = tree(
        t,
        main(
            '    fileService.register(ipcMain);',
            "    fileService.register(ipcMain);\n    win.webContents.ipc.handle('shell:beep', () => 0);",
        ),
    );
    assert.ok(has(whats(root), 'registers `shell:beep`, which the preload never calls'));
});

test('the receiver is whatever the file types as IpcMain', (t) => {
    const renamed = FILE.replace('register(ipc: IpcMain)', 'register(bus: IpcMain)').replaceAll(
        'ipc.handle(',
        'bus.handle(',
    );
    assert.deepEqual(whats(tree(t, { 'src/main/services/file.ts': renamed })), []);
});

/** file.ts with its receiver typed as the project's own narrowed type. */
const REGISTRAR = FILE.replace(
    "import { type IpcMain } from 'electron';",
    "import type { IpcRegistrar } from '../ipc';",
).replace('register(ipc: IpcMain)', 'register(ipc: IpcRegistrar)');

test('a receiver typed as anything else fails per registration, naming the option', (t) => {
    const problems = run(tree(t, { 'src/main/services/file.ts': REGISTRAR })).problems.filter((p) =>
        p.what.includes('not typed as an IPC receiver'),
    );
    assert.deepEqual(
        problems.map((p) => p.what),
        ['file:read', 'file:write', 'dialog:open'].map(
            (c) => `registers \`${c}\` on \`ipc\`, which is not typed as an IPC receiver`,
        ),
    );
    assert.match(problems[0].why, /`IpcMain`, or add its type to `receiverTypes`/);
});

test('receiverTypes recognises a project’s own receiver type', (t) => {
    const root = tree(t, { 'src/main/services/file.ts': REGISTRAR });
    assert.deepEqual(whats(root, { receiverTypes: ['IpcMain', 'IpcRegistrar'] }), []);
});

test('receiverTypes replaces the default rather than adding to it', (t) => {
    assert.ok(
        has(whats(tree(t), { receiverTypes: ['IpcRegistrar'] }), /registers `log:error` on `ipc`, which is not typed/),
    );
});

test('an event-emitter .on( with a plain event name is not mistaken for an unrecognised receiver', (t) => {
    const root = tree(
        t,
        main(
            '    fileService.register(ipcMain);',
            "    fileService.register(ipcMain);\n    app.on('before-quit', () => {});\n    win.webContents.on('did-finish-load', () => {});",
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('a duplicate registration fails', (t) => {
    const root = tree(
        t,
        file(
            "    ipc.handle('dialog:open', openDialog);",
            "    ipc.handle('dialog:open', openDialog);\n    ipc.handle('file:read', openDialog);",
        ),
    );
    assert.ok(has(whats(root), 'registers `file:read`, which src/main/services/file.ts already registers'));
});

// ── 5. Passthrough and literal channels ──────────────────────────────────────

test('exposing ipcRenderer itself fails', (t) => {
    const root = tree(
        t,
        preload("exposeInMainWorld('electronAPI', api)", "exposeInMainWorld('electronAPI', ipcRenderer)"),
    );
    assert.ok(has(whats(root), 'exposes `ipcRenderer` itself'));
});

test('a variable channel in the preload fails', (t) => {
    const root = tree(
        t,
        preload(
            "    openDialog: () => ipcRenderer.invoke('dialog:open'),",
            "    openDialog: () => ipcRenderer.invoke('dialog:open'),\n    call: (channel: string) => ipcRenderer.invoke(channel),",
        ),
    );
    assert.ok(has(whats(root), 'passes `channel` as a channel name instead of a literal'));
});

test('A TEMPLATE channel in the preload fails: the copies only caught identifiers', (t) => {
    const root = tree(
        t,
        preload("ipcRenderer.send('log:error', { message })", 'ipcRenderer.send(`log:${level}`, { message })'),
    );
    assert.ok(has(whats(root), /passes `\x60log:\$\{level\}\x60` as a channel name/));
});

test('a template channel in the main process fails', (t) => {
    const root = tree(t, log("ipc.on('log:error',", 'ipc.on(`log:${level}`,'));
    assert.ok(has(whats(root), /registers a channel that is not a string literal/));
});

test('a template channel on webContents.send fails', (t) => {
    const root = tree(t, file("win.webContents.send('file:changed'", 'win.webContents.send(`file:${kind}`'));
    assert.ok(has(whats(root), /sends on a channel that is not a string literal/));
});

// ── 6. One typed bridge ──────────────────────────────────────────────────────

test('no bridge fails', (t) => {
    const root = tree(t, preload("contextBridge.exposeInMainWorld('electronAPI', api);", ''));
    assert.ok(has(whats(root), 'never calls `contextBridge.exposeInMainWorld`'));
});

test('two bridges fail', (t) => {
    const root = tree(
        t,
        preload(
            "contextBridge.exposeInMainWorld('electronAPI', api);",
            "contextBridge.exposeInMainWorld('electronAPI', api);\ncontextBridge.exposeInMainWorld('debug', dbg);",
        ),
    );
    assert.ok(has(whats(root), 'calls exposeInMainWorld 2 times'));
});

test('an untyped bridge object fails', (t) => {
    const root = tree(t, preload('const api: ElectronAPI = {', 'const api = {'));
    assert.ok(has(whats(root), 'the exposed object is not typed `ElectronAPI`'));
});

test('THE WRONG-OBJECT TRAP: an ElectronAPI annotation on something else does not count', (t) => {
    const root = tree(
        t,
        preload('const api: ElectronAPI = {', 'const unused: ElectronAPI = null as never;\nconst api = {'),
    );
    assert.ok(has(whats(root), 'the exposed object is not typed `ElectronAPI`'));
});

test('satisfies counts, on a binding or inline', (t) => {
    const bound = PRELOAD.replace('const api: ElectronAPI = {', 'const api = {').replace(
        '\n};\n\ncontextBridge',
        '\n} satisfies ElectronAPI;\n\ncontextBridge',
    );
    assert.deepEqual(whats(tree(t, { 'src/preload/index.ts': bound })), []);
});

test('a missing contract file fails, and one that does not declare the type', (t) => {
    assert.ok(has(whats(tree(t, { 'src/schemas/electron.d.ts': null })), 'does not exist'));
    assert.ok(
        has(whats(tree(t, { 'src/schemas/electron.d.ts': 'export type Other = {};\n' })), 'declares no `ElectronAPI`'),
    );
});

test('contractType renames the type everywhere it is read', (t) => {
    const renamed = {
        'src/preload/index.ts': PRELOAD.replaceAll('ElectronAPI', 'DesktopBridge'),
        'src/schemas/electron.d.ts': CONTRACT.replaceAll('ElectronAPI', 'DesktopBridge'),
    };
    assert.deepEqual(whats(tree(t, renamed), { contractType: 'DesktopBridge' }), []);
});

// ── 7. Every argument validated ──────────────────────────────────────────────

test('an unvalidated argument fails, by name', (t) => {
    const root = tree(t, main("if (typeof url !== 'string') return false;\n", ''));
    assert.ok(has(whats(root), '`shell:openExternal` uses `url` without validating it'));
});

test('ONE of two arguments unvalidated fails on that one', (t) => {
    const root = tree(t, file('{ filePath: rawPath, content: rawContent }', '{ filePath: rawPath }'));
    assert.ok(has(whats(root), '`file:write` uses `rawContent` without validating it'));
});

test('THE NEIGHBOUR TRAP: the next handler’s check does not validate this one', (t) => {
    // The copies read 2500 characters from the handler's start, straight into the next handler.
    const code = LOG.replace(
        "    ipc.on('log:error', (_event, rawEntry: unknown): void => write('error', rawEntry));",
        "    ipc.on('log:error', (_event, ...args: unknown[]): void => log.error(...args));",
    );
    assert.ok(
        has(whats(tree(t, { 'src/main/services/log.ts': code })), '`log:error` uses `args` without validating it'),
    );
});

test('an argument handed to a validating helper in the same file counts', (t) => {
    // log.ts's handlers delegate to write(), which safeParses — the baseline passes on that.
    assert.deepEqual(whats(tree(t)), []);
});

test('a helper that validates a DIFFERENT parameter does not count', (t) => {
    const root = tree(
        t,
        log(
            'function write(level: LogLevel, rawEntry: unknown): void {\n    const parsed = LogEntrySchema.safeParse(rawEntry);',
            'function write(level: LogLevel, rawEntry: unknown): void {\n    const parsed = LogEntrySchema.safeParse(level);',
        ),
    );
    assert.ok(has(whats(root), '`log:error` uses `rawEntry` without validating it'));
});

test('the argument is followed to the parameter it ARRIVES as, not another one', (t) => {
    const code = LOG.replace("write('error', rawEntry)", "write(rawEntry, 'error')").replace(
        'function write(level: LogLevel, rawEntry: unknown): void {\n    const parsed = LogEntrySchema.safeParse(rawEntry);',
        'function write(rawEntry: unknown, level: LogLevel): void {\n    const parsed = LevelSchema.safeParse(level);',
    );
    assert.ok(
        has(whats(tree(t, { 'src/main/services/log.ts': code })), '`log:error` uses `rawEntry` without validating it'),
    );
});

test('a helper that is not declared in the file does not count', (t) => {
    const root = tree(t, log("write('error', rawEntry)", "logger.write('error', rawEntry)"));
    assert.ok(has(whats(root), '`log:error` uses `rawEntry` without validating it'));
});

test('the event is not an argument, and _unused ones are not either', (t) => {
    const root = tree(
        t,
        file(
            "ipc.handle('dialog:open', openDialog)",
            "ipc.handle('dialog:open', (event, _unused) => openDialog(event))",
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('each validator form counts', (t) => {
    for (const check of [
        'Array.isArray(x)',
        "typeof x === 'number'",
        'x instanceof Uint8Array',
        '/^a$/.test(x)',
        'Schema.parse(x)',
        'Number.isInteger(x)',
    ]) {
        const root = tree(
            t,
            main("if (typeof url !== 'string') return false;", `if (!(${check.replace('x', 'url')})) return false;`),
        );
        assert.deepEqual(whats(root), [], check);
    }
});

test('a handler named by reference is read from its declaration', (t) => {
    const root = tree(
        t,
        file(
            'async function openDialog(): Promise<Result> {',
            'async function openDialog(_event, title: unknown): Promise<Result> {',
        ),
    );
    assert.ok(has(whats(root), '`dialog:open` uses `title` without validating it'));
});

test('a handler that cannot be read says so', (t) => {
    const root = tree(t, file("ipc.handle('dialog:open', openDialog)", "ipc.handle('dialog:open', dialogs.open)"));
    assert.ok(has(whats(root), "`dialog:open`'s handler cannot be read"));
});

test('a return-type annotation with braces is not mistaken for the body', (t) => {
    const root = tree(t, main('Promise<boolean> =>', 'Promise<{ ok: boolean }> =>'));
    assert.deepEqual(whats(root), []);
});

// ── 8. Naming ────────────────────────────────────────────────────────────────

for (const [channel, pattern] of [
    ['dialog-open', /is not `domain:action`/],
    ['file:read:all', /is not `domain:action`/],
    ['File:read', /non-camelCase domain/],
    ['file:Read', /non-camelCase action/],
    ['file:read_all', /non-camelCase action/],
    ['file:fileRead', /repeats its domain in the action/],
]) {
    test(`naming: ${channel}`, (t) => {
        const root = tree(t, {
            ...file("ipc.handle('file:read',", `ipc.handle('${channel}',`),
            ...preload("ipcRenderer.invoke('file:read'", `ipcRenderer.invoke('${channel}'`),
        });
        assert.ok(has(whats(root), pattern));
    });
}

test('the repeat rule names the shorter channel it should be', (t) => {
    const root = tree(t, {
        ...file("ipc.handle('file:read',", "ipc.handle('file:fileRead',"),
        ...preload("ipcRenderer.invoke('file:read'", "ipcRenderer.invoke('file:fileRead'"),
    });
    assert.ok(run(root).problems.some((p) => p.why === '`file:read` says the same thing.'));
});

// ── 9. Every bridge member used by the renderer ──────────────────────────────

const UNUSED_READ = '`readFile` is on the bridge, but nothing in src/renderer uses it';

test('a member nothing in the renderer uses fails, at its line in the contract', (t) => {
    const root = tree(t, renderer("    void window.electronAPI.readFile('notes.md');\n", ''));
    assert.deepEqual(
        run(root).problems.map((p) => [p.file, p.what]),
        [['src/schemas/electron.d.ts:7', UNUSED_READ]],
    );
});

test('a nested member is named by its dotted path', (t) => {
    const root = tree(t, renderer("    window.electronAPI.log.info('boot');\n", ''));
    assert.deepEqual(whats(root), ['`log.info` is on the bridge, but nothing in src/renderer uses it']);
});

test('THE MOCK TRAP: a use in a renderer test file does not count', (t) => {
    const root = tree(t, {
        ...renderer("    void window.electronAPI.readFile('notes.md');\n", ''),
        'src/renderer/boot.test.ts': "void window.electronAPI.readFile('notes.md');\n",
    });
    assert.deepEqual(whats(root), [UNUSED_READ]);
});

test('THE SAME-NAME TRAP: another object’s readFile is not the bridge’s', (t) => {
    const root = tree(
        t,
        renderer(
            "    void window.electronAPI.readFile('notes.md');\n",
            "    const disk = { readFile: (p: string): string => p };\n    disk.readFile('notes.md');\n",
        ),
    );
    assert.deepEqual(whats(root), [UNUSED_READ]);
});

test('a use in a type is not a use', (t) => {
    const root = tree(
        t,
        renderer(
            "    void window.electronAPI.readFile('notes.md');\n",
            '    const read: typeof window.electronAPI.readFile | null = null;\n    void read;\n',
        ),
    );
    assert.deepEqual(whats(root), [UNUSED_READ]);
});

test('uses through an alias, destructuring and a literal key all count', (t) => {
    const root = tree(t, {
        'src/renderer/boot.ts': `export function boot(): void {
    const api = window.electronAPI;
    const { log } = api;
    log.error('boot');
    const { info: say } = api.log;
    say('boot');
    void api['openExternal']('https://example.com');
    const { readFile } = window.electronAPI;
    void readFile('notes.md');
}
`,
    });
    assert.deepEqual(whats(root), []);
});

test('handing on an object counts everything under it, and nothing beside it', (t) => {
    const root = tree(t, {
        'src/renderer/boot.ts': `declare function useLogger(log: Window['electronAPI']['log']): void;

export function boot(): void {
    useLogger(window.electronAPI.log);
    void window.electronAPI.openExternal('https://example.com');
}
`,
    });
    assert.deepEqual(whats(root), [UNUSED_READ]);
});

test('handing on the whole bridge counts every member', (t) => {
    const root = tree(t, {
        'src/renderer/boot.ts': 'export const bridge = (): Window["electronAPI"] => window.electronAPI;\n',
    });
    assert.deepEqual(whats(root), []);
});

test('a .vue script block is renderer code', (t) => {
    const root = tree(t, {
        ...renderer("    void window.electronAPI.readFile('notes.md');\n", ''),
        'src/renderer/App.vue': `<template><p>notes</p></template>

<script setup lang="ts">
void window.electronAPI.readFile('notes.md');
</script>
`,
    });
    assert.deepEqual(whats(root), []);
});

test('a missing renderer directory is reported, and the option points elsewhere', (t) => {
    const moved = {
        'src/renderer/boot.ts': null,
        'src/renderer/env.d.ts': null,
        'src/app/boot.ts': RENDERER,
        'src/app/env.d.ts': 'declare var window: Window;\n',
        'tsconfig.json': TSCONFIG.replace('src/renderer', 'src/app'),
    };
    assert.deepEqual(whats(tree(t, moved)), ['does not exist']);
    assert.deepEqual(whats(tree(t, moved), { renderer: ['src/app'] }), []);
});

test('a renderer no tsconfig holds fails, rather than passing unchecked', (t) => {
    const root = tree(t, { 'tsconfig.json': null });
    assert.deepEqual(whats(root), ['no tsconfig holds a renderer file and reaches `ElectronAPI`']);
});

// ── Comments ─────────────────────────────────────────────────────────────────

test('a commented-out handler is not a handler', (t) => {
    const root = tree(
        t,
        file(
            "    ipc.handle('dialog:open', openDialog);",
            "    ipc.handle('dialog:open', openDialog);\n    // ipc.handle('file:delete', remove);",
        ),
    );
    assert.deepEqual(whats(root), []);
});

// ── The printing runner ──────────────────────────────────────────────────────

test('checkIpcStandards prints the summary and sets no failing exit code on a clean tree', (t) => {
    const root = tree(t);
    const lines = [];
    const [out, exitCode] = [console.log, process.exitCode];
    console.log = (...a) => lines.push(a.join(' '));
    try {
        checkIpcStandards({ root });
        assert.notEqual(process.exitCode, 1);
    } finally {
        console.log = out;
        process.exitCode = exitCode;
    }
    assert.match(lines.join('\n'), /6 handlers and 1 event, all documented/);
    assert.match(lines.join('\n'), /its 4 members all used by the renderer/);
});
