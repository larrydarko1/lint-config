/**
 * `larry({ layout })`: a single-package family's rules follow a role, not the folder the
 * family assumes. What is worth testing is that a moved role takes every rule the family
 * has for it — the gap this closed was a project laid out unlike its family, whose
 * family rules matched no file — and that a role pointing at nothing fails loudly
 * instead of linting less.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';

import { larry } from '../src/eslint/index.ts';
import { resolveLayout, resolvePaths } from '../src/eslint/presets.ts';
import { apiStandards } from '../src/eslint/api/index.ts';
import { electronStandards } from '../src/eslint/electron/index.ts';
import { fullstackStandards } from '../src/eslint/fullstack/index.ts';
import { libraryStandards } from '../src/eslint/library/index.ts';
import { spaStandards } from '../src/eslint/spa/index.ts';
import { tauriStandards } from '../src/eslint/tauri/index.ts';

/** No package.json here, so the guard has nothing to hold the roles to and stays out of the way. */
const ROOT = '/tmp/lint-config-layout-test';

const calculate = async (configBlocks, file) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: configBlocks, cwd: ROOT });
    return eslint.calculateConfigForFile(`${ROOT}/${file}`);
};

const severityOf = async (configBlocks, file, rule) => {
    const entry = (await calculate(configBlocks, file))?.rules[rule] ?? 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

// ── Roles ───────────────────────────────────────────────────────────────────

test('a role left out defaults from the one it sits in, and a named one wins', () => {
    assert.deepEqual(resolveLayout('electron', { src: 'app' }), {
        src: 'app',
        main: 'app/main',
        preload: 'app/preload',
        renderer: 'app/renderer',
        tests: 'tests',
        locales: 'assets/locales',
    });
    assert.equal(resolveLayout('electron', { src: 'app', main: 'backend' }).main, 'backend');
    assert.equal(resolveLayout('api', { lib: 'src/core' }).config, 'src/core/config.ts');
});

test('a role is a folder however it is written', () => {
    assert.equal(resolveLayout('spa', { src: './web/' }).src, 'web');
    assert.equal(resolveLayout('spa', { src: './web/' }).locales, 'web/i18n/locales');
});

test("the preset's paths are built from the same roles", () => {
    const paths = resolvePaths('electron', {}, { renderer: 'ui', tests: 'spec' });
    assert.deepEqual(paths.browser, ['ui/**/*.{ts,vue}']);
    assert.deepEqual(paths.vue, ['ui/**/*.vue']);
    assert.deepEqual(paths.tests, ['spec/**/*.ts', 'vitest.setup.ts']);
    assert.deepEqual(resolvePaths('library', {}, { tests: 'spec' }).tests, ['spec/**/*.{ts,js}']);
    // `paths` still has the last word on an area.
    assert.deepEqual(resolvePaths('electron', { browser: ['web/**/*.ts'] }, { renderer: 'ui' }).browser, [
        'web/**/*.ts',
    ]);
});

// ── Each family's rules follow its roles ────────────────────────────────────

test('electron: the main and preload rules move with the processes, and the renderer gets the window', async () => {
    const config = larry({
        preset: 'electron',
        rootDir: ROOT,
        layout: { src: 'app' },
        standards: electronStandards(),
    });
    for (const file of ['app/main/index.ts', 'app/preload/index.ts']) {
        assert.equal(await severityOf(config, file, 'larry/no-caught-message-leak'), 2, file);
        assert.equal(await severityOf(config, file, 'no-console'), 2, file);
    }
    assert.equal(await severityOf(config, 'src/main/index.ts', 'larry/no-caught-message-leak'), 'absent');
    const { languageOptions } = await calculate(config, 'app/renderer/main.ts');
    assert.ok('window' in languageOptions.globals);
    assert.equal(await severityOf(config, 'app/renderer/App.vue', 'vue/no-v-html'), 2);
});

test('spa: the app and its locale files move together', async () => {
    const config = larry({ preset: 'spa', rootDir: ROOT, layout: { src: 'web' }, standards: spaStandards() });
    assert.equal(await severityOf(config, 'web/main.ts', 'no-console'), 2);
    assert.equal(
        await severityOf(config, 'web/i18n/locales/en.json', '@intlify/vue-i18n/no-duplicate-keys-in-locale'),
        2,
    );
    assert.equal(await severityOf(config, 'src/main.ts', 'no-console'), 'absent');
});

test('tauri: the bridge is wherever the layout puts it', async () => {
    const config = larry({
        preset: 'tauri',
        rootDir: ROOT,
        layout: { bridge: 'src/native' },
        standards: tauriStandards(),
    });
    assert.equal(await severityOf(config, 'src/native/fs.ts', 'larry/no-caught-message-leak'), 2);
    assert.equal(await severityOf(config, 'src/native/fs.ts', 'larry/no-tauri-outside-bridge'), 'absent');
    // The old bridge folder is ordinary webview code now.
    assert.equal(await severityOf(config, 'src/bridge/fs.ts', 'larry/no-tauri-outside-bridge'), 2);
});

test('api: the config module is the one that reads process.env, wherever it is', async () => {
    const config = larry({ preset: 'api', rootDir: ROOT, layout: { config: 'src/env.ts' }, standards: apiStandards() });
    assert.equal(await severityOf(config, 'src/env.ts', 'no-process-env'), 0);
    assert.equal(await severityOf(config, 'src/lib/config.ts', 'no-process-env'), 2);
});

test('library: the no-exit rule and the suites follow src and tests', async () => {
    const config = larry({
        preset: 'library',
        rootDir: ROOT,
        layout: { src: 'lib', tests: 'spec' },
        standards: libraryStandards(),
    });
    assert.equal(await severityOf(config, 'lib/index.ts', 'no-restricted-properties'), 2);
    assert.equal(await severityOf(config, 'src/index.ts', 'no-restricted-properties'), 'absent');
    // A suite may read the environment; shipped code may not.
    assert.equal(await severityOf(config, 'spec/index.test.js', 'no-process-env'), 0);
    assert.equal(await severityOf(config, 'lib/index.ts', 'no-process-env'), 2);
});

// ── Mistakes fail the config ────────────────────────────────────────────────

test("a role the family does not have fails the config, naming the family's roles", () => {
    assert.throws(
        () => larry({ preset: 'spa', rootDir: ROOT, layout: { main: 'src/main' } }),
        /names 'main', which the spa preset has no role for\. Its roles: src, locales\./,
    );
});

test("layout is not the full-stack preset's: its roles are workspaces", () => {
    assert.throws(
        () => larry({ preset: 'fullstack', rootDir: ROOT, layout: { src: 'app' }, standards: fullstackStandards() }),
        /the full-stack preset's roles are `workspaces`/,
    );
});

test("a family's standards belong to its preset", () => {
    assert.throws(
        () => larry({ preset: 'spa', rootDir: ROOT, standards: electronStandards() }),
        /electronStandards\(\) needs preset: 'electron', not 'spa'/,
    );
});

// ── The guard ───────────────────────────────────────────────────────────────

/** A throwaway project: a package.json, and each of `paths` as a folder. */
const project = (t, paths) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-layout-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'package.json'), '{}');
    for (const dir of paths) mkdirSync(path.join(root, dir), { recursive: true });
    return root;
};

