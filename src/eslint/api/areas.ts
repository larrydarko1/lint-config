/**
 * An Express service's areas: the restricted syntax and imports for its source, routes,
 * gateway, error handler, database and config modules, and its `lib/`. The API family
 * gives them its own layout; the full-stack family gives them the api workspace's.
 *
 * `no-restricted-syntax` and `no-restricted-imports` are last-match-wins, so each area
 * names the whole list it wants.
 */
import {
    apiBannedImports,
    apiRoutesOnlySelectors,
    httpServiceSelectors,
    proxyWorkBannedImports,
} from '../fullstack/api.ts';
import { dbBannedImports, mongoSelectors, scriptEnvSelectors } from '../fullstack/db.ts';
import { errorHandlingSelectors } from '../fullstack/error-handling.ts';
import { loggerCallSelectors, noDirectErrorResponse } from '../fullstack/logging.ts';
import { wsEventNameSelectors, wsGatewayBannedImports, wsGatewaySelectors } from '../fullstack/ws.ts';
import type { ApiLayout } from '../presets.ts';
import { noFileURLToPath, noSingleLetterDeclaration } from '../rules/code-style.ts';
import { configModuleSelectors } from '../rules/env.ts';
import { layeredImports, libBannedImportPatterns, type ImportPath } from '../rules/layering.ts';
import { bannedCryptoModules } from '../rules/security.ts';
import { tsSourceSelectors } from '../rules/typescript.ts';

type ApiAreaOptions = {
    mongo: boolean;
    redis: boolean;
    ws: boolean;
    /** Named in a message: where a returned shape is declared, and who compiles against it. */
    namedShapes: string;
};

/** Tests sit beside the code, so every area below leaves them out. */
const NOT_TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

const E2E = ['e2e/**/*.ts'];

export const apiAreas = (layout: ApiLayout, options: ApiAreaOptions): object[] => {
    const { mongo: useMongo, redis, ws, namedShapes } = options;
    const source = [`${layout.src}/**/*.ts`];
    const gateway = [`${layout.gateway}/**/*.ts`];
    const mongo = mongoSelectors(layout);
    const db = useMongo ? mongo.application : [];
    /** Every area of the service shares these; each block below adds or swaps its own. */
    const common = [
        ...httpServiceSelectors({ appError: layout.appError, namedShapes }),
        ...loggerCallSelectors,
        ...errorHandlingSelectors,
        ...tsSourceSelectors,
        noSingleLetterDeclaration,
    ];
    const bannedImports = backendBannedImports({ mongo: useMongo, redis });

    return [
        { files: source, ignores: NOT_TESTS, rules: { 'no-console': 'error' } },
        // A caught error's message reaches a log, never a response.
        { files: source, ignores: NOT_TESTS, rules: { 'larry/no-caught-message-leak': 'error' } },

        syntaxBlock(source, [...common, noDirectErrorResponse, ...db]),
        syntaxBlock([`${layout.routes}/**/*.ts`], [...common, ...apiRoutesOnlySelectors, noDirectErrorResponse, ...db]),
        // The handler is where an error becomes a response, so it answers directly.
        syntaxBlock([layout.errorHandler], [...common, ...db], []),
        ...(useMongo
            ? [syntaxBlock([layout.dbModule], [...common, noDirectErrorResponse, ...mongo.dbModule], [])]
            : []),
        ...(ws
            ? [
                  syntaxBlock(gateway, [
                      ...wsGatewaySelectors,
                      ...wsEventNameSelectors,
                      ...common,
                      noDirectErrorResponse,
                      ...db,
                  ]),
              ]
            : []),
        syntaxBlock([layout.config], [...configModuleSelectors, ...tsSourceSelectors, noSingleLetterDeclaration], []),

        { files: source, rules: { 'no-restricted-imports': ['error', { paths: bannedImports }] } },
        {
            files: [`${layout.lib}/**/*.ts`],
            ignores: NOT_TESTS,
            rules: layeredImports(bannedImports, [], libBannedImportPatterns),
        },
        ...(ws
            ? [
                  {
                      files: gateway,
                      rules: {
                          'no-restricted-imports': ['error', { paths: [...bannedImports, ...wsGatewayBannedImports] }],
                      },
                  },
              ]
            : []),
    ];
};

/**
 * The repository's Node code outside the service: end-to-end suites, ops scripts and
 * migrations, which sit at the root in both families.
 *
 * @param layout `database` holds the migrations.
 */
export const nodeRepoAreas = (
    layout: Pick<ApiLayout, 'database' | 'indexManifest' | 'documentTypes'>,
    options: { mongo: boolean },
): object[] => [
    syntaxBlock(E2E, [...tsSourceSelectors, noSingleLetterDeclaration, noFileURLToPath], []),
    syntaxBlock(['scripts/**/*.ts'], scriptEnvSelectors, []),
    ...(options.mongo
        ? [
              {
                  files: [`${layout.database}/migrations/**/*.js`],
                  rules: {
                      'no-restricted-syntax': ['error', ...mongoSelectors(layout).migration],
                      'no-restricted-imports': ['error', { paths: dbBannedImports }],
                  },
              },
          ]
        : []),
];

const syntaxBlock = (files: string[], selectors: object[], ignores: string[] = NOT_TESTS): object => ({
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
    rules: { 'no-restricted-syntax': ['error', ...selectors] },
});

/** The modules a backend's own code may not import, by which of its dependencies it has. */
const backendBannedImports = ({ mongo, redis }: { mongo: boolean; redis: boolean }): ImportPath[] => [
    ...bannedCryptoModules,
    ...(mongo ? dbBannedImports : []),
    ...(redis ? apiBannedImports : proxyWorkBannedImports),
];
