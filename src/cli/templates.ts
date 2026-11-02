/**
 * The files `larry init` writes, for one family. Each is the smallest that works: the
 * shared config with what only this project knows left to its options, and every gate
 * whose options name the project's own files skipped with what it needs.
 */
import type { BasePaths, PresetName } from '../eslint/presets.ts';
import { gatesFor } from '../gates/registry.ts';
import { SELF_NAME } from '../toolchain.ts';

export type Distribution = 'open' | 'closed';

/** Where a base project's source runs: the one thing about it no file says. */
export type Runtime = 'node' | 'browser' | 'both';

type Scaffold = {
    family: PresetName;
    distribution: Distribution;
    /** What code-style reads: the source and test folders. */
    scan: string[];
    /** What duplication reads: the source folders only, since tests repeat their fixtures on purpose. */
    sources: string[];
    /** The `npm run` scripts `ci:check` and CI run, in order. */
    ciScripts: string[];
    /** The Node major CI installs: the floor of the project's engines.node. */
    nodeMajor: number;
    /** The base family only: the paths its eslint.config.js names, since it assumes none. */
    basePaths?: BasePaths;
};

/** Families with a Vue app, so they have styles to lint and templates to compare. */
export const UI_FAMILIES: readonly PresetName[] = ['electron', 'fullstack', 'spa', 'tauri'];

/**
 * A gate whose required options are paths and shapes only the project knows, and what
 * it needs. init skips each one the family runs, with this as the reason.
 */
const NEEDS: Partial<Record<string, string>> = {
    'api-standards': '`routesDir`, `indexFile`, `rateLimiters`, `tokenBucket` and `schemas`',
    'contrast': '`themes`, `text` and `backgrounds`',
    'db-drift':
        '`manifest`, `manifestSpecifier`, `typesFile`, `collectionTypes`, `bootstrap`, `architecture`, `examplesDir`, `migrationsDir`, `testsDir` and `checksums`',
    'env-drift': '`services`',
    'html-standards': '`indexHtml`',
    'i18n': '`localeDir` and `configFile`',
    'metrics': '`manifests`',
    'scss-standards': '`themes`, `styles`, `src`, `mainScript`, `viteConfigs` and `injectedSpecifier`',
    'security-drift': '`entry`, `config`, `envModule`, `backendDirs` and `auth`',
    'testing': '`config` and `layout`',
    'ws-standards': '`gateway`, `gatewayDir`, `serverDirs` and `rooms`',
};

/** actions/checkout and actions/setup-node, pinned to a commit as `pipeline` requires. */
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0';

/**
 * The Node major a project with no engines.node is written for: the newest LTS, except two
 * that cannot choose it. A library supports the oldest maintained LTS, so its consumers
 * need not move first; an electron app runs on the Node Electron bundles (24, as of
 * Electron 45). Raise each with the release that moves it.
 */
export const nodeMajorFor = (family: PresetName): number => (family === 'library' || family === 'electron' ? 24 : 26);

/** Every file init writes, keyed by its path from the repository root. */
export function scaffoldFiles(scaffold: Scaffold): Record<string, string> {
    const { family } = scaffold;
    const ui = UI_FAMILIES.includes(family);
    return {
        'larry.config.ts': larryConfig(scaffold),
        'eslint.config.js': lines(
            `import { larry } from '${SELF_NAME}/eslint';`,
            `import { ${family}Standards } from '${SELF_NAME}/eslint/${family}';`,
            '',
            'export default larry({',
            `    preset: '${family}',`,
            '    rootDir: import.meta.dirname,',
            ...(family === 'fullstack'
                ? ['    // Workspaces other than frontend, api, worker and packages/shared are named in `workspaces`.']
                : []),
            ...(scaffold.basePaths === undefined ? [] : pathsOption(scaffold.basePaths)),
            `    standards: ${family}Standards(),`,
            '});',
        ),
        'prettier.config.js': lines(`export { default } from '${SELF_NAME}/prettier';`),
        'commitlint.config.js': lines(
            `import { commitlint } from '${SELF_NAME}/commitlint';`,
            '',
            'export default commitlint();',
        ),
        'lint-staged.config.js': lines(
            `import { lintStaged } from '${SELF_NAME}/lint-staged';`,
            '',
            `export default lintStaged(${ui ? '{ stylelint: true }' : ''});`,
        ),
        'knip.config.js': knipConfig(family),
        ...(ui
            ? {
                  '.stylelintrc.mjs': lines(
                      `import { stylelint } from '${SELF_NAME}/stylelint';`,
                      '',
                      'export default stylelint();',
                  ),
              }
            : {}),
        '.jscpd.json': `${JSON.stringify(
            {
                format: ui ? ['typescript', 'vue'] : ['typescript'],
                minTokens: 50,
                ignore: ['**/node_modules/**', '**/dist/**'],
            },
            null,
            4,
        )}\n`,
        '.prettierignore': lines('package-lock.json', 'dist'),
        '.gitignore': lines('node_modules', 'dist', '.env'),
        '.husky/pre-commit': lines('npx --no -- lint-staged'),
        '.husky/commit-msg': lines('npx --no -- commitlint --edit "$1"'),
        '.github/workflows/ci.yml': ciWorkflow(scaffold.ciScripts, scaffold.nodeMajor),
    };
}

