/**
 * The full-stack family: rules that assume frontend / api / worker / shared workspaces,
 * a database behind the api and a websocket gateway. The selectors a project composes
 * into its own `no-restricted-syntax` blocks are re-exported individually below.
 */
import { apiStandards } from './api.ts';
import { dbStandards } from './db.ts';
import { envStandards } from './env.ts';
import { htmlStandards } from './html.ts';
import { i18nStandards } from './i18n.ts';
import { loggingStandards } from './logging.ts';
import { refactoringStandards } from './refactoring.ts';
import { securityStandards } from './security.ts';
import { testingStandards } from './testing.ts';
import { typescriptStandards } from './typescript.ts';
import { vueStandards } from './vue.ts';

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
    security?: Parameters<typeof securityStandards>[0];
    /** See logging.ts — `consoleAllowed`. */
    logging?: Parameters<typeof loggingStandards>[0];
    /** See refactoring.ts — `markerFiles`. */
    refactoring?: Parameters<typeof refactoringStandards>[0];
    /** See i18n.ts. Pass `false` for a single-language app. */
    i18n?: Parameters<typeof i18nStandards>[0] | false;
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
        ...securityStandards(securityOptions),
        ...loggingStandards(loggingOptions),
        ...typescriptStandards,
        ...envStandards,
        ...(i18nOptions === false ? [] : i18nStandards(i18nOptions)),
        ...vueStandards,
        ...htmlStandards,
        ...refactoringStandards(refactoringOptions),
        ...testingStandards,
    ];
}
