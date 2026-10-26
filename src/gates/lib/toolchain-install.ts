/**
 * Whether a project that depends on this package gets its toolchain from it: the project
 * lists none of the tools itself, and each CLI it runs by name sits at the top of its
 * `node_modules` at the version pinned here. The package-json gate and `larry doctor`
 * both ask this.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_CLIS, SELF_NAME, providedPackages } from '../../toolchain.ts';
import { isRecord, stringAt, readJson } from './json.ts';
import type { GateFailure } from './report.ts';

type DependencyFields = { dependencies?: unknown; devDependencies?: unknown };

/**
 * @param root The project's root.
 * @param manifests Each manifest to read, root first, by its path relative to `root`.
 * @param provided What this package installs, mapped to the version it pins.
 * @returns A failure for each tool the project lists, and for each CLI missing from the top of `node_modules` or at another version.
 */
export function inspectToolchainInstall(
    root: string,
    manifests: { file: string; pkg: DependencyFields }[],
    provided: Record<string, string> = providedPackages(),
): GateFailure[] {
    const problems: GateFailure[] = [];

    for (const { file, pkg } of manifests) {
        for (const field of ['dependencies', 'devDependencies'] as const) {
            const listed = pkg[field];
            const ours = isRecord(listed) ? Object.keys(listed).filter((name) => Object.hasOwn(provided, name)) : [];
            for (const name of ours) {
                problems.push({
                    file,
                    what: `${field}.${name} is installed by ${SELF_NAME}`,
                    why: 'Remove it. The project copy is the one scripts, git hooks and the editor would run, and version bumps belong in one place.',
                });
            }
        }
    }

    // A symlinked `file:` install keeps its dependencies inside it, so nothing hoists.
    for (const name of Object.keys(PROJECT_CLIS)) {
        const pinned = provided[name];
        if (pinned === undefined) continue;
        const manifest = path.join('node_modules', name, 'package.json');
        if (!fs.existsSync(path.join(root, manifest))) {
            problems.push({
                file: manifest,
                what: `\`${name}\` is not installed at the top of node_modules`,
                why: `Scripts, git hooks and editors look for it there. If ${SELF_NAME} is a \`file:\` dependency, set \`install-links=true\` in .npmrc so npm installs it as a copy rather than a symlink, then reinstall.`,
            });
            continue;
        }
        const version = stringAt(readJson(path.join(root, manifest)), 'version');
        if (version !== pinned) {
            problems.push({
                file: manifest,
                what: `\`${name}\` resolves to ${version ?? 'no version'}, but ${SELF_NAME} pins ${pinned}`,
                why: `Another package put its own copy at the top of node_modules, so that is the one scripts, hooks and editors run. \`npm explain ${name}\` names it.`,
            });
        }
    }

    return problems;
}
