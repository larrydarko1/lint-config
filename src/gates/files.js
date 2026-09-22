/**
 * Walking a source tree, once.
 *
 * Twelve gates across the two families defined their own `walk`, in six signatures
 * that differed only in whether the filter was a string extension, a RegExp or a
 * predicate, and in whether it was tested against the file's NAME or its PATH.
 * That last difference is the one that bit: a filter reading the name cannot say
 * "not under __tests__", so gates that needed it grew a second `.filter()` after
 * the walk, and gates that needed it and forgot silently scanned their own tests.
 *
 * Here the filter always sees the path relative to the repo root, which is a strict
 * superset: `/\.ts$/` still matches, and `!rel.includes('__tests__')` now can too.
 *
 * A directory that does not exist is skipped rather than throwing, because that is
 * what makes one options object work for a family whose members have different
 * services — Orchid walks `api` and `worker`, Mosaic walks those and `ingestor`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {RegExp | ((rel: string) => boolean)} PathFilter */

/**
 * @param {PathFilter} filter
 * @param {string} rel
 * @returns {boolean}
 */
const matches = (filter, rel) => (filter instanceof RegExp ? filter.test(rel) : filter(rel));

/**
 * Every file under `dirs`, as paths relative to `root`, sorted so a gate's output
 * is the same on every machine — `readdirSync` order is the filesystem's, not
 * alphabetical, and a gate whose findings reorder between runs is unreviewable.
 *
 * @param {string} root Repository root.
 * @param {string | string[]} dirs One or more directories, relative to `root`.
 * @param {object} [options]
 * @param {PathFilter} [options.match] Keep only paths matching this. Defaults to every file.
 * @param {PathFilter} [options.exclude] Drop paths matching this, applied after `match`.
 * @returns {string[]}
 */
export function walkFiles(root, dirs, options = {}) {
    const { match, exclude } = options;
    /** @type {string[]} */
    const out = [];

    /** @param {string} rel */
    const visit = (rel) => {
        const absolute = path.join(root, rel);
        if (!fs.existsSync(absolute)) return;
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                visit(child);
            } else if (match === undefined || matches(match, child)) {
                if (exclude === undefined || !matches(exclude, child)) out.push(child);
            }
        }
    };

    for (const dir of Array.isArray(dirs) ? dirs : [dirs]) visit(dir);
    return out.sort();
}

export default walkFiles;
