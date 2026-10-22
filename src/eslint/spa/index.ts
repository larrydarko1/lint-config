/**
 * The SPA family: one Vue app built by Vite, in one package, with no server of its own.
 * Its rules are the full-stack frontend's: the shared ones in ../rules, given this
 * layout's folders, and none of the rules for an API, a database or a socket gateway,
 * because there is none. The selectors a project composes into its own
 * `no-restricted-syntax` blocks are re-exported individually below.
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

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, noToastLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';

/** The components, and everything that runs in the app. */
const { vue, browser: app, tests: TESTS } = PRESETS.spa;
/** The app's own code: what ships. */
const SOURCE = ['src/**/*.{ts,vue}'];
const E2E = ['e2e/**/*.ts'];

export type SpaStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /**
     * `consoleAllowed`: files where `console` is the point — the app shell reporting a
     * boot failure it cannot yet report any other way.
     */
    logging?: { consoleAllowed?: string[] };
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};

export function spaStandards(options: SpaStandardsOptions = {}) {
    const { security, logging = {}, html, refactoring, i18n } = options;
    const { consoleAllowed = [] } = logging;

    return [
        ...securityStandards({ code: SOURCE, vue }, security),
        // A browser console is read by nobody once the app ships.
        { files: SOURCE, ignores: TESTS, rules: { 'no-console': 'error' } },
        ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
        ...typescriptStandards({ source: SOURCE, code: [...SOURCE, ...E2E], defaultExportAllowed: [] }),
        ...envStandards([...TESTS, 'scripts/**/*.ts', '*.config.{js,ts}']),
        ...(i18n === false
            ? []
            : i18nStandards({ vue, frontend: app, localeFiles: 'src/i18n/locales/*.json', usageSrc: 'src' }, i18n)),
        ...vueStandards({ vue, frontend: app }),
        ...htmlStandards({ vue, globalStylesheet: [] }, html),
        ...refactoringStandards(
            { code: [...SOURCE, ...E2E], source: SOURCE, tests: TESTS, markerFiles: ['eslint.config.js'] },
            refactoring,
        ),
        ...testingStandards(['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.spec.ts']),
    ];
}
