/**
 * Where each family keeps its code. Every path in the shared rules comes from here: a
 * family's layout names the folders by the role each plays, and both the preset's paths
 * and the family's standards are built from it. A project whose code lives elsewhere
 * moves a role with `larry({ layout })`, or `larry({ workspaces })` in the full-stack
 * family, and every rule for that role follows. `paths` then adjusts one area of the
 * base config on its own.
 */

export type PresetName = 'api' | 'electron' | 'fullstack' | 'library' | 'spa' | 'tauri';

/** The families in one package, whose roles are folders rather than workspaces. */
export type SinglePackagePreset = Exclude<PresetName, 'fullstack'>;

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

/**
 * Each role is a path from the repository root. A role left out defaults from the one
 * it sits in, so moving `src` moves everything under it that is not named on its own.
 */
export type ElectronLayout = {
    /** All three processes, and the schemas they share. */
    src: string;
    main: string;
    preload: string;
    renderer: string;
    /** The suites, mirroring `src/`. */
    tests: string;
    /** The locale JSON files. */
    locales: string;
};

export type SpaLayout = {
    /** The app. Its tests sit beside the code, in `__tests__/`. */
    src: string;
    locales: string;
};

export type TauriLayout = {
    /** The webview. */
    src: string;
    /** The only code that imports `@tauri-apps/*`. */
    bridge: string;
    tests: string;
    locales: string;
};

export type ApiLayout = {
    /** The service. Its tests sit beside the code, in `__tests__/`. */
    src: string;
    routes: string;
    /** The Socket.IO gateway. */
    gateway: string;
    /** The modules a route builds on: config, the database client, AppError. */
    lib: string;
    /** The one module that reads `process.env`. */
    config: string;
    /** The one module that holds the database client and applies the index manifest. */
    dbModule: string;
    /** Where a thrown error becomes a response. */
    errorHandler: string;
    /** Named in messages: the error class every failure is thrown as. */
    appError: string;
    /** Named in messages: the indexes every collection has. */
    indexManifest: string;
    /** Named in messages: the document type of every collection. */
    documentTypes: string;
    /** The JavaScript Node runs against the database: migrations in `<database>/migrations/`. */
    database: string;
};

export type LibraryLayout = {
    /** What `dist/` is built from. */
    src: string;
    /** The suites `node --test` runs. */
    tests: string;
};

/** Each single-package family's roles, resolved. */
export type FamilyLayouts = {
    api: ApiLayout;
    electron: ElectronLayout;
    library: LibraryLayout;
    spa: SpaLayout;
    tauri: TauriLayout;
};

/** Every role of every single-package family. `larry({ layout })` holds the names to the preset's own. */
export type LayoutOverrides = Partial<
    Record<keyof ApiLayout | keyof ElectronLayout | keyof LibraryLayout | keyof SpaLayout | keyof TauriLayout, string>
>;

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

/**
 * What a project passes to move a family's roles: workspaces in the full-stack family,
 * folders in the rest. No name is in both.
 */
export type RoleOverrides = Partial<FullstackWorkspaces> & LayoutOverrides;

const LAYOUTS: { [TPreset in SinglePackagePreset]: (given: LayoutOverrides) => FamilyLayouts[TPreset] } = {
    electron: (given): ElectronLayout => {
        const src = dir(given.src, 'src');
        return {
            src,
            main: dir(given.main, `${src}/main`),
            preload: dir(given.preload, `${src}/preload`),
            renderer: dir(given.renderer, `${src}/renderer`),
            tests: dir(given.tests, 'tests'),
            locales: dir(given.locales, 'assets/locales'),
        };
    },
    spa: (given): SpaLayout => {
        const src = dir(given.src, 'src');
        return { src, locales: dir(given.locales, `${src}/i18n/locales`) };
    },
    tauri: (given): TauriLayout => {
        const src = dir(given.src, 'src');
        return {
            src,
            bridge: dir(given.bridge, `${src}/bridge`),
            tests: dir(given.tests, 'tests'),
            locales: dir(given.locales, `${src}/i18n/locales`),
        };
    },
    api: (given): ApiLayout => {
        const src = dir(given.src, 'src');
        const lib = dir(given.lib, `${src}/lib`);
        return {
            src,
            routes: dir(given.routes, `${src}/routes`),
            gateway: dir(given.gateway, `${src}/gateway`),
            lib,
            config: dir(given.config, `${lib}/config.ts`),
            dbModule: dir(given.dbModule, `${lib}/db.ts`),
            errorHandler: dir(given.errorHandler, `${src}/middleware/error-handler.ts`),
            appError: dir(given.appError, `${lib}/app-error.ts`),
            indexManifest: dir(given.indexManifest, `${src}/db/indexes.ts`),
            documentTypes: dir(given.documentTypes, `${src}/db/collections.ts`),
            database: dir(given.database, 'db'),
        };
    },
    library: (given): LibraryLayout => ({ src: dir(given.src, 'src'), tests: dir(given.tests, 'test') }),
};

