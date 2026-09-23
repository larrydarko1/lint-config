import type { ImportOrderOptions } from './import-order.js';

/** The canonical order of a module's top-level statements. */
export declare const CATEGORIES: string[];

/** The canonical order of a test file's top-level statements. */
export declare const TEST_CATEGORIES: string[];

/** A suite, or a module that only exists to support one. */
export declare const isTestPath: (rel: string) => boolean;

export type Misplaced = {
    /** The category the statement was binned into. */
    cat: string;
    /** The statement's name, as the report prints it. */
    name: string;
    /** 1-based line in the file — already offset past an SFC's `<template>`. */
    line: number;
    /** Where it should sit instead, as `category "name"`. */
    belongsAfter: string;
};

export type Analysis = {
    misplaced: Misplaced[];
    /** Top-level statements considered. */
    count: number;
    /** Set when no order satisfies the load-time dependencies. */
    cycle?: boolean;
    /** The ideal sequence as original statement indices — what a fixer needs. */
    order?: number[];
};

/** Reads a file (unwrapping an SFC's `<script setup>`) and analyses it. Null when an SFC has no script block. */
export declare function analyzeFile(rel: string, root: string): Analysis | null;

export type DeclarationOrderOptions = {
    /** Repository root. Defaults to the caller's repo root. */
    root?: string;
    /** Directories to walk, relative to `root`. */
    sourceRoots: string[];
    /** Forwarded to `createImportOrder` for the import-sorting pass. */
    importOrder?: ImportOrderOptions;
};

export declare function checkDeclarationOrder(options: DeclarationOrderOptions): void;
export default checkDeclarationOrder;
