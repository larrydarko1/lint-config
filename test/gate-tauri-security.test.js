/**
 * The Tauri security gate against a temp app shaped like sprout: one window, one
 * capability named after it, the standard's CSP, and fs granted command by command.
 * Each test breaks one setting and asserts the gate names it. The traps are the ones
 * that look right: a platform file that undoes the base config, a capability that
 * exists but is not listed, and an fs preset whose name reads like a command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectTauriSecurity } from '../src/gates/tauri-security.ts';

const CONFIG = {
    productName: 'Sprout',
    version: '../package.json',
    identifier: 'dev.example.sprout',
    app: {
        windows: [{ label: 'main', title: '', width: 700, height: 640 }],
        security: {
            csp: {
                'default-src': "'self'",
                'connect-src': 'ipc: http://ipc.localhost',
                'img-src': "'self' asset: http://asset.localhost blob: data:",
            },
            devCsp: {
                'default-src': "'self'",
                'connect-src': 'ipc: http://ipc.localhost ws://localhost:1420',
                'style-src': "'self' 'unsafe-inline'",
            },
            freezePrototype: true,
            capabilities: ['main'],
        },
    },
};

const CAPABILITY = {
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'main',
    description: 'The editor window.',
    windows: ['main'],
    permissions: [
        'core:default',
        'allow-take-pending-files',
        'fs:allow-read-text-file',
        'fs:allow-write-text-file',
        'dialog:allow-open',
        'log:default',
    ],
};

/** A structured clone with `edit` applied, so each test changes one thing. */
const tweak = (value, edit) => {
    const copy = structuredClone(value);
    edit(copy);
    return copy;
};

/** Writes the app, with `files` replacing or adding to the passing baseline. */
function app(t, files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-tauri-sec-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const all = {
        'src-tauri/tauri.conf.json': CONFIG,
        'src-tauri/capabilities/main.json': CAPABILITY,
        ...files,
    };
    for (const [rel, body] of Object.entries(all)) {
        if (body === null) continue;
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
}

const whats = (root) => inspectTauriSecurity({ root }).problems.map((p) => p.what);
const config = (t, edit) => whats(app(t, { 'src-tauri/tauri.conf.json': tweak(CONFIG, edit) }));
const capability = (t, edit) => whats(app(t, { 'src-tauri/capabilities/main.json': tweak(CAPABILITY, edit) }));

test('the baseline app passes, and the counts are what it holds', (t) => {
    const { problems, counts } = inspectTauriSecurity({ root: app(t) });
    assert.deepEqual(problems, []);
    assert.deepEqual(counts, { windows: 1, capabilities: 1, permissions: 6 });
});

test('a missing config is one problem, not a crash', (t) => {
    assert.deepEqual(whats(app(t, { 'src-tauri/tauri.conf.json': null })), ['does not exist']);
});

test('a config that is not JSON says so', (t) => {
    const [what] = whats(app(t, { 'src-tauri/tauri.conf.json': '{ app: ' }));
    assert.match(what, /cannot be read as JSON/);
});

// ── The CSP ─────────────────────────────────────────────────────────────────

test('csp: null fails, and so does no csp at all', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp = null)),
        ['`app.security.csp` is `null`'],
    );
    assert.deepEqual(
        config(t, (c) => delete c.app.security.csp),
        ['`app.security.csp` is not set'],
    );
});

test("'unsafe-eval' in script-src fails, in csp and devCsp alike", (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp['script-src'] = "'self' 'unsafe-eval'")),
        ["`csp` allows `'unsafe-eval'` in `script-src`"],
    );
    assert.deepEqual(
        config(t, (c) => (c.app.security.devCsp['script-src'] = "'self' 'unsafe-inline'")),
        ["`devCsp` allows `'unsafe-inline'` in `script-src`"],
    );
});

test('with no script-src, default-src is the script policy', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp['default-src'] = "'self' https://cdn.example.com")),
        ['`csp` allows `https://cdn.example.com` in `default-src`'],
    );
});

test("devCsp's loosened style-src is not a script source", (t) => {
    // The baseline already has `'unsafe-inline'` in devCsp's style-src, and passes.
    assert.deepEqual(whats(app(t)), []);
});

