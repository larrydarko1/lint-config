export type ImportProblem = { line: number; message: string };

export type ImportAnalysis = {
    /** Every place the import run departs from canonical order, sorted by line. */
    problems: ImportProblem[];
    /** How many imports were in the leading run. */
    count: number;
    /** The same source with the run rewritten into canonical order. */
    fixed: string;
};

export type ImportOrderOptions = {
    /** The npm scope this monorepo's own packages use, e.g. `'@orchid/'`. */
    workspaceScope?: string;
    /** tsconfig `paths` entries that look like packages but point into this repo. */
    localAliases?: string[];
};

/**
 * Declared as properties holding functions, not as methods: these are plain closures with
 * no `this`, and a method signature makes `unbound-method` flag every destructuring of them.
 */
export type ImportOrder = {
    IMPORT_GROUPS: string[];
    /** `null` when the file is an SFC with no script block. */
    checkImportsInFile: (rel: string, root: string) => ImportAnalysis | null;
    /** Rewrites the file in place. Returns whether anything changed. */
    fixImportsInFile: (rel: string, root: string) => boolean;
};

export declare function createImportOrder(options?: ImportOrderOptions): ImportOrder;
export default createImportOrder;