const ELECTRON = ['src/main', 'src/preload', 'src/renderer', 'assets/locales'];

test('GUARD: a role the standards read and the repository lacks fails the config, with the fix', (t) => {
    const root = project(t, ['src/main', 'src/renderer', 'assets/locales']);
    assert.throws(
        () => larry({ preset: 'electron', rootDir: root, standards: electronStandards() }),
        /looks for 'preload' at 'src\/preload', which does not exist.*layout: \{ preload: '…' \}/,
    );
    assert.doesNotThrow(() =>
        larry({ preset: 'electron', rootDir: project(t, ELECTRON), standards: electronStandards() }),
    );
});

test('GUARD: the locales role is read only while i18n is on and reads the family default', (t) => {
    const root = project(t, ['src/main', 'src/preload', 'src/renderer']);
    assert.throws(
        () => larry({ preset: 'electron', rootDir: root, standards: electronStandards() }),
        /'locales' at 'assets\/locales'/,
    );
    assert.doesNotThrow(() =>
        larry({ preset: 'electron', rootDir: root, standards: electronStandards({ i18n: false }) }),
    );
    assert.doesNotThrow(() =>
        larry({
            preset: 'electron',
            rootDir: root,
            standards: electronStandards({ i18n: { localeFiles: 'src/renderer/locales/*.json' } }),
        }),
    );
});

test('GUARD: a role the switches turn off is not read', (t) => {
    const root = project(t, ['src/routes', 'src/lib', 'src/middleware']);
    writeFileSync(path.join(root, 'src/lib/config.ts'), '');
    writeFileSync(path.join(root, 'src/middleware/error-handler.ts'), '');
    assert.throws(() => larry({ preset: 'api', rootDir: root, standards: apiStandards() }), /'dbModule'.*'gateway'/s);
    assert.doesNotThrow(() =>
        larry({ preset: 'api', rootDir: root, standards: apiStandards({ mongo: false, ws: false }) }),
    );
});

test('GUARD: a role the project names must exist, read or not', (t) => {
    const root = project(t, ELECTRON);
    assert.throws(
        () => larry({ preset: 'electron', rootDir: root, layout: { tests: 'spec' }, standards: electronStandards() }),
        /larry\(\{ layout \}\) puts 'tests' at 'spec', which does not exist/,
    );
});

test('GUARD: without the family standards nothing is read, so only named roles are held', (t) => {
    const root = project(t, ['src']);
    assert.doesNotThrow(() => larry({ preset: 'electron', rootDir: root }));
});

test('GUARD: a moved role is held at its new path', (t) => {
    const root = project(t, ['app/main', 'app/preload', 'app/renderer', 'assets/locales']);
    assert.doesNotThrow(() =>
        larry({ preset: 'electron', rootDir: root, layout: { src: 'app' }, standards: electronStandards() }),
    );
});
