/**
 * The API family: one Express service in one package, with its clients in other
 * repositories. Its rules are the full-stack api's: the shared ones in ../rules and the
 * api, database, logging and socket selectors in ../fullstack, given this layout's
 * folders, with no frontend or shared-package rules because there are none. MongoDB,
 * Redis and a socket gateway are assumed, and each can be switched off for an API
 * without it.
 *
 * `no-restricted-syntax` and `no-restricted-imports` are last-match-wins, so each area
 * below names the whole list it wants. A project that adds a selector to an area names
 * that area's whole list again in its own block. The selectors are re-exported
 * individually below for that.
 */
import { familyStandards, type FamilyStandards } from '../family.ts';
import {
    apiBannedImports,
    apiRoutesOnlySelectors,
    httpServiceSelectors,
    proxyWorkBannedImports,
} from '../fullstack/api.ts';
import { libBannedImportPatterns } from '../fullstack/code-style.ts';
import { dbBannedImports, mongoSelectors, scriptEnvSelectors } from '../fullstack/db.ts';
import { errorHandlingSelectors } from '../fullstack/error-handling.ts';
import { loggerCallSelectors, noDirectErrorResponse } from '../fullstack/logging.ts';
import { wsEventNameSelectors, wsGatewayBannedImports, wsGatewaySelectors } from '../fullstack/ws.ts';
import { PRESETS, resolveLayout, type ApiLayout } from '../presets.ts';
import { noFileURLToPath, noSingleLetterDeclaration } from '../rules/code-style.ts';
import { configModuleSelectors, envStandards } from '../rules/env.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { bannedCryptoModules, securityStandards } from '../rules/security.ts';
import { testingStandards } from '../rules/testing.ts';
import { tsSourceSelectors, typescriptStandards } from '../rules/typescript.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { apiRoutesOnlySelectors, apiBannedImports } from '../fullstack/api.ts';
export { dbBannedImports } from '../fullstack/db.ts';
export { loggerCallSelectors, noDirectErrorResponse } from '../fullstack/logging.ts';
export { errorHandlingSelectors } from '../fullstack/error-handling.ts';
export { libBannedImportPatterns } from '../fullstack/code-style.ts';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports } from '../fullstack/ws.ts';

export type ApiStandardsOptions = {
    /**
     * `consoleAllowed`: files where `console` is the point — a boot failure reported before
     * the logger exists.
     */
    logging?: { consoleAllowed?: string[] };
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
    /**
     * MongoDB through the native driver: no ODM, typed collections, one client in
     * `src/lib/db.ts`, indexes in the manifest, forward-only migrations in `db/migrations/`.
     * Defaults to true; pass `false` for an API with no database.
     */
    mongo?: boolean;
    /**
     * Redis behind the API, as the one cache and the rate limiter's token bucket, so
     * in-process caches and fixed-window limiters are banned. Defaults to true; pass
     * `false` for a single-instance API with no Redis, where both are allowed.
     */
    redis?: boolean;
    /**
     * A Socket.IO gateway in `src/gateway/`: nothing thrown across the socket, coded error
     * events, `resource:action` event names. Defaults to true; pass `false` for an API with
     * no websockets.
     */
    ws?: boolean;
};
const E2E = ['e2e/**/*.ts'];
/** Tests sit beside the code, so every area below leaves them out. */
const NOT_TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];
const NAMED_SHAPES = 'and export it from the module that returns it, so every caller compiles against one definition';
const DEFAULT_LAYOUT = resolveLayout('api');

const { tests: TESTS } = PRESETS.api;

/** The full-stack messages, pointed at the default layout's files. `apiStandards()` points them at the project's. */
export const apiSourceSelectors = httpServiceSelectors({
    appError: DEFAULT_LAYOUT.appError,
    namedShapes: NAMED_SHAPES,
});
const defaultMongo = mongoSelectors(DEFAULT_LAYOUT);
/** Application code: the index manifest owns indexes, lib/db.ts owns the client. Named as in the full-stack family. */
export const dbApiWorkerSelectors = defaultMongo.application;
/** src/lib/db.ts, which applies the manifest and holds the client. */
export const dbDbTsSelectors = defaultMongo.dbModule;

