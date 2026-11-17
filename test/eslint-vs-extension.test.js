/**
 * The VS Code extension family: its two rules through ESLint's RuleTester, then the
 * family's own wiring through the resolver. The valid cases are what an extension
 * really writes beside the mistakes: the async `fs`, a Disposable pushed or kept, a
 * local object whose name happens to be `vscode`.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, Linter, RuleTester } from 'eslint';
import ts from 'typescript-eslint';

import { larry } from '../src/eslint/index.ts';
import { vsExtensionRules } from '../src/eslint/rules/vs-extension.ts';
import * as extension from '../src/eslint/vs-extension/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: ts.parser, sourceType: 'module' } });

tester.run('no-sync-io', vsExtensionRules['no-sync-io'], {
    valid: [
        "import fs from 'node:fs/promises'; await fs.readFile('a');",
        "import fs from 'node:fs'; await fs.promises.readFile('a'); fs.createReadStream('a');",
        "import { execFile } from 'node:child_process'; execFile('git', ['status'], done);",
        // A module of another name is not the file system.
        "import cache from '@/lib/cache'; cache.readSync('a');",
        "const fs = makeFs(); fs.readFileSync('a');",
    ],
    invalid: [
        { code: "import { readFileSync } from 'node:fs'; readFileSync('a');", errors: [{ messageId: 'blocking' }] },
        { code: "import fs from 'fs'; fs.existsSync('a');", errors: [{ messageId: 'blocking' }] },
        { code: "import * as fs from 'node:fs'; fs['writeFileSync']('a', '');", errors: [{ messageId: 'blocking' }] },
        { code: "import fs from 'node:fs'; const { mkdirSync } = fs;", errors: [{ messageId: 'blocking' }] },
        {
            code: "import { execFileSync, spawnSync } from 'node:child_process';",
            errors: [{ messageId: 'blocking' }, { messageId: 'blocking' }],
        },
    ],
});

tester.run('no-floating-disposable', vsExtensionRules['no-floating-disposable'], {
    valid: [
        "import * as vscode from 'vscode'; context.subscriptions.push(vscode.commands.registerCommand('a.b', run));",
        "import * as vscode from 'vscode'; const saved = vscode.workspace.onDidSaveTextDocument(rerun);",
        "import * as vscode from 'vscode'; function watch() { return vscode.workspace.createFileSystemWatcher('**'); }",
        // A terminal belongs to the person: theirs to close.
        "import * as vscode from 'vscode'; vscode.window.createTerminal({ name: 'npm' }).show();",
        "import * as vscode from 'vscode'; void vscode.commands.executeCommand('setContext', 'a.b', true);",
        // Not the VS Code API, whatever it is called.
        "const vscode = fake(); vscode.commands.registerCommand('a.b', run);",
        'token.onCancellationRequested(stop);',
    ],
    invalid: [
        {
            code: "import * as vscode from 'vscode'; vscode.commands.registerCommand('a.b', run);",
            errors: [{ messageId: 'dropped', data: { method: 'registerCommand' } }],
        },
        {
            code: "import * as vscode from 'vscode'; vscode.workspace.onDidChangeConfiguration(reload);",
            errors: [{ messageId: 'dropped' }],
        },
        {
            code: "import { window } from 'vscode'; window.createOutputChannel('Log', { log: true });",
            errors: [{ messageId: 'dropped' }],
        },
        {
            code: "import * as vscode from 'vscode'; function start() { void vscode.window.registerTreeDataProvider('a.b', tree); }",
            errors: [{ messageId: 'dropped' }],
        },
    ],
});

const ROOT = '/tmp/lint-config-eslint-test';
const config = (options) =>
    larry({ preset: 'vs-extension', rootDir: ROOT, standards: extension.vsExtensionStandards(options) });

const resolved = async (file) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config(), cwd: ROOT });
    return eslint.calculateConfigForFile(`${ROOT}/${file}`);
};

const severityOf = async (file, rule) => {
    const entry = (await resolved(file))?.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

/** The messages `rule`, as `file` resolves it, reports on `code`. */
const reported = async (file, rule, code) => {
    const entry = (await resolved(file)).rules[rule];
    return new Linter({ configType: 'flat' })
        .verify(code, [
            {
                languageOptions: { parser: ts.parser, sourceType: 'module' },
                plugins: { '@typescript-eslint': ts.plugin },
                rules: { [rule]: entry },
            },
        ])
        .map((message) => message.message);
};

