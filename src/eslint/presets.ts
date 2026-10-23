/**
 * Where each family keeps its code. Every path in the shared rules comes from here;
 * a project overrides any of them with the `paths` option.
 */

export type PresetName = 'electron' | 'fullstack' | 'spa' | 'tauri';

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
const electron: PresetPaths = {
    /** Shipped code. Excludes tests, which the test block relaxes separately. */
    source: ['src/**/*.{ts,vue}', 'scripts/**/*.ts'],
    /** Everything a tsconfig covers, so type-aware rules can run on it. */
    typedSource: ['src/**/*.{ts,vue}', 'tests/**/*.ts', 'vitest.setup.ts', 'scripts/**/*.ts'],
    tests: ['tests/**/*.ts', 'vitest.setup.ts'],
    /** Tests sit outside `src/` and name their helpers freely. */
    namingIgnores: ['tests/**/*.ts', 'vitest.setup.ts'],
    /** Runs in a browser-like context — gets DOM globals. */
    browser: ['src/renderer/**/*.{ts,vue}'],
    /** Runs in Node — gets Node globals. */
    node: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.ts'],
    /** Both sets of globals (an E2E runner driving a browser from Node). */
    nodeAndBrowser: [],
    vue: ['src/renderer/**/*.vue'],
    // A Python virtualenv (a tool installed with pip) is third-party code like node_modules, JS files and all.
    ignores: ['out/', 'dist-electron/', 'node_modules/', '**/.venv/', 'models/', 'coverage/', 'build/'],
    /** The config files that quote rule patterns, so naming-convention is off there. */
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
};

/**
 * A single-page app: one Vue app built by Vite, in one package, with no server of its own.
 * Tests sit in `__tests__/` beside the code they test, so they are named like it.
 */
const spa: PresetPaths = {
    source: ['src/**/*.{ts,vue}', 'scripts/**/*.ts'],
    typedSource: ['src/**/*.{ts,vue}', 'scripts/**/*.ts', 'e2e/**/*.ts'],
    tests: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.setup.ts', 'e2e/**/*.ts'],
    namingIgnores: [],
    browser: ['src/**/*.{ts,vue}'],
    // The tool configs at the root run in Node too: Vite's, Vitest's, ESLint's own.
    node: ['scripts/**/*.ts', '**/*.setup.ts', '*.config.{js,ts}'],
    nodeAndBrowser: ['e2e/**/*.ts'],
    vue: ['src/**/*.vue'],
    // `public/` is copied into the build as it is, so it holds assets, not source.
    ignores: ['dist/', 'node_modules/', 'public/', '**/.venv/', 'coverage/', 'playwright-report/'],
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
};

/**
 * A Tauri desktop app: the webview is one Vue app in `src/`, the Rust side is `src-tauri/`.
 * A single package, so tests mirror `src/` in `tests/`. `src-tauri/` holds no JavaScript,
 * only Rust, the generated schemas and Cargo's `target/`, so ESLint never walks it.
 */
const tauri: PresetPaths = {
    source: ['src/**/*.{ts,vue}', 'scripts/**/*.ts'],
    typedSource: ['src/**/*.{ts,vue}', 'tests/**/*.ts', 'vitest.setup.ts', 'scripts/**/*.ts'],
    tests: ['tests/**/*.ts', 'vitest.setup.ts'],
    namingIgnores: ['tests/**/*.ts', 'vitest.setup.ts'],
    browser: ['src/**/*.{ts,vue}'],
    // The tool configs at the root run in Node too: Vite's, Vitest's, ESLint's own.
    node: ['scripts/**/*.ts', 'vitest.setup.ts', '*.config.{js,ts}'],
    nodeAndBrowser: [],
    vue: ['src/**/*.vue'],
    ignores: ['dist/', 'node_modules/', 'src-tauri/', 'public/', '**/.venv/', 'coverage/'],
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
};

