/**
 * A Vue app's areas: the restricted syntax and imports for its source, its `utils/` and
 * its tests, given the app's source folder.
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

/** Tests sit beside the code, so every area below leaves them out. */
const NOT_TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'];

export const frontendAreas = (src: string): object[] => {
    const source = [`${src}/**/*.{ts,vue}`];
    const paths = bannedCryptoModules;
    const patterns = [...noStoreLibraryPatterns, ...noToastLibraryPatterns, ...aliasOnlyImportPatterns];

    return [
        // A browser console is read by nobody once the app ships.
        { files: source, ignores: NOT_TESTS, rules: { 'no-console': 'error' } },
        {
            files: source,
            ignores: NOT_TESTS,
            rules: {
                'no-restricted-syntax': [
                    'error',
                    noImportMetaEnv,
                    ...tsSourceSelectors,
                    noSingleLetterDeclaration,
                    noFileURLToPath,
                ],
            },
        },
        { files: source, rules: { 'no-restricted-imports': ['error', { paths, patterns }] } },
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
