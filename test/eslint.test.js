/**
 * The ESLint base, asserted through ESLint's own config resolver rather than by
 * reading the array we just built — `calculateConfigForFile` is what actually
 * decides a rule's severity, and flat config is last-match-wins, so the order of
 * the blocks is exactly the thing worth testing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import vuePlugin from 'eslint-plugin-vue';
import ts from 'typescript-eslint';

import { larry } from '../src/eslint/index.ts';
import { PRESETS, resolvePaths } from '../src/eslint/presets.ts';
import { vueStandards } from '../src/eslint/rules/vue.ts';

const ROOT = '/tmp/lint-config-eslint-test';

/** The severity ESLint resolves for `rule` on `file`, as 0/1/2. */
const severityOf = async (config, file, rule) => {
    const eslint = new ESLint({
        overrideConfigFile: true,
        baseConfig: config,
        cwd: ROOT,
    });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

const base = (options) => larry({ preset: 'electron', rootDir: ROOT, ...options });

test('rootDir is required — tsconfigRootDir must point at the project, not this package', () => {
    assert.throws(() => larry({ preset: 'electron' }), /rootDir/);
});

test('an unknown preset fails loudly rather than silently linting nothing', () => {
    assert.throws(() => larry({ preset: 'nope', rootDir: ROOT }), /Unknown preset/);
});

test('the catch-all block cannot undo the strict block that follows it', async () => {
    // The bug this ordering exists to prevent: a trailing block with no `files`
    // matches every file and, being last, wins — downgrading the strict rules above.
    const config = base();
    assert.equal(await severityOf(config, 'src/main/index.ts', '@typescript-eslint/no-explicit-any'), 2);
    assert.equal(await severityOf(config, 'src/renderer/App.vue', '@typescript-eslint/no-explicit-any'), 2);
});

test('tests relax some strict rules, and the relaxation is what wins', async () => {
    const config = base();
    assert.equal(await severityOf(config, 'tests/thing.test.ts', '@typescript-eslint/no-non-null-assertion'), 0);
    // …but a rule nobody relaxed stays on in tests.
    assert.equal(await severityOf(config, 'tests/thing.test.ts', '@typescript-eslint/no-floating-promises'), 2);
});

test('any and unchecked casts stay banned in tests, where a fake with the wrong shape would hide behind them', async () => {
    const config = base();
    for (const rule of [
        'no-explicit-any',
        'no-unsafe-assignment',
        'no-unsafe-member-access',
        'no-unsafe-call',
        'no-unsafe-return',
        'no-unsafe-argument',
        'no-unsafe-type-assertion',
    ]) {
        assert.equal(await severityOf(config, 'tests/thing.test.ts', `@typescript-eslint/${rule}`), 2, rule);
        assert.equal(await severityOf(config, 'src/main/index.ts', `@typescript-eslint/${rule}`), 2, rule);
    }
});

test('testRules are merged after the defaults, so a project can relax one more', async () => {
    const config = base({
        testRules: { '@typescript-eslint/no-extraneous-class': 'off' },
    });
    assert.equal(await severityOf(config, 'tests/thing.test.ts', '@typescript-eslint/no-extraneous-class'), 0);
    assert.equal(await severityOf(config, 'src/main/index.ts', '@typescript-eslint/no-extraneous-class'), 2);
});

test('namingIgnores keeps naming-convention off the Electron tests and on the full-stack ones', async () => {
    const electron = larry({ preset: 'electron', rootDir: ROOT });
    const fullstack = larry({ preset: 'fullstack', rootDir: ROOT });
    assert.equal(await severityOf(electron, 'tests/thing.test.ts', '@typescript-eslint/naming-convention'), 'absent');
    assert.equal(
        await severityOf(fullstack, 'api/src/__tests__/thing.test.ts', '@typescript-eslint/naming-convention'),
        2,
    );
});

test('explicit-function-return-type applies to source and not to tests', async () => {
    const config = base();
    const rule = '@typescript-eslint/explicit-function-return-type';
    assert.equal(await severityOf(config, 'src/main/index.ts', rule), 2);
    assert.equal(await severityOf(config, 'tests/thing.test.ts', rule), 'absent');
});

test('overrides are appended after the standards, so a project has the last word', async () => {
    const config = base({
        standards: [{ files: ['src/**/*.ts'], rules: { 'no-console': 'error' } }],
        overrides: [{ files: ['src/main/debug.ts'], rules: { 'no-console': 'off' } }],
    });
    assert.equal(await severityOf(config, 'src/main/index.ts', 'no-console'), 2);
    assert.equal(await severityOf(config, 'src/main/debug.ts', 'no-console'), 0);
});

test('Prettier comes last, so the formatting rules it disables stay disabled', async () => {
    // An override that switches a formatting rule back on would be undone by Prettier —
    // which is the point: formatting is Prettier's job, not ESLint's.
    const config = base({
        overrides: [{ rules: { 'no-mixed-spaces-and-tabs': 'error' } }],
    });
    assert.equal(await severityOf(config, 'src/main/index.ts', 'no-mixed-spaces-and-tabs'), 0);
});

test('importExtensions is off unless asked for, and nodeRun flips the rule for those folders', async () => {
    assert.equal(await severityOf(base(), 'src/main/index.ts', 'import-x/extensions'), 'absent');

    const config = base({ importExtensions: { nodeRun: ['scripts/**/*.ts'] } });
    const eslint = new ESLint({
        overrideConfigFile: true,
        baseConfig: config,
        cwd: ROOT,
    });
    const inSrc = await eslint.calculateConfigForFile(`${ROOT}/src/main/index.ts`);
    const inScripts = await eslint.calculateConfigForFile(`${ROOT}/scripts/build.ts`);
    assert.equal(inSrc.rules['import-x/extensions'][1], 'never');
    assert.equal(inScripts.rules['import-x/extensions'][1], 'always');
});

test('vue: false drops the Vue plugin rather than leaving it half-configured', async () => {
    const config = larry({ preset: 'electron', rootDir: ROOT, vue: false });
    assert.equal(await severityOf(config, 'src/renderer/thing.ts', 'vue/require-v-for-key'), 'absent');
    assert.equal(await severityOf(base(), 'src/renderer/thing.ts', 'vue/require-v-for-key'), 2);
});

test('paths override the preset without having to restate the rest of it', () => {
    const paths = resolvePaths('electron', { tests: ['spec/**/*.ts'] });
    assert.deepEqual(paths.tests, ['spec/**/*.ts']);
    assert.deepEqual(paths.browser, PRESETS.electron.browser);
});

test('both presets produce a config ESLint accepts end to end', async () => {
    for (const preset of Object.keys(PRESETS)) {
        const eslint = new ESLint({
            overrideConfigFile: true,
            baseConfig: larry({ preset, rootDir: ROOT }),
            cwd: ROOT,
        });
        const resolved = await eslint.calculateConfigForFile(`${ROOT}/scripts/thing.ts`);
        assert.ok(Object.keys(resolved.rules).length > 100, `${preset} resolved too few rules`);
    }
});

test('a disable comment must name its rule and say why', async () => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: base(), cwd: ROOT });
    const ruleIds = async (code) =>
        (await eslint.lintText(code, { filePath: `${ROOT}/thing.js` }))[0].messages.map((m) => m.ruleId);

    assert.ok(
        (await ruleIds('// eslint-disable-next-line no-console\nconsole.log(1);\n')).includes(
            '@eslint-community/eslint-comments/require-description',
        ),
    );
    assert.ok(
        (await ruleIds('/* eslint-disable */\nconsole.log(1);\n')).includes(
            '@eslint-community/eslint-comments/no-unlimited-disable',
        ),
    );
    assert.ok(
        (await ruleIds('const a = 1;\n/* eslint-disable no-console -- startup banner */\nconsole.log(a);\n')).includes(
            '@eslint-community/eslint-comments/disable-enable-pair',
        ),
    );
    // At the very top, a block disable is a whole-file exception: allowed, with its reason.
    assert.ok(
        !(await ruleIds('/* eslint-disable no-console -- a CLI script */\nconsole.log(1);\n')).includes(
            '@eslint-community/eslint-comments/disable-enable-pair',
        ),
    );
    assert.deepEqual(
        (await ruleIds('// eslint-disable-next-line no-console -- startup banner\nconsole.log(1);\n')).filter((id) =>
            id?.startsWith('@eslint-community/'),
        ),
        [],
    );
});

test('a cast in a Vue template is an error, since the typed cast rule only reads <script>', async () => {
    const config = [
        ...vuePlugin.configs['flat/recommended'],
        { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } } },
        ...vueStandards({ vue: ['**/*.vue'], frontend: ['**/*.vue'] }),
    ];
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const ruleIds = async (template) =>
        (
            await eslint.lintText(
                `<script setup lang="ts">\nconst p: unknown = 1;\n</script>\n\n<template>\n    ${template}\n</template>\n`,
                {
                    filePath: `${ROOT}/src/renderer/Thing.vue`,
                },
            )
        )[0].messages.map((m) => m.ruleId);

    assert.ok((await ruleIds('<p>{{ (p as number) + 1 }}</p>')).includes('vue/no-restricted-syntax'));
    assert.ok(!(await ruleIds('<p>{{ p }}</p>')).includes('vue/no-restricted-syntax'));
});
