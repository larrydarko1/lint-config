/**
 * The Electron security gate against a temp repository shaped like the three
 * desktop apps: a main process with one window, its navigation and permission
 * handlers, a custom scheme and an IPC shell handler, and a renderer with
 * innerHTML widgets, a v-html binding and a RegExp built from a name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkElectronSecurity, inspectElectronSecurity } from '../src/gates/electron-security.js';

const MAIN = `import { app, BrowserWindow, ipcMain, shell, protocol, net, session } from 'electron';

let mainWindow = null;

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 800,
        webPreferences: {
            preload: path.join(import.meta.dirname, '../preload/index.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition: 'persist:app',
        },
        show: false,
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }): { action: 'deny' } => {
        if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url): void => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
        }
    });
}

function registerAppProtocol(ses): void {
    ses.protocol.handle('app', (request): Response => {
        const filePath = decodeURIComponent(new URL(request.url).pathname);
        if (!isInsideBoundary(filePath, root)) {
            return new Response('Forbidden', { status: 403 });
        }
        return net.fetch(filePath);
    });
}

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: { standard: true, secure: true, stream: true },
    },
]);

void app.whenReady().then((): void => {
    const ses = session.fromPartition('persist:app');
    registerAppProtocol(ses);
    createWindow();

    ses.setPermissionRequestHandler((_webContents, permission, callback): void => {
        if (permission !== 'media') {
            callback(false);
            return;
        }
        callback(true);
    });
    ses.setPermissionCheckHandler((_webContents, permission): boolean => {
        if (permission !== 'media') return false;
        return true;
    });

    ipcMain.handle('shell:openExternal', async (_event, url: string): Promise<boolean> => {
        if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
            try {
                await shell.openExternal(url);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    });
});
`;

const WIDGETS = `const playSvg = '<svg><polygon points="5 3 19 12 5 21"/></svg>';
const volIcon = '<svg>';
const volSvg = volIcon + '<polygon/></svg>';
const muteSvg = volIcon + '<line/></svg>';

export class EmbedWidget {
    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = \`<span class="icon">\\u{1F4CE}</span> <span>\${this.escapeHtml(this.fileName)}</span>\`;
        const btn = document.createElement('button');
        btn.innerHTML = playSvg;
        btn.innerHTML = volume === 0 ? muteSvg : volSvg;
        return wrapper;
    }
}
`;

const SEARCH = `<script setup lang="ts">
function highlight(text: string): string {
    const escaped = searchQuery.value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(\`(\${escaped})|\\\\b\${escaped}\\\\b\`, 'gi');
    return text.replace(regex, '$1');
}
</script>

<template>
    <div class="search">
        <span v-html="shape.icon"></span>
    </div>
</template>
`;

const FILES = {
    'src/main/index.ts': MAIN,
    'src/preload/index.ts':
        "import { contextBridge } from 'electron';\ncontextBridge.exposeInMainWorld('electronAPI', api);\n",
    'src/renderer/widgets.ts': WIDGETS,
    'src/renderer/SearchPanel.vue': SEARCH,
};

const OPTIONS = {
    vHtml: [
        { file: 'src/renderer/SearchPanel.vue', binding: 'shape.icon', why: 'A static SVG table in the component.' },
    ],
};

/** A repository that passes, with `files` merged over it; null deletes one. */
function tree(t, files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-electron-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries({ ...FILES, ...files })) {
        if (body === null) continue;
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return root;
}

const run = (root, options = {}) => inspectElectronSecurity({ root, ...OPTIONS, ...options });
const whats = (root, options) => run(root, options).problems.map((p) => p.what);
const files = (root, options) => run(root, options).problems.map((p) => p.file);

/** A fixture with one string replaced, asserting the fixture contained it. */
const swap = (rel, fixture, from, to) => {
    assert.ok(fixture.includes(from), `fixture does not contain: ${from}`);
    return { [rel]: fixture.replace(from, to) };
};
const main = (from, to) => swap('src/main/index.ts', MAIN, from, to);
const widgets = (from, to) => swap('src/renderer/widgets.ts', WIDGETS, from, to);
const search = (from, to) => swap('src/renderer/SearchPanel.vue', SEARCH, from, to);

