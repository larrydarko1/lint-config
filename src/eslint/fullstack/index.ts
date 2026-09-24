/**
 * The full-stack family's standards: the rules that assume workspaces for frontend,
 * api, worker and shared, a database behind the api, and a websocket gateway. Orchid
 * and Mosaic kept their own copies of all of these.
 *
 * `fullstackStandards()` returns the blocks in the order they have always been
 * applied. The selectors the project composes into its own per-area
 * `no-restricted-syntax` blocks are re-exported individually below.
 */
import apiStandards from './api.ts';
import dbStandards from './db.ts';
import env from './env.ts';
import html from './html.ts';
import i18n from './i18n.ts';
import logging from './logging.ts';
import refactoring from './refactoring.ts';
import security from './security.ts';
import testing from './testing.ts';
import typescriptStandards from './typescript.ts';
import vueStandards from './vue.ts';

export {
    apiSourceSelectors,
    apiRoutesOnlySelectors,
    outboundCallSelectors,
    apiBannedImports,
    frontendSelectors,
} from './api.ts';
export { dbApiWorkerSelectors, dbDbTsSelectors, dbWorkerIndexSelectors, dbBannedImports } from './db.ts';
export { bannedCryptoModules } from './security.ts';
export { loggerCallSelectors, noDirectErrorResponse } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { tsSourceSelectors, sharedPackageBannedImports } from './typescript.ts';
export { configModuleSelectors, noImportMetaEnv } from './env.ts';
export {
    noSingleLetterDeclaration,
    noFileURLToPath,
    utilsBannedImportPatterns,
    libBannedImportPatterns,
} from './code-style.ts';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from './vue.ts';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports, wsSocketClientBannedImports } from './ws.ts';
export { functionContractsPlugin } from './function-contracts.ts';

export type FullstackStandardsOptions = {
    /** See security.ts — `vHtmlAllowed`. */
    security?: Parameters<typeof security>[0];
    /** See logging.ts — `consoleAllowed`. */
    logging?: Parameters<typeof logging>[0];
    /** See refactoring.ts — `markerFiles`. */
    refactoring?: Parameters<typeof refactoring>[0];
    /** See i18n.ts. Pass `false` for a single-language app. */
    i18n?: Parameters<typeof i18n>[0] | false;
};

export function fullstackStandards(options: FullstackStandardsOptions = {}) {
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
