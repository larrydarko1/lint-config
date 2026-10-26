#!/usr/bin/env node
/**
 * The `larry` command. `larry check` runs every gate the project's family runs, with the
 * options in larry.config.ts, and exits 1 if any fails; `larry check audit secrets` runs
 * just those. A usage or config mistake exits 2, so CI can tell it from a failing gate.
 */
import fs from 'node:fs';

import { findRepoRoot } from '../gates/lib/repo-root.ts';
import { gatesFor } from '../gates/registry.ts';
import { runGates, summarise } from './check.ts';
import { loadConfig } from './load-config.ts';

const USAGE = `Usage: larry check [gate…] [--fix] [--all]

  larry check              Run every gate the family in larry.config.ts runs.
  larry check audit i18n   Run only the gates named.

  --fix   declaration-order rewrites the import order it can fix.
  --all   dead-code and duplication print the tool's whole report instead of gating.

  larry --version          Print this package's version.`;

/** The flags a gate reads from the command line itself. */
const GATE_FLAGS = new Set(['--fix', '--all']);

/** `src/` and `dist/` both sit two levels below the manifest. */
const readVersion = (): string => {
    const manifest: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof manifest === 'object' && manifest !== null && 'version' in manifest ? String(manifest.version) : '';
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function check(args: string[]): Promise<number> {
    const unknownFlag = args.find((arg) => arg.startsWith('-') && !GATE_FLAGS.has(arg));
    if (unknownFlag !== undefined) {
        console.error(`larry: unknown option ${unknownFlag}\n\n${USAGE}`);
        return 2;
    }

    let config;
    try {
        config = await loadConfig(findRepoRoot(process.cwd()));
    } catch (error) {
        console.error(`✗ larry: ${message(error)}`);
        return 2;
    }

    const runs = gatesFor(config.family);
    const named = args.filter((arg) => !arg.startsWith('-'));
    const notRun = named.filter((name) => !(runs as readonly string[]).includes(name));
    if (notRun.length > 0) {
        console.error(
            `✗ larry: ${notRun.map((n) => `"${n}"`).join(', ')} ${notRun.length === 1 ? 'is not a gate' : 'are not gates'} ${config.family} projects run. They run: ${runs.join(', ')}.`,
        );
        return 2;
    }

    // Named gates run in the registry's order, as a whole run would.
    const run = await runGates(config, named.length > 0 ? runs.filter((name) => named.includes(name)) : runs);
    console.log(`\n${summarise(run)}`);
    return run.failed.length > 0 ? 1 : 0;
}

async function main(args: string[]): Promise<number> {
    const [command, ...rest] = args;
    if (command === 'check') return check(rest);
    if (command === '--help' || command === '-h' || command === 'help') {
        console.log(USAGE);
        return 0;
    }
    if (command === '--version' || command === '-v') {
        console.log(readVersion());
        return 0;
    }
    console.error(command === undefined ? USAGE : `larry: unknown command "${command}"\n\n${USAGE}`);
    return 2;
}

process.exitCode = await main(process.argv.slice(2));