test('what the extension host runs is held to the host’s rules; the tests and scripts are not', async () => {
    for (const rule of ['larry/no-sync-io', 'larry/no-floating-disposable', 'no-console', 'no-restricted-properties']) {
        assert.equal(await severityOf('src/lib/runner.ts', rule), 2, rule);
        assert.equal(await severityOf('src/vscode/commands.ts', rule), 2, rule);
        assert.equal(await severityOf('tests/lib/runner.test.ts', rule), 'absent', rule);
        assert.equal(await severityOf('scripts/build.ts', rule), 'absent', rule);
    }
});

test('lib/ may not load `vscode` or the glue, though it may name a type from them', async () => {
    const rule = '@typescript-eslint/no-restricted-imports';
    assert.equal((await reported('src/lib/runner.ts', rule, "import * as vscode from 'vscode';")).length, 1);
    assert.equal((await reported('src/lib/runner.ts', rule, "import { session } from '@/vscode/session';")).length, 1);
    assert.equal((await reported('src/lib/runner.ts', rule, "import { activate } from '@/extension';")).length, 1);
    assert.deepEqual(await reported('src/lib/runner.ts', rule, "import type { Uri } from 'vscode';"), []);
    assert.deepEqual(await reported('src/lib/runner.ts', rule, "import { readKata } from '@/lib/kata';"), []);
});

test('the glue may import `vscode`, and a unit suite may not', async () => {
    assert.deepEqual(
        await reported('src/vscode/commands.ts', 'no-restricted-imports', "import * as vscode from 'vscode';"),
        [],
    );
    const suite = await reported(
        'tests/lib/runner.test.ts',
        '@typescript-eslint/no-restricted-imports',
        "import * as vscode from 'vscode';",
    );
    assert.equal(suite.length, 1);
    assert.match(suite[0], /Vitest/);
});

test('an E2E spec drives the extension through the API, never through its source', async () => {
    const rule = 'no-restricted-imports';
    assert.deepEqual(await reported('e2e/activation.spec.ts', rule, "import * as vscode from 'vscode';"), []);
    assert.equal((await reported('e2e/activation.spec.ts', rule, "import { run } from '@/lib/runner';")).length, 1);
    assert.equal(
        (await reported('e2e/activation.spec.ts', rule, "import { run } from '../src/lib/runner';")).length,
        1,
    );
    assert.equal((await reported('e2e/activation.spec.ts', rule, "import assert from 'node:assert';")).length, 1);
});

test('the source reaches its own files through the extension context, not the bundle’s path', async () => {
    const syntax = await reported('src/vscode/commands.ts', 'no-restricted-syntax', 'const dir = import.meta.dirname;');
    assert.equal(syntax.length, 1);
    assert.match(syntax[0], /extensionUri/);
    const globals = await reported('src/lib/runner.ts', 'no-restricted-globals', 'const dir = __dirname;');
    assert.match(globals[0], /extensionUri/);
    // A script runs on Node as written, so `import.meta.dirname` is right there.
    assert.deepEqual(
        await reported('scripts/build.ts', 'no-restricted-globals', 'const dir = import.meta.dirname;'),
        [],
    );
});

test('the reporter a test runner loads may be a default export when the project names it', async () => {
    const named = larry({
        preset: 'vs-extension',
        rootDir: ROOT,
        standards: extension.vsExtensionStandards({ defaultExportAllowed: ['src/reporter.ts'] }),
    });
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: named, cwd: ROOT });
    const at = async (file) => (await eslint.calculateConfigForFile(`${ROOT}/${file}`)).rules['no-restricted-exports'];
    assert.equal(await at('src/reporter.ts'), undefined);
    assert.equal((await at('src/extension.ts'))[0], 2);
});

test('the preset never walks the build or the editors the E2E suite downloads', async () => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config(), cwd: ROOT });
    for (const file of ['out/extension.cjs', '.vscode-test/vscode-darwin-1.100.0/x.js', 'coverage/x.js'])
        assert.equal(await eslint.isPathIgnored(`${ROOT}/${file}`), true, file);
    const app = await eslint.calculateConfigForFile(`${ROOT}/src/extension.ts`);
    assert.ok('process' in app.languageOptions.globals);
    assert.ok(!('document' in app.languageOptions.globals));
});

test('a log call keeps its message constant and logs the whole error', () => {
    const verify = (code) =>
        new Linter({ configType: 'flat' }).verify(code, [
            {
                languageOptions: { sourceType: 'module' },
                rules: { 'no-restricted-syntax': ['error', ...extension.loggerCallSelectors] },
            },
        ]).length;
    assert.equal(verify('log.warn(`Kata not found: ${kataId}`);'), 1);
    assert.equal(verify("log.error('Run failed', { error: error.message });"), 1);
    assert.equal(verify("log.warn('Kata not found', { kataId }); log.error('Run failed', error);"), 0);
});
