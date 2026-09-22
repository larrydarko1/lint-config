/** Walk up from `startDir` to the repository root. Throws if there is none above it. */
export declare function findRepoRoot(startDir?: string): string;
/** The repository root for the current process, resolved from its cwd. */
export declare const REPO_ROOT: string;
