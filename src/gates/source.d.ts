/** Reading structure out of source text without parsing it. See source.js. */

export interface CallSite {
    /** Byte offset of the first character of the call. */
    index: number;
    /** Byte offset of the matching `)`. */
    end: number;
    /** The argument text between the parens. */
    args: string;
}

/** Every `token(…)` call with its position and bracket-balanced arguments. `token` ends in `(`. */
export declare function callSites(source: string, token: string): CallSite[];

/** The argument text of every `token(…)` call, bracket-balanced. `token` ends in `(`. */
export declare function callArgs(source: string, token: string): string[];

/** The brace-balanced body of the first block whose `{` follows a match of `opener`. */
export declare function braceBlock(source: string, opener: RegExp): string;

/** One property's value text, bracket-balanced, up to its own comma; `null` when absent. */
export declare function propertyValue(source: string, key: string): string | null;

/** `text` split on `separator` at bracket depth zero and outside strings, parts trimmed. */
export declare function splitTopLevel(text: string, separator: string): string[];

export interface FunctionParts {
    /** Parameter names in order — types, defaults and `...` stripped, destructuring flattened. */
    params: string[];
    /** The block's inside, or an expression-bodied arrow's expression. */
    body: string;
}

/** The function expression `text` starts with; `null` when it starts with anything else. */
export declare function functionParts(text: string): FunctionParts | null;

/** The function `name` is declared as in this file; `null` when nothing here declares it. */
export declare function declaredFunction(source: string, name: string): FunctionParts | null;

/** The body of whatever declares `name` in this file; `''` when nothing does. */
export declare function declaredBody(source: string, name: string): string;

/** A file sliced from `header` to the next top-level `export`; `''` when absent. */
export declare function fnBody(source: string, header: string): string;

/** The body text of every `catch (…) { … }` block, brace-balanced. */
export declare function catchBodies(source: string): string[];

/** Evaluate a literal product like `2 * 60 * 60 * 1000`; `0` for anything else. */
export declare function evalProduct(expression: string | undefined): number;
