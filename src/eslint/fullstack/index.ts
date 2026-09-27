/**
 * The full-stack family: rules that assume frontend / api / worker / shared workspaces,
 * a database behind the api and a websocket gateway. The rules both families share
 * live in ../rules and are given this family's folders here. The selectors a project
 * composes into its own `no-restricted-syntax` blocks are re-exported individually below.
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
import { apiStandards } from './api.ts';
import { dbStandards } from './db.ts';
import { loggingStandards } from './logging.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export {
    apiSourceSelectors,
    apiRoutesOnlySelectors,
    outboundCallSelectors,
    apiBannedImports,
    frontendSelectors,
} from './api.ts';
export { dbApiWorkerSelectors, dbDbTsSelectors, dbWorkerIndexSelectors, dbBannedImports } from './db.ts';
export { loggerCallSelectors, noDirectErrorResponse } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { sharedPackageBannedImports } from './boundaries.ts';
export { utilsBannedImportPatterns, libBannedImportPatterns } from './code-style.ts';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports, wsSocketClientBannedImports } from './ws.ts';

/** The frontend's components, and everything that runs in the browser. */
const { vue, browser: frontend } = PRESETS.fullstack;
/** Every workspace's shipped code. */
const SOURCE = ['api/src/**/*.ts', 'worker/src/**/*.ts', 'frontend/src/**/*.{ts,vue}', 'packages/shared/src/**/*.ts'];
/** Tests live inside each workspace's `src/`, beside the code they test. */
const TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

export type FullstackStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /** See logging.ts — `consoleAllowed`. */
    logging?: Parameters<typeof loggingStandards>[0];
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};

export function fullstackStandards(options: FullstackStandardsOptions = {}) {
    const { security, logging, html, refactoring, i18n } = options;

    return [
        ...apiStandards,
        ...dbStandards,
        ...securityStandards(
            { code: ['api/src/**/*.ts', 'worker/src/**/*.ts', 'packages/**/*.ts', 'frontend/src/**/*.{ts,vue}'], vue },
            security,
        ),
        ...loggingStandards(logging),
        ...typescriptStandards({
            source: [...SOURCE, 'e2e/**/*.ts'],
            code: [...SOURCE, 'e2e/**/*.ts'],
            defaultExportAllowed: ['e2e/playwright.config.ts', 'e2e/support/global-setup.ts'],
        }),
        ...envStandards([
            '**/lib/config.ts',
            '**/config/env.ts',
            '**/__tests__/**/*.ts',
            '**/*.test.ts',
            '**/*.setup.ts',
            'e2e/**/*.ts',
            'scripts/**/*.ts',
            'db/**/*.js',
        ]),
        ...(i18n === false
            ? []
            : i18nStandards(
                  { vue, frontend, localeFiles: 'frontend/src/i18n/locales/*.json', usageSrc: 'frontend/src' },
                  i18n,
              )),
        ...vueStandards({ vue, frontend }),
        ...htmlStandards({ vue, globalStylesheet: [] }, html),
        ...refactoringStandards(
            { code: [...SOURCE, 'e2e/**/*.ts'], source: SOURCE, tests: TESTS, markerFiles: ['eslint.config.js'] },
            refactoring,
        ),
        ...testingStandards(['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.spec.ts']),
    ];
}
