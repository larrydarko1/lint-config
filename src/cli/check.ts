/**
 * Runs gates one after another in this process, each with its options from the config.
 * A gate reports by printing and setting `process.exitCode`, so the exit code is cleared
 * before each one and read after it.
 */
import { plural } from '../gates/lib/report.ts';
import { GATES, type GateName } from '../gates/registry.ts';
import type { LoadedConfig } from './load-config.ts';

type CheckRun = { passed: GateName[]; failed: GateName[]; skipped: GateName[] };

/** Every gate's `check*` takes its own options type; the config has already been checked against the registry. */
type AnyCheck = (options: Record<string, unknown>) => void | Promise<void>;

/**
 * @param config The loaded config.
 * @param names The gates to run, in order.
 * @returns Which gates passed, failed and were skipped. A gate that throws has failed.
 */
export async function runGates(config: LoadedConfig, names: readonly GateName[]): Promise<CheckRun> {
    const run: CheckRun = { passed: [], failed: [], skipped: [] };

    for (const name of names) {
        console.log(`\n── ${name}`);
        const reason = config.skipped.get(name);
        if (reason !== undefined) {
            console.log(`– skipped: ${reason}`);
            run.skipped.push(name);
            continue;
        }

        process.exitCode = undefined;
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the config's gate names were checked against the registry; its options are typed in the editor, and a gate given the wrong ones fails as it would from a script.
            const check = (await GATES[name].load()) as AnyCheck;
            await check(config.options.get(name) ?? {});
        } catch (error) {
            console.error(`✗ ${name} stopped with an error before it could report:`);
            console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
            process.exitCode = 1;
        }
        (failedExit() ? run.failed : run.passed).push(name);
    }

    process.exitCode = undefined;
    return run;
}

/** The last line of a run: how many gates passed, and which failed or were skipped. */
export function summarise(run: CheckRun): string {
    const total = run.passed.length + run.failed.length;
    const skipped =
        run.skipped.length > 0 ? ` ${plural(run.skipped.length, 'gate')} skipped: ${run.skipped.join(', ')}.` : '';
    if (run.failed.length === 0) return `✓ larry check: ${plural(total, 'gate')} passed.${skipped}`;
    return `✗ larry check: ${run.failed.length} of ${plural(total, 'gate')} failed: ${run.failed.join(', ')}.${skipped}`;
}

const failedExit = (): boolean => Number(process.exitCode ?? 0) !== 0;
