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
import { PRESETS } from '../presets.ts';
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
/** The service's own code: what ships. */
const SOURCE = ['src/**/*.ts'];
const E2E = ['e2e/**/*.ts'];
/** Tests sit beside the code, so every area below leaves them out. */
const NOT_TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

const CONFIG = 'src/lib/config.ts';
const DB = 'src/lib/db.ts';
const ERROR_HANDLER = 'src/middleware/error-handler.ts';
const ROUTES = ['src/routes/**/*.ts'];
const GATEWAY = ['src/gateway/**/*.ts'];
const LIB = ['src/lib/**/*.ts'];

const { tests: TESTS } = PRESETS.api;

/** The full-stack messages, pointed at this layout's files. */
export const apiSourceSelectors = httpServiceSelectors({
    appError: 'src/lib/app-error.ts',
    namedShapes: 'and export it from the module that returns it, so every caller compiles against one definition',
});
const mongo = mongoSelectors({ indexManifest: 'src/db/indexes.ts', documentTypes: 'src/db/collections.ts' });
/** Application code: the index manifest owns indexes, lib/db.ts owns the client. Named as in the full-stack family. */
export const dbApiWorkerSelectors = mongo.application;
/** src/lib/db.ts, which applies the manifest and holds the client. */
export const dbDbTsSelectors = mongo.dbModule;

export function apiStandards(options: ApiStandardsOptions = {}) {
    const { logging = {}, refactoring, mongo: useMongo = true, redis = true, ws = true } = options;
    const { consoleAllowed = [] } = logging;

    const db = useMongo ? dbApiWorkerSelectors : [];
    /** Every area of the service shares these; each block below adds or swaps its own. */
    const common = [
        ...apiSourceSelectors,
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
        ...securityStandards({ code: SOURCE, vue: [] }),
        { files: SOURCE, ignores: TESTS, rules: { 'no-console': 'error' } },
        ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
        // A caught error's message reaches a log, never a response.
        { files: SOURCE, ignores: TESTS, rules: { 'larry/no-caught-message-leak': 'error' } },
        ...typescriptStandards({ source: SOURCE, code: [...SOURCE, ...E2E], defaultExportAllowed: [] }),
        ...envStandards([CONFIG, 'src/config/env.ts', ...TESTS, 'scripts/**/*.ts', 'db/**/*.js', '*.config.{js,ts}']),
        ...refactoringStandards(
            { code: [...SOURCE, ...E2E], source: SOURCE, tests: TESTS, markerFiles: ['eslint.config.js'] },
            refactoring,
        ),
        ...testingStandards(['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.spec.ts']),

        // ── Restricted syntax, broadest area first ───────────────────────────
        syntax(SOURCE, [...common, noDirectErrorResponse, ...db]),
        syntax(ROUTES, [...common, ...apiRoutesOnlySelectors, noDirectErrorResponse, ...db]),
        // The handler is where an error becomes a response, so it answers directly.
        syntax([ERROR_HANDLER], [...common, ...db], []),
        ...(useMongo ? [syntax([DB], [...common, noDirectErrorResponse, ...dbDbTsSelectors], [])] : []),
        ...(ws
            ? [
                  syntax(GATEWAY, [
                      ...wsGatewaySelectors,
                      ...wsEventNameSelectors,
                      ...common,
                      noDirectErrorResponse,
                      ...db,
                  ]),
              ]
            : []),
        syntax([CONFIG], [...configModuleSelectors, ...tsSourceSelectors, noSingleLetterDeclaration], []),
        syntax(E2E, [...tsSourceSelectors, noSingleLetterDeclaration, noFileURLToPath], []),
        syntax(['scripts/**/*.ts'], scriptEnvSelectors, []),
        ...(useMongo
            ? [
                  {
                      files: ['db/migrations/**/*.js'],
                      rules: {
                          'no-restricted-syntax': ['error', ...mongo.migration],
                          'no-restricted-imports': ['error', { paths: dbBannedImports }],
                      },
                  },
              ]
            : []),

        // ── Restricted imports ───────────────────────────────────────────────
        { files: SOURCE, rules: { 'no-restricted-imports': ['error', { paths: bannedImports }] } },
        {
            files: LIB,
            ignores: NOT_TESTS,
            rules: {
                'no-restricted-imports': ['error', { paths: bannedImports, patterns: libBannedImportPatterns }],
            },
        },
        ...(ws
            ? [
                  {
                      files: GATEWAY,
                      rules: {
                          'no-restricted-imports': ['error', { paths: [...bannedImports, ...wsGatewayBannedImports] }],
                      },
                  },
              ]
            : []),
    ];
}
