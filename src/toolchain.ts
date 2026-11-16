/** What this package installs so a project does not, read from its own manifest so it cannot drift. */
import fs from 'node:fs';

import { recordAt, stringAt } from './gates/lib/json.ts';

/** `src/` and `dist/` are both one level below the manifest. */
const SELF: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SELF_NAME = ownString(SELF, 'name');

export const SELF_VERSION = ownString(SELF, 'version');

/** The oldest Node this package runs on: the major in its `engines.node`. */
export const NODE_FLOOR = Number(/\d+/.exec(ownString(recordAt(SELF, 'engines'), 'node'))?.[0]);

/** Dependencies a project may still list because its own code uses them; everything else is lint-only. */
const ALSO_THE_PROJECTS = new Set(['typescript', 'yaml', '@vue/compiler-sfc', '@clack/prompts']);

/**
 * Package → binary for the CLIs a project runs by name (scripts, hooks, editor).
 * These must land in the project's top-level `node_modules`.
 */
export const PROJECT_CLIS: Record<string, string> = {
    'eslint': 'eslint',
    'prettier': 'prettier',
    'stylelint': 'stylelint',
    '@commitlint/cli': 'commitlint',
    'lint-staged': 'lint-staged',
    'husky': 'husky',
};

/** Every package this one provides, mapped to the exact version it pins. */
export const providedPackages = (): Record<string, string> =>
    Object.fromEntries(
        Object.entries(recordAt(SELF, 'dependencies')).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string' && !ALSO_THE_PROJECTS.has(entry[0]),
        ),
    );

/** A field this package's own manifest has, or the build shipped broken: say so at load, not later. */
function ownString(manifest: unknown, key: string): string {
    const field = stringAt(manifest, key);
    if (field === undefined) throw new Error(`This package's own package.json has no \`${key}\`.`);
    return field;
}
