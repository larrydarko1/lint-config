/**
 * knip enables a plugin only when the project lists its package. The linters come
 * from this package instead, so without this their config files read as unused and
 * their CLIs and plugins as unlisted. Only those are ignored: knip warns about
 * ignore entries that match nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { KnipConfiguration } from 'knip';

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

/** The project's knip config, with the plugins for this package's CLIs switched on. */
export function knip(config: KnipConfiguration): KnipConfiguration {
    const bins = Object.values(PROJECT_CLIS);
    return {
        ...(Object.fromEntries(bins.map((bin) => [bin, true])) as KnipConfiguration),
        ...config,
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
