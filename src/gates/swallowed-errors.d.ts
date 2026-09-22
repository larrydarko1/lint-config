import type { GateFailure } from './report.js';

export type SwallowScanOptions = {
    /** Repository root. */
    root: string;
    /** Paths to scan, relative to `root`. */
    files: string[];
};

/** One entry per empty catch block whose comment gives no reason (or none at all). */
export declare function findSwallowedErrors(options: SwallowScanOptions): (GateFailure & { file: string })[];
/** How many empty catch blocks were examined, explained or not. */
export declare function countSwallows(options: SwallowScanOptions): number;
export default findSwallowedErrors;
