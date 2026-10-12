/**
 * The full-stack family: rules for a frontend, an api, the services beside it and the
 * shared packages they all import, with a database behind the api and a websocket
 * gateway. Which folder plays which role is `larry({ workspaces })`; every block here is
 * built from that, so a workspace added to a role gets that role's rules. The rules both
 * families share live in ../rules and are given this family's folders here. The
 * selectors a project composes into its own `no-restricted-syntax` blocks are
 * re-exported individually below.
 */
import type { Linter } from 'eslint';

import type { FullstackLayout } from '../presets.ts';
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
import { errorHandlingStandards } from './error-handling.ts';
import { loggingStandards } from './logging.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, noToastLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
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

/** Tests live inside each workspace's `src/`, beside the code they test. */
const TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

export type FullstackStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /** See logging.ts — `consoleAllowed`. */
    logging?: Parameters<typeof loggingStandards>[1];
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};

/** What `fullstackStandards()` returns: `larry()` calls it with the project's resolved workspaces. */
export type FullstackStandards = (layout: FullstackLayout) => Linter.Config[];

export function fullstackStandards(options: FullstackStandardsOptions = {}): FullstackStandards {
    const { security, logging, html, refactoring, i18n } = options;

    return (layout) => {
        const { vue, frontend, source, workspaces } = layout;
        const sharedCode = workspaces.shared.map((dir) => `${dir}/**/*.ts`);

        return [
            ...apiStandards(layout),
            ...dbStandards(layout),
            ...securityStandards({ code: [...layout.backend, ...sharedCode, ...frontend], vue }, security),
            ...loggingStandards(layout, logging),
            ...errorHandlingStandards(layout),
            ...typescriptStandards({
                source: [...source, 'e2e/**/*.ts'],
                code: [...source, 'e2e/**/*.ts'],
                defaultExportAllowed: [
                    'e2e/playwright.config.ts',
                    'e2e/support/global-setup.ts',
                    'e2e/support/global-teardown.ts',
                ],
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
                      {
                          vue,
                          frontend,
                          localeFiles: `${workspaces.frontend}/src/i18n/locales/*.json`,
                          usageSrc: `${workspaces.frontend}/src`,
                      },
                      i18n,
                  )),
            ...vueStandards({ vue, frontend }),
            ...htmlStandards({ vue, globalStylesheet: [] }, html),
            ...refactoringStandards(
                { code: [...source, 'e2e/**/*.ts'], source, tests: TESTS, markerFiles: ['eslint.config.js'] },
                refactoring,
            ),
            ...testingStandards(['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.spec.ts']),
        ] as Linter.Config[];
    };
}