/** The required gates init skips for `family`, each with what it needs. */
export function unconfiguredGates(family: PresetName): [string, string][] {
    return gatesFor(family).flatMap((name) => {
        const needs = NEEDS[name];
        return needs === undefined ? [] : [[name, needs] as [string, string]];
    });
}

function larryConfig(scaffold: Scaffold): string {
    const { family, distribution, scan, sources } = scaffold;
    const ceilings = UI_FAMILIES.includes(family) ? '{ typescript: 2, vue: 2 }' : '{ typescript: 2 }';
    const configured: [string, string][] = [
        ['code-style', `{ scan: ${list(scan)} }`],
        ...(family === 'library' ? [['dead-code', '{ publicApi: packageEntries() }'] as [string, string]] : []),
        ['duplication', `{ scan: ${list(sources)}, ceilings: ${ceilings} }`],
        ['licenses', `{ distribution: '${distribution}' }`],
    ];
    const skipped = unconfiguredGates(family);
    return lines(
        "// The gates `larry check` runs, and each one's options. The editor lists every option a gate takes.",
        `import { defineConfig } from '${SELF_NAME}/config';`,
        ...(family === 'library' ? [`import { packageEntries } from '${SELF_NAME}/knip';`] : []),
        '',
        'export default defineConfig({',
        `    family: '${family}',`,
        '    gates: {',
        ...configured.map(([name, options]) => `        '${name}': ${options},`),
        ...(skipped.length > 0
            ? [
                  '        // These read files only this project can name. Give each its options and remove the skip.',
                  ...skipped.map(([name, needs]) => `        '${name}': { skip: 'Not set up yet: needs ${needs}.' },`),
              ]
            : []),
        '    },',
        '});',
    );
}

function knipConfig(family: PresetName): string {
    if (family === 'library') {
        return lines(
            `import { knip, packageEntries } from '${SELF_NAME}/knip';`,
            '',
            '// A library is used through the files behind its `exports`; the `!` keeps them entries under --production.',
            `export default knip({ entry: packageEntries().map((file) => \`\${file}!\`), project: ['src/**/*.ts!'] });`,
        );
    }
    return lines(
        `import { knip } from '${SELF_NAME}/knip';`,
        '',
        "// knip's plugins find the entry points its tools declare. Name any others in `entry`.",
        'export default knip({});',
    );
}

function pathsOption(paths: BasePaths): string[] {
    return [
        '    // The base family assumes no layout: these are the folders init found. An area with none is [].',
        '    paths: {',
        ...Object.entries(paths)
            .filter(([area, globs]) => area !== 'nodeAndBrowser' || globs.length > 0)
            .map(([area, globs]) => `        ${area}: ${list(globs)},`),
        '    },',
    ];
}

function ciWorkflow(ciScripts: string[], nodeMajor: number): string {
    return lines(
        'name: CI',
        '',
        'on:',
        '    push:',
        '        branches: [main]',
        '    pull_request:',
        '',
        'concurrency:',
        `    group: ci-\${{ github.ref }}`,
        '    cancel-in-progress: true',
        '',
        'permissions:',
        '    contents: read',
        '',
        'jobs:',
        '    check:',
        '        runs-on: ubuntu-24.04',
        '        timeout-minutes: 20',
        '        steps:',
        `            - uses: ${CHECKOUT}`,
        `            - uses: ${SETUP_NODE}`,
        '              with:',
        `                  node-version: ${nodeMajor}`,
        '                  cache: npm',
        '            - run: npm ci',
        ...ciScripts.map((script) => `            - run: npm run ${script}`),
    );
}

const lines = (...text: string[]): string => `${text.join('\n')}\n`;

/** A string array as a literal in the file written. */
const list = (items: string[]): string => `[${items.map((item) => `'${item}'`).join(', ')}]`;
