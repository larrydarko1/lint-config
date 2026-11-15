/**
 * The API family: one Express service in one package, with its clients in other
 * repositories. Its rules are the shared ones in ../rules and the service's areas in
 * ./areas.ts, given this layout's folders; the full-stack family gives the same areas
 * its api workspace. MongoDB, Redis and a socket gateway are assumed, and each can be
 * switched off for an API without it.
 *
 * `no-restricted-syntax` and `no-restricted-imports` are last-match-wins, so a project
 * that adds a selector to an area names that area's whole list again in its own block.
 * The selectors are re-exported individually below for that.
 */
import { familyStandards, type FamilyStandards } from '../family.ts';
import { PRESETS, resolveLayout, type ApiLayout } from '../presets.ts';
import { envStandards } from '../rules/env.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards } from '../rules/security.ts';
import { testingStandards } from '../rules/testing.ts';
import { typescriptStandards } from '../rules/typescript.ts';
import { httpServiceSelectors } from './api.ts';
import { apiAreas, nodeRepoAreas } from './areas.ts';
import { mongoSelectors } from './db.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';
export { apiRoutesOnlySelectors, apiBannedImports } from './api.ts';
export { dbBannedImports } from './db.ts';
export { loggerCallSelectors, noDirectErrorResponse } from './logging.ts';
export { errorHandlingSelectors } from './error-handling.ts';
export { libBannedImportPatterns } from '../rules/layering.ts';
export { wsGatewaySelectors, wsEventNameSelectors, wsGatewayBannedImports } from './ws.ts';

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
    const { logging = {}, refactoring, mongo = true, redis = true, ws = true } = options;
    const { consoleAllowed = [] } = logging;
    const roles: (keyof ApiLayout)[] = [
        'src',
        'routes',
        'config',
        'errorHandler',
        ...(mongo ? (['dbModule'] as const) : []),
        ...(ws ? (['gateway'] as const) : []),
    ];

    return familyStandards('api', roles, (layout) => {
        /** The service's own code: what ships. */
        const source = [`${layout.src}/**/*.ts`];

        return [
            ...securityStandards({ code: source, vue: [] }),
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
            ...apiAreas(layout, { mongo, redis, ws, namedShapes: NAMED_SHAPES }),
            ...nodeRepoAreas(layout, { mongo }),
            ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
        ];
    });
}