const has = (list, pattern) =>
    list.some((item) => (typeof pattern === 'string' ? item === pattern : pattern.test(item)));

// ── The baseline ─────────────────────────────────────────────────────────────

test('a repository that satisfies every rule passes', (t) => {
    assert.deepEqual(whats(tree(t)), []);
});

test('the counts are what the tree holds', (t) => {
    assert.deepEqual(run(tree(t)).counts, { windows: 1, schemes: 1, innerHtml: 3, vHtml: 1, regexps: 1 });
});

test('a missing main directory is one problem, not a crash', (t) => {
    const root = tree(t, { 'src/main/index.ts': null });
    assert.deepEqual(whats(root), ['does not exist']);
});

// ── 1/2/3. webPreferences ────────────────────────────────────────────────────

for (const [from, to, pattern] of [
    ['            contextIsolation: true,\n', '', /missing `contextIsolation: true`/],
    ['contextIsolation: true', 'contextIsolation: false', /sets `contextIsolation: false`, not `true`/],
    ['nodeIntegration: false', 'nodeIntegration: true', /sets `nodeIntegration: true`, not `false`/],
    ['            sandbox: true,\n', '', /missing `sandbox: true`/],
    ['sandbox: true', 'sandbox: !isDev', /sets `sandbox: !isDev`, not `true`/],
]) {
    test(`webPreferences: ${pattern.source}`, (t) => {
        assert.ok(has(whats(tree(t, main(from, to))), pattern));
    });
}

for (const key of [
    'webviewTag',
    'allowRunningInsecureContent',
    'experimentalFeatures',
    'enableRemoteModule',
    'nodeIntegrationInWorker',
    'nodeIntegrationInSubFrames',
]) {
    test(`webPreferences: ${key}: true is banned`, (t) => {
        const root = tree(
            t,
            main('            sandbox: true,\n', `            sandbox: true,\n            ${key}: true,\n`),
        );
        assert.ok(has(whats(root), `webPreferences sets \`${key}: true\``));
    });
}

test('webPreferences: webSecurity: false is banned, webSecurity: true is not', (t) => {
    const off = tree(t, main('sandbox: true,', 'sandbox: true,\n            webSecurity: false,'));
    assert.ok(has(whats(off), 'webPreferences sets `webSecurity: false`'));
    const on = tree(t, main('sandbox: true,', 'sandbox: true,\n            webSecurity: true,'));
    assert.deepEqual(whats(on), []);
});

test('a window with no preload fails', (t) => {
    const root = tree(t, main("            preload: path.join(import.meta.dirname, '../preload/index.cjs'),\n", ''));
    assert.ok(has(whats(root), 'declares no `preload`'));
});

