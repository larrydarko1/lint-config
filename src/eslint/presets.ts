/**
 * Where each family keeps its code. Every path in the shared rules comes from here,
 * so a rule can say "the browser half of the app" without knowing whether that is
 * `frontend/src` (a web app) or `src/renderer` (an Electron window).
 *
 * A project overrides any of these with the `paths` option; the preset is only the
 * default that keeps a normal project's config file short.
 */

export type PresetName = 'electron' | 'fullstack';

/** Glob lists, one per area the shared rules address. */
export type PresetPaths = {
    source: string[];
    typedSource: string[];
    tests: string[];
    namingIgnores: string[];
    browser: string[];
    node: string[];
    nodeAndBrowser: string[];
    vue: string[];
    ignores: string[];
    configFiles: string[];
};

/** Electron desktop: main / preload / renderer under one `src/`, tests in `tests/`. */
export const electron: PresetPaths = {
    /** Shipped code. Excludes tests, which the test block relaxes separately. */
    source: ['src/**/*.{ts,vue}', 'scripts/**/*.ts'],
    /** Everything a tsconfig covers, so type-aware rules can run on it. */
    typedSource: ['src/**/*.{ts,vue}', 'tests/**/*.ts', 'vitest.setup.ts', 'scripts/**/*.ts'],
    tests: ['tests/**/*.ts', 'vitest.setup.ts'],
    /**
     * Tests here sit outside `src/`, so they never picked up naming-convention and
     * their helpers are named freely. Keeping that means the migration does not
     * rename a few hundred fixtures for no benefit.
     */
    namingIgnores: ['tests/**/*.ts', 'vitest.setup.ts'],
    /** Runs in a browser-like context — gets DOM globals. */
    browser: ['src/renderer/**/*.{ts,vue}'],
    /** Runs in Node — gets Node globals. */
    node: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.ts'],
    /** Both sets of globals (an E2E runner driving a browser from Node). */
    nodeAndBrowser: [],
    vue: ['src/renderer/**/*.vue'],
    ignores: ['out/', 'dist-electron/', 'node_modules/', 'models/', 'coverage/', 'build/'],
    /** The config files that quote rule patterns, so naming-convention is off there. */
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
};

/** Full-stack monorepo: workspaces for frontend / api / worker / shared, plus e2e. */
export const fullstack: PresetPaths = {
    source: [
        'frontend/src/**/*.{ts,vue}',
        'api/src/**/*.ts',
        'worker/src/**/*.ts',
        'packages/shared/src/**/*.ts',
        'e2e/**/*.ts',
        'scripts/**/*.ts',
    ],
    typedSource: [
        'frontend/src/**/*.{ts,vue}',
        'api/src/**/*.ts',
        'worker/src/**/*.ts',
        'packages/shared/src/**/*.ts',
        'e2e/**/*.ts',
        'scripts/**/*.ts',
    ],
    tests: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.setup.ts', 'e2e/**/*.ts'],
    /** Tests live inside each workspace's `src/`, so they are named like the code they test. */
    namingIgnores: [],
    browser: ['frontend/src/**/*.{ts,vue}'],
    // The repo scripts and the DB migrations are run by Node directly, so they get its globals too.
    node: ['api/src/**/*.ts', 'worker/src/**/*.ts', '**/*.setup.ts', 'scripts/**/*.ts', 'db/**/*.js'],
    nodeAndBrowser: ['e2e/**/*.ts'],
    vue: ['frontend/src/**/*.vue'],
    ignores: ['**/dist/', '**/node_modules/', 'backups/', 'models/', 'coverage/', 'playwright-report/'],
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
};

export const PRESETS: Record<PresetName, PresetPaths> = { electron, fullstack };

/** The preset's paths with the project's overrides applied. */
export const resolvePaths = (preset: PresetName, overrides: Partial<PresetPaths> = {}): PresetPaths => {
    const base = PRESETS[preset];
    if (!base) throw new Error(`Unknown preset '${preset}'. Expected one of: ${Object.keys(PRESETS).join(', ')}.`);
    return { ...base, ...overrides };
};
