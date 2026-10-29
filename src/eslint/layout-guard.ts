/**
 * Holds a family's roles to the repository it lints. The rules for a role reach only
 * the files under its path, so a role pointing at nothing lints nothing, and nothing
 * would say so: a workspace added to package.json without a role gets the base rules
 * and none of its role's, and a project laid out unlike its family's defaults gets
 * none of the family's. Mosaic's ingestor went a whole migration like that.
 *
 * A folder with no package.json beside it is not a project, so there is nothing to
 * hold the roles to and both guards stay out of the way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FullstackWorkspaces, SinglePackagePreset } from './presets.ts';

/**
 * Throws when a role the family's standards read, or one the project named in
 * `larry({ layout })`, has no file or folder at its path.
 */
export const assertLayoutExists = (
    rootDir: string,
    preset: SinglePackagePreset,
    layout: Record<string, string>,
    roles: { read: string[]; named: string[] },
): void => {
    if (!existsSync(path.join(rootDir, 'package.json'))) return;

    const problems = [...new Set([...roles.named, ...roles.read])]
        .filter((role) => !existsSync(path.join(rootDir, layout[role] ?? '')))
        .map((role) =>
            roles.named.includes(role)
                ? `larry({ layout }) puts '${role}' at '${layout[role]}', which does not exist.`
                : `The ${preset} preset looks for '${role}' at '${layout[role]}', which does not exist, so its rules would lint nothing. Point it at the real one with larry({ layout: { ${role}: '…' } }).`,
        );

    if (problems.length > 0) throw new Error(`Layout out of date:\n  - ${problems.join('\n  - ')}`);
};

/**
 * Throws when a workspace with a `src/` has no role, or a role names a folder with no `src/`.
 * A workspace without `src/` (migrations, fixtures) is not source and needs no role.
 */
export const assertWorkspacesCovered = (rootDir: string, workspaces: FullstackWorkspaces): void => {
    const declared = declaredWorkspaces(rootDir);
    if (declared === null) return;

    const assigned = [workspaces.frontend, workspaces.api, ...workspaces.services, ...workspaces.shared];
    const problems: string[] = [];

    for (const dir of declared) {
        if (hasSource(rootDir, dir) && !assigned.includes(dir)) {
            problems.push(
                `'${dir}' is a workspace with a src/ but has no role, so only the base rules reach it. Add it to \`services\` (a Node process outside the request cycle) or \`shared\` (a package the others import) in larry({ workspaces }).`,
            );
        }
    }
    for (const dir of assigned) {
        if (!hasSource(rootDir, dir)) {
            problems.push(
                `larry({ workspaces }) names '${dir}', which has no src/ — a renamed or removed workspace, so its role's rules reach nothing.`,
            );
        }
    }

    if (problems.length) throw new Error(`Workspace roles out of date:\n  - ${problems.join('\n  - ')}`);
};

/** package.json `workspaces`, with a trailing `/*` expanded. Null when there is no list to hold the roles to. */
const declaredWorkspaces = (rootDir: string): string[] | null => {
    let manifest: { workspaces?: string[] | { packages?: string[] } };
    try {
        manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as typeof manifest;
    } catch {
        return null;
    }
    const list = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
    if (!Array.isArray(list)) return null;

    return list.flatMap((entry) => {
        if (!entry.endsWith('/*')) return [entry];
        const parent = entry.slice(0, -2);
        if (!existsSync(path.join(rootDir, parent))) return [];
        return readdirSync(path.join(rootDir, parent), { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => `${parent}/${dirent.name}`);
    });
};

const hasSource = (rootDir: string, dir: string): boolean => existsSync(path.join(rootDir, dir, 'src'));
