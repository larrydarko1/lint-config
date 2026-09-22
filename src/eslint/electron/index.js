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
import security from './security.js';
import logging from './logging.js';
import typescriptStandards from './typescript.js';
import env from './env.js';
import html from './html.js';
import vueStandards from './vue.js';
import i18n from './i18n.js';
import refactoring from './refactoring.js';
import testing from './testing.js';

export { bannedCryptoModules } from './security.js';
export { loggerCallSelectors } from './logging.js';
export { errorHandlingSelectors } from './error-handling.js';
export { tsSourceSelectors, schemasBannedImports, rendererBannedImports, mainBannedImports } from './typescript.js';
export { configModuleSelectors, noImportMetaEnv } from './env.js';
export { noSingleLetterDeclaration, utilsBannedImportPatterns, libBannedImportPatterns } from './code-style.js';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from './vue.js';
export { functionContractsPlugin } from './function-contracts.js';

/**
 * @param {object} [options]
 * @param {object} [options.security] See security.js — `vHtmlAllowed`.
 * @param {object} [options.html] See html.js — `globalStylesheet`.
 * @param {object|false} [options.i18n] See i18n.js. Pass `false` for a single-language app (Quartz).
 */
export function electronStandards(options = {}) {
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
