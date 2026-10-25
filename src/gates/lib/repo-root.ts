/**
 * The repository root: the nearest ancestor with a `workspaces` manifest, else the
 * nearest with `.git`, so a gate gets the same answer from any subdirectory.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param [startDir] Where to start looking. Defaults to this file's directory,
 *   which is inside the installed package — the walk still reaches the consuming repo.
 * @returns The repository root.
 */
export function findRepoRoot(startDir: string = import.meta.dirname): string {
    const found = walkUp(startDir, isWorkspaceRoot) ?? walkUp(startDir, isGitRoot);
    if (found !== null) return found;
    throw new Error(
        `Could not locate the repository root above ${startDir} — no ancestor has a .git directory ` +
            `or a package.json declaring "workspaces".`,
    );
}

/** True when `dir` holds a package.json with a `workspaces` array — a monorepo root. */
const isWorkspaceRoot = (dir: string) => {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) return false;
    try {
        return Array.isArray(JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces);
    } catch {
        // Unparseable package.json — keep walking rather than guessing.
        return false;
    }
};

const isGitRoot = (dir: string) => fs.existsSync(path.join(dir, '.git'));

const walkUp = (startDir: string, marker: (dir: string) => boolean): string | null => {
    let dir = startDir;
    for (;;) {
        if (marker(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
};

/** Resolved from the CWD, not this file: the package may be installed outside the repo it lints. */
export const REPO_ROOT: string = findRepoRoot(process.cwd());