/**
 * A full-stack monorepo's workspaces, by the role each plays. Every full-stack rule is
 * written against a role, not a folder name, so a new workspace is one entry here and
 * every rule for its role reaches it. Each is a directory holding a `src/`.
 */
export type FullstackWorkspaces = {
    /** The Vue app. */
    frontend: string;
    /** The HTTP service: routes, middleware, the websocket gateway. */
    api: string;
    /** Node processes outside the request cycle — a queue consumer, a feed ingestor, a scheduled role. */
    services: string[];
    /** Framework-neutral packages the other workspaces import. */
    shared: string[];
};

/** The four the family started with. A project overrides any role with `larry({ workspaces })`. */
export const FULLSTACK_WORKSPACES: FullstackWorkspaces = {
    frontend: 'frontend',
    api: 'api',
    services: ['worker'],
    shared: ['packages/shared'],
};

/** Each role's source as globs — what the full-stack rules are given. */
export type FullstackLayout = {
    workspaces: FullstackWorkspaces;
    /** The frontend's TypeScript and components. */
    frontend: string[];
    /** The frontend's components alone. */
    vue: string[];
    api: string[];
    services: string[];
    /** The api and every service: the Node side. */
    backend: string[];
    shared: string[];
    /** Every workspace's shipped code. */
    source: string[];
};

const nodeSource = (dir: string): string => `${dir}/src/**/*.ts`;

export const fullstackLayout = (workspaces: Partial<FullstackWorkspaces> = {}): FullstackLayout => {
    const resolved = { ...FULLSTACK_WORKSPACES, ...workspaces };
    const api = [nodeSource(resolved.api)];
    const services = resolved.services.map(nodeSource);
    const shared = resolved.shared.map(nodeSource);
    const frontend = [`${resolved.frontend}/src/**/*.{ts,vue}`];
    return {
        workspaces: resolved,
        frontend,
        vue: [`${resolved.frontend}/src/**/*.vue`],
        api,
        services,
        backend: [...api, ...services],
        shared,
        source: [...frontend, ...api, ...services, ...shared],
    };
};

const fullstackPaths = (layout: FullstackLayout): PresetPaths => ({
    source: [...layout.source, 'e2e/**/*.ts', 'scripts/**/*.ts'],
    typedSource: [...layout.source, 'e2e/**/*.ts', 'scripts/**/*.ts'],
    tests: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.setup.ts', 'e2e/**/*.ts'],
    /** Tests live inside each workspace's `src/`, so they are named like the code they test. */
    namingIgnores: [],
    browser: layout.frontend,
    // The repo scripts and the DB migrations are run by Node directly, so they get its globals too.
    node: [...layout.backend, '**/*.setup.ts', 'scripts/**/*.ts', 'db/**/*.js'],
    nodeAndBrowser: ['e2e/**/*.ts'],
    vue: layout.vue,
    // A Python virtualenv (the API fuzzer's, e2e/fuzz/.venv) is third-party code like node_modules, JS files and all.
    ignores: ['**/dist/', '**/node_modules/', '**/.venv/', 'backups/', 'models/', 'coverage/', 'playwright-report/'],
    configFiles: ['eslint/**/*.js', 'eslint.config.js'],
});

export const PRESETS: Record<PresetName, PresetPaths> = {
    electron,
    fullstack: fullstackPaths(fullstackLayout()),
    spa,
    tauri,
};

/** The preset's paths, for the full-stack family built from its workspaces, with the project's overrides applied. */
export const resolvePaths = (
    preset: PresetName,
    overrides: Partial<PresetPaths> = {},
    workspaces: Partial<FullstackWorkspaces> = {},
): PresetPaths => {
    const base = preset === 'fullstack' ? fullstackPaths(fullstackLayout(workspaces)) : PRESETS[preset];
    if (!base) throw new Error(`Unknown preset '${preset}'. Expected one of: ${Object.keys(PRESETS).join(', ')}.`);
    return { ...base, ...overrides };
};
