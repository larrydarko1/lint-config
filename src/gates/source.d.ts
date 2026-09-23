/** Reading structure out of source text without parsing it. See source.js. */

/** The argument text of every `token(…)` call, bracket-balanced. `token` ends in `(`. */
export declare function callArgs(source: string, token: string): string[];

/** The brace-balanced body of the first block whose `{` follows a match of `opener`. */
export declare function braceBlock(source: string, opener: RegExp): string;

/** A file sliced from `header` to the next top-level `export`; `''` when absent. */
export declare function fnBody(source: string, header: string): string;

/** The body text of every `catch (…) { … }` block, brace-balanced. */
export declare function catchBodies(source: string): string[];

/** Evaluate a literal product like `2 * 60 * 60 * 1000`; `0` for anything else. */
export declare function evalProduct(expression: string | undefined): number;