test('no BrowserWindow at all fails rather than reading nothing', (t) => {
    const root = tree(t, main('new BrowserWindow(', 'makeWindow('));
    assert.ok(has(whats(root), /no `new BrowserWindow/));
});

test('options passed as a variable cannot be read, and say so', (t) => {
    const root = tree(
        t,
        main(/new BrowserWindow\(\{[\s\S]*?\n {4}\}\);/.exec(MAIN)[0], 'new BrowserWindow(windowOptions);'),
    );
    assert.ok(has(whats(root), /passes its options as a variable/));
});

test('webPreferences passed as a variable cannot be read, and say so', (t) => {
    const block = /webPreferences: \{[\s\S]*?\n {8}\},/.exec(MAIN)[0];
    const root = tree(t, main(block, 'webPreferences: prefs,'));
    assert.ok(has(whats(root), /passes webPreferences as a variable/));
});

test('THE INDENTATION TRAP: a window built at the top level is still read', (t) => {
    // The copies ended the block on `\n    })` — four spaces of that day's indentation.
    const top = `const win = new BrowserWindow({
    webPreferences: { preload: 'p.cjs', nodeIntegration: true, contextIsolation: true, sandbox: true },
});
`;
    const root = tree(t, { 'src/main/window.ts': top });
    assert.ok(has(whats(root), /sets `nodeIntegration: true`/));
    assert.ok(files(root).includes('src/main/window.ts:1'));
});

test('a second window is checked on its own, at its own line', (t) => {
    const about = `export const about = () =>
    new BrowserWindow({
        webPreferences: { preload: 'p.cjs', nodeIntegration: false, contextIsolation: true },
    });
`;
    const root = tree(t, { 'src/main/about.ts': about });
    assert.deepEqual(
        run(root).problems.map((p) => `${p.file} ${p.what}`),
        ['src/main/about.ts:2 webPreferences is missing `sandbox: true`'],
    );
});

test('a key nested elsewhere in the options is not read as a webPreference', (t) => {
    const root = tree(t, main('        show: false,', '        show: false,\n        extra: { sandbox: false },'));
    assert.deepEqual(whats(root), []);
});

test('a commented-out window in the main process is not read', (t) => {
    const root = tree(t, {
        'src/main/old.ts': '// new BrowserWindow({ webPreferences: { nodeIntegration: true } })\nexport {};\n',
    });
    assert.deepEqual(whats(root), []);
});

// ── 4/5/6. Navigation ────────────────────────────────────────────────────────

test('no setWindowOpenHandler fails', (t) => {
    const block = /\n {4}mainWindow\.webContents\.setWindowOpenHandler[\s\S]*?\n {4}\}\);/.exec(MAIN)[0];
    assert.ok(has(whats(tree(t, main(block, ''))), 'registers no `setWindowOpenHandler`'));
});

test('THE TYPE TRAP: a handler annotated deny that returns allow fails', (t) => {
    const root = tree(t, main("return { action: 'deny' };", "return { action: 'allow' };"));
    assert.ok(has(whats(root), "setWindowOpenHandler returns `action: 'allow'`"));
});

test('a handler that allows some URLs and denies the rest still fails', (t) => {
    const root = tree(
        t,
        main(
            "        return { action: 'deny' };",
            "        if (url === 'about:blank') return { action: 'allow' };\n        return { action: 'deny' };",
        ),
    );
    assert.ok(has(whats(root), "setWindowOpenHandler returns `action: 'allow'`"));
});

test('an expression-bodied deny passes', (t) => {
    const block = /mainWindow\.webContents\.setWindowOpenHandler[\s\S]*?\n {4}\}\);/.exec(MAIN)[0];
    const root = tree(t, main(block, "mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));"));
    assert.deepEqual(whats(root), []);
});

test('a handler with no return at all fails', (t) => {
    const root = tree(t, main("        return { action: 'deny' };\n", ''));
    assert.ok(has(whats(root), "setWindowOpenHandler does not return `action: 'deny'`"));
});

test('no will-navigate handler fails', (t) => {
    const root = tree(t, main("'will-navigate'", "'did-navigate'"));
    assert.ok(has(whats(root), 'has no `will-navigate` handler'));
});

test('a will-navigate handler that never cancels fails', (t) => {
    const root = tree(t, main('event.preventDefault();', "console.log('leaving');"));
    assert.ok(has(whats(root), /never calls `preventDefault\(\)`/));
});

test('preventDefault on something other than its own event does not count', (t) => {
    const root = tree(t, main('event.preventDefault();', 'otherEvent.preventDefault();'));
    assert.ok(has(whats(root), /never calls `preventDefault\(\)`/));
});

test('the event parameter can be called anything', (t) => {
    const renamed = MAIN.replace("'will-navigate', (event, url)", "'will-navigate', (e, url)").replace(
        'event.preventDefault()',
        'e.preventDefault()',
    );
    assert.deepEqual(whats(tree(t, { 'src/main/index.ts': renamed })), []);
});

test("a 'new-window' handler fails: it never fires", (t) => {
    const root = tree(
        t,
        main(
            '    registerAppProtocol(ses);',
            "    registerAppProtocol(ses);\n    mainWindow.webContents.on('new-window', (e) => e.preventDefault());",
        ),
    );
    assert.ok(has(whats(root), "registers a 'new-window' handler"));
});

// ── 7. Permissions ───────────────────────────────────────────────────────────

test('missing permission handlers fail, each by name', (t) => {
    const without = MAIN.replace('setPermissionRequestHandler(', 'x(').replace('setPermissionCheckHandler(', 'y(');
    const list = whats(tree(t, { 'src/main/index.ts': without }));
    assert.ok(has(list, 'registers no `setPermissionRequestHandler`'));
    assert.ok(has(list, 'registers no `setPermissionCheckHandler`'));
});

test('a request handler that never calls back false fails', (t) => {
    const root = tree(t, main('            callback(false);', '            callback(true);'));
    assert.ok(has(whats(root), '`setPermissionRequestHandler` has no deny path'));
});

test('the callback is read by its parameter position, whatever it is named', (t) => {
    const renamed = MAIN.replace('(_webContents, permission, callback): void', '(_webContents, permission, done): void')
        .replace('callback(false);', 'done(false);')
        .replace('callback(true);', 'done(true);');
    assert.deepEqual(whats(tree(t, { 'src/main/index.ts': renamed })), []);
});

test('a check handler that never returns false fails', (t) => {
    const root = tree(t, main("if (permission !== 'media') return false;", "if (permission !== 'media') return true;"));
    assert.ok(has(whats(root), '`setPermissionCheckHandler` has no deny path'));
});

test('an expression-bodied check handler returning false passes', (t) => {
    const block = /ses\.setPermissionCheckHandler[\s\S]*?\n {4}\}\);/.exec(MAIN)[0];
    assert.deepEqual(whats(tree(t, main(block, 'ses.setPermissionCheckHandler(() => false);'))), []);
});

test('a null handler restores the default and fails', (t) => {
    const block = /ses\.setPermissionCheckHandler[\s\S]*?\n {4}\}\);/.exec(MAIN)[0];
    assert.ok(
        has(
            whats(tree(t, main(block, 'ses.setPermissionCheckHandler(null);'))),
            '`setPermissionCheckHandler` has no deny path',
        ),
    );
});

// ── 8/9. Custom protocols ────────────────────────────────────────────────────

test('a scheme handler with no boundary check fails', (t) => {
    const root = tree(t, main('!isInsideBoundary(filePath, root)', "filePath.includes('..')"));
    assert.ok(has(whats(root), 'the `app://` handler does not check that the path is inside its root'));
});

