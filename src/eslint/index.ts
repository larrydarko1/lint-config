/**
 * The shared ESLint base: presets, globals, strict type rules, naming and test
 * relaxations. Per-area wiring (which selectors apply to which folder) stays in the
 * project's config and is passed in as `overrides`.
 */
import { rules as eslintCommentRules } from '@eslint-community/eslint-plugin-eslint-comments';
import js from '@eslint/js';
import type { ESLint, Linter } from 'eslint';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import vuePlugin from 'eslint-plugin-vue';
import globals from 'globals';
import ts from 'typescript-eslint';

import { buildStandards, type AnyFamilyStandards } from './family.ts';
import { assertLayoutExists, assertPathsExist, assertWorkspacesCovered } from './layout-guard.ts';
import {
    BASE_REQUIRED,
    fullstackLayout,
    resolveLayout,
    resolvePaths,
    type BasePaths,
    type FullstackWorkspaces,
    type LaidOutPreset,
    type LayoutOverrides,
    type PresetPaths,
} from './presets.ts';
import { larryPlugin } from './rules/larry-plugin.ts';
import { NAMING_CONVENTION } from './rules/naming.ts';

export { FAMILIES, PRESETS, FULLSTACK_WORKSPACES, fullstackLayout, resolveLayout, resolvePaths } from './presets.ts';
export { NAMING_CONVENTION } from './rules/naming.ts';

export type LarryOptions = PresetOptions & {
    /** The project root: pass `import.meta.dirname`. Required, for `tsconfigRootDir`. */
    rootDir: string;
    /**
     * Full-stack only: which workspace plays which role, merged over FULLSTACK_WORKSPACES.
     * The preset's paths and `fullstackStandards()` are both built from it, and it is held
     * to package.json's `workspaces` — one with a `src/` and no role fails the config.
     */
    workspaces?: Partial<FullstackWorkspaces>;
    /**
     * Every family but full-stack: where each of its roles lives, merged over the family's
     * layout. The preset's paths and the family's standards are both built from it, and a
     * role the standards read, or one named here, must exist. See presets.ts for the roles.
     */
    layout?: LayoutOverrides;
    /** Load the Vue plugin and parse `.vue` files. Defaults to true, and to false for the `api`, `base` and `library` presets, which assume no components. */
    vue?: boolean;
    /** Enforce import specifiers: no extension on TS/JS, but `.vue` and `.json` keep theirs. Defaults to false.*/
    importExtensions?: boolean | ImportExtensionsOptions;
    /** A dedicated tsconfig for tests (e.g. `./tsconfig.test.json`). Without it tests use the project service like everything else. */
    testProject?: string;
    /** Extra rules for test files, merged after the defaults. */
    testRules?: Linter.RulesRecord;
    /** Extra rules for all source files, merged last. */
    rules?: Linter.RulesRecord;
    /** The family's standards (security, logging, …): `apiStandards()`, `baseStandards()`, `electronStandards()`, `fullstackStandards()`, `libraryStandards()`, `spaStandards()` or `tauriStandards()`. Plain blocks are spliced in as they are. */
    standards?: Linter.Config[] | AnyFamilyStandards;
    /** The project's own blocks — the per-area `no-restricted-syntax`/`no-restricted-imports` wiring. Appended last, before Prettier. */
    overrides?: Linter.Config[];
};

/** A family with a layout assumes its paths; the base family has none, so the project names them. */
type PresetOptions =
    | {
          /** Which family's folder layout to assume. */
          preset: LaidOutPreset;
          /** Override any path set from the preset's roles, in the shared config only: the standards keep the roles' paths. See presets.ts. */
          paths?: Partial<PresetPaths>;
      }
    | {
          /** For code no other family describes: the shared config, with no layout assumed. */
          preset: 'base';
          /** Where everything is. Each of `source`, `tests`, `browser` and `node` is required, and must exist. */
          paths: BasePaths;
      };

type ImportExtensionsOptions = {
    /** Folders Node executes directly (`['scripts/**\/*.ts']`), where the specifier must name the real `.ts` file. */
    nodeRun?: string[];
};

/**
 * Rules relaxed in tests, where mocks and fixtures legitimately do what shipped code must not.
 * `any` and unchecked casts are not among them: a fake that skips the type check is how a test
 * passes against a shape the real code never has.
 */
