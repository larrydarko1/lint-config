export type DeadCodeCategory = { label: string; fix: string };

/** One knip finding, flattened. `name === file` means the whole file is unused. */
export type DeadCodeHit = { file: string; name: string; line: number | undefined };

export type KnipItem = { name: string; line?: number };

/** knip --reporter json, reduced to what this gate reads. */
export type KnipReport = { issues?: ({ file: string } & Record<string, unknown>)[] };

export type KnipRunInput = {
    root: string;
    /** Absolute path to the knip binary. */
    bin: string;
    include: string[];
    extra?: string[];
};

export type DeadCodeOptions = {
    root?: string;
    /** Max findings per category. Zero unless a backlog is still being cleared. */
    budgets?: Record<string, number>;
    /** Where this project keeps its gates, for the closing hint. */
    checksDir?: string;
    /** The runtime-reachability examples this repo would recognise. */
    notMachineChecked?: string;
};

/** Every knip issue type this gate fails on; doubles as the `--include` list. */
export declare const CATEGORIES: Record<string, DeadCodeCategory>;

/** The second pass, keyed separately — `testOnlyExports` is this gate's word, not knip's. */
export declare const TEST_ONLY: DeadCodeCategory & { key: string };

export declare const runKnip: (input: KnipRunInput) => Record<string, DeadCodeHit[]>;

export declare const collectHits: (report: KnipReport, include: string[]) => Record<string, DeadCodeHit[]>;

export declare const inspectDeadCode: (
    knip: (include: string[], extra?: string[]) => Record<string, DeadCodeHit[]>,
) => Record<string, DeadCodeHit[]>;

/** The budget decision, separated from the run so it is testable without knip. */
export declare const deadCodeProblems: (
    found: Record<string, DeadCodeHit[]>,
    budgets?: Record<string, number>,
    checksDir?: string,
) => { what: string; why: string }[];

export declare const checkDeadCode: (options?: DeadCodeOptions) => void;

export default checkDeadCode;