test("'wasm-unsafe-eval', nonces and hashes are allowed script sources", (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp['script-src'] = "'self' 'wasm-unsafe-eval' 'sha256-abc='")),
        [],
    );
});

test('a policy written as one string is read the same way', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp = "default-src 'self'; script-src 'self' *")),
        ['`csp` allows `*` in `script-src`'],
    );
});

test('a policy with neither script-src nor default-src fails', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.csp = { 'img-src': "'self'" })),
        ['`csp` has neither `script-src` nor `default-src`'],
    );
});

// ── Flags ───────────────────────────────────────────────────────────────────

test('dangerousDisableAssetCspModification fails, as true or as a list', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.dangerousDisableAssetCspModification = ['style-src'])),
        ['sets `dangerousDisableAssetCspModification`'],
    );
});

test('withGlobalTauri: true fails', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.withGlobalTauri = true)),
        ['sets `app.withGlobalTauri: true`'],
    );
});

test('freezePrototype must be set, not just left out', (t) => {
    assert.deepEqual(
        config(t, (c) => delete c.app.security.freezePrototype),
        ['`app.security.freezePrototype` is not set'],
    );
});

test('an enabled asset protocol needs a scope, and not a wide one', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.assetProtocol = { enable: true })),
        ['`assetProtocol` is enabled with no `scope`'],
    );
    assert.deepEqual(
        config(
            t,
            (c) => (c.app.security.assetProtocol = { enable: true, scope: ['$APPDATA/thumbnails/**', '$HOME/**'] }),
        ),
        ['`assetProtocol.scope` includes `$HOME/**`'],
    );
    assert.deepEqual(
        config(t, (c) => (c.app.security.assetProtocol = { enable: true, scope: { allow: ['/**'] } })),
        ['`assetProtocol.scope` includes `/**`'],
    );
});

test('THE PLATFORM TRAP: a platform file that undoes the base config fails', (t) => {
    const root = app(t, {
        'src-tauri/tauri.linux.conf.json': {
            app: { withGlobalTauri: true, security: { csp: null, freezePrototype: false } },
        },
    });
    const problems = inspectTauriSecurity({ root }).problems;
    assert.deepEqual(
        problems.map((p) => [p.file, p.what]),
        [
            ['src-tauri/tauri.linux.conf.json', 'sets `app.security.csp` to `null`'],
            ['src-tauri/tauri.linux.conf.json', 'sets `app.withGlobalTauri: true`'],
            ['src-tauri/tauri.linux.conf.json', '`app.security.freezePrototype` is false'],
        ],
    );
});

test('a platform file that sets nothing security-related passes', (t) => {
    assert.deepEqual(whats(app(t, { 'src-tauri/tauri.macos.conf.json': { bundle: { macOS: {} } } })), []);
});

test('the version comes from package.json', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.version = '1.0.0')),
        ['`version` is `1.0.0`, not `"../package.json"`'],
    );
});

// ── The capability list ─────────────────────────────────────────────────────

test('no capability list fails: every file in the folder would be enabled', (t) => {
    assert.deepEqual(
        config(t, (c) => delete c.app.security.capabilities),
        ['`app.security.capabilities` does not list the capabilities'],
    );
});

test('a listed capability with no file, and a file nobody listed, both fail', (t) => {
    assert.deepEqual(
        config(t, (c) => (c.app.security.capabilities = ['main', 'settings'])),
        ['`app.security.capabilities` lists `settings`, which no capability file declares'],
    );
    const extra = tweak(CAPABILITY, (c) => {
        c.identifier = 'about';
        c.windows = ['about'];
    });
    assert.deepEqual(whats(app(t, { 'src-tauri/capabilities/about.json': extra })), [
        '`about` is not listed in `app.security.capabilities`',
    ]);
});

test('a capability that is not JSON says so', (t) => {
    assert.deepEqual(whats(app(t, { 'src-tauri/capabilities/extra.toml': 'identifier = "x"' })), ['is not JSON']);
});

// ── Windows ─────────────────────────────────────────────────────────────────

test('a window with no label fails', (t) => {
    assert.deepEqual(
        config(t, (c) => delete c.app.windows[0].label),
        ['`app.windows[0]` has no `label`'],
    );
});

test('a window no capability names fails', (t) => {
    assert.deepEqual(
        config(t, (c) => c.app.windows.push({ label: 'settings' })),
        ['no capability names the `settings` window'],
    );
});