const TEST_RELAXATIONS: Linter.RulesRecord = {
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

/** The shared ESLint flat config. See {@link LarryOptions} for what a project passes. */
export function larry(options: LarryOptions): Linter.Config[] {
    // The `as Linter.Config` casts: third-party preset types disagree with ESLint's under
    // exactOptionalPropertyTypes. ESLint validates every block at load.

    // eslint.config.js is plain JS, so `larry()` with no argument must fail readably.
    if (!options?.rootDir)
        throw new Error('larry({ rootDir }) is required — pass `import.meta.dirname` from the project.');

    const {
        preset,
        rootDir,
        workspaces = {},
        layout = {},
        paths: pathOverrides = {},
        vue: useVue = preset !== 'api' && preset !== 'base' && preset !== 'library',
        importExtensions = false,
        testProject = null,
        testRules = {},
        rules = {},
        standards = [],
        overrides = [],
    } = options;

    if (preset !== 'fullstack' && Object.keys(workspaces).length)
        throw new Error(`larry({ workspaces }) is for the full-stack preset; '${preset}' has no workspaces.`);
    if (preset === 'fullstack' && Object.keys(layout).length > 0)
        throw new Error(
            "larry({ layout }) is for the single-package presets; the full-stack preset's roles are `workspaces`.",
        );
    if (preset === 'base' && Object.keys(layout).length > 0)
        throw new Error(
            "larry({ layout }) moves a family's roles; the base preset has none, so name its globs in `paths`.",
        );
    if (typeof standards === 'function' && standards.family !== preset)
        throw new Error(`${standards.family}Standards() needs preset: '${standards.family}', not '${preset}'.`);

    // First, so an unknown preset or role is reported before the guard reads the disk for it.
    const paths = resolvePaths(preset, pathOverrides, { ...workspaces, ...layout });

    if (preset === 'fullstack') assertWorkspacesCovered(rootDir, fullstackLayout(workspaces).workspaces);
    else if (preset === 'base') assertPathsExist(rootDir, paths, BASE_REQUIRED);
    else
        assertLayoutExists(rootDir, preset, resolveLayout(preset, layout), {
            read: typeof standards === 'function' ? standards.roles : [],
            named: Object.keys(layout),
        });

    const standardBlocks =
        typeof standards === 'function' ? buildStandards(standards, { workspaces, layout, paths }) : standards;

    // Type-aware presets only reach files a tsconfig covers — locale JSON and config files are not.
    const typedOnly = (blocks: Linter.Config[]): Linter.Config[] =>
        blocks.map((block) => ({ ...block, files: paths.typedSource }));

    return [
        { ignores: paths.ignores },

        // ── Base JS and TypeScript ───────────────────────────────────────────
        js.configs.recommended,
        ...(ts.configs.recommended as Linter.Config[]),
        ...typedOnly(ts.configs.recommendedTypeChecked),
        ...typedOnly(ts.configs.strict),
        ...typedOnly(ts.configs.stylistic),

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
        // ESLint refuses an empty `files`: an API has no browser code, and a base project may have no Node code.
        ...(paths.browser.length
            ? [{ files: paths.browser, languageOptions: { globals: globals.browser } } satisfies Linter.Config]
            : []),
        ...(paths.node.length > 0
            ? [
                  {
                      files: paths.node,
                      languageOptions: { globals: globals.node, sourceType: 'module' },
                  } satisfies Linter.Config,
              ]
            : []),
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
        // First on purpose: it matches everything, and flat config is last-match-wins.
        {
            plugins: {
                'larry': larryPlugin as unknown as ESLint.Plugin,
                '@eslint-community/eslint-comments': { rules: eslintCommentRules },
            },
            rules: {
                '@eslint-community/eslint-comments/require-description': 'error',
                '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
                '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
                '@eslint-community/eslint-comments/no-unused-enable': 'error',
                '@eslint-community/eslint-comments/no-duplicate-disable': 'error',
                '@eslint-community/eslint-comments/no-aggregating-enable': 'error',
                // `x != null` is the one loose comparison worth keeping: it means "null or undefined".
                'eqeqeq': ['error', 'always', { null: 'ignore' }],
                'array-callback-return': 'error',
                'no-self-compare': 'error',
                'no-template-curly-in-string': 'error',
                'no-unmodified-loop-condition': 'error',
                'no-unreachable-loop': 'error',
                'no-constructor-return': 'error',
                'no-new-func': 'error',
                'no-implicit-coercion': 'error',
                'no-param-reassign': 'error',
                'radix': 'error',
                'object-shorthand': 'error',
                'prefer-template': 'error',
                'no-useless-call': 'error',
                'no-useless-computed-key': 'error',
                'no-useless-concat': 'error',
                'no-useless-rename': 'error',
                'no-useless-return': 'error',
                // A leading `_` marks a binding unused on purpose, typed or not: an omitted key in a rest pattern.
                '@typescript-eslint/no-unused-vars': [
                    'error',
                    {
                        argsIgnorePattern: '^_',
                        varsIgnorePattern: '^_',
                        caughtErrorsIgnorePattern: '^_',
                    },
                ],
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
                '@typescript-eslint/no-unsafe-type-assertion': 'error',
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
                // Dead logic that looks alive: a ternary whose condition can only go one way, a `??`
                // whose left side is never (or always) nullish. Only as honest as the types — a value
                // typed on trust at a boundary gets its real guard reported as unnecessary. Type predicates
                // are left alone: `hasValue(s)` on a string still rejects '', which `value is string` cannot say.
                '@typescript-eslint/no-unnecessary-condition': [
                    'error',
                    { allowConstantLoopConditions: 'only-allowed-literals' },
                ],
                // The rest of strictTypeChecked and stylisticTypeChecked, by name rather than by preset: the
                // presets also tighten restrict-template-expressions to reject `${count}`, which is not wanted.
                '@typescript-eslint/no-deprecated': 'error',
                '@typescript-eslint/no-misused-spread': 'error',
                '@typescript-eslint/no-mixed-enums': 'error',
                '@typescript-eslint/no-generated-empty-object-type': 'error',
                '@typescript-eslint/no-meaningless-void-operator': 'error',
                '@typescript-eslint/no-useless-default-assignment': 'error',
                '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
                '@typescript-eslint/no-unnecessary-template-expression': 'error',
                '@typescript-eslint/no-unnecessary-type-arguments': 'error',
                '@typescript-eslint/no-unnecessary-type-conversion': 'error',
                '@typescript-eslint/no-unnecessary-type-parameters': 'error',
                '@typescript-eslint/prefer-reduce-type-parameter': 'error',
                '@typescript-eslint/prefer-return-this-type': 'error',
                '@typescript-eslint/related-getter-setter-pairs': 'error',
                '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
                // A `.catch((err: Error) => …)` annotation is a cast: a promise can reject with anything.
                '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
                // `() => resolve()` is fine; `const x = log()` is the confusion worth catching.
                '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
                '@typescript-eslint/non-nullable-type-assertion-style': 'error',
                '@typescript-eslint/prefer-find': 'error',
                '@typescript-eslint/prefer-includes': 'error',
                '@typescript-eslint/prefer-nullish-coalescing': 'error',
                '@typescript-eslint/prefer-optional-chain': 'error',
                '@typescript-eslint/prefer-regexp-exec': 'error',
                '@typescript-eslint/prefer-string-starts-ends-with': 'error',
                // A switch over a union names every member, so a new one is a compile-time question. A
                // `default` counts as handling the rest — a webhook's switch picks its few events on purpose.
                '@typescript-eslint/switch-exhaustiveness-check': [
                    'error',
                    { considerDefaultExhaustiveForUnions: true },
                ],
                '@typescript-eslint/require-array-sort-compare': 'error',
                '@typescript-eslint/no-unused-private-class-members': 'error',
                '@typescript-eslint/prefer-readonly': 'error',
                '@typescript-eslint/consistent-type-exports': 'error',
                '@typescript-eslint/consistent-type-imports': [
                    'error',
                    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
                ],
                '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
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
        ...standardBlocks,
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

        prettier, // Prettier last — it switches off the formatting rules that conflict.
    ];
}

/** Bundled code omits `.ts`; code Node runs directly must name it. */
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