test('a scheme handler that never refuses with 403 fails', (t) => {
    const root = tree(t, main('status: 403', 'status: 200'));
    assert.ok(has(whats(root), 'the `app://` handler never returns 403'));
});

test('EVERY scheme is read, not just the first', (t) => {
    const second = `export function registerMedia(ses): void {
    ses.protocol.handle('media', (request): Response => net.fetch(request.url));
}
`;
    const list = whats(tree(t, { 'src/main/media.ts': second }));
    assert.ok(has(list, 'the `media://` handler does not check that the path is inside its root'));
    assert.ok(has(list, 'the `media://` handler never returns 403'));
});

test('a boundary check in the NEXT function does not count', (t) => {
    const second = `export function registerMedia(ses): void {
    ses.protocol.handle('media', (request): Response => net.fetch(request.url));
}

export function other(p): Response {
    if (!isInsideBoundary(p, root)) return new Response('', { status: 403 });
}
`;
    assert.ok(has(whats(tree(t, { 'src/main/media.ts': second })), /`media:\/\/` handler does not check/));
});

for (const api of ['registerFileProtocol', 'registerBufferProtocol', 'interceptFileProtocol']) {
    test(`the deprecated ${api} fails`, (t) => {
        const root = tree(t, { 'src/main/old.ts': `protocol.${api}('app', (req, cb) => cb({ path: req.url }));\n` });
        assert.ok(has(whats(root), `uses the deprecated \`${api}\``));
    });
}

test('bypassCSP: true on a privileged scheme fails', (t) => {
    const root = tree(t, main('stream: true }', 'stream: true, bypassCSP: true }'));
    assert.ok(has(whats(root), 'a privileged scheme sets `bypassCSP: true`'));
});

test('bypassCSP: false passes', (t) => {
    assert.deepEqual(whats(tree(t, main('stream: true }', 'stream: true, bypassCSP: false }'))), []);
});

// ── 10. shell.openExternal ───────────────────────────────────────────────────

test('an unguarded openExternal fails', (t) => {
    const root = tree(
        t,
        main(
            "if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);",
            'void shell.openExternal(url);',
        ),
    );
    assert.ok(has(whats(root), /calls shell\.openExternal\(url\) with no http\/https check/));
});