export function apiStandards(options: ApiStandardsOptions = {}): FamilyStandards<'api'> {
    const { logging = {}, refactoring, mongo: useMongo = true, redis = true, ws = true } = options;
    const { consoleAllowed = [] } = logging;
    const roles: (keyof ApiLayout)[] = [
        'src',
        'routes',
        'config',
        'errorHandler',
        ...(useMongo ? (['dbModule'] as const) : []),
        ...(ws ? (['gateway'] as const) : []),
    ];

    return familyStandards('api', roles, (layout) => {
        /** The service's own code: what ships. */
        const source = [`${layout.src}/**/*.ts`];
        const routes = [`${layout.routes}/**/*.ts`];
        const gateway = [`${layout.gateway}/**/*.ts`];
        const mongo = mongoSelectors(layout);

        const db = useMongo ? mongo.application : [];
        /** Every area of the service shares these; each block below adds or swaps its own. */
        const common = [
            ...httpServiceSelectors({ appError: layout.appError, namedShapes: NAMED_SHAPES }),
            ...loggerCallSelectors,
            ...errorHandlingSelectors,
            ...tsSourceSelectors,
            noSingleLetterDeclaration,
        ];
        const bannedImports = [
            ...bannedCryptoModules,
            ...(useMongo ? dbBannedImports : []),
            ...(redis ? apiBannedImports : proxyWorkBannedImports),
        ];
        const syntax = (files: string[], selectors: object[], ignores: string[] = NOT_TESTS) => ({
            files,
            ...(ignores.length ? { ignores } : {}),
            rules: { 'no-restricted-syntax': ['error', ...selectors] },
        });

        return [
            ...securityStandards({ code: source, vue: [] }),
            { files: source, ignores: TESTS, rules: { 'no-console': 'error' } },
            ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
            // A caught error's message reaches a log, never a response.
            { files: source, ignores: TESTS, rules: { 'larry/no-caught-message-leak': 'error' } },
            ...typescriptStandards({ source, code: [...source, ...E2E], defaultExportAllowed: [] }),
            ...envStandards([
                layout.config,
                `${layout.src}/config/env.ts`,
                ...TESTS,
                'scripts/**/*.ts',
                `${layout.database}/**/*.js`,
                '*.config.{js,ts}',
            ]),
            ...refactoringStandards(
                { code: [...source, ...E2E], source, tests: TESTS, markerFiles: ['eslint.config.js'] },
                refactoring,
            ),
            ...testingStandards(['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.spec.ts']),

            // ── Restricted syntax, broadest area first ───────────────────────
            syntax(source, [...common, noDirectErrorResponse, ...db]),
            syntax(routes, [...common, ...apiRoutesOnlySelectors, noDirectErrorResponse, ...db]),
            // The handler is where an error becomes a response, so it answers directly.
            syntax([layout.errorHandler], [...common, ...db], []),
            ...(useMongo ? [syntax([layout.dbModule], [...common, noDirectErrorResponse, ...mongo.dbModule], [])] : []),
            ...(ws
                ? [
                      syntax(gateway, [
                          ...wsGatewaySelectors,
                          ...wsEventNameSelectors,
                          ...common,
                          noDirectErrorResponse,
                          ...db,
                      ]),
                  ]
                : []),
            syntax([layout.config], [...configModuleSelectors, ...tsSourceSelectors, noSingleLetterDeclaration], []),
            syntax(E2E, [...tsSourceSelectors, noSingleLetterDeclaration, noFileURLToPath], []),
            syntax(['scripts/**/*.ts'], scriptEnvSelectors, []),
            ...(useMongo
                ? [
                      {
                          files: [`${layout.database}/migrations/**/*.js`],
                          rules: {
                              'no-restricted-syntax': ['error', ...mongo.migration],
                              'no-restricted-imports': ['error', { paths: dbBannedImports }],
                          },
                      },
                  ]
                : []),

            // ── Restricted imports ───────────────────────────────────────────
            { files: source, rules: { 'no-restricted-imports': ['error', { paths: bannedImports }] } },
            {
                files: [`${layout.lib}/**/*.ts`],
                ignores: NOT_TESTS,
                rules: {
                    'no-restricted-imports': ['error', { paths: bannedImports, patterns: libBannedImportPatterns }],
                },
            },
            ...(ws
                ? [
                      {
                          files: gateway,
                          rules: {
                              'no-restricted-imports': [
                                  'error',
                                  { paths: [...bannedImports, ...wsGatewayBannedImports] },
                              ],
                          },
                      },
                  ]
                : []),
        ];
    });
}
