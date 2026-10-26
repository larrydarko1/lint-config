#!/usr/bin/env node
/**
 * The `larry` command. `larry check` runs every gate the project's family runs, with the
 * options in larry.config.ts, and exits 1 if any fails; `larry check audit secrets` runs
 * just those. `larry init` sets a project up, and `larry doctor` says what is wrong with
 * its install. A usage or config mistake exits 2, so CI can tell it from a failing gate.
 */
import path from 'node:path';

import { PRESETS, type PresetName } from '../eslint/presets.ts';
import { findRepoRoot } from '../gates/lib/repo-root.ts';
import { plural } from '../gates/lib/report.ts';
import { gatesFor } from '../gates/registry.ts';
import { SELF_VERSION } from '../toolchain.ts';
import { runGates, summarise } from './check.ts';
import { loadConfig } from './load-config.ts';
import type { Distribution } from './templates.ts';

const USAGE = `Usage: larry check [gate…] [--fix] [--all]
       larry init <family> --distribution <open|closed>
       larry doctor

  larry check              Run every gate the family in larry.config.ts runs.
  larry check audit i18n   Run only the gates named.
    --fix   declaration-order rewrites the import order it can fix.
    --all   dead-code and duplication print the tool's whole report instead of gating.

  larry init spa --distribution closed
                           Write the config files, git hooks, CI workflow, larry.config.ts
                           and package.json scripts a project is missing. Nothing that
                           exists is changed. The family is one of ${Object.keys(PRESETS).join(', ')}.
    --distribution   open if the app's source is published, closed if not (the licenses gate).

  larry doctor             Check Node, the install, the git hooks and the config files.

  larry --version          Print this package's version.`;

/** The flags a gate reads from the command line itself. */
const GATE_FLAGS = new Set(['--fix', '--all']);

/** The package folder this CLI runs from: \`src/cli\` and \`dist/cli\` are both two levels down. */
const RUNNING = path.resolve(import.meta.dirname, '../..');

const isFamily = (name: string): name is PresetName => Object.hasOwn(PRESETS, name);

const isDistribution = (value: string): value is Distribution => value === 'open' || value === 'closed';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The repository root from the working directory, or null after saying why there is none. */
const repoRoot = (): string | null => {
    try {
        return findRepoRoot(process.cwd());
    } catch (error) {
        console.error(`✗ larry: ${message(error)}`);
        return null;
    }
};

async function check(args: string[]): Promise<number> {
    const unknownFlag = args.find((arg) => arg.startsWith('-') && !GATE_FLAGS.has(arg));
    if (unknownFlag !== undefined) {
        console.error(`larry: unknown option ${unknownFlag}\n\n${USAGE}`);
        return 2;
    }

    const root = repoRoot();
    if (root === null) return 2;
    let config;
    try {
        config = await loadConfig(root);
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

async function initProject(args: string[]): Promise<number> {
    const [family, ...flags] = args;
    if (family === undefined || !isFamily(family)) {
        console.error(
            `larry: ${family === undefined ? 'init needs a family' : `"${family}" is not a family`}. It is one of ${Object.keys(PRESETS).join(', ')}.\n\n${USAGE}`,
        );
        return 2;
    }
    // `--distribution closed` and `--distribution=closed` both.
    const distribution = /^--distribution=(.*)$/.exec(flags.join('='))?.[1] ?? '';
    if (!isDistribution(distribution)) {
        console.error(
            `larry: init needs --distribution open or --distribution closed: whether this app's own source is published. The licenses gate allows copyleft dependencies only in an open one.\n\n${USAGE}`,
        );
        return 2;
    }
    const root = repoRoot();
    if (root === null) return 2;

    let result;
    try {
        // Loaded only for its command, so `larry check` does not pay for Prettier.
        const { init } = await import('./init.ts');
        result = await init(root, family, distribution);
    } catch (error) {
        console.error(`✗ larry: ${message(error)}`);
        return 2;
    }
    for (const file of result.written) console.log(`+ ${file}`);
    for (const field of result.added) console.log(`+ package.json ${field}`);
    for (const file of result.kept) console.log(`= ${file} (exists, left as it is)`);
    console.log(`\n✓ larry init: ${family}, ${plural(result.written.length, 'file')} written.\n\nNext:`);
    for (const step of result.next) console.log(`- ${step}`);
    return 0;
}

async function doctor(args: string[]): Promise<number> {
    if (args.length > 0) {
        console.error(`larry: doctor takes no arguments\n\n${USAGE}`);
        return 2;
    }
    const root = repoRoot();
    if (root === null) return 2;

    const { diagnose } = await import('./doctor.ts');
    const found = await diagnose(root, RUNNING);
    const symbol = { ok: '✓', problem: '✗', note: '–' } as const;
    for (const { status, what, fix } of found) {
        console.log(`${symbol[status]} ${what}`);
        if (fix !== undefined) console.log(`  ${fix}`);
    }
    const problems = found.filter(({ status }) => status === 'problem').length;
    console.log(
        problems === 0
            ? `\n✓ larry doctor: nothing wrong in ${root}.`
            : `\n✗ larry doctor: ${plural(problems, 'problem')} in ${root}.`,
    );
    return problems === 0 ? 0 : 1;
}

async function main(args: string[]): Promise<number> {
    const [command, ...rest] = args;
    if (command === 'check') return check(rest);
    if (command === 'init') return initProject(rest);
    if (command === 'doctor') return doctor(rest);
    if (command === '--help' || command === '-h' || command === 'help') {
        console.log(USAGE);
        return 0;
    }
    if (command === '--version' || command === '-v') {
        console.log(SELF_VERSION);
        return 0;
    }
    console.error(command === undefined ? USAGE : `larry: unknown command "${command}"\n\n${USAGE}`);
    return 2;
}

process.exitCode = await main(process.argv.slice(2));
