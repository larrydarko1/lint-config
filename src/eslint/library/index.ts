/**
 * The library family: a package published to npm, built from `src/` into `dist/` and
 * tested by `node --test`. Its rules are the shared ones in ../rules, given this layout's
 * folders, plus two for code that runs inside someone else's process: it does not print,
 * and it does not exit. There are no components and no service, so none of the frontend,
 * API, database or socket rules apply. The selectors a project composes into its own
 * blocks are re-exported individually below.
 */
import { PRESETS } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards } from '../rules/security.ts';
import { nodeTestStandards } from '../rules/testing.ts';
import { typescriptStandards } from '../rules/typescript.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { nodeTestParkedSelectors, nodeAssertBannedImports } from '../rules/testing.ts';

export type LibraryStandardsOptions = {
    /**
     * `consoleAllowed`: files where `console` is the point — a CLI the package ships, or a
     * report it prints for a script that asked for one.
     */
    logging?: { consoleAllowed?: string[] };
    /**
     * `processEnvAllowed`: source files that read `process.env` on purpose, beyond the tests,
     * scripts and tool configs that always may — a CLI honouring `NO_COLOR`, a child process
     * given its parent's environment.
     */
    env?: { processEnvAllowed?: string[] };
    /** Modules a tool loads by their default export: a shareable config the package publishes. */
    defaultExportAllowed?: string[];
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
};
/** The package's own code: what `dist/` is built from. */
const SOURCE = ['src/**/*.ts'];
const SCRIPTS = ['scripts/**/*.{ts,js}'];

/** `process.exit()` in a library ends its caller's process. */
export const noProcessExit = {
    object: 'process',
    property: 'exit',
    message:
        'A library that exits ends the process it was imported into, and exit() can cut off output still buffered on a pipe. Throw, or set `process.exitCode` and return.',
};

const { tests: TESTS } = PRESETS.library;

export function libraryStandards(options: LibraryStandardsOptions = {}) {
    const { logging = {}, env = {}, defaultExportAllowed = [], refactoring } = options;
    const { consoleAllowed = [] } = logging;
    const { processEnvAllowed = [] } = env;

    return [
        ...securityStandards({ code: [...SOURCE, ...SCRIPTS], vue: [] }),
        // The caller owns the terminal and the logs; a library hands back values and errors.
        { files: SOURCE, rules: { 'no-console': 'error' } },
        ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
        { files: SOURCE, rules: { 'no-restricted-properties': ['error', noProcessExit] } },
        ...typescriptStandards({
            source: SOURCE,
            // `explicit-module-boundary-types` needs types to read, so a JavaScript suite is left out.
            code: [...SOURCE, 'test/**/*.ts', 'scripts/**/*.ts'],
            defaultExportAllowed,
        }),
        ...envStandards([...TESTS, ...SCRIPTS, '*.config.{js,ts}', ...processEnvAllowed]),
        ...refactoringStandards(
            {
                code: [...SOURCE, ...TESTS, ...SCRIPTS],
                source: SOURCE,
                tests: TESTS,
                markerFiles: ['eslint.config.js'],
            },
            refactoring,
        ),
        ...nodeTestStandards(TESTS),
    ];
}
