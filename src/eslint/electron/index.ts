/**
 * The Electron family: rules that assume a main / preload / renderer split, a sandboxed
 * window and IPC as the only way across. The rules both families share live in
 * ../rules and are given this family's folders here, from the project's layout. The
 * selectors a project composes into its own `no-restricted-syntax` blocks are
 * re-exported individually below.
 */
import { familyStandards, type FamilyStandards } from '../family.ts';
import type { ElectronLayout } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { htmlStandards, type HtmlOptions } from '../rules/html.ts';
import { i18nStandards, readsLocalesRole, type I18nOptions } from '../rules/i18n.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards, type SecurityOptions } from '../rules/security.ts';
import { testingStandards } from '../rules/testing.ts';
import { typescriptStandards } from '../rules/typescript.ts';
import { vueStandards } from '../rules/vue.ts';
import { errorHandlingStandards } from './error-handling.ts';
import { loggingStandards } from './logging.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, noToastLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { loggerCallSelectors } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { schemasBannedImports, rendererBannedImports, mainBannedImports } from './boundaries.ts';
export { utilsBannedImportPatterns, libBannedImportPatterns } from './code-style.ts';

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
export function electronStandards(options: ElectronStandardsOptions = {}): FamilyStandards<'electron'> {
    const { security, html, refactoring, i18n } = options;
    const roles: (keyof ElectronLayout)[] = ['src', 'main', 'preload', 'renderer'];

    return familyStandards('electron', readsLocalesRole(i18n) ? [...roles, 'locales'] : roles, (layout) => {
        /** All three processes. */
        const source = [`${layout.src}/**/*.{ts,vue}`];
        const tests = [`${layout.tests}/**/*.ts`];
        /** The renderer's components, and everything that runs in the window. */
        const vue = [`${layout.renderer}/**/*.vue`];
        const renderer = [`${layout.renderer}/**/*.{ts,vue}`];

        return [
            ...securityStandards({ code: source, vue }, security),
            ...loggingStandards(source),
            ...errorHandlingStandards([`${layout.main}/**/*.ts`, `${layout.preload}/**/*.ts`]),
            ...typescriptStandards({ source, code: [...source, ...tests], defaultExportAllowed: [] }),
            ...envStandards(['**/lib/config.ts', ...tests, 'vitest.setup.ts', 'scripts/**/*.ts', 'build/**/*.cjs']),
            ...htmlStandards({ vue, globalStylesheet: [`${layout.renderer}/App.vue`] }, html),
            ...vueStandards({ vue, frontend: renderer }),
            ...(i18n === false
                ? []
                : i18nStandards(
                      { vue, frontend: renderer, localeFiles: `${layout.locales}/*.json`, usageSrc: layout.renderer },
                      i18n,
                  )),
            ...refactoringStandards(
                {
                    code: [...source, ...tests],
                    source,
                    tests,
                    markerFiles: ['eslint/**/*.js', 'eslint.config.js', 'scripts/**/*.ts'],
                },
                refactoring,
            ),
            ...testingStandards([...tests, '**/*.test.ts', '**/*.spec.ts']),
        ];
    });
}
