/**
 * A swallowed failure states its reason.
 *
 * The one error-handling check both families had, because it is about `catch`
 * itself rather than about HTTP or IPC. ESLint's `no-empty` already rejects a bare
 * `catch {}`; what it cannot do is ask WHY this particular failure is safe to drop.
 * Dropping an error is sometimes exactly right — the file was already gone, the
 * cleanup is best-effort — but only the author knows which case this is, and a year
 * later nobody can tell a considered swallow from an abandoned one.
 *
 * So an empty catch must carry a comment, and the comment must say something.
 * `/* ignore *\/` is the anti-pattern the standard names by name: it reads
 * identically whether the author reasoned about it or never thought about it at
 * all, which makes it worse than no comment, because it silences the check.
 *
 * One copy enforced the comment's CONTENT and the other only its presence — while
 * the other's own failure message said "it cannot ask for the reason. Write it."
 * The first is what both were describing, so it is the one that ships.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GateFailure } from './report.ts';
import { stripComments } from './strip-comments.ts';

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

/**
 * A catch block whose body is empty once comments are blanked. The body pattern
 * excludes braces deliberately: a catch containing any nested block is not empty,
 * so there is nothing here to report, and matching it would only risk running past
 * the block's real end.
 */
const EMPTY_CATCH = /\}\s*catch\s*(?:\([^)]*\)\s*)?\{([^{}]*)\}/g;

/** @param src @param {number} index @returns {number} */
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

/**
 * Count of catch blocks examined, for a gate that wants to report how many swallows
 * it cleared rather than only that it found none it disliked.
 */
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
