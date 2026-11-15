/**
 * A Vue app's areas: the restricted syntax and imports for its source, its `utils/` and
 * its tests. The SPA family gives them its `src`; the full-stack family gives them the
 * frontend workspace's, with the rules for an app that is the client of its own API.
 *
 * `no-restricted-syntax` and `no-restricted-imports` are last-match-wins, so each area
 * names the whole list it wants.
 */
import { noFileURLToPath, noSingleLetterDeclaration } from '../rules/code-style.ts';
import { noImportMetaEnv } from '../rules/env.ts';
import { layeredImports, utilsBannedImportPatterns } from '../rules/layering.ts';
import { bannedCryptoModules } from '../rules/security.ts';
import { tsSourceSelectors } from '../rules/typescript.ts';
import { aliasOnlyImportPatterns, noStoreLibraryPatterns, noToastLibraryPatterns } from '../rules/vue.ts';

/** What an app that talks to an API of its own adds: the client side of the wire contract. */
export type ApiClientRules = {
    selectors: object[];
    bannedImports: { name: string; message: string }[];
    /** The one module allowed what `bannedImports` bans elsewhere: the socket client. */
    socketModule: string;
};

/** Tests sit beside the code, so every area below leaves them out. */
const NOT_TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

/**
 * @param src The app's source folder.
 * @param client The API-client rules, for a frontend with an API in the same repository.
 */
export const frontendAreas = (src: string, client?: ApiClientRules): object[] => {
    const source = [`${src}/**/*.{ts,vue}`];
    const paths = [...bannedCryptoModules, ...(client?.bannedImports ?? [])];
    const patterns = [...noStoreLibraryPatterns, ...noToastLibraryPatterns, ...aliasOnlyImportPatterns];
    /** The socket client may import `socket.io-client`, and nothing else the app may not. */
    const socketModule =
        client === undefined
            ? []
            : [
                  {
                      files: [client.socketModule],
                      rules: { 'no-restricted-imports': ['error', { paths: bannedCryptoModules, patterns }] },
                  },
              ];

    return [
        // A browser console is read by nobody once the app ships.
        { files: source, ignores: NOT_TESTS, rules: { 'no-console': 'error' } },
        {
            files: source,
            ignores: NOT_TESTS,
            rules: {
                'no-restricted-syntax': [
                    'error',
                    ...(client?.selectors ?? []),
                    noImportMetaEnv,
                    ...tsSourceSelectors,
                    noSingleLetterDeclaration,
                    noFileURLToPath,
                ],
            },
        },
        { files: source, rules: { 'no-restricted-imports': ['error', { paths, patterns }] } },
        ...socketModule,
        {
            files: [`${src}/utils/**/*.{ts,vue}`],
            ignores: NOT_TESTS,
            rules: layeredImports(paths, patterns, utilsBannedImportPatterns),
        },
        {
            files: [`${src}/**/__tests__/**/*.{ts,vue}`, `${src}/**/*.test.ts`, `${src}/**/*.spec.ts`],
            rules: {
                'no-restricted-imports': ['error', { paths: bannedCryptoModules, patterns: noStoreLibraryPatterns }],
                'no-restricted-syntax': ['error', noFileURLToPath],
                'vue/require-typed-ref': 'off',
                'vue/no-ref-object-reactivity-loss': 'off',
            },
        },
    ];
};
