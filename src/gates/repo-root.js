/**
 * The repository root, and never the caller's cwd.
 *
 * Every gate needs it and none may depend on where it was invoked from: `npm run`
 * sets cwd to the package root, a git hook does not, and an editor task runner sets
 * it to whatever folder happens to be open. Resolving it from the filesystem makes
 * the answer the same in all three.
 *
 * The two families had two different answers, and neither generalises. Orchid walked
 * up for a `package.json` declaring `workspaces`, which finds nothing in a
 * single-package repo like Fern. Fern used `../..` from its own file, which is
 * correct only while the file stays exactly two levels down. This walks up for the
 * markers in priority order, so both layouts land on the same directory they always
 * did — and a file that moves does not silently change the answer.
 */
import fs from 'node:fs';
import path from 'node:path';

/** True when `dir` holds a package.json with a `workspaces` array — a monorepo root. */
const isWorkspaceRoot = (dir) => {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) return false;
    try {
        return Array.isArray(JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces);
    } catch {
        // Unparseable package.json — keep walking rather than guessing.
        return false;
    }
};

const isGitRoot = (dir) => fs.existsSync(path.join(dir, '.git'));

/**
 * Walk up from `startDir` and return the first directory matching `marker`.
 *
 * @param {string} startDir
 * @param {(dir: string) => boolean} marker
 * @returns {string | null}
 */
const walkUp = (startDir, marker) => {
    let dir = startDir;
    for (;;) {
        if (marker(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
};

/**
 * @param {string} [startDir] Where to start looking. Defaults to this file's directory,
 *   which is inside the installed package — the walk still reaches the consuming repo.
 * @returns {string} The repository root.
 */
export function findRepoRoot(startDir = import.meta.dirname) {
    // A workspaces manifest wins: in a monorepo the git root and the workspace root are
    // the same directory, but checking it first keeps the answer right if they ever differ.
    const found = walkUp(startDir, isWorkspaceRoot) ?? walkUp(startDir, isGitRoot);
    if (found !== null) return found;
    throw new Error(
        `Could not locate the repository root above ${startDir} — no ancestor has a .git directory ` +
            `or a package.json declaring "workspaces".`,
    );
}

/**
 * The repo root for the process that imported this. Resolved from the CWD rather than
 * from this file, because the package may be installed outside the repo it is linting.
 */
export const REPO_ROOT = findRepoRoot(process.cwd());
