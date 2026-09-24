/**
 * The Electron family's standards: the rules that assume a main / preload / renderer
 * split, a sandboxed window and IPC as the only way across. Fern, Quartz and bamboo
 * kept byte-identical copies of every one of these files, which is the duplication
 * this package exists to end.
 *
 * `electronStandards()` returns the blocks in the order they have always been applied.
 * The selectors the project composes into its own per-area `no-restricted-syntax`
 * blocks are re-exported individually below.
 */
import env from './env.ts';
import html from './html.ts';
import i18n from './i18n.ts';
import logging from './logging.ts';
import refactoring from './refactoring.ts';
import security from './security.ts';
import testing from './testing.ts';
import typescriptStandards from './typescript.ts';
import vueStandards from './vue.ts';

export { bannedCryptoModules } from './security.ts';
export { loggerCallSelectors } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { tsSourceSelectors, schemasBannedImports, rendererBannedImports, mainBannedImports } from './typescript.ts';
export { configModuleSelectors, noImportMetaEnv } from './env.ts';
export { noSingleLetterDeclaration, utilsBannedImportPatterns, libBannedImportPatterns } from './code-style.ts';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from './vue.ts';
export { functionContractsPlugin } from './function-contracts.ts';

export type ElectronStandardsOptions = {
    /** See security.ts — `vHtmlAllowed`. */
    security?: Parameters<typeof security>[0];
    /** See html.ts — `globalStylesheet`. */
    html?: Parameters<typeof html>[0];
    /** See i18n.ts. Pass `false` for a single-language app (Quartz). */
    i18n?: Parameters<typeof i18n>[0] | false;
};

export function electronStandards(options: ElectronStandardsOptions = {}) {
    const { security: securityOptions, html: htmlOptions, i18n: i18nOptions } = options;

    return [
        ...security(securityOptions),
        ...logging,
        ...typescriptStandards,
        ...env,
        ...html(htmlOptions),
        ...vueStandards,
        ...(i18nOptions === false ? [] : i18n(i18nOptions)),
        ...refactoring,
        ...testing,
    ];
}

export default electronStandards;
