/**
 * knip enables a plugin only when the project lists its package. The linters come
 * from this package instead, so without this their config files read as unused and
 * their CLIs and plugins as unlisted. Only those are ignored: knip warns about
 * ignore entries that match nothing.
 */
import type { KnipConfiguration } from 'knip';

import { PROJECT_CLIS } from './toolchain.ts';

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
