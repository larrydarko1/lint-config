/**
 * The full-stack family: a frontend, an api, the services beside it and the shared
 * packages they all import, with a database behind the api and a websocket gateway.
 * Which folder plays which role is `larry({ workspaces })`. The frontend gets the SPA
 * family's areas and the api the API family's, each given its workspace; ./areas.ts adds
 * the services, the shared packages and the frontend's side of the wire contract. The
 * repository-wide rules come once, from ../rules. The selectors a project composes into
 * its own `no-restricted-syntax` blocks are re-exported individually below.
 */
import { apiAreas, nodeRepoAreas } from '../api/areas.ts';
import { familyStandards, type FamilyStandards } from '../family.ts';
import { fullstackLayout } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { htmlStandards, type HtmlOptions } from '../rules/html.ts';
import { i18nStandards, type I18nOptions } from '../rules/i18n.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards, type SecurityOptions } from '../rules/security.ts';
import { testingStandards } from '../rules/testing.ts';
import { typescriptStandards } from '../rules/typescript.ts';
import { vueStandards } from '../rules/vue.ts';
import { frontendAreas } from '../spa/areas.ts';
import { httpServiceSelectors } from './api.ts';
import { apiClientRules, apiWorkspaceLayout, serviceAreas, sharedAreas, sharedShapes } from './areas.ts';
import { mongoSelectors } from './db.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors, noImportMetaEnv } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { noStoreLibraryPatterns, noToastLibraryPatterns, aliasOnlyImportPatterns } from '../rules/vue.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { apiRoutesOnlySelectors, outboundCallSelectors, apiBannedImports, frontendSelectors } from './api.ts';
export { dbBannedImports } from './db.ts';
export { loggerCallSelectors, noDirectErrorResponse } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { sharedPackageBannedImports } from './boundaries.ts';
export { utilsBannedImportPatterns, libBannedImportPatterns } from '../rules/layering.ts';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports, wsSocketClientBannedImports } from './ws.ts';

export type FullstackStandardsOptions = {
    /** See rules/security.ts — `vHtmlAllowed`. */
    security?: SecurityOptions;
    /**
     * `consoleAllowed`: files where `console` is the point — the app shell reporting a
     * boot failure it cannot yet log any other way.
     */
    logging?: { consoleAllowed?: string[] };
    /** See rules/html.ts — `globalStylesheet`. */
    html?: HtmlOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /** See rules/i18n.ts. Pass `false` for a single-language app. */
    i18n?: I18nOptions | false;
};

/** What `fullstackStandards()` returns: `larry()` calls it with the project's resolved workspaces. */
export type FullstackStandards = FamilyStandards<'fullstack'>;

/** Tests live inside each workspace's `src/`, beside the code they test. */
const TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

const DEFAULT_LAYOUT = fullstackLayout();
const DEFAULT_API = apiWorkspaceLayout(DEFAULT_LAYOUT);
const defaultMongo = mongoSelectors(DEFAULT_API);

/** The api's source selectors, as the family gives them to the default workspaces. */
export const apiSourceSelectors = httpServiceSelectors({
    appError: DEFAULT_API.appError,
    namedShapes: sharedShapes(DEFAULT_LAYOUT),
});
/** Backend application code: the index manifest owns indexes, each lib/db.ts owns its client. */
export const dbApiWorkerSelectors = defaultMongo.application;
/** The api's lib/db.ts, which applies the manifest and holds the client. */
export const dbDbTsSelectors = defaultMongo.dbModule;
/** A service's lib/db.ts, which holds that process's client but applies no indexes. */
export const dbWorkerIndexSelectors = defaultMongo.serviceEntry;

export function fullstackStandards(options: FullstackStandardsOptions = {}): FullstackStandards {
    const { security, logging = {}, html, refactoring, i18n } = options;
    const { consoleAllowed = [] } = logging;

    return familyStandards('fullstack', [], (layout) => {
        const { vue, frontend, source, workspaces } = layout;
        const sharedCode = workspaces.shared.map((dir) => `${dir}/**/*.ts`);
        const api = apiWorkspaceLayout(layout);

        return [
            ...securityStandards({ code: [...layout.backend, ...sharedCode, ...frontend], vue }, security),
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

            ...frontendAreas(`${workspaces.frontend}/src`, apiClientRules(layout)),
            ...apiAreas(api, { mongo: true, redis: true, ws: true, namedShapes: sharedShapes(layout) }),
            ...workspaces.services.flatMap((dir) => serviceAreas(dir, api)),
            ...workspaces.shared.flatMap(sharedAreas),
            ...nodeRepoAreas(api, { mongo: true }),
            ...(consoleAllowed.length > 0 ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
        ];
    });
}
