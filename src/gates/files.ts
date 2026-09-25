/**
 * The shared source-tree walk. Filters see the path relative to the repo root, not
 * the file name, so they can exclude directories. Missing directories are skipped,
 * so one options object fits projects with different services.
 */
import fs from 'node:fs';
import path from 'node:path';

export type PathFilter = RegExp | ((rel: string) => boolean);

export type WalkOptions = {
    /** Keep only paths matching this. Defaults to every file. */
    match?: PathFilter;
    /** Drop paths matching this, applied after `match`. */
    exclude?: PathFilter;
};

const matches = (filter: PathFilter, rel: string): boolean =>
    filter instanceof RegExp ? filter.test(rel) : filter(rel);

/**
 * Every file under `dirs`, as paths relative to `root`, sorted so output is stable
 * across filesystems.
 *
 * @param root Repository root.
 * @param dirs One or more directories, relative to `root`.
 * @param [options.match] Keep only paths matching this. Defaults to every file.
 * @param [options.exclude] Drop paths matching this, applied after `match`.
 */
export function walkFiles(root: string, dirs: string | string[], options: WalkOptions = {}): string[] {
    const { match, exclude } = options;
    const out: string[] = [];

    const visit = (rel: string) => {
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
