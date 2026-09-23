/** Deferral markers, shouted. Case-sensitive on purpose — see the gate's header. */
export declare const MARKERS: RegExp;

export type RefactoringOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /**
     * Extensions ESLint already covers, so this gate leaves them alone.
     * `.vue` is the exception: listing it means ESLint has the `<script>` half, so this
     * gate reads the `<template>` half. Omitting it means the whole file is read.
     * Defaults to `['.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs']`.
     */
    linted?: string[];
    /** Extra basenames never read, on top of `package-lock.json` and the tracker. */
    skip?: string[];
    /** Paths never read. Replaces the default build-output list. */
    ignore?: RegExp;
    /** The file deferred work belongs in. Defaults to `todo.md`. */
    tracker?: string;
    /** Require every tracker bullet to carry a `[ ]` checkbox. */
    requireCheckboxes?: boolean;
};

export declare function checkRefactoring(options?: RefactoringOptions): void;
export default checkRefactoring;
