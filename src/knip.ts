/**
 * knip enables a plugin only when the project lists its package. The linters come
 * from this package instead, so without this their config files read as unused and
 * their CLIs and plugins as unlisted. Only those are ignored: knip warns about
 * ignore entries that match nothing. larry.config.ts is made an entry point the same
 * way, since no plugin knows it.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { KnipConfiguration } from 'knip';

import { CONFIG_FILES } from './config.ts';
import { PROJECT_CLIS } from './toolchain.ts';

type PackageEntriesOptions = {
    /** The package's directory. Defaults to the working directory, where knip and the gates run. */
    root?: string;
    /** Where the build writes. Defaults to `dist`. */
    outDir?: string;
    /** Where the build reads from. Defaults to `src`. */
    rootDir?: string;
};

/** The manifest fields that point an installer at a built file. */
const ENTRY_FIELDS = ['exports', 'main', 'bin'];

/** What stylelint.ts and commitlint.ts resolve to absolute paths, which knip's plugins read back as names. */
const CONFIG_PLUGINS = [
    'stylelint-config-standard-scss',
    'stylelint-scss',
    'stylelint-declaration-strict-value',
    'postcss-html',
    '@commitlint/config-conventional',
];

/**
 * What knip takes as entry points when a workspace names none. Naming one replaces these,
 * so adding larry.config.ts to a workspace that names none writes them in as well.
 */
const KNIP_DEFAULT_ENTRY = [
    '{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!',
    'src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!',
];

/**
 * @param config The project's knip config.
 * @param root The project's directory. Defaults to the working directory, where knip runs.
 * @returns The config, with the plugins for this package's CLIs switched on and larry.config.ts an entry point.
 */
export function knip(config: KnipConfiguration, root = process.cwd()): KnipConfiguration {
    const bins = Object.values(PROJECT_CLIS);
    return {
        ...(Object.fromEntries(bins.map((bin) => [bin, true])) as KnipConfiguration),
        ...withLarryConfig(config, root),
        ignoreBinaries: [...bins, ...(config.ignoreBinaries ?? [])],
        ignoreDependencies: [...CONFIG_PLUGINS, ...(config.ignoreDependencies ?? [])],
    };
}

/**
 * The source files behind a published package's entry points, read back from what its
 * manifest points at: `./dist/gates/audit.js` in `exports`, `main` or `bin` is
 * `src/gates/audit.ts`. Declarations are skipped, and a subpath pattern stays a glob.
 * knip takes them as `entry` (with a `!` each, so `--production` keeps them), and the
 * dead-code gate as `publicApi`, so both read the API from the same place.
 */
export function packageEntries(options: PackageEntriesOptions = {}): string[] {
    const { root = process.cwd(), outDir = 'dist', rootDir = 'src' } = options;
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const pointed =
        typeof manifest === 'object' && manifest !== null
            ? Object.entries(manifest).flatMap(([field, value]: [string, unknown]) =>
                  ENTRY_FIELDS.includes(field) ? [value] : [],
              )
            : [];
    const targets = (value: unknown): string[] => {
        if (typeof value === 'string') return [value];
        if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(targets);
        return [];
    };
    const sources = pointed.flatMap(targets).flatMap((target) => {
        const file = path.posix.normalize(target);
        const ext = /\.([cm]?)js$/.exec(file);
        if (!file.startsWith(`${outDir}/`) || ext === null) return [];
        return [`${rootDir}/${file.slice(outDir.length + 1, ext.index)}.${ext[1] ?? ''}ts`];
    });
    return [...new Set(sources)];
}

/**
 * The config with larry.config.ts an entry of the root workspace, when the project has one.
 * Nothing imports it, since `larry check` loads it by path, so knip would read it as unused.
 * It is a production entry: what it imports from the project is used.
 */
function withLarryConfig(config: KnipConfiguration, root: string): KnipConfiguration {
    const file = CONFIG_FILES.find((name) => fs.existsSync(path.join(root, name)));
    if (file === undefined) return config;
    const addEntry = <TWorkspace extends { entry?: string | string[] | undefined }>(
        workspace: TWorkspace,
    ): TWorkspace => ({
        ...workspace,
        entry: [...(workspace.entry === undefined ? KNIP_DEFAULT_ENTRY : [workspace.entry].flat()), `${file}!`],
    });
    if (config.workspaces === undefined) return addEntry(config);
    return { ...config, workspaces: { ...config.workspaces, '.': addEntry(config.workspaces['.'] ?? {}) } };
}
