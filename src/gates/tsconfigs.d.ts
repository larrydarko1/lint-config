export type TsconfigProblem = {
    /** `path` or `path:line`. */
    file: string;
    what: string;
    why: string;
};

export type TsconfigsInspection = {
    problems: TsconfigProblem[];
    /** Every config that checks code: not the base, not a solution file. */
    projects: string[];
    /** How many checking flags the base was held to. */
    flagCount: number;
};

export type TsconfigsOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The instructions file to point at on failure. Omit where the repo documents none. */
    standard?: string;
    /** The one config that owns strictness. Defaults to `tsconfig.base.json`. */
    base?: string;
    /** Checking flags the base must hold, at the strict value. Defaults to `BASE_FLAGS`. */
    baseFlags?: Record<string, boolean>;
    /** Settings the base may NOT hold, because they describe an environment. Defaults to `ENVIRONMENTAL`. */
    environmental?: string[];
    /** Section dividers, in the order they must appear. Defaults to `SECTIONS`. */
    sections?: string[];
    /** Extra directory names to skip, beyond the build-output defaults. */
    ignore?: string[];
    /** Configs that must declare exactly `["node"]` — a service, nothing else in scope. */
    nodeTyped?: string[];
    /** Configs for a browser program: no `node` in `types` without a reason, ES and DOM libs only. */
    browserProjects?: string[];
    /** Source trees bundled for a browser. No file in them may reach for Node. Tests are exempt. */
    browserSources?: string[];
    /** Configs for a package consumed as TypeScript source, which may set no emit setting. */
    nonEmitting?: string[];
};

export type TsconfigsInput = Omit<TsconfigsOptions, 'standard' | 'root'> & { root: string };

/** Checking flags the base owns, at the strict value. Identical in every repo checked. */
export declare const BASE_FLAGS: Record<string, boolean>;
/** Settings that describe an environment rather than a checking rule. */
export declare const ENVIRONMENTAL: string[];
/** Section dividers, in the order they must appear. */
export declare const SECTIONS: string[];

export declare function inspectTsconfigs(options: TsconfigsInput): TsconfigsInspection;
export declare function checkTsconfigs(options?: TsconfigsOptions): void;
export default checkTsconfigs;
