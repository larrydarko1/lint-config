/**
 * The shared source-tree walks. Filters see the path relative to the repo root, not
 * the file name, so they can exclude directories. Missing directories are skipped,
 * so one options object fits projects with different services. `repoFiles` is the
 * other way in: everything git knows about, so nothing has to be listed to be seen.
 * `gitIgnores` asks git whether it ignores a path.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
 * @param dirs One or more directories, relative to `root`. A file is read as itself.
 * @param [options.match] Keep only paths matching this. Defaults to every file.
 * @param [options.exclude] Drop paths matching this, applied after `match`.
 */
export function walkFiles(root: string, dirs: string | string[], options: WalkOptions = {}): string[] {
    const { match, exclude } = options;
    const out: string[] = [];

    const keep = (rel: string) => {
        if (match !== undefined && !matches(match, rel)) return;
        if (exclude === undefined || !matches(exclude, rel)) out.push(rel);
    };
    const visit = (rel: string) => {
        for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) visit(child);
            else keep(child);
        }
    };

    for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
        const absolute = path.join(root, dir);
        if (!fs.existsSync(absolute)) continue;
        // A file named as a root is read on its own: `src-tauri/build.rs` without `src-tauri/target/`.
        if (fs.statSync(absolute).isDirectory()) visit(dir);
        else keep(dir);
    }
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

/**
 * Whether git ignores a path, asked of `git check-ignore`: pattern order, negations
 * and nested ignore files decide it, so reading `.gitignore` cannot.
 *
 * @returns Null when git could not answer (no repository, no git).
 */
export function gitIgnores(root: string, rel: string): boolean | null {
    const { status, error } = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], {
        cwd: root,
        stdio: 'ignore',
    });
    if (error !== undefined || status === null || status > 1) return null;
    return status === 0;
}
