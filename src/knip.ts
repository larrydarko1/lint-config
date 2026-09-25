/**
 * knip config: the project's own entry points and paths, plus what knip cannot
 * work out for itself once the lint toolchain comes from this package.
 *
 * knip switches a plugin on when the project lists the plugin's package. A
 * project that lists none of the linters gets none of the plugins, so every file
 * they read — eslint.config.js, prettier.config.js, commitlint.config.js,
 * lint-staged.config.js — comes back as an unused file, and the dead-code gate
 * fails on four files that are very much alive.
 *
 * The same missing listing makes knip report, in `--all`, the CLIs as unlisted
 * binaries and the packages the Stylelint and commitlint configs hand over by
 * path as unlisted dependencies. Both are ignored here, but only those: knip
 * answers an ignore entry that matches nothing with a "remove from ignore…"
 * hint, so ignoring everything this package installs would bury the project's
 * real hints under twenty false ones.
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
