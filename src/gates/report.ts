/**
 * The shape every gate reports in. Each failure carries `what` (the violation) and
 * `why` (the reason the rule exists). Failures print grouped by file; a pass prints
 * the summary and a `Not machine-checked` footer saying what the gate cannot prove.
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

/** `3 swallows` / `1 swallow`. */
export function plural(n: number, noun: string, plural = `${noun}s`): string {
    return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * @param options.name The gate's name as it appears in its own output ("Error handling").
 */
export function createGateReport(options: GateReportOptions): GateReport {
    const { name } = options;
    const failures: GateFailure[] = [];

    return {
        /** Record a violation; nothing prints until `report`, so every check runs. */
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
         * @param result.summary The one-line pass message: what the gate proved, with counts.
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
                // Not process.exit(): it can truncate output still buffered on a pipe.
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
