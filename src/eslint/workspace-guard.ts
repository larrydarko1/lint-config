/**
 * Holds `larry({ workspaces })` to the repository it lints. The roles are written by
 * hand, so without this a workspace added to package.json would get the base rules and
 * none of its role's — no `no-console`, no ODM ban, no security rules — and nothing
 * would say so. Mosaic's ingestor went a whole migration like that.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FullstackWorkspaces } from './presets.ts';

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
