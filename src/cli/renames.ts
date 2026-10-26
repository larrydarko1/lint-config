/**
 * Gate options renamed in a release. A rename takes effect in the release that makes it,
 * with no grace version: the options type drops the old name, `larry check` stops on a
 * config that still uses it, and `larry upgrade` makes the rename. Entries stay for good,
 * so a project that skips releases still gets every rename it missed.
 */
import type { GateName } from '../gates/registry.ts';

export type RenamedOption = {
    gate: GateName;
    from: string;
    to: string;
    /** The release that renamed it. */
    since: string;
};

/** Every rename ever made, oldest first. */
export const RENAMED_OPTIONS: readonly RenamedOption[] = [];

/**
 * @param gate The gate the options are for.
 * @param options Its options, as larry.config.ts gives them.
 * @param renames The renames to look for.
 * @returns A problem for each option still set under its old name.
 */
export function renamedOptionProblems(
    gate: string,
    options: Record<string, unknown>,
    renames: readonly RenamedOption[] = RENAMED_OPTIONS,
): string[] {
    return renames
        .filter((rename) => rename.gate === gate && Object.hasOwn(options, rename.from))
        .map(({ from, to, since }) =>
            Object.hasOwn(options, to)
                ? `"${gate}" sets both \`${from}\` and \`${to}\`. \`${from}\` is its name from before ${since}: remove it.`
                : `"${gate}".${from} is called \`${to}\` since ${since}. \`npx larry upgrade\` renames it.`,
        );
}
