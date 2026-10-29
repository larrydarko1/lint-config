/**
 * The Tauri family: one Vue app in a webview, and a Rust process ESLint never sees. Its
 * TypeScript is an SPA's — the shared rules in ../rules, given this layout's folders — plus
 * the one boundary Tauri adds: the webview reaches Rust only through `src/bridge/`, and the
 * bridge turns what Rust and the plugins reject with into an error code. The Rust side is
 * Clippy's and the gates'. The selectors a project composes into its own
 * `no-restricted-syntax` blocks are re-exported individually below.
 */
import { familyStandards, type FamilyStandards } from '../family.ts';
import type { TauriLayout } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { htmlStandards, type HtmlOptions } from '../rules/html.ts';
import { i18nStandards, readsLocalesRole, type I18nOptions } from '../rules/i18n.ts';
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
export { noStoreLibraryPatterns, noToastLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { loggerCallSelectors } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { webviewBannedImports } from './boundaries.ts';

export type TauriStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};
export function tauriStandards(options: TauriStandardsOptions = {}): FamilyStandards<'tauri'> {
    const { security, html, refactoring, i18n } = options;
    const roles: (keyof TauriLayout)[] = ['src', 'bridge'];

    return familyStandards('tauri', readsLocalesRole(i18n) ? [...roles, 'locales'] : roles, (layout) => {
        /** The webview's own code: what ships, and everything that runs in the webview. */
        const source = [`${layout.src}/**/*.{ts,vue}`];
        const vue = [`${layout.src}/**/*.vue`];
        /** The only code that imports `@tauri-apps/*`. */
        const bridge = [`${layout.bridge}/**/*.ts`];
        const tests = [`${layout.tests}/**/*.ts`, 'vitest.setup.ts'];

        return [
            ...securityStandards({ code: source, vue }, security),
            { files: source, ignores: bridge, rules: { 'larry/no-tauri-outside-bridge': 'error' } },
            // A rejection from Rust or a plugin is English that can name a path on the user's disk.
            { files: bridge, rules: { 'larry/no-caught-message-leak': 'error' } },
            ...loggingStandards(source, tests),
            ...typescriptStandards({ source, code: [...source, ...tests], defaultExportAllowed: [] }),
            ...envStandards([...tests, 'scripts/**/*.ts', '*.config.{js,ts}']),
            ...(i18n === false
                ? []
                : i18nStandards(
                      { vue, frontend: source, localeFiles: `${layout.locales}/*.json`, usageSrc: layout.src },
                      i18n,
                  )),
            ...vueStandards({ vue, frontend: source }),
            ...htmlStandards({ vue, globalStylesheet: [] }, html),
            ...refactoringStandards(
                {
                    code: [...source, ...tests],
                    source,
                    tests,
                    markerFiles: ['eslint.config.js', 'scripts/**/*.ts'],
                },
                refactoring,
            ),
            ...testingStandards([...tests, '**/*.test.ts', '**/*.spec.ts']),
        ];
    });
}
