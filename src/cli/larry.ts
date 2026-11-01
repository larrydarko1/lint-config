#!/usr/bin/env node
/**
 * The `larry` command. `larry check` runs every gate the project's family runs, with the
 * options in larry.config.ts, and exits 1 if any fails; `larry check audit secrets` runs
 * just those. `larry init` sets a project up, asking at a terminal for what its flags
 * leave out, `larry doctor` says what is wrong with its install, and `larry upgrade`
 * rewrites what an older release set up. A usage or config mistake exits 2, so CI can tell
 * it from a failing gate, and stopping init at a question exits 130. Its output is coloured
 * at a terminal only: `styleText` leaves it plain for a pipe, `NO_COLOR` or `FORCE_COLOR=0`,
 * so the text a script reads is the same either way.
 */
import path from 'node:path';
import { styleText } from 'node:util';

import { FAMILIES, isFamily } from '../eslint/presets.ts';
import { findRepoRoot } from '../gates/lib/repo-root.ts';
import { plural } from '../gates/lib/report.ts';
import { gatesFor } from '../gates/registry.ts';
import { SELF_VERSION } from '../toolchain.ts';
import { runGates, summarise } from './check.ts';
import type { InitOptions } from './init.ts';
import { loadConfig } from './load-config.ts';
import type { Distribution, Runtime } from './templates.ts';

const USAGE = `Usage: larry check [gate…] [--fix] [--all]
       larry init <family> --distribution <open|closed> [--runtime <node|browser|both>]
       larry doctor
       larry upgrade [--dry-run]

  larry check              Run every gate the family in larry.config.ts runs.
  larry check audit i18n   Run only the gates named.
    --fix   declaration-order rewrites the import order it can fix.
    --all   dead-code and duplication print the tool's whole report instead of gating.

  larry init spa --distribution closed
                           Write the config files, git hooks, CI workflow, larry.config.ts
                           and package.json scripts a project is missing. Nothing that
                           exists is changed. The family is one of ${FAMILIES.join(', ')}.
                           At a terminal, \`larry init\` asks for whatever is left out; in CI
                           or a pipe, it is a usage error.
    --distribution   open if the app's source is published, closed if not (the licenses gate).
    --runtime        base only, and required there: where the source runs. The base family
                     assumes no layout, so its eslint.config.js names the folders init finds.

  larry doctor             Check Node, the install, the git hooks and the config files.

  larry upgrade            Rewrite what an older release set up into what this one reads:
                           gate scripts into larry.config.ts, renamed options to their new
                           names. Read the diff afterwards.
    --dry-run   List the changes without writing them.

  larry --version          Print this package's version.`;

/** The flags a gate reads from the command line itself. */
const GATE_FLAGS = new Set(['--fix', '--all']);

const INIT_FLAGS = ['--distribution', '--runtime'];

const NEEDS_DISTRIBUTION =
    "init needs --distribution open or --distribution closed: whether this app's own source is published. The licenses gate allows copyleft dependencies only in an open one.";

const NEEDS_RUNTIME =
    'the base family needs --runtime node, --runtime browser or --runtime both: where its source runs, which no file says.';

/** The package folder this CLI runs from: \`src/cli\` and \`dist/cli\` are both two levels down. */
const RUNNING = path.resolve(import.meta.dirname, '../..');

const isDistribution = (value: string): value is Distribution => value === 'open' || value === 'closed';

const isRuntime = (value: string): value is Runtime => value === 'node' || value === 'browser' || value === 'both';

/** A flag's value, given as `--name value` or `--name=value`. Undefined when the flag is not there. */
const flagValue = (flags: string[], name: string): string | undefined => {
    const at = flags.findIndex((flag) => flag === name || flag.startsWith(`${name}=`));
    if (at === -1) return undefined;
    const flag = flags[at] ?? '';
    return flag === name ? flags[at + 1] : flag.slice(name.length + 1);
};

/**
 * Whether a person is at the terminal to answer init's questions. A pipe or CI is not,
 * so there a missing option stays a usage error rather than a prompt nobody answers.
 */
const interactive = (): boolean =>
    process.stdin.isTTY && process.stdout.isTTY && ['', '0', 'false'].includes(process.env['CI'] ?? '');

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The commands in a line, the `backticked` spans, in the colour init gives the command it ends with.
 *
 * @param stream Where the line goes, which decides whether it is coloured.
 */
