/**
 * Runs gates one after another, each with its options from the config. A gate reports by
 * printing and setting `process.exitCode`, so the exit code is cleared before each one and
 * read after it.
 *
 * In a pipe or CI each gate runs in this process. At a terminal each runs in a process of its
 * own while a spinner says which is running, since a gate blocks on its work and a spinner
 * drawn here would stop with it. Its output is held until it ends, then printed under its
 * heading, so what stays on the screen is what a pipe gets.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { styleText } from 'node:util';

import { plural } from '../gates/lib/report.ts';
import { GATES, type GateName } from '../gates/registry.ts';
import type { LoadedConfig } from './load-config.ts';
import { spinner } from './spinner.ts';

type CheckRun = { passed: GateName[]; failed: GateName[]; skipped: GateName[] };

/** A run at a terminal: where it draws, and what each gate's process is given. */
type Terminal = {
    /** The repository root, where each gate's process loads the config from. */
    root: string;
    /** The flags a gate reads from the command line itself. */
    flags: string[];
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
};

/** Every gate's `check*` takes its own options type; the config has already been checked against the registry. */
type AnyCheck = (options: Record<string, unknown>) => void | Promise<void>;

/** `.ts` from source, `.js` once built, as this file is. */
const RUN_GATE = path.join(import.meta.dirname, `run-gate${path.extname(import.meta.filename)}`);

/**
 * @param config The loaded config.
 * @param names The gates to run, in order.
 * @param terminal Given at a terminal, to run each gate in its own process under a spinner.
 * @returns Which gates passed, failed and were skipped. A gate that throws has failed.
 */
export async function runGates(
    config: LoadedConfig,
    names: readonly GateName[],
    terminal?: Terminal,
): Promise<CheckRun> {
    const run: CheckRun = { passed: [], failed: [], skipped: [] };
    const { stdout } = terminal ?? process;

    for (const [index, name] of names.entries()) {
        const reason = config.skipped.get(name);
        if (reason !== undefined) {
            stdout.write(
                `${heading(name, stdout)}\n${styleText('yellow', '–', { stream: stdout })} skipped: ${reason}\n`,
            );
            run.skipped.push(name);
            continue;
        }

        let passed;
        if (terminal === undefined) {
            stdout.write(`${heading(name, stdout)}\n`);
            passed = await runGate(config, name);
        } else {
            passed = await runInChild(terminal, name, `${index + 1} of ${names.length}`);
        }
        (passed ? run.passed : run.failed).push(name);
    }

    return run;
}

/**
 * Runs one gate in this process.
 *
 * @returns Whether it passed.
 */
export async function runGate(config: LoadedConfig, name: GateName): Promise<boolean> {
    process.exitCode = undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the config's gate names were checked against the registry; its options are typed in the editor, and a gate given the wrong ones fails as it would from a script.
        const check = (await GATES[name].load()) as AnyCheck;
        await check(config.options.get(name) ?? {});
    } catch (error) {
        stopped(name, error);
        process.exitCode = 1;
    }
    const passed = !failedExit();
    process.exitCode = undefined;
    return passed;
}

/** The last line of a run: how many gates passed, and which failed or were skipped. */
export function summarise(run: CheckRun, stream: NodeJS.WritableStream = process.stdout): string {
    const total = run.passed.length + run.failed.length;
    const skipped =
        run.skipped.length > 0 ? ` ${plural(run.skipped.length, 'gate')} skipped: ${run.skipped.join(', ')}.` : '';
    if (run.failed.length === 0) {
        return `${styleText('green', '✓', { stream })} ${styleText('bold', `larry check: ${plural(total, 'gate')} passed.`, { stream })}${skipped}`;
    }
    return `${styleText('red', '✗', { stream })} ${styleText('bold', `larry check: ${run.failed.length} of ${plural(total, 'gate')} failed: ${run.failed.join(', ')}.`, { stream })}${skipped}`;
}

/** The line each gate's report starts under. */
const heading = (name: GateName, stream: NodeJS.WritableStream): string =>
    `\n${styleText('dim', '──', { stream })} ${styleText('bold', name, { stream })}`;

/** Says a gate threw rather than reporting. */
function stopped(name: GateName, error: unknown, stream: NodeJS.WritableStream = process.stderr): void {
    stream.write(`✗ ${name} stopped with an error before it could report:\n`);
    stream.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
}

/**
 * Runs one gate in a process of its own under a spinner, then prints its heading and what it printed.
 *
 * @param position Where the gate comes in the run, e.g. "3 of 12".
 * @returns Whether it passed.
 */
async function runInChild(terminal: Terminal, name: GateName, position: string): Promise<boolean> {
    const { root, flags, stdout, stderr } = terminal;
    const child = spawn(process.execPath, [RUN_GATE, root, name, ...flags], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Each chunk with the stream it was written to, in the order they came.
    const output: [NodeJS.WritableStream, Buffer][] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push([stdout, chunk]));
    child.stderr.on('data', (chunk: Buffer) => output.push([stderr, chunk]));

    const turning = spinner(stdout, `${name} ${styleText('dim', position, { stream: stdout })}`);
    // The cursor comes back before Ctrl-C stops larry: the handler goes, and the signal is sent again.
    const interrupt = (): void => {
        turning.stop();
        child.kill();
        process.kill(process.pid, 'SIGINT');
    };
    process.once('SIGINT', interrupt);
    let failure: unknown;
    try {
        await once(child, 'close');
    } catch (error) {
        failure = error;
    } finally {
        process.off('SIGINT', interrupt);
        turning.stop();
    }

    stdout.write(`${heading(name, stdout)}\n`);
    for (const [stream, chunk] of output) stream.write(chunk);
    if (failure !== undefined) stopped(name, failure, stderr);
    else if (child.signalCode !== null) stderr.write(`✗ ${name} was stopped by ${child.signalCode}.\n`);
    return failure === undefined && child.exitCode === 0;
}

const failedExit = (): boolean => Number(process.exitCode ?? 0) !== 0;
