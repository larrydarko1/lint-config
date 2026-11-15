/**
 * The full-stack family's own areas, the ones neither single-package family has: the
 * api workspace's layout as the API family's areas read it, the services beside the api,
 * the shared packages, and the frontend's side of the wire contract.
 */
import { backendBannedImports, NOT_TESTS, syntaxBlock, testsBlock } from '../api/areas.ts';
import { resolveLayout, type ApiLayout, type FullstackLayout } from '../presets.ts';
import { noFileURLToPath, noSingleLetterDeclaration } from '../rules/code-style.ts';
import { configModuleSelectors } from '../rules/env.ts';
import { layeredImports, libBannedImportPatterns } from '../rules/layering.ts';
import { bannedCryptoModules } from '../rules/security.ts';
import { tsSourceSelectors } from '../rules/typescript.ts';
import type { ApiClientRules } from '../spa/areas.ts';
import { frontendSelectors, outboundCallSelectors } from './api.ts';
import { sharedPackageBannedImports } from './boundaries.ts';
import { mongoSelectors } from './db.ts';
import { errorHandlingSelectors } from './error-handling.ts';
import { loggerCallSelectors } from './logging.ts';
import { wsEventNameSelectors, wsSocketClientBannedImports } from './ws.ts';

/**
 * The api workspace as the API family lays out a service, with the index manifest and
 * the document types in the first shared package, where every workspace imports them.
 */
export const apiWorkspaceLayout = (layout: FullstackLayout): ApiLayout => {
    const [shared] = layout.workspaces.shared;
    const src = `${layout.workspaces.api}/src`;
    return resolveLayout('api', {
        src,
        ...(shared === undefined
            ? {}
            : { indexManifest: `${shared}/src/db/indexes.ts`, documentTypes: `${shared}/src/db/collections.ts` }),
    });
};

/** Named in a message: where a returned shape is declared, so both ends compile against it. */
export const sharedShapes = (layout: FullstackLayout): string => {
    const [shared] = layout.workspaces.shared;
    return shared === undefined
        ? 'and export it from the module that returns it, so every caller compiles against one definition'
        : `in ${shared} so the API and the frontend both compile against it`;
};

/**
 * A Node process outside the request cycle: it makes outbound calls but serves no HTTP,
 * and its one database client is in its own `src/lib/db.ts`, as the api's is. Only the
 * api applies the index manifest, so `createIndex` stays banned there.
 */
export const serviceAreas = (
    dir: string,
    messagePaths: Pick<ApiLayout, 'indexManifest' | 'documentTypes'>,
): object[] => {
    const source = [`${dir}/src/**/*.ts`];
    const lib = `${dir}/src/lib`;
    const mongo = mongoSelectors(messagePaths);
    const common = [...outboundCallSelectors, ...loggerCallSelectors, ...errorHandlingSelectors];
    const tail = [...tsSourceSelectors, noSingleLetterDeclaration];
    const bannedImports = backendBannedImports({ mongo: true, redis: true });

    return [
        { files: source, ignores: NOT_TESTS, rules: { 'no-console': 'error' } },
        { files: source, ignores: NOT_TESTS, rules: { 'larry/no-caught-message-leak': 'error' } },
        syntaxBlock(source, [...common, ...mongo.application, ...tail]),
        syntaxBlock([`${lib}/db.ts`], [...common, ...mongo.serviceEntry, ...tail], []),
        syntaxBlock([`${lib}/config.ts`], [...configModuleSelectors, ...tail], []),
        testsBlock(`${dir}/src`),
        { files: source, rules: { 'no-restricted-imports': ['error', { paths: bannedImports }] } },
        {
            files: [`${lib}/**/*.ts`],
            ignores: NOT_TESTS,
            rules: layeredImports(bannedImports, [], libBannedImportPatterns),
        },
    ];
};

/** A framework-neutral package every workspace imports: it loads no Vue, no server framework, no driver. */
export const sharedAreas = (dir: string): object[] => {
    const source = [`${dir}/src/**/*.ts`];
    return [
        syntaxBlock(source, [...tsSourceSelectors, noSingleLetterDeclaration, noFileURLToPath]),
        testsBlock(`${dir}/src`),
        { files: source, rules: layeredImports(bannedCryptoModules, [], sharedPackageBannedImports.patterns) },
    ];
};

/** The frontend's side of the API contract: what it may read off a response, and its one socket. */
export const apiClientRules = (layout: FullstackLayout): ApiClientRules => ({
    selectors: [...frontendSelectors, ...wsEventNameSelectors],
    bannedImports: wsSocketClientBannedImports,
    socketModule: `${layout.workspaces.frontend}/src/api/socket.ts`,
});
