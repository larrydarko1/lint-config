/**
 * The VS Code extension family: one package whose `src/` esbuild bundles for the editor's
 * extension host, the Node process every installed extension shares. Its rules are the
 * shared ones in ../rules, given this layout's folders, plus what that host asks: no
 * blocking calls, no console, no exit, every Disposable kept. `lib/` never loads `vscode`,
 * so Vitest can run it; the glue in `vscode/` is what the E2E suite runs, in a real editor,
 * through the API alone. The selectors a project composes into its own blocks are
 * re-exported individually below.
 */
import path from 'node:path';

import { familyStandards, type FamilyStandards } from '../family.ts';
import type { VsExtensionLayout } from '../presets.ts';
import { noSingleLetterDeclaration, testCodeSelectors } from '../rules/code-style.ts';
import { envStandards } from '../rules/env.ts';
import { layeredImports } from '../rules/layering.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { bannedCryptoModules, securityStandards } from '../rules/security.ts';
import {
    nodeAssertBannedImports,
    nodeTestParkedSelectors,
    nodeTestStandards,
    testingStandards,
} from '../rules/testing.ts';
import { tsSourceSelectors, typescriptStandards } from '../rules/typescript.ts';
import { aliasOnlyImportPatterns } from '../rules/vue.ts';
import { errorHandlingSelectors } from './error-handling.ts';
import { loggerCallSelectors, loggingStandards } from './logging.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { noSingleLetterDeclaration } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { nodeTestParkedSelectors, nodeAssertBannedImports } from '../rules/testing.ts';
export { loggerCallSelectors } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';

export type VsExtensionStandardsOptions = {
    /** Files where `console` is the point: a script the extension's own build runs is already outside `src/`. */
    logging?: { consoleAllowed?: string[] };
    /**
     * `processEnvAllowed`: source files that read `process.env` on purpose — the `PATH` a
     * child process is started with. Settings are the extension's configuration, read with
     * `workspace.getConfiguration`.
     */
    env?: { processEnvAllowed?: string[] };
    /** Modules a tool loads by their default export: a test reporter the extension ships. */
    defaultExportAllowed?: string[];
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
};

const E2E = ['e2e/**/*.ts'];
const SCRIPTS = ['scripts/**/*.ts'];

/** `process.exit()` in the extension host ends every extension in the window. */
export const noHostExit = {
    object: 'process',
    property: 'exit',
    message:
        'The extension host is one process for every installed extension: exiting it stops all of them, and the editor reports a crash. Throw, or show the failure and return.',
};

/** The bundle is CommonJS, where `import.meta` is empty: the source reads a path the build never has. */
export const noImportMetaPath = {
    selector: "MemberExpression[object.type='MetaProperty'][property.name=/^(dirname|filename|url)$/]",
    message:
        'The extension is bundled as CommonJS, where `import.meta` is empty, so this reads `undefined` once built while the tests, which run the source, pass. Reach the extension’s own files through `context.extensionUri`, which also works in a remote window.',
};

export function vsExtensionStandards(options: VsExtensionStandardsOptions = {}): FamilyStandards<'vs-extension'> {
    const { logging = {}, env = {}, defaultExportAllowed = [], refactoring } = options;
    const { consoleAllowed = [] } = logging;
    const { processEnvAllowed = [] } = env;

    return familyStandards('vs-extension', ['src', 'entry'], (layout) => {
        /** What the editor runs: the bundle's sources. */
        const source = [`${layout.src}/**/*.ts`];
        const tests = [`${layout.tests}/**/*.ts`];
        const code = [...source, ...tests, ...E2E, ...SCRIPTS];

        return [
            ...securityStandards({ code, vue: [] }),
            ...loggingStandards(source, consoleAllowed),
            {
                files: source,
                rules: {
                    'no-restricted-properties': ['error', noHostExit],
                    'larry/no-sync-io': 'error',
                    'larry/no-floating-disposable': 'error',
                },
            },
            ...typescriptStandards({ source, code, defaultExportAllowed }),
            {
                files: source,
                rules: {
                    'no-restricted-globals': [
                        'error',
                        ...['__dirname', '__filename'].map((name) => ({
                            name,
                            message: `\`${name}\` is where the bundle runs from, not a path the extension owns. Reach its files through \`context.extensionUri\`.`,
                        })),
                    ],
                },
            },
            ...envStandards([...tests, ...E2E, ...SCRIPTS, '*.config.{js,ts}', '*.mjs', ...processEnvAllowed]),
            ...refactoringStandards(
                { code, source, tests: [...tests, ...E2E], markerFiles: ['eslint.config.js'] },
                refactoring,
            ),
            ...testingStandards(tests),
            ...nodeTestStandards(E2E),
            ...areas(layout),
        ];
    });
}

/**
 * Each area's restricted syntax and imports. Both rules are last-match-wins, so each area
 * names the whole list it wants.
 */
function areas(layout: VsExtensionLayout): object[] {
    const source = [`${layout.src}/**/*.ts`];
    const alias = (target: string): string => `@/${path.posix.relative(layout.src, target).replace(/\.ts$/, '')}`;
    const glue = [`${alias(layout.vscode)}/*`, `${alias(layout.vscode)}/**`, alias(layout.entry)];

    return [
        {
            files: source,
            rules: {
                'no-restricted-syntax': [
                    'error',
                    ...loggerCallSelectors,
                    ...errorHandlingSelectors,
                    ...tsSourceSelectors,
                    noSingleLetterDeclaration,
                    noImportMetaPath,
                ],
                'no-restricted-imports': ['error', { paths: bannedCryptoModules, patterns: aliasOnlyImportPatterns }],
            },
        },
        {
            files: [`${layout.lib}/**/*.ts`],
            rules: layeredImports(bannedCryptoModules, aliasOnlyImportPatterns, [
                vscodeOutsideHost('`lib/`'),
                {
                    group: glue,
                    message:
                        '`lib/` is the logic the glue calls, never the other way round: importing the glue brings `vscode` with it.',
                },
            ]),
        },
        {
            files: [`${layout.tests}/**/*.ts`],
            rules: {
                'no-restricted-syntax': ['error', ...testCodeSelectors],
                ...layeredImports(bannedCryptoModules, [], [vscodeOutsideHost('A unit suite')]),
            },
        },
        {
            files: E2E,
            rules: {
                'no-restricted-syntax': ['error', ...nodeTestParkedSelectors, ...testCodeSelectors],
                'no-restricted-imports': [
                    'error',
                    {
                        paths: [...bannedCryptoModules, ...nodeAssertBannedImports],
                        patterns: [
                            {
                                group: ['@/*', `**/${layout.src}/*`, `**/${layout.src}/**`],
                                message:
                                    'An E2E spec drives the extension the editor loaded, through the `vscode` API. Importing its source bundles a second copy, with state of its own, that the editor never ran.',
                            },
                        ],
                    },
                ],
            },
        },
    ];
}

/** Vitest runs outside the editor, where `vscode` does not exist. */
function vscodeOutsideHost(where: string): { regex: string; message: string } {
    return {
        // The module itself: a gitignore-style `vscode` would also match the `@/vscode/` glue.
        regex: '^vscode$',
        message: `${where} runs in Vitest, outside the editor, where the \`vscode\` module does not exist: the import fails before any test runs. Take what is needed as plain values and leave the API to the glue in \`vscode/\`. A type, with \`import type\`, is fine.`,
    };
}
