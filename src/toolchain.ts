/** What this package installs so a project does not, read from its own manifest so it cannot drift. */
import fs from 'node:fs';

/** `src/` and `dist/` are both one level below the manifest. */
const SELF = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string;
    dependencies: Record<string, string>;
};

export const SELF_NAME = SELF.name;

/** Dependencies a project may still list because its own code uses them; everything else is lint-only. */
const ALSO_THE_PROJECTS = new Set(['typescript', 'yaml', '@vue/compiler-sfc']);

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
    Object.fromEntries(Object.entries(SELF.dependencies).filter(([name]) => !ALSO_THE_PROJECTS.has(name)));
