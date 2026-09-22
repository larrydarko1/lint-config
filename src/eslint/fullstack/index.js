/**
 * The full-stack family's standards: the rules that assume workspaces for frontend,
 * api, worker and shared, a database behind the api, and a websocket gateway. Orchid
 * and Mosaic kept their own copies of all of these.
 *
 * `fullstackStandards()` returns the blocks in the order they have always been
 * applied. The selectors the project composes into its own per-area
 * `no-restricted-syntax` blocks are re-exported individually below.
 */
import apiStandards from './api.js';
import dbStandards from './db.js';
import security from './security.js';
import logging from './logging.js';
import typescriptStandards from './typescript.js';
import env from './env.js';
import html from './html.js';
import vueStandards from './vue.js';
import i18n from './i18n.js';
import refactoring from './refactoring.js';
import testing from './testing.js';

export {
    apiSourceSelectors,
    apiRoutesOnlySelectors,
    outboundCallSelectors,
    apiBannedImports,
    frontendSelectors,
} from './api.js';
export { dbApiWorkerSelectors, dbDbTsSelectors, dbWorkerIndexSelectors, dbBannedImports } from './db.js';
export { bannedCryptoModules } from './security.js';
export { loggerCallSelectors, noDirectErrorResponse } from './logging.js';
export { errorHandlingSelectors } from './error-handling.js';
export { tsSourceSelectors, sharedPackageBannedImports } from './typescript.js';
export { configModuleSelectors, noImportMetaEnv } from './env.js';
export {
    noSingleLetterDeclaration,
    noFileURLToPath,
    utilsBannedImportPatterns,
    libBannedImportPatterns,
} from './code-style.js';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from './vue.js';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports, wsSocketClientBannedImports } from './ws.js';
export { functionContractsPlugin } from './function-contracts.js';

/**
 * @param {object} [options]
 * @param {object} [options.security] See security.js — `vHtmlAllowed`.
 * @param {object} [options.logging] See logging.js — `consoleAllowed`.
 * @param {object} [options.refactoring] See refactoring.js — `markerFiles`.
 * @param {object|false} [options.i18n] See i18n.js. Pass `false` for a single-language app.
 */
export function fullstackStandards(options = {}) {
    const {
        security: securityOptions,
        logging: loggingOptions,
        refactoring: refactoringOptions,
        i18n: i18nOptions,
    } = options;

    return [
        ...apiStandards,
        ...dbStandards,
        ...security(securityOptions),
        ...logging(loggingOptions),
        ...typescriptStandards,
        ...env,
        ...(i18nOptions === false ? [] : i18n(i18nOptions)),
        ...vueStandards,
        ...html,
        ...refactoring(refactoringOptions),
        ...testing,
    ];
}

export default fullstackStandards;