test('THE NEIGHBOUR TRAP: a guard in the previous function does not count', (t) => {
    // The copies accepted `https?://` anywhere in the 400 characters before the call.
    const code = `export function isWeb(url: string): boolean {
    return url.startsWith('https://');
}

export function open(url: string): void {
    void shell.openExternal(url);
}
`;
    assert.ok(has(whats(tree(t, { 'src/main/links.ts': code })), /calls shell\.openExternal\(url\)/));
});

test('THE OUTER-FUNCTION TRAP: a guard outside the arrow that makes the call does not count', (t) => {
    // The arrow is its own function: the outer `url` check is about a different value.
    const code = `export function wire(win, url: string): void {
    if (url.startsWith('https://')) console.log('ok');
    win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });
}
`;
    assert.ok(has(whats(tree(t, { 'src/main/links.ts': code })), /calls shell\.openExternal\(url\)/));
});

test('a guard around the call in an enclosing if and try counts', (t) => {
    // The IPC handler in the fixture: `if (…startsWith('https://')) { try { await shell.openExternal(url) } }`.
    assert.deepEqual(whats(tree(t)), []);
});

test('an early-return guard counts', (t) => {
    const code = `async function openExternal(url: string): Promise<void> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    await shell.openExternal(url);
}
`;
    assert.deepEqual(whats(tree(t, { 'src/main/links.ts': code })), []);
});

test('a URL-object protocol check counts', (t) => {
    const code = `function open(raw: string): void {
    const url = new URL(raw);
    if (url.protocol === 'https:') void shell.openExternal(url.href);
}
`;
    assert.deepEqual(whats(tree(t, { 'src/main/links.ts': code })), []);
});

test('a literal https URL needs no guard', (t) => {
    assert.deepEqual(
        whats(
            tree(t, {
                'src/main/help.ts': "export const help = () => shell.openExternal('https://example.com/help');\n",
            }),
        ),
        [],
    );
});

test('a literal file URL is not waved through', (t) => {
    const list = whats(
        tree(t, { 'src/main/help.ts': "export const help = () => shell.openExternal('file:///etc/passwd');\n" }),
    );
    assert.ok(has(list, /calls shell\.openExternal/));
});

// ── 11. HTML sinks ───────────────────────────────────────────────────────────

for (const [code, name] of [
    ["document.write('<p>' + x);", 'document.write'],
    ["document.writeln('<p>');", 'document.writeln'],
    ["el.outerHTML = '<p></p>';", 'outerHTML ='],
    ["el.insertAdjacentHTML('beforeend', '<p></p>');", 'insertAdjacentHTML'],
]) {
    test(`${name} is banned`, (t) => {
        assert.ok(has(whats(tree(t, { 'src/renderer/sink.ts': `${code}\n` })), `uses \`${name}\``));
    });
}

test('READING outerHTML is not a sink', (t) => {
    assert.deepEqual(whats(tree(t, { 'src/renderer/read.ts': 'export const html = (el) => el.outerHTML;\n' })), []);
});

test('comparing innerHTML is not an assignment', (t) => {
    assert.deepEqual(
        whats(tree(t, { 'src/renderer/read.ts': "export const empty = (el) => el.innerHTML === '';\n" })),
        [],
    );
});

test('an unescaped interpolation into innerHTML fails', (t) => {
    const root = tree(t, widgets('${this.escapeHtml(this.fileName)}', '${this.fileName}'));
    assert.ok(has(whats(root), 'assigns `this.fileName` to innerHTML without escaping'));
});

test('THE PLAIN CASE: assigning a property to innerHTML fails', (t) => {
    // The copies only looked inside template literals, so this — the bug in its simplest form — passed.
    const root = tree(t, widgets('btn.innerHTML = playSvg;', 'btn.innerHTML = note.title;'));
    assert.ok(has(whats(root), 'assigns `note.title` to innerHTML without escaping'));
});

test('a concatenation with one unescaped piece fails on that piece', (t) => {
    const root = tree(t, widgets('btn.innerHTML = playSvg;', "btn.innerHTML = '<b>' + this.escapeHtml(a) + name;"));
    assert.ok(has(whats(root), 'assigns `name` to innerHTML without escaping'));
});