const PATHS: { [TPreset in SinglePackagePreset]: (layout: FamilyLayouts[TPreset]) => PresetPaths } = {
    /** Electron desktop: main / preload / renderer under one `src/`, tests in `tests/`. */
    electron: ({ src, main, preload, renderer, tests }): PresetPaths => ({
        /** Shipped code. Excludes tests, which the test block relaxes separately. */
        source: [`${src}/**/*.{ts,vue}`, 'scripts/**/*.ts'],
        /** Everything a tsconfig covers, so type-aware rules can run on it. */
        typedSource: [`${src}/**/*.{ts,vue}`, `${tests}/**/*.ts`, 'vitest.setup.ts', 'scripts/**/*.ts'],
        tests: [`${tests}/**/*.ts`, 'vitest.setup.ts'],
        /** Tests sit outside `src/` and name their helpers freely. */
        namingIgnores: [`${tests}/**/*.ts`, 'vitest.setup.ts'],
        /** Runs in a browser-like context — gets DOM globals. */
        browser: [`${renderer}/**/*.{ts,vue}`],
        /** Runs in Node — gets Node globals. */
        node: [`${main}/**/*.ts`, `${preload}/**/*.ts`, 'scripts/**/*.ts'],
        /** Both sets of globals (an E2E runner driving a browser from Node). */
        nodeAndBrowser: [],
        vue: [`${renderer}/**/*.vue`],
        // A Python virtualenv (a tool installed with pip) is third-party code like node_modules, JS files and all.
        ignores: ['out/', 'dist-electron/', 'node_modules/', '**/.venv/', 'models/', 'coverage/', 'build/'],
        /** The config files that quote rule patterns, so naming-convention is off there. */
        configFiles: ['eslint/**/*.js', 'eslint.config.js'],
    }),

    /**
     * A single-page app: one Vue app built by Vite, in one package, with no server of its own.
     * Tests sit in `__tests__/` beside the code they test, so they are named like it.
     */
    spa: ({ src }): PresetPaths => ({
        source: [`${src}/**/*.{ts,vue}`, 'scripts/**/*.ts'],
        typedSource: [`${src}/**/*.{ts,vue}`, 'scripts/**/*.ts', 'e2e/**/*.ts'],
        tests: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.setup.ts', 'e2e/**/*.ts'],
        namingIgnores: [],
        browser: [`${src}/**/*.{ts,vue}`],
        // The tool configs at the root run in Node too: Vite's, Vitest's, ESLint's own.
        node: ['scripts/**/*.ts', '**/*.setup.ts', '*.config.{js,ts}'],
        nodeAndBrowser: ['e2e/**/*.ts'],
        vue: [`${src}/**/*.vue`],
        // `public/` is copied into the build as it is, so it holds assets, not source.
        ignores: ['dist/', 'node_modules/', 'public/', '**/.venv/', 'coverage/', 'playwright-report/'],
        configFiles: ['eslint/**/*.js', 'eslint.config.js'],
    }),

    /**
     * An API on its own: one Express service in one package, laid out like the full-stack `api`
     * workspace at the root of its own repository, with its clients in other repositories.
     * Everything runs in Node. Tests sit in `__tests__/` beside the code they test, and the
     * migrations in `db/` are run by Node directly.
     */
    api: ({ src, database }): PresetPaths => ({
        source: [`${src}/**/*.ts`, 'scripts/**/*.ts'],
        typedSource: [`${src}/**/*.ts`, 'scripts/**/*.ts', 'e2e/**/*.ts'],
        tests: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.setup.ts', 'e2e/**/*.ts'],
        namingIgnores: [],
        browser: [],
        node: [
            `${src}/**/*.ts`,
            'scripts/**/*.ts',
            'e2e/**/*.ts',
            '**/*.setup.ts',
            `${database}/**/*.js`,
            '*.config.{js,ts}',
        ],
        nodeAndBrowser: [],
        vue: [],
        ignores: ['dist/', 'node_modules/', '**/.venv/', 'backups/', 'coverage/'],
        configFiles: ['eslint/**/*.js', 'eslint.config.js'],
    }),

    /**
     * A Tauri desktop app: the webview is one Vue app in `src/`, the Rust side is `src-tauri/`.
     * A single package, so tests mirror `src/` in `tests/`. `src-tauri/` holds no JavaScript,
     * only Rust, the generated schemas and Cargo's `target/`, so ESLint never walks it.
     */
    tauri: ({ src, tests }): PresetPaths => ({
        source: [`${src}/**/*.{ts,vue}`, 'scripts/**/*.ts'],
        typedSource: [`${src}/**/*.{ts,vue}`, `${tests}/**/*.ts`, 'vitest.setup.ts', 'scripts/**/*.ts'],
        tests: [`${tests}/**/*.ts`, 'vitest.setup.ts'],
        namingIgnores: [`${tests}/**/*.ts`, 'vitest.setup.ts'],
        browser: [`${src}/**/*.{ts,vue}`],
        // The tool configs at the root run in Node too: Vite's, Vitest's, ESLint's own.
        node: ['scripts/**/*.ts', 'vitest.setup.ts', '*.config.{js,ts}'],
        nodeAndBrowser: [],
        vue: [`${src}/**/*.vue`],
        ignores: ['dist/', 'node_modules/', 'src-tauri/', 'public/', '**/.venv/', 'coverage/'],
        configFiles: ['eslint/**/*.js', 'eslint.config.js'],
    }),

    /**
     * A library published to npm: TypeScript in `src/` compiled to `dist/`, suites in `test/`
     * run by `node --test`. Everything runs in Node, and there are no components. A suite may
     * be plain JavaScript importing the `.ts` sources, which Node strips itself, so `test/` is
     * linted either way and type-checked where it is TypeScript.
     */
    library: ({ src, tests }): PresetPaths => ({
        source: [`${src}/**/*.ts`, 'scripts/**/*.ts'],
        typedSource: [`${src}/**/*.ts`, `${tests}/**/*.ts`, 'scripts/**/*.ts'],
        tests: [`${tests}/**/*.{ts,js}`],
        namingIgnores: [`${tests}/**/*.{ts,js}`],
        browser: [],
        node: [`${src}/**/*.ts`, `${tests}/**/*.{ts,js}`, 'scripts/**/*.{ts,js}', '*.config.{js,ts}'],
        nodeAndBrowser: [],
        vue: [],
        // `dist/` is the build, and what `npm pack` ships; it is checked as a package, not as source.
        ignores: ['dist/', 'node_modules/', '**/.venv/', 'coverage/'],
        configFiles: ['eslint/**/*.js', 'eslint.config.js'],
    }),
};

