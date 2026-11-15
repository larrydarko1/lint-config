/**
 * Layering bans: which layer may depend on which — a shared package on a driver,
 * `utils/` on `lib/`, `lib/` on `services/`. A dependency is what such a ban is about,
 * and `import type` is not one: it is erased before anything runs, so the shared package
 * still ships without the driver and a pure function naming a type from `lib/` still
 * does no I/O. The base `no-restricted-imports` cannot tell the two apart, so a block
 * with a layering ban uses the typescript-eslint rule and switches the base one off.
 * Module bans (crypto, a store library) and the relative-path ban stay absolute: a `../`
 * path breaks on a move whether or not the symbol survives to runtime.
 */
type ImportPath = { name: string; message: string };
type ImportPattern = ({ group: string[] } | { regex: string }) & { message: string };

export const utilsBannedImportPatterns = [
    {
        group: ['@/lib/*', '@/api/*', '@/services/*', '@/composables/*', '@/stores/*', '**/lib/*', '**/services/*'],
        message:
            'utils/ is pure functions — no side effects, no state, no I/O. Importing infrastructure makes it none of those. Move the function to lib/ (owns one external concern) or to the composable that needs it.',
    },
];

export const libBannedImportPatterns = [
    {
        group: ['@/services/*', '@/services/**', '**/services/*', '**/services/**'],
        message:
            'lib/ owns one external concern and is consumed BY services/ — never the reverse. A type may be imported with `import type`; if lib needs a value from a service, that value belongs in lib (or packages/shared).',
    },
];

/**
 * @param paths Modules banned outright, type imports included.
 * @param patterns Patterns banned outright, type imports included.
 * @param layering Patterns banned for what they would load, so `import type` passes.
 */
export const layeredImports = (
    paths: ImportPath[],
    patterns: ImportPattern[],
    layering: ImportPattern[],
): Record<string, unknown> => ({
    'no-restricted-imports': 'off',
    '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths, patterns: [...patterns, ...layering.map((entry) => ({ ...entry, allowTypeImports: true }))] },
    ],
});