test('a let can be reassigned, so it is not trusted', (t) => {
    const root = tree(t, widgets("const playSvg = '<svg>", "let playSvg = '<svg>"));
    assert.ok(has(whats(root), 'assigns `playSvg` to innerHTML without escaping'));
});

test('a const bound to input is followed and fails', (t) => {
    const root = tree(
        t,
        widgets('const playSvg = \'<svg><polygon points="5 3 19 12 5 21"/></svg>\';', 'const playSvg = location.hash;'),
    );
    assert.ok(has(whats(root), 'assigns `location.hash` to innerHTML without escaping'));
});

test('THE SIBLING TRAP: one constant reached through two branches is safe twice', (t) => {
    // volIcon feeds both muteSvg and volSvg; a shared cycle guard once reported the second.
    assert.deepEqual(whats(tree(t)), []);
});

test('a sanitizer the project names passes; the same call without it fails', (t) => {
    const root = tree(t, widgets('btn.innerHTML = playSvg;', 'btn.innerHTML = this.renderInline(cell);'));
    assert.ok(has(whats(root), 'assigns `this.renderInline(cell)` to innerHTML without escaping'));
    assert.deepEqual(whats(root, { sanitizers: [{ name: 'renderInline', why: 'Escapes first.' }] }), []);
});

test('a sanitizer only vouches for its own output, not for what is appended to it', (t) => {
    const root = tree(t, widgets('btn.innerHTML = playSvg;', 'btn.innerHTML = DOMPurify.sanitize(a) + b;'));
    assert.ok(has(whats(root), 'assigns `b` to innerHTML without escaping'));
});

