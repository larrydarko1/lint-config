/**
 * The family standards, asserted through ESLint's own resolver like the base in
 * eslint.test.js. Most of the rules are one implementation in src/eslint/rules given
 * each family's folders, so what is worth testing is that the folders arrive: a shared
 * rule that resolves in one family and not the other is how the two copies drifted before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, Linter } from 'eslint';

import { larry } from '../src/eslint/index.ts';
import * as electron from '../src/eslint/electron/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';

const ROOT = '/tmp/lint-config-eslint-test';

/** The rule entry ESLint resolves for `file`, or 'absent'. */
const entryOf = async (config, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    if (resolved === undefined) return 'unlinted';
    return resolved.rules[rule] ?? 'absent';
};

const severityOf = async (config, file, rule) => {
    const entry = await entryOf(config, file, rule);
    return Array.isArray(entry) ? entry[0] : entry;
};

const electronConfig = (options) =>
    larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards(options) });
const fullstackConfig = (options) =>
    larry({ preset: 'fullstack', rootDir: ROOT, standards: fullstack.fullstackStandards(options) });

test('both families export the same shared selectors, not copies of them', () => {
    const shared = [
        'bannedCryptoModules',
        'configModuleSelectors',
        'noImportMetaEnv',
        'noSingleLetterDeclaration',
        'noFileURLToPath',
        'tsSourceSelectors',
        'noStoreLibraryPatterns',
        'aliasOnlyImportPatterns',
        'functionContractsPlugin',
    ];
    for (const name of shared) assert.equal(electron[name], fullstack[name], name);
});

test('the shared rules reach each family’s own frontend', async () => {
    const rules = [
        '@intlify/vue-i18n/valid-plural-forms',
        '@intlify/vue-i18n/no-unknown-locale',
        'vue/require-typed-ref',
        'a11y/alt-text',
        'vue/no-v-html',
    ];
    for (const rule of rules) {
        assert.equal(await severityOf(electronConfig(), 'src/renderer/App.vue', rule), 2, `electron ${rule}`);
        assert.equal(await severityOf(fullstackConfig(), 'frontend/src/App.vue', rule), 2, `fullstack ${rule}`);
    }
});

test('the full-stack locale files are linted where Orchid and Mosaic keep them', async () => {
    const rule = '@intlify/vue-i18n/no-missing-keys-in-other-locales';
    assert.equal(await severityOf(fullstackConfig(), 'frontend/src/i18n/locales/en.json', rule), 2);
    assert.equal(await severityOf(electronConfig(), 'assets/locales/en.json', rule), 2);
});

test('the <i18n> block message names the folder the locales are really in', async () => {
    const entry = await entryOf(
        fullstackConfig({ i18n: { localeFiles: 'web/locales/*.json' } }),
        'frontend/src/App.vue',
        'vue/no-restricted-block',
    );
    assert.match(entry[1].message, /web\/locales\/<locale>\.json/);
});

test('customLocales lets a locale that is not a language code through', async () => {
    const config = electronConfig({ i18n: { customLocales: ['brainrot'] } });
    const entry = await entryOf(config, 'assets/locales/brainrot.json', '@intlify/vue-i18n/no-unknown-locale');
    assert.deepEqual(entry[1].locales, ['brainrot']);
});

test('i18n: false drops the i18n rules in both families', async () => {
    const rule = '@intlify/vue-i18n/no-missing-keys';
    assert.equal(await severityOf(electronConfig({ i18n: false }), 'src/renderer/App.vue', rule), 'absent');
    assert.equal(await severityOf(fullstackConfig({ i18n: false }), 'frontend/src/App.vue', rule), 'absent');
});

test('globalStylesheet defaults to the family’s and can be set in either', async () => {
    const rule = 'vue/enforce-style-attribute';
    const plainAllowed = async (config, file) => (await entryOf(config, file, rule))[1].allow.includes('plain');

    assert.equal(await plainAllowed(electronConfig(), 'src/renderer/App.vue'), true);
    assert.equal(await plainAllowed(fullstackConfig(), 'frontend/src/App.vue'), false);
    assert.equal(
        await plainAllowed(
            fullstackConfig({ html: { globalStylesheet: ['frontend/src/App.vue'] } }),
            'frontend/src/App.vue',
        ),
        true,
    );
});

test('markerFiles defaults to the family’s and can be set in either', async () => {
    const rule = 'no-warning-comments';
    assert.equal(await severityOf(electronConfig(), 'scripts/check.ts', rule), 0);
    assert.equal(await severityOf(electronConfig({ refactoring: { markerFiles: [] } }), 'scripts/check.ts', rule), 2);
    assert.equal(await severityOf(fullstackConfig(), 'eslint.config.js', rule), 0);
});

test('a declaration file may export default in both families — the *.vue shim has to', async () => {
    const rule = 'no-restricted-exports';
    assert.equal(await severityOf(electronConfig(), 'src/renderer/shims-vue.d.ts', rule), 'absent');
    assert.equal(await severityOf(fullstackConfig(), 'frontend/src/shims-vue.d.ts', rule), 'absent');
    assert.equal(await severityOf(fullstackConfig(), 'frontend/src/main.ts', rule), 2);
});

test('both families ban same-directory relative imports, not only parent ones', () => {
    const groups = electron.aliasOnlyImportPatterns.flatMap((pattern) => pattern.group);
    assert.ok(groups.includes('./*'));
    assert.ok(groups.includes('../*'));
});

/** Whether `patterns` bans an import of `specifier`, asked of ESLint's own rule. */
const bans = (patterns, specifier) =>
    new Linter({ configType: 'flat' }).verify(`import x from '${specifier}';`, [
        {
            languageOptions: { sourceType: 'module' },
            rules: { 'no-restricted-imports': ['error', { patterns }] },
        },
    ]).length > 0;

test('a package ban covers the package and its subpaths, not a local module of the same name', () => {
    const cases = [
        [
            electron.rendererBannedImports.patterns,
            ['electron', 'electron/main', 'fs/promises', 'node:fs'],
            ['@/schemas/electron', './fs', '@/utils/path'],
        ],
        [
            electron.schemasBannedImports.patterns,
            ['vue', '@vue/reactivity', 'electron-log/main'],
            ['@/renderer/vue', 'vue-demi'],
        ],
        [electron.mainBannedImports.patterns, ['vue', '@/renderer/App.vue'], ['@/main/vue-bridge']],
        [
            fullstack.sharedPackageBannedImports.patterns,
            ['mongodb', 'mongodb/lib/x', 'vue-router', '@types/express'],
            ['@/lib/mongodb', './express', 'vue-demi'],
        ],
        [fullstack.noStoreLibraryPatterns, ['pinia', 'vuex/dist/vuex'], ['@/composables/pinia']],
    ];
    for (const [patterns, banned, allowed] of cases) {
        for (const specifier of banned) assert.ok(bans(patterns, specifier), `${specifier} should be banned`);
        for (const specifier of allowed) assert.ok(!bans(patterns, specifier), `${specifier} should be allowed`);
    }
});
