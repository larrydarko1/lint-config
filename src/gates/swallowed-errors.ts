/**
 * An empty catch must carry a comment that gives a reason. `no-empty` accepts any
 * comment; this rejects placeholders like `/* ignore *\/`, which silence the check
 * without saying why dropping the error is safe.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GateFailure } from './lib/report.ts';
import { stripComments } from './lib/strip-comments.ts';

export type SwallowScanOptions = {
    /** Repository root. */
    root: string;
    /** Paths to scan, relative to `root`. */
    files: string[];
};

/**
 * Comments that occupy the space a reason should fill without giving one.
 * Anchored: "ignore" alone is empty, "ignore — the socket is already closed" is not.
 */
const REASONLESS =
    /^(ignore|ignored|silently (fail|ignore)|no-?op|noop|skip|skipped|cleanup|whatever|nothing|n\/a|todo|fixme)\.?$/i;

/** A catch block whose body is empty once comments are blanked. A nested block means not empty. */
const EMPTY_CATCH = /\}\s*catch\s*(?:\([^)]*\)\s*)?\{([^{}]*)\}/g;

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

/**
 * @param options.root Repository root.
 * @param options.files Paths to scan, relative to `root`.
 * @returns One entry per unexplained swallow.
 */
export function findSwallowedErrors(options: SwallowScanOptions): (GateFailure & { file: string })[] {
    const { root, files } = options;
    const failures: { file: string; what: string; why: string }[] = [];

    for (const rel of files) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');

        for (const match of src.matchAll(EMPTY_CATCH)) {
            const body = match[1] ?? '';
            if (stripComments(body).trim() !== '') continue;

            // What is left once the comment markers go is the reason the author gave.
            const reason = body
                .replace(/\/\*|\*\/|^\s*\/\//gm, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (reason === '' || REASONLESS.test(reason)) {
                failures.push({
                    file: `${rel}:${lineOf(src, match.index)}`,
                    what: `swallows a failure without a reason (${reason === '' ? 'no comment' : `"${reason}"`})`,
                    why:
                        'Say what is being dropped and why it is safe to drop — "the file was already gone", ' +
                        '"a cleanup failure is non-fatal here". `no-empty` accepts any comment; it cannot ask ' +
                        'for the reason, and a bare `/* ignore */` reads the same whether the author thought ' +
                        'about it or not.',
                });
            }
        }
    }

    return failures;
}

/** Count of catch blocks examined, for the gate's summary. */
export function countSwallows(options: SwallowScanOptions): number {
    const { root, files } = options;
    let total = 0;
    for (const rel of files) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        for (const match of src.matchAll(EMPTY_CATCH)) {
            if (stripComments(match[1] ?? '').trim() === '') total += 1;
        }
    }
    return total;
}