test('a sanitizer call is only safe as the WHOLE value, not as the start of one', (t) => {
    const root = tree(t, widgets('btn.innerHTML = playSvg;', "btn.innerHTML = this.escapeHtml(a).replace('x', raw);"));
    assert.ok(has(whats(root), /assigns `this\.escapeHtml\(a\)\.replace/));
});

test('a sanitizer with no why fails', (t) => {
    assert.ok(
        has(
            whats(tree(t), { sanitizers: [{ name: 'renderInline', why: ' ' }] }),
            'sanitizer `renderInline` has no `why`',
        ),
    );
});

test('innerHTML += is an assignment too', (t) => {
    const root = tree(t, widgets('btn.innerHTML = playSvg;', 'btn.innerHTML += userText;'));
    assert.ok(has(whats(root), 'assigns `userText` to innerHTML without escaping'));
});

// ── 12. v-html ───────────────────────────────────────────────────────────────

test('an unlisted v-html binding fails', (t) => {
    assert.ok(has(whats(tree(t), { vHtml: [] }), /binds `shape\.icon` with v-html, and no entry vouches for it/));
});

test('A SECOND BINDING in a listed file fails: entries are per binding', (t) => {
    const root = tree(
        t,
        search(
            '<span v-html="shape.icon"></span>',
            '<span v-html="shape.icon"></span>\n        <p v-html="note.body"></p>',
        ),
    );
    assert.ok(has(whats(root), /binds `note\.body` with v-html/));
});

test('a :innerHTML binding is v-html by another name', (t) => {
    const root = tree(
        t,
        search(
            '<span v-html="shape.icon"></span>',
            '<span v-html="shape.icon"></span>\n        <p :innerHTML="note.body"></p>',
        ),
    );
    assert.ok(has(whats(root), /binds `note\.body` with v-html/));
});

test('a commented-out v-html is not a binding', (t) => {
    const root = tree(
        t,
        search(
            '<span v-html="shape.icon"></span>',
            '<span v-html="shape.icon"></span>\n        <!-- <p v-html="note.body"></p> -->',
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('a stale entry fails', (t) => {
    const root = tree(t, search('<span v-html="shape.icon"></span>', '<span>{{ shape.label }}</span>'));
    assert.ok(has(whats(root), 'is listed in `vHtml` for `shape.icon`, which it no longer binds'));
});

test('an entry with no why fails', (t) => {
    const list = whats(tree(t), { vHtml: [{ file: 'src/renderer/SearchPanel.vue', binding: 'shape.icon', why: '' }] });
    assert.ok(has(list, 'the v-html entry for `shape.icon` has no `why`'));
});

// ── 13. RegExp ───────────────────────────────────────────────────────────────

test('an unescaped interpolation into a RegExp fails', (t) => {
    const root = tree(
        t,
        search(
            "const escaped = searchQuery.value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
            'const escaped = searchQuery.value;',
        ),
    );
    assert.ok(has(whats(root), /builds a RegExp from `searchQuery\.value`/));
});

test('THE FILE-WIDE TRAP: an escape elsewhere in the file does not rescue this one', (t) => {
    // The copies accepted any `.replace(` near the declaration if the escape appeared ANYWHERE in the file.
    const code = `export const safe = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
export function find(name, text) {
    const trimmed = name.trim().replace(/\\s+/g, ' ');
    return new RegExp(\`^\${trimmed}$\`).test(text);
}
`;
    assert.ok(has(whats(tree(t, { 'src/renderer/find.ts': code })), /builds a RegExp from `name\.trim\(\)/));
});

test('an escaping helper declared in the same file counts', (t) => {
    const code = `function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}
export const find = (name: string) => new RegExp(\`^\${escapeRegExp(name)}$\`);
`;
    assert.deepEqual(whats(tree(t, { 'src/renderer/find.ts': code })), []);
});

test('concatenation and bare identifiers are read too', (t) => {
    const list = whats(
        tree(t, {
            'src/renderer/find.ts':
                "export const a = (name) => new RegExp('^' + name);\nexport const b = (pattern) => new RegExp(pattern);\n",
        }),
    );
    assert.ok(has(list, /builds a RegExp from `name`/));
    assert.ok(has(list, /builds a RegExp from `pattern`/));
});

test('literals, regex literals and another RegExp’s source are fine', (t) => {
    const code =
        "export const a = new RegExp('^x$', 'g');\nexport const b = new RegExp(/^x$/, 'g');\nexport const c = new RegExp(other.source, 'g');\n";
    assert.deepEqual(whats(tree(t, { 'src/renderer/find.ts': code })), []);
});

test('the main process is read for RegExps too', (t) => {
    assert.ok(
        has(
            whats(tree(t, { 'src/main/find.ts': 'export const a = (n) => new RegExp(`${n}`);\n' })),
            /builds a RegExp from `n`/,
        ),
    );
});

test('test files are not read', (t) => {
    const root = tree(t, {
        'src/renderer/__tests__/find.test.ts': 'const a = (n) => new RegExp(n);\nel.innerHTML = n;\n',
    });
    assert.deepEqual(whats(root), []);
});

// ── 14. TLS ──────────────────────────────────────────────────────────────────

for (const code of [
    "app.commandLine.appendSwitch('ignore-certificate-errors');",
    "app.on('certificate-error', (e, wc, url, err, cert, cb) => cb(true));",
    'ses.setCertificateVerifyProc((req, cb) => cb(0));',
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
    'const agent = new https.Agent({ rejectUnauthorized: false });',
]) {
    test(`a certificate override fails: ${code.slice(0, 40)}`, (t) => {
        assert.equal(run(tree(t, { 'src/main/net.ts': `${code}\n` })).problems.length, 1);
    });
}

test('a certificate override in the preload fails too', (t) => {
    assert.equal(
        run(tree(t, { 'src/preload/net.ts': 'const a = { rejectUnauthorized: false };\n' })).problems.length,
        1,
    );
});

test('a comment naming an override is not one', (t) => {
    assert.deepEqual(
        whats(tree(t, { 'src/main/net.ts': '// never call setCertificateVerifyProc here\nexport {};\n' })),
        [],
    );
});

// ── The printing runner ──────────────────────────────────────────────────────

test('checkElectronSecurity prints the summary and sets no failing exit code on a clean tree', (t) => {
    const root = tree(t);
    const lines = [];
    const [log, exitCode] = [console.log, process.exitCode];
    console.log = (...a) => lines.push(a.join(' '));
    try {
        checkElectronSecurity({ root, ...OPTIONS });
        assert.notEqual(process.exitCode, 1);
    } finally {
        console.log = log;
        process.exitCode = exitCode;
    }
    assert.match(lines.join('\n'), /1 window with the process-model invariants/);
    assert.match(lines.join('\n'), /3 innerHTML assignments escaped, 1 v-html binding vouched for/);
});
