import type { GateFailure } from './report.js';

export type Ceiling = {
    /** Percentage of duplicated tokens this format may not exceed. */
    limit: number;
    /** Why this format's number is where it is. Printed as the failure's reason. */
    note?: string;
};

export type CrossCloneAllowance = {
    /** The two repo-relative paths, in either order. */
    files: [string, string];
    /** What makes the two copies composition rather than logic. */
    why: string;
};

/** jscpd's JSON report, reduced to what this gate reads. */
export type CloneLocation = { name: string; start: number; end: number };
export type Clone = {
    format: string;
    lines: number;
    tokens: number;
    firstFile: CloneLocation;
    secondFile: CloneLocation;
};
export type JscpdReport = {
    duplicates: Clone[];
    statistics: {
        formats: Record<string, { percentageTokens: number; clones: number } | undefined>;
        total: { clones: number };
    };
};

export type DuplicationOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /** Source trees to scan. One entry means the cross-root rules say nothing. */
    scan: string[];
    /** Per-format token-percentage ceilings. A format with no entry is not gated. */
    ceilings: Record<string, number | Ceiling>;
    /** Also hold each scan root to the ceilings on its own, one jscpd run per root. */
    perRoot?: boolean;
    /** No single clone may exceed this many tokens. Omitted means not gated. */
    maxCloneTokens?: number;
    /** Cross-root clones that are composition roots, not logic. */
    crossCloneAllowed?: CrossCloneAllowance[];
    /** jscpd config file, relative to `root`. Defaults to `.jscpd.json`. */
    config?: string;
    /** Directories the exported-type-name rule does not descend into. */
    ignoreDirs?: string[];
};

export type TypeDeclaration = { root: string; where: string };

export type DuplicationInput = {
    root: string;
    /** The run over every scan root at once. */
    report: JscpdReport;
    /** One run per scan root, keyed by root. Absent roots are simply not checked. */
    perRootReports?: Record<string, JscpdReport>;
    /** Exported type names and where each was declared. */
    declarations?: Map<string, TypeDeclaration[]>;
    scan: string[];
    ceilings: Record<string, number | Ceiling>;
    maxCloneTokens?: number;
    crossCloneAllowed?: CrossCloneAllowance[];
};

export type DuplicationInspection = {
    problems: GateFailure[];
    /** How many distinct exported type names were seen. */
    types: number;
};

/** Every exported type and interface name under `scan`, and where it was declared. */
export declare function exportedTypes(
    root: string,
    scan: string[],
    ignoreDirs?: string[],
): Map<string, TypeDeclaration[]>;

/** Every rule, decided from a jscpd report — no filesystem, no child process. */
export declare function inspectDuplication(input: DuplicationInput): DuplicationInspection;

export declare function checkDuplication(options: DuplicationOptions): void;
export default checkDuplication;
