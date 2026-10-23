/**
 * The Tauri family: `larry/no-tauri-outside-bridge` through ESLint's RuleTester, then the
 * family's own wiring through the resolver. The valid cases are what a webview really has
 * beside Tauri: the bridge's own exports, a local module whose name says tauri, a property
 * that merely starts with the word.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, Linter, RuleTester } from 'eslint';
import globals from 'globals';
import ts from 'typescript-eslint';

import { larry } from '../src/eslint/index.ts';
import { tauriRules } from '../src/eslint/rules/tauri.ts';
import * as tauri from '../src/eslint/tauri/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
    languageOptions: { parser: ts.parser, sourceType: 'module', globals: globals.browser },
});

tester.run('no-tauri-outside-bridge', tauriRules['no-tauri-outside-bridge'], {
    valid: [
        "import { readFile, onFileOpened, type Unlisten } from '@/bridge/files';",
        "import { log } from '@/bridge/log';",
        // A local module is not the package, whatever it is called.
        "import { useTauriTheme } from '@/composables/tauri-apps/useTheme';",
        'const label = settings.tauriVersion; const x = { __tauriish: 1 }.__tauriish;',
        // A name the module declares itself is not the global.
        'const __TAURI__ = mock(); __TAURI__.core.invoke("x");',
    ],
    invalid: [
        { code: "import { invoke } from '@tauri-apps/api/core';", errors: [{ messageId: 'import' }] },
        { code: "import { open } from '@tauri-apps/plugin-dialog';", errors: [{ messageId: 'import' }] },
        // A type is still Tauri leaking into the app; the bridge re-exports what the app needs.
        { code: "import type { UnlistenFn } from '@tauri-apps/api/event';", errors: [{ messageId: 'import' }] },
        { code: "const { invoke } = await import('@tauri-apps/api/core');", errors: [{ messageId: 'import' }] },
        { code: "export { open } from '@tauri-apps/plugin-dialog';", errors: [{ messageId: 'import' }] },
        { code: "export * from '@tauri-apps/api/window';", errors: [{ messageId: 'import' }] },
        { code: 'window.__TAURI__.core.invoke("read_file");', errors: [{ messageId: 'global' }] },
        { code: "globalThis['__TAURI_INTERNALS__'].invoke('x');", errors: [{ messageId: 'global' }] },
        { code: "if ('__TAURI_INTERNALS__' in window) start();", errors: [{ messageId: 'global' }] },
        { code: '__TAURI__.core.invoke("read_file");', errors: [{ messageId: 'global' }] },
    ],
});

const ROOT = '/tmp/lint-config-eslint-test';
const config = (options) => larry({ preset: 'tauri', rootDir: ROOT, standards: tauri.tauriStandards(options) });

const severityOf = async (baseConfig, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    if (resolved === undefined) return 'unlinted';
    const entry = resolved.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

test('Tauri is reachable from the bridge and from nowhere else in the webview', async () => {
    const rule = 'larry/no-tauri-outside-bridge';
    assert.equal(await severityOf(config(), 'src/App.vue', rule), 2);
    assert.equal(await severityOf(config(), 'src/composables/useFile.ts', rule), 2);
    assert.equal(await severityOf(config(), 'src/bridge/files.ts', rule), 'absent');
    // A test drives the real module through Tauri's mocks, so it may import them.
    assert.equal(await severityOf(config(), 'tests/bridge/files.test.ts', rule), 'absent');
});

test('the bridge, where Rust’s rejections arrive, keeps a caught message out of what it returns', async () => {
    const rule = 'larry/no-caught-message-leak';
    assert.equal(await severityOf(config(), 'src/bridge/files.ts', rule), 2);
    assert.equal(await severityOf(config(), 'src/composables/useFile.ts', rule), 'absent');
});

test('the webview bans console in the app, not in its tests', async () => {
    assert.equal(await severityOf(config(), 'src/main.ts', 'no-console'), 2);
    assert.equal(await severityOf(config(), 'src/bridge/log.ts', 'no-console'), 2);
    assert.equal(await severityOf(config(), 'tests/App.test.ts', 'no-console'), 'absent');
});

test('Tauri tests mirror src/ in tests/, so they name their helpers freely and need no return types', async () => {
    const file = 'tests/composables/useFile.test.ts';
    assert.equal(await severityOf(config(), file, '@typescript-eslint/naming-convention'), 'absent');
    assert.equal(await severityOf(config(), file, '@typescript-eslint/explicit-function-return-type'), 'absent');
    assert.equal(
        await severityOf(config(), 'src/composables/useFile.ts', '@typescript-eslint/explicit-function-return-type'),
        2,
    );
});

test('the Tauri preset never walks src-tauri/, and lints the tool configs as Node', async () => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config(), cwd: ROOT });
    for (const file of [
        'src-tauri/target/debug/build/x.js',
        'src-tauri/gen/schemas/desktop-schema.json',
        'dist/assets/index.js',
    ])
        assert.equal(await eslint.isPathIgnored(`${ROOT}/${file}`), true, file);
    const vite = await eslint.calculateConfigForFile(`${ROOT}/vite.config.ts`);
    assert.ok('process' in vite.languageOptions.globals);
    const app = await eslint.calculateConfigForFile(`${ROOT}/src/main.ts`);
    assert.ok(!('process' in app.languageOptions.globals));
    assert.ok('document' in app.languageOptions.globals);
});

test('the gate scripts quote the deferral markers they ban, so the ban skips them', async () => {
    const rule = 'no-warning-comments';
    assert.equal(await severityOf(config(), 'scripts/check/check-refactoring.ts', rule), 0);
    assert.equal(await severityOf(config(), 'src/bridge/files.ts', rule), 2);
});

test('the Tauri locale files sit under src/i18n, like the SPA’s', async () => {
    const rule = '@intlify/vue-i18n/no-missing-keys-in-other-locales';
    assert.equal(await severityOf(config(), 'src/i18n/locales/en.json', rule), 2);
});

/** Whether `patterns` bans an import of `specifier`, asked of ESLint's own rule. */
const bans = (patterns, specifier) =>
    new Linter({ configType: 'flat' }).verify(`import x from '${specifier}';`, [
        {
            languageOptions: { sourceType: 'module' },
            rules: { 'no-restricted-imports': ['error', { patterns }] },
        },
    ]).length > 0;

