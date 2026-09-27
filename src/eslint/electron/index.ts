/**
 * The Electron family: rules that assume a main / preload / renderer split, a sandboxed
 * window and IPC as the only way across. The rules both families share live in
 * ../rules and are given this family's folders here. The selectors a project composes
 * into its own `no-restricted-syntax` blocks are re-exported individually below.
 */
import { PRESETS } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { htmlStandards, type HtmlOptions } from '../rules/html.ts';
import { i18nStandards, type I18nOptions } from '../rules/i18n.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards, type SecurityOptions } from '../rules/security.ts';
import { testingStandards } from '../rules/testing.ts';
import { typescriptStandards } from '../rules/typescript.ts';
import { vueStandards } from '../rules/vue.ts';
import { loggingStandards } from './logging.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { loggerCallSelectors } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { schemasBannedImports, rendererBannedImports, mainBannedImports } from './boundaries.ts';
export { utilsBannedImportPatterns, libBannedImportPatterns } from './code-style.ts';

/** The renderer's components, and everything that runs in the window. */
const { vue, browser: renderer } = PRESETS.electron;
/** All three processes. */
const SOURCE = ['src/**/*.{ts,vue}'];
const TESTS = ['tests/**/*.ts'];

export type ElectronStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};

export function electronStandards(options: ElectronStandardsOptions = {}) {
    const { security, html, refactoring, i18n } = options;

    return [
        ...securityStandards({ code: SOURCE, vue }, security),
        ...loggingStandards,
        ...typescriptStandards({ source: SOURCE, code: [...SOURCE, ...TESTS], defaultExportAllowed: [] }),
        ...envStandards(['**/lib/config.ts', ...TESTS, 'vitest.setup.ts', 'scripts/**/*.ts', 'build/**/*.cjs']),
        ...htmlStandards({ vue, globalStylesheet: ['src/renderer/App.vue'] }, html),
        ...vueStandards({ vue, frontend: renderer }),
        ...(i18n === false
            ? []
            : i18nStandards(
                  { vue, frontend: renderer, localeFiles: 'assets/locales/*.json', usageSrc: 'src/renderer' },
                  i18n,
              )),
        ...refactoringStandards(
            {
                code: [...SOURCE, ...TESTS],
                source: SOURCE,
                tests: TESTS,
                markerFiles: ['eslint/**/*.js', 'eslint.config.js', 'scripts/**/*.ts'],
            },
            refactoring,
        ),
        ...testingStandards([...TESTS, '**/*.test.ts', '**/*.spec.ts']),
    ];
}
