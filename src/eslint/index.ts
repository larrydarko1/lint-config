/**
 * The ESLint base every project shares: the JS/TS/Vue presets, which globals apply
 * where, the strict type rules, the naming convention, and the relaxations tests get.
 *
 * What it deliberately does NOT own is the per-area wiring — which selectors apply to
 * `api/src/routes` or to `src/main`. That is genuinely shaped by the project's folders,
 * so it stays in the project's own config file and is passed in as `overrides`. The
 * selectors it composes are exported from here, so the project writes the wiring, not
 * the rules.
 */
import js from '@eslint/js';
import type { Linter } from 'eslint';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import vuePlugin from 'eslint-plugin-vue';
import globals from 'globals';
import ts from 'typescript-eslint';

import { resolvePaths, type PresetName, type PresetPaths } from './presets.ts';
import { NAMING_CONVENTION } from './rules/naming.ts';

export type ImportExtensionsOptions = {
    /**
     * Folders Node executes directly (`['scripts/**\/*.ts']`), where the specifier must name
     * the real `.ts` file.
     */
    nodeRun?: string[];
};

export type LarryOptions = {
    /** Which family's folder layout to assume. */
    preset: PresetName;
    /**
     * The project root — pass `import.meta.dirname`. Required: `tsconfigRootDir` has to point
     * at the project, and `import.meta.dirname` read from inside this package would point at
     * the package instead.
     */
    rootDir: string;
    /** Override any path set from the preset. See presets.ts. */
    paths?: Partial<PresetPaths>;
    /** Load the Vue plugin and parse `.vue` files. Defaults to true. */
    vue?: boolean;
    /**
     * Enforce import specifiers: no extension on TS/JS, but `.vue` and `.json` keep theirs.
     * Defaults to false.
     */
    importExtensions?: boolean | ImportExtensionsOptions;
    /**
     * A dedicated tsconfig for tests (Fern's `./tsconfig.test.json`). Without it tests use the
     * project service like everything else.
     */
    testProject?: string;
    /** Extra rules for test files, merged after the defaults. */
    testRules?: Linter.RulesRecord;
    /** Extra rules for all source files, merged last. */
    rules?: Linter.RulesRecord;
    /** Standards blocks (security, logging, …) to splice in. */
    standards?: Linter.Config[];
    /**
     * The project's own blocks — the per-area `no-restricted-syntax`/`no-restricted-imports`
     * wiring. Appended last, before Prettier.
     */
    overrides?: Linter.Config[];
};

/** Rules relaxed in tests, where mocks and fixtures legitimately do what shipped code must not. */
const TEST_RELAXATIONS: Linter.RulesRecord = {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/unbound-method': 'off',
    '@typescript-eslint/consistent-type-imports': 'off',
    '@typescript-eslint/strict-boolean-expressions': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-dynamic-delete': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/await-thenable': 'off',
};

/**
 * Import specifiers say exactly what the runtime resolves. A bundler strips `.ts` for you,
 * so writing it is noise; Node, running a script directly, resolves the string as written and
 * fails without it. The two blocks below encode that split.
 */
const importExtensionBlocks = (option: boolean | ImportExtensionsOptions): Linter.Config[] => {
    const { nodeRun = [] } = typeof option === 'object' ? option : {};
    return [
        {
            files: ['**/*.{ts,tsx,vue}'],
            plugins: { 'import-x': importX },
            settings: {
                'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
            },
            rules: {
                // ignorePackages skips deep package imports (e.g. 'electron-log/main.js').
                'import-x/extensions': [
                    'error',
                    'never',
                    { ignorePackages: true, pattern: { vue: 'always', json: 'always' } },
                ],
            },
        },
        ...(nodeRun.length
            ? [
                  {
                      files: nodeRun,
                      rules: {
                          'import-x/extensions': ['error', 'always', { ignorePackages: true }],
                      },
                  } satisfies Linter.Config,
              ]
            : []),
    ];
};

