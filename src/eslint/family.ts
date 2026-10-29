/**
 * A family's standards as `larry()` takes them: a function of the project's resolved
 * roles rather than blocks built on the family's defaults, so a role the project moves
 * takes its rules with it. Each is tagged with its family, which `larry()` holds to the
 * preset, and with the roles its rules are on for, which the layout guard holds to the
 * repository. The base family has no roles, so its standards are built from the paths
 * the project names.
 */
import type { Linter } from 'eslint';

import {
    fullstackLayout,
    resolveLayout,
    type FamilyLayouts,
    type FullstackLayout,
    type FullstackWorkspaces,
    type LayoutOverrides,
    type PresetName,
    type PresetPaths,
    type SinglePackagePreset,
} from './presets.ts';

/** What each family's standards are built from: the full-stack role globs, a family's resolved layout, or the base family's paths. */
type StandardsInput = FamilyLayouts & { base: PresetPaths; fullstack: FullstackLayout };

/** A single-package family's role names. The full-stack family's workspaces have a guard of their own. */
type RoleOf<TPreset extends PresetName> = TPreset extends SinglePackagePreset
    ? keyof FamilyLayouts[TPreset] & string
    : never;

export type FamilyStandards<TPreset extends PresetName> = ((input: StandardsInput[TPreset]) => Linter.Config[]) & {
    family: TPreset;
    /** The roles whose rules are on: each must exist, or those rules lint nothing. */
    roles: RoleOf<TPreset>[];
};

export type AnyFamilyStandards = { [TPreset in PresetName]: FamilyStandards<TPreset> }[PresetName];

export const familyStandards = <TPreset extends PresetName>(
    family: TPreset,
    roles: RoleOf<TPreset>[],
    build: (input: StandardsInput[TPreset]) => object[],
): FamilyStandards<TPreset> =>
    Object.assign(
        // The blocks' inferred types disagree with ESLint's under exactOptionalPropertyTypes; ESLint validates every block at load.
        (input: StandardsInput[TPreset]) => build(input) as Linter.Config[],
        { family, roles },
    );

/** The standards, given the roles of the family they were written for. */
export const buildStandards = (
    standards: AnyFamilyStandards,
    roles: { workspaces: Partial<FullstackWorkspaces>; layout: LayoutOverrides; paths: PresetPaths },
): Linter.Config[] => {
    const { workspaces, layout, paths } = roles;
    switch (standards.family) {
        case 'base':
            return standards(paths);
        case 'fullstack':
            return standards(fullstackLayout(workspaces));
        case 'api':
            return standards(resolveLayout('api', layout));
        case 'electron':
            return standards(resolveLayout('electron', layout));
        case 'library':
            return standards(resolveLayout('library', layout));
        case 'spa':
            return standards(resolveLayout('spa', layout));
        case 'tauri':
            return standards(resolveLayout('tauri', layout));
    }
};
