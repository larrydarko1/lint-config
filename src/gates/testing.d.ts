/** Where this project put its suites. The pattern is data; the rule is the same either way. */
export type TestLayout =
    | { kind: 'colocated' }
    | {
          kind: 'mirrored';
          /** The tree the suites live in, e.g. `tests`. */
          root: string;
          /** The `src/` directories it mirrors one-for-one. Omit to allow any. */
          areas?: string[];
      };

/** Where the E2E suite lives, or `false` where there deliberately is none. */
export type E2eLayout = false | { dir: string; config: string };

export type CoverageThresholds = {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
};

export type DomEnvironment = {
    /** The environment the standard names, e.g. `jsdom`. */
    name: string;
    /** The config that sets it. */
    config: string;
    /** A named Vitest project inside that config, where the config has more than one. */
    project?: string;
};

export type TestingOptions = {
    root?: string;
    /** The config holding the coverage thresholds and excludes. */
    config: string;
    layout: TestLayout;
    e2e?: E2eLayout;
    /** The floors as they stand. They may rise, never fall. */
    thresholds?: CoverageThresholds;
    /** Every path the coverage config may exclude, mapped to why it is not a coverage gap. */
    excludes?: Record<string, string>;
    coverageSummary?: string;
    domEnvironment?: DomEnvironment;
    /** Sites reading a component through `wrapper.vm`, as a ratchet. Raise it with a reason. */
    vmBaseline?: number;
    /** The document to point at on failure. */
    standard?: string;
};

export type TestingInput = Omit<TestingOptions, 'standard'> & { root: string };

export type TestingProblem = {
    file: string;
    what: string;
    why: string;
};

export type TestingInspection = {
    problems: TestingProblem[];
    /** `.test.ts` files found. */
    suites: number;
    /** `.spec.ts` / `.spec.js` files found. */
    specs: number;
    /** Files in the coverage report, when one was present. */
    measured: number;
    /** Files in it with no covered statement at all. */
    uncovered: number;
    haveCoverage: boolean;
};

export type HygieneRule = {
    re: RegExp;
    what: string;
    why: string;
};

export declare const HYGIENE: HygieneRule[];
/** Tracked and untracked-but-not-ignored files that still exist on disk. */
export declare const repoFiles: (root: string) => string[];
/** Case titles repeated inside one `describe`, which is a copy-paste that lost its edit. */
export declare const duplicateTitles: (source: string) => { title: string; count: number }[];
export declare const inspectTesting: (input: TestingInput) => TestingInspection;
export declare const checkTesting: (options: TestingOptions) => void;
export default checkTesting;