/** The four the family started with. A project overrides any role with `larry({ workspaces })`. */
export const FULLSTACK_WORKSPACES: FullstackWorkspaces = {
    frontend: 'frontend',
    api: 'api',
    services: ['worker'],
    shared: ['packages/shared'],
};

/**
 * The family's roles with the project's moves applied. A role the family does not have
 * throws, so a misspelt or misplaced one cannot leave the default in place unnoticed.
 */
export const resolveLayout = <TPreset extends SinglePackagePreset>(
    preset: TPreset,
    given: LayoutOverrides = {},
): FamilyLayouts[TPreset] => {
    if (!Object.hasOwn(LAYOUTS, preset))
        throw new Error(`No layout for preset '${preset}'. Expected one of: ${Object.keys(LAYOUTS).join(', ')}.`);
    const resolve = LAYOUTS[preset];
    const roles = Object.keys(resolve({}));
    const unknown = Object.keys(given).filter((role) => !roles.includes(role));
    if (unknown.length > 0) {
        throw new Error(
            `larry({ layout }) names ${unknown.map((role) => `'${role}'`).join(', ')}, which the ${preset} preset has no role for. Its roles: ${roles.join(', ')}.`,
        );
    }
    return resolve(given);
};

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

/**
 * The preset's paths, built from its roles — the full-stack family's workspaces, or another
 * family's layout — with the project's overrides applied.
 */
export const resolvePaths = (
    preset: PresetName,
    overrides: Partial<PresetPaths> = {},
    roles: RoleOverrides = {},
): PresetPaths => {
    if (!Object.hasOwn(PRESETS, preset))
        throw new Error(`Unknown preset '${preset}'. Expected one of: ${Object.keys(PRESETS).join(', ')}.`);
    const base = preset === 'fullstack' ? fullstackPaths(fullstackLayout(roles)) : singlePackagePaths(preset, roles);
    return { ...base, ...overrides };
};

/** `src/`, `./src` and `src` are the same folder; the globs below join with one `/`. */
const dir = (given: string | undefined, fallback: string): string =>
    (given ?? fallback).replace(/^\.\//, '').replace(/\/+$/, '');

const singlePackagePaths = (preset: SinglePackagePreset, given: LayoutOverrides): PresetPaths =>
    pathsFor(preset, resolveLayout(preset, given));

/** Generic so the family's layout reaches the builder written for that family. */
const pathsFor = <TPreset extends SinglePackagePreset>(preset: TPreset, layout: FamilyLayouts[TPreset]): PresetPaths =>
    PATHS[preset](layout);

const nodeSource = (dir: string): string => `${dir}/src/**/*.ts`;

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

/** Each preset's paths with its roles at their defaults. */
export const PRESETS: Record<PresetName, PresetPaths> = {
    api: PATHS.api(LAYOUTS.api({})),
    electron: PATHS.electron(LAYOUTS.electron({})),
    fullstack: fullstackPaths(fullstackLayout()),
    library: PATHS.library(LAYOUTS.library({})),
    spa: PATHS.spa(LAYOUTS.spa({})),
    tauri: PATHS.tauri(LAYOUTS.tauri({})),
};