test('the webview bans Node and Electron, not a local module of the same name', () => {
    const { patterns } = tauri.webviewBannedImports;
    for (const specifier of ['node:fs', 'fs/promises', 'path', 'child_process', 'electron', 'electron-log/renderer'])
        assert.ok(bans(patterns, specifier), `${specifier} should be banned`);
    for (const specifier of ['@/utils/path', './fs', '@/bridge/files', 'pathe'])
        assert.ok(!bans(patterns, specifier), `${specifier} should be allowed`);
});

test('a bridge wrapper logs a failure or returns it, never logs and rethrows', () => {
    const verify = (code) =>
        new Linter({ configType: 'flat' }).verify(code, [
            {
                languageOptions: { sourceType: 'module' },
                rules: { 'no-restricted-syntax': ['error', ...tauri.errorHandlingSelectors] },
            },
        ]).length;
    assert.equal(verify("try { read(); } catch (err) { log.error('Read failed', { err }); throw err; }"), 1);
    const handled =
        "function readNote() { try { return read(); } catch (err) { log.error('Read failed', { err }); return { success: false, error: 'X' }; } }";
    assert.equal(verify(handled), 0);
});

test('a log call keeps its message constant and logs the whole error', () => {
    const verify = (code) =>
        new Linter({ configType: 'flat' }).verify(code, [
            {
                languageOptions: { sourceType: 'module' },
                rules: { 'no-restricted-syntax': ['error', ...tauri.loggerCallSelectors] },
            },
        ]).length;
    assert.equal(verify('log.warn(`File not found: ${path}`);'), 1);
    assert.equal(verify("log.error('Save failed', { err: err.message });"), 1);
    assert.equal(verify("log.warn('File not found', { path }); log.error('Save failed', { err });"), 0);
});