test('a window two capabilities name fails, and says which', (t) => {
    const second = tweak(CAPABILITY, (c) => (c.identifier = 'extra'));
    const root = app(t, {
        'src-tauri/tauri.conf.json': tweak(CONFIG, (c) => c.app.security.capabilities.push('extra')),
        'src-tauri/capabilities/extra.json': second,
    });
    assert.ok(whats(root).includes('the `main` window is named by 2 capabilities (extra, main)'));
});

// ── Each capability ─────────────────────────────────────────────────────────

test('a wildcard window, or a second one, fails', (t) => {
    assert.deepEqual(
        capability(t, (c) => (c.windows = ['*'])),
        ['no capability names the `main` window', '`windows` is ["*"], not one window’s label'],
    );
    assert.deepEqual(
        capability(t, (c) => (c.windows = ['main', 'settings'])),
        ['`windows` is ["main","settings"], not one window’s label'],
    );
});

test('an identifier that is not the window’s label fails', (t) => {
    const root = app(t, {
        'src-tauri/tauri.conf.json': tweak(CONFIG, (c) => (c.app.security.capabilities = ['default'])),
        'src-tauri/capabilities/main.json': tweak(CAPABILITY, (c) => (c.identifier = 'default')),
    });
    assert.deepEqual(whats(root), ['`identifier` is `default`, not the window’s label `main`']);
});

test('remote fails', (t) => {
    assert.deepEqual(
        capability(t, (c) => (c.remote = { urls: ['https://*.example.com'] })),
        ['declares `remote`'],
    );
});

// ── Permissions ─────────────────────────────────────────────────────────────

test('the program runners are never granted', (t) => {
    assert.deepEqual(
        capability(t, (c) => c.permissions.push('shell:allow-execute', 'shell:allow-spawn', 'shell:allow-open')),
        ['grants `shell:allow-execute`', 'grants `shell:allow-spawn`'],
    );
});

test('opener:allow-open-path needs a scope, and a narrow one', (t) => {
    assert.deepEqual(
        capability(t, (c) => c.permissions.push('opener:allow-open-path')),
        ['grants `opener:allow-open-path` with no scope'],
    );
    assert.deepEqual(
        capability(t, (c) =>
            c.permissions.push({ identifier: 'opener:allow-open-path', allow: [{ path: '$HOME/**' }] }),
        ),
        ['scopes `opener:allow-open-path` to `$HOME/**`'],
    );
    assert.deepEqual(
        capability(t, (c) =>
            c.permissions.push({ identifier: 'opener:allow-open-path', allow: [{ path: '$DOWNLOAD/*.pdf' }] }),
        ),
        [],
    );
});

test('fs:default and the fs bundles fail: fs is granted command by command', (t) => {
    assert.deepEqual(
        capability(t, (c) => c.permissions.push('fs:default', 'fs:read-all', 'fs:write-files')),
        ['grants `fs:default`', 'grants the bundle `fs:read-all`', 'grants the bundle `fs:write-files`'],
    );
});

test('THE PRESET TRAP: an fs preset on a user directory fails; one on the app’s own passes', (t) => {
    assert.deepEqual(
        capability(t, (c) =>
            c.permissions.push(
                'fs:allow-home-read-recursive',
                'fs:scope-desktop',
                'fs:allow-appdata-write-recursive',
                'fs:scope-resource',
            ),
        ),
        ['grants `fs:allow-home-read-recursive`', 'grants `fs:scope-desktop`'],
    );
});

test('a command permission whose name starts like a directory is not a preset', (t) => {
    assert.deepEqual(
        capability(t, (c) => c.permissions.push('fs:allow-read-file', 'fs:allow-write-file', 'fs:allow-exists')),
        [],
    );
});

test('an fs scope object must stay in the app’s own directories', (t) => {
    assert.deepEqual(
        capability(t, (c) =>
            c.permissions.push({
                identifier: 'fs:scope',
                allow: [{ path: '$APPDATA/**' }, { path: '$DOCUMENT/**' }, { path: '$APPDATA/../**' }],
            }),
        ),
        ['scopes `fs:scope` to `$DOCUMENT/**`', 'scopes `fs:scope` to `$APPDATA/../**`'],
    );
});
