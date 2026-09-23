/** `3 swallows` / `1 swallow` — a summary that reads "1 swallows" costs a reader's trust in the rest of the number. */
export declare function plural(n: number, noun: string, plural?: string): string;

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
    standard?: string;
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

export declare function createGateReport(options: GateReportOptions): GateReport;
export default createGateReport;