const commands = (line: string, stream: NodeJS.WriteStream = process.stdout): string =>
    line.replaceAll(/`[^`]+`/g, (span) => styleText('cyan', span, { stream }));

/** Says on stderr why larry stopped. */
const fail = (problem: string): void => {
    const { stderr } = process;
    console.error(`${styleText('red', '✗', { stream: stderr })} larry: ${commands(problem, stderr)}`);
};

/** The repository root from the working directory, or null after saying why there is none. */
const repoRoot = (): string | null => {
    try {
        return findRepoRoot(process.cwd());
    } catch (error) {
        fail(message(error));
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
        fail(message(error));
        return 2;
    }

    const runs = gatesFor(config.family);
    const named = args.filter((arg) => !arg.startsWith('-'));
    const notRun = named.filter((name) => !(runs as readonly string[]).includes(name));
    if (notRun.length > 0) {
        fail(
            `${notRun.map((n) => `"${n}"`).join(', ')} ${notRun.length === 1 ? 'is not a gate' : 'are not gates'} ${config.family} projects run. They run: ${runs.join(', ')}.`,
        );
        return 2;
    }

    // Named gates run in the registry's order, as a whole run would.
    const run = await runGates(config, named.length > 0 ? runs.filter((name) => named.includes(name)) : runs);
    console.log(`\n${summarise(run)}`);
    return run.failed.length > 0 ? 1 : 0;
}

async function initProject(args: string[]): Promise<number> {
    const [first] = args;
    const named = first === undefined || first.startsWith('-') ? undefined : first;
    const flags = named === undefined ? args : args.slice(1);
    const usage = (problem: string): number => {
        console.error(`larry: ${problem}\n\n${USAGE}`);
        return 2;
    };

    if (named !== undefined && !isFamily(named)) {
        return usage(`"${named}" is not a family. It is one of ${FAMILIES.join(', ')}.`);
    }
    const unknownFlag = flags.find((flag) => flag.startsWith('-') && !INIT_FLAGS.includes(flag.split('=')[0] ?? ''));
    if (unknownFlag !== undefined) return usage(`unknown option ${unknownFlag}`);
    const distribution = flagValue(flags, '--distribution');
    if (distribution !== undefined && !isDistribution(distribution)) return usage(NEEDS_DISTRIBUTION);
    const runtime = flagValue(flags, '--runtime');
    if (runtime !== undefined && named !== 'base') {
        return usage(
            named === undefined
                ? `--runtime is for the base family: name it, as in \`larry init base --runtime ${runtime}\`.`
                : `--runtime is for the base family; the ${named} family knows where its code runs.`,
        );
    }
    if (runtime !== undefined && !isRuntime(runtime)) return usage(NEEDS_RUNTIME);

    if (interactive()) {
        const root = repoRoot();
        if (root === null) return 2;
        const { initInteractively } = await import('./init-prompts.ts');
        return initInteractively(root, { family: named, distribution, runtime });
    }
    if (named === undefined) return usage(`init needs a family. It is one of ${FAMILIES.join(', ')}.`);
    if (distribution === undefined) return usage(NEEDS_DISTRIBUTION);
    if (named === 'base' && runtime === undefined) return usage(NEEDS_RUNTIME);
    const root = repoRoot();
    if (root === null) return 2;
    return initPlainly(root, { family: named, distribution, runtime: runtime ?? null });
}

/** `larry init` with every option given and no terminal to ask at: what it wrote, one line each. */
async function initPlainly(root: string, options: InitOptions): Promise<number> {
    let result;
    try {
        // Loaded only for its command, so `larry check` does not pay for Prettier.
        const { init } = await import('./init.ts');
        result = await init(root, options);
    } catch (error) {
        fail(message(error));
        return 2;
    }
    for (const file of result.written) console.log(`+ ${file}`);
    for (const field of result.added) console.log(`+ package.json ${field}`);
    for (const file of result.kept) console.log(`= ${file} (exists, left as it is)`);
    console.log(`\n✓ larry init: ${options.family}, ${plural(result.written.length, 'file')} written.\n\nNext:`);
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
    const symbol = { ok: styleText('green', '✓'), problem: styleText('red', '✗'), note: styleText('yellow', '–') };
    for (const { status, what, fix } of found) {
        console.log(`${symbol[status]} ${commands(what)}`);
        if (fix !== undefined) console.log(`  ${commands(fix)}`);
    }
    const problems = found.filter(({ status }) => status === 'problem').length;
    console.log(
        problems === 0
            ? `\n${symbol.ok} ${styleText('bold', `larry doctor: nothing wrong in ${root}.`)}`
            : `\n${symbol.problem} ${styleText('bold', `larry doctor: ${plural(problems, 'problem')} in ${root}.`)}`,
    );
    return problems === 0 ? 0 : 1;
}

async function upgradeProject(args: string[]): Promise<number> {
    const unknown = args.find((arg) => arg !== '--dry-run');
    if (unknown !== undefined) {
        console.error(`larry: upgrade takes only --dry-run, not ${unknown}\n\n${USAGE}`);
        return 2;
    }
    const write = !args.includes('--dry-run');
    const root = repoRoot();
    if (root === null) return 2;

    let steps;
    try {
        const { upgrade } = await import('./upgrade.ts');
        steps = await upgrade(root, write);
    } catch (error) {
        fail(message(error));
        return 2;
    }
    // A removed file and a note both start with "-"; the colour tells them apart.
    const symbol = { added: styleText('green', '+'), changed: styleText('blue', '~'), removed: styleText('red', '-') };
    for (const { title, changed, notes } of steps) {
        console.log(`\n${styleText('dim', '──')} ${styleText('bold', title)}`);
        for (const { file, how } of changed) console.log(`${symbol[how]} ${file}`);
        for (const note of notes) console.log(`${styleText('yellow', '-')} ${commands(note)}`);
    }
    const files = new Set(steps.flatMap(({ changed }) => changed.map(({ file }) => file))).size;
    // A blank line parts the summary from the steps above it, when there are any.
    const done = (summary: string): void => {
        console.log(
            `${steps.length === 0 ? '' : '\n'}${styleText('green', '✓')} ${styleText('bold', commands(summary))}`,
        );
    };
    if (files === 0) {
        done(steps.length === 0 ? 'larry upgrade: nothing to upgrade.' : 'larry upgrade: nothing changed.');
    } else if (write) {
        done(`larry upgrade: ${plural(files, 'file')} changed. Read the diff, then run \`npm run ci:check\`.`);
    } else {
        done(`larry upgrade --dry-run: ${plural(files, 'file')} would change. Nothing was written.`);
    }
    return 0;
}

async function main(args: string[]): Promise<number> {
    const [command, ...rest] = args;
    if (command === 'check') return check(rest);
    if (command === 'init') return initProject(rest);
    if (command === 'doctor') return doctor(rest);
    if (command === 'upgrade') return upgradeProject(rest);
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
