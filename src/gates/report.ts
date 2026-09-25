/**
 * The shape every gate reports in.
 *
 * Fifteen of the gates across the two families had their own copy of the same
 * three things: a `failures` array, a `fail(file, what, why)` that pushes onto it,
 * and a report block that prints them and exits. The copies had drifted into two
 * output formats and two opinions about the closing line, which is how a developer
 * ends up reading each gate's output differently.
 *
 * WHY THREE FIELDS AND NOT A MESSAGE. `what` is the violation and `why` is the
 * reason the rule exists. Keeping them apart is what stops a gate becoming a wall
 * of unexplained "invalid" lines: a gate whose failures cannot be justified in a
 * sentence is a gate that will be switched off the first time it is inconvenient.
 *
 * TWO CHOICES MERGED. Failures are grouped by file (the desktop family's format —
 * it reads far better when one file has twenty problems), and a passing run prints
 * the `Not machine-checked` footer (the full-stack family's convention). The
 * footer is the more useful half of a gate's output:
 * it says what a green tick does NOT prove, so nobody mistakes the gate for the
 * standard.
 */

export type GateFailure = {
    /** `path` or `path:line`. Null for a finding that belongs to no single file. */
    file: string | null;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
};

export type GateReportOptions = {
    /** The gate's name as it appears in its own output, e.g. "Error handling". */
    name: string;
    /** The instructions file to point at on failure. */
    standard?: string | undefined;
};

export type GateResult = {
    /** The one-line pass message: what the gate actually proved, with counts. */
    summary: string;
    /** What this gate cannot see, so a green tick is not mistaken for the whole standard. */
    notMachineChecked?: string;
};

/**
 * Declared as properties holding functions rather than as methods: these are closures
 * with no `this`, and a method signature makes `unbound-method` flag every destructuring.
 */
export type GateReport = {
    fail: (file: string | null, what: string, why: string) => void;
    readonly count: number;
    readonly failures: GateFailure[];
    done: (result: GateResult) => void;
};

/**
 * `3 swallows` / `1 swallow`. Gate summaries quote counts constantly and a summary
 * that reads "1 swallows" is the kind of small wrongness that makes a reader stop
 * trusting the rest of the number.
 */
export function plural(n: number, noun: string, plural = `${noun}s`): string {
    return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * @param options.name The gate's name as it appears in its own output ("Error handling").
 * @param [options.standard] The instructions file to point at on failure.
 */
export function createGateReport(options: GateReportOptions): GateReport {
    const { name, standard } = options;
    const failures: GateFailure[] = [];

    return {
        /**
         * Record a violation. Recording is separate from reporting so a gate runs every
         * check before printing: stopping at the first failure means fixing them one
         * commit at a time.
         */
        fail(file: string | null, what: string, why: string): void {
            failures.push({ file, what, why });
        },

        /** How many violations have been recorded so far. */
        get count() {
            return failures.length;
        },

        /** The recorded violations, for a gate that needs to summarise them itself. */
        get failures() {
            return [...failures];
        },

        /**
         * Print the report and set the exit code. Always the last thing a gate does.
         *
         * @param result.summary The one-line pass message — what the gate actually
         *   proved, with counts. "passed" on its own tells a reader nothing.
         * @param [result.notMachineChecked] What this gate cannot see, so a green
         *   tick is not mistaken for the whole standard.
         */
        done(result: GateResult): void {
            const { summary, notMachineChecked } = result;

            if (failures.length > 0) {
                console.error(`✗ ${name} check failed — ${failures.length} problem(s):\n`);
                let current = undefined as string | null | undefined;
                for (const { file, what, why } of failures) {
                    if (file !== current) {
                        console.error(file === null ? '  (project-wide)' : `  ${file}`);
                        current = file;
                    }
                    console.error(`    • ${what}`);
                    console.error(`      ${why}\n`);
                }
                if (standard !== undefined) console.error(`See ${standard}, then re-run.`);
                // Not process.exit(): that can truncate output still buffered on a pipe,
                // which is exactly where a CI log reads it from.
                process.exitCode = 1;
                return;
            }

            console.log(`✓ ${summary}`);
            if (notMachineChecked !== undefined) {
                console.log(`\nNot machine-checked: ${notMachineChecked}`);
            }
        },
    };
}