/** The shared ESLint flat config. See {@link LarryOptions} for what a project passes. */
export function larry(options: LarryOptions): Linter.Config[] {
    // The `as Linter.Config` casts below are where another package's preset enters the array.
    // typescript-eslint, eslint-plugin-vue and eslint-config-prettier each declare their configs
    // with their own types, which disagree with ESLint's (and with each other) under
    // exactOptionalPropertyTypes. ESLint validates every block when it loads the array.

    // Checked before anything is read from `options`: a project's eslint.config.js is plain
    // JavaScript, and `larry()` with nothing at all deserves this message, not a destructuring error.
    if (!options?.rootDir)
        throw new Error('larry({ rootDir }) is required — pass `import.meta.dirname` from the project.');

    const {
        preset,
        rootDir,
        paths: pathOverrides = {},
        vue: useVue = true,
        importExtensions = false,
        testProject = null,
        testRules = {},
        rules = {},
        standards = [],
        overrides = [],
    } = options;

    const paths = resolvePaths(preset, pathOverrides);

    // Type-aware presets only reach files a tsconfig covers — locale JSON and config files are not.
    const typedOnly = (blocks: Linter.Config[]): Linter.Config[] =>
        blocks.map((block) => ({ ...block, files: paths.typedSource }));

    return [
        { ignores: paths.ignores },

        // ── Base JS and TypeScript ───────────────────────────────────────────
        js.configs.recommended as Linter.Config,
        ...(ts.configs.recommended as Linter.Config[]),
        ...typedOnly(ts.configs.recommendedTypeChecked as Linter.Config[]),
        ...typedOnly(ts.configs.strict as Linter.Config[]),
        ...typedOnly(ts.configs.stylistic as Linter.Config[]),

        // ── Vue ──────────────────────────────────────────────────────────────
        ...(useVue ? (vuePlugin.configs['flat/recommended'] as Linter.Config[]) : []),
        ...(useVue
            ? [
                  {
                      files: ['**/*.vue'],
                      languageOptions: { parserOptions: { parser: ts.parser as Linter.Parser } },
                  } satisfies Linter.Config,
              ]
            : []),

        // ── Which globals exist where ────────────────────────────────────────
        { files: paths.browser, languageOptions: { globals: globals.browser } },
        {
            files: paths.node,
            languageOptions: { globals: globals.node, sourceType: 'module' },
        },
        ...(paths.nodeAndBrowser.length
            ? [
                  {
                      files: paths.nodeAndBrowser,
                      languageOptions: {
                          globals: { ...globals.node, ...globals.browser },
                      },
                  } satisfies Linter.Config,
              ]
            : []),

        // ── Everywhere, typed or not ─────────────────────────────────────────
        // This block is deliberately FIRST of the rule blocks. Flat config is
        // last-match-wins and this one has no `files`, so it matches everything:
        // placed after the strict block it would quietly undo it.
        {
            rules: {
                '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
                '@typescript-eslint/no-empty-object-type': 'error',
                ...(useVue
                    ? ({
                          'vue/multi-word-component-names': 'off',
                          'vue/require-v-for-key': 'error',
                      } satisfies Linter.RulesRecord)
                    : {}),
            },
        },

        // ── Typed source: the strict half ────────────────────────────────────
        {
            files: paths.typedSource,
            languageOptions: {
                parserOptions: {
                    projectService: true,
                    tsconfigRootDir: rootDir,
                    ...(useVue ? { extraFileExtensions: ['.vue'] } : {}),
                },
            },
            rules: {
                '@typescript-eslint/no-explicit-any': 'error',
                '@typescript-eslint/no-unsafe-assignment': 'error',
                '@typescript-eslint/no-unsafe-member-access': 'error',
                '@typescript-eslint/no-unsafe-call': 'error',
                '@typescript-eslint/no-unsafe-return': 'error',
                '@typescript-eslint/no-unsafe-argument': 'error',
                '@typescript-eslint/no-floating-promises': 'error',
                '@typescript-eslint/await-thenable': 'error',
                '@typescript-eslint/no-misused-promises': 'error',
                '@typescript-eslint/strict-boolean-expressions': [
                    'error',
                    {
                        allowString: false,
                        allowNumber: false,
                        allowNullableObject: false,
                    },
                ],
                '@typescript-eslint/consistent-type-imports': [
                    'error',
                    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
                ],
                '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
                '@typescript-eslint/no-unused-vars': [
                    'error',
                    {
                        argsIgnorePattern: '^_',
                        varsIgnorePattern: '^_',
                        caughtErrorsIgnorePattern: '^_',
                    },
                ],
                ...rules,
            },
        },

        // ── Naming ───────────────────────────────────────────────────────────
        {
            files: paths.typedSource,
            ...(paths.namingIgnores.length ? { ignores: paths.namingIgnores } : {}),
            rules: { '@typescript-eslint/naming-convention': NAMING_CONVENTION },
        },

        // ── The signature is the contract, so it states its return type ──────
        {
            files: paths.source,
            ignores: paths.tests,
            rules: {
                '@typescript-eslint/explicit-function-return-type': [
                    'error',
                    { allowTypedFunctionExpressions: false, allowIIFEs: true },
                ],
            },
        },

        // ── Import specifiers ────────────────────────────────────────────────
        ...(importExtensions ? importExtensionBlocks(importExtensions) : []),

        // ── The project's own standards and per-area wiring ──────────────────
        ...standards,
        ...overrides,

        // ── Tests, last, so the relaxations actually win ─────────────────────
        {
            files: paths.tests,
            languageOptions: {
                globals: globals.node,
                ...(testProject
                    ? {
                          parserOptions: {
                              projectService: false,
                              project: [testProject],
                              tsconfigRootDir: rootDir,
                          },
                      }
                    : {}),
            },
            rules: { ...TEST_RELAXATIONS, ...testRules },
        },

        // The rule modules quote their own trigger patterns, which are not camelCase.
        {
            files: paths.configFiles,
            rules: { '@typescript-eslint/naming-convention': 'off' },
        },

        prettier as Linter.Config, // Prettier last — it switches off the formatting rules that conflict.
    ];
}

export { PRESETS, resolvePaths } from './presets.ts';
export { NAMING_CONVENTION } from './rules/naming.ts';
export default larry;
