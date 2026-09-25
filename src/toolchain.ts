/**
 * What this package installs so a project does not. Read from its own manifest,
 * so the list cannot drift from what is actually installed: add a dependency
 * there and the package-json gate and the knip config both know about it.
 */
import fs from 'node:fs';

/** `src/` and `dist/` are both one level below the manifest. */
const SELF = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string;
    dependencies: Record<string, string>;
};

export const SELF_NAME = SELF.name;

/**
 * Dependencies of this package that a project may still list, because its own code
 * uses them: TypeScript is the compiler it builds with, and the other two are
 * libraries an app can import for reasons of its own. Everything else here exists
 * only to lint, and a project's second copy of it is drift.
 */
const ALSO_THE_PROJECTS = new Set(['typescript', 'yaml', '@vue/compiler-sfc']);

/** Every package this one provides, mapped to the exact version it pins. */
export const providedPackages = (): Record<string, string> =>
    Object.fromEntries(Object.entries(SELF.dependencies).filter(([name]) => !ALSO_THE_PROJECTS.has(name)));

/**
 * The CLIs a project runs by name — from its scripts, its git hooks and its
 * editor — mapped from package to binary. All three look in the project's own
 * `node_modules`, so these have to land at its top level; everything else is
 * resolved from inside this package and can sit anywhere. knip names its plugin
 * for each after the binary.
 */
export const PROJECT_CLIS: Record<string, string> = {
    'eslint': 'eslint',
    'prettier': 'prettier',
    'stylelint': 'stylelint',
    '@commitlint/cli': 'commitlint',
    'lint-staged': 'lint-staged',
    'husky': 'husky',
};
