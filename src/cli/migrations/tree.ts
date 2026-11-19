/**
 * The project as the migrations see it: the files on disk, with each migration's changes
 * laid over them. Nothing is written until the whole upgrade has run, so a migration that
 * stops with an error leaves the project as it was, and `--dry-run` writes nothing at all.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Tree = {
    /** A file's content, by path from the root: undefined when it does not exist. */
    read: (file: string) => string | undefined;
    exists: (file: string) => boolean;
    write: (file: string, content: string) => void;
    remove: (file: string) => void;
    /** The names of the files in `dir`, as the changes so far leave it. */
    list: (dir: string) => string[];
    /** Each changed file and its new content, null when it is removed. A file written back as it was is not changed. */
    changes: () => Map<string, string | null>;
    /** Whether `file` was on disk before the upgrade. */
    existed: (file: string) => boolean;
};

export function createTree(root: string): Tree {
    const changes = new Map<string, string | null>();
    const onDisk = (file: string): string | undefined => {
        const full = path.join(root, file);
        return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : undefined;
    };
    const read = (file: string): string | undefined =>
        changes.has(file) ? (changes.get(file) ?? undefined) : onDisk(file);
    const set = (file: string, content: string | null): void => {
        if ((onDisk(file) ?? null) === content) changes.delete(file);
        else changes.set(file, content);
    };

    return {
        read,
        exists: (file): boolean => read(file) !== undefined,
        write: set,
        remove: (file): void => {
            set(file, null);
        },
        list: (dir): string[] => {
            const full = path.join(root, dir);
            const names = new Set(fs.existsSync(full) ? fs.readdirSync(full) : []);
            for (const [file, content] of changes) {
                if (path.posix.dirname(file) !== dir) continue;
                if (content === null) names.delete(path.posix.basename(file));
                else names.add(path.posix.basename(file));
            }
            return [...names].sort();
        },
        changes: (): Map<string, string | null> => new Map(changes),
        existed: (file): boolean => onDisk(file) !== undefined,
    };
}

/** Writes the changes to disk, and removes a folder a removal leaves empty. */
export function commitTree(root: string, tree: Tree): void {
    for (const [file, content] of tree.changes()) {
        const full = path.join(root, file);
        if (content !== null) {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
            continue;
        }
        fs.rmSync(full);
        const dir = path.dirname(full);
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
}
