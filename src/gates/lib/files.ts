/**
 * The shared source-tree walks. Filters see the path relative to the repo root, not
 * the file name, so they can exclude directories. Missing directories are skipped,
 * so one options object fits projects with different services. `repoFiles` is the
 * other way in: everything git knows about, so nothing has to be listed to be seen.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type WalkOptions = {
    /** Keep only paths matching this. Defaults to every file. */
    match?: PathFilter;
    /** Drop paths matching this, applied after `match`. */
    exclude?: PathFilter;
};

type PathFilter = RegExp | ((rel: string) => boolean);

const matches = (filter: PathFilter, rel: string): boolean =>
    filter instanceof RegExp ? filter.test(rel) : filter(rel);

/**
 * Every file under `dirs`, as paths relative to `root`, sorted so output is stable
 * across filesystems.
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

/** Every tracked or untracked-but-not-ignored file that still exists on disk. */
export function repoFiles(root: string): string[] {
    return (
        execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: root,
            encoding: 'utf8',
        })
            .split('\n')
            .filter(Boolean)
            // `--cached` still lists files deleted but not yet committed.
            .filter((rel) => fs.existsSync(path.join(root, rel)))
    );
}
