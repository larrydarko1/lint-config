/**
 * How a project numbers its releases. What the number has to tell its reader depends on
 * whether anyone can be running an old copy, and that follows from what the family ships,
 * so every family but base has its scheme fixed. Base is for no one kind of project, so
 * the project names its own.
 */
import type { PresetName } from '../../eslint/presets.ts';

/**
 * `semver`: MAJOR.MINOR.PATCH, for what someone can stay on an old copy of (an installed
 * app, a package pinned in a manifest), where the number must say whether updating breaks
 * them. `calver`: YYYY.M.PATCH, for what everyone gets the latest of (a website, a
 * service), where the number only says how recent a release is.
 */
export type Versioning = 'semver' | 'calver';

export const VERSIONINGS = ['semver', 'calver'] as const satisfies readonly Versioning[];

/**
 * Each family's scheme. Apps and editor extensions are installed and libraries are pinned,
 * so old copies run; web apps and APIs are deployed, so none do. An installed app could not
 * take a calendar version anyway: Tauri requires semver, and Windows Installer caps the
 * first two numbers at 255.
 */
export const FAMILY_VERSIONING: Record<Exclude<PresetName, 'base'>, Versioning> = {
    'api': 'calver',
    'electron': 'semver',
    'fullstack': 'calver',
    'library': 'semver',
    'spa': 'calver',
    'tauri': 'semver',
    'vs-extension': 'semver',
};

/** How each scheme is named and linked in a changelog's intro, and the shape of its versions. */
export const SCHEMES: Record<Versioning, { name: string; link: string; url: string; shape: string }> = {
    semver: {
        name: 'Semantic Versioning',
        link: '](https://semver.org/',
        url: 'https://semver.org/spec/v2.0.0.html',
        shape: 'MAJOR.MINOR.PATCH, with no leading zeros (`1.4.2`, `2.0.0-beta.1`)',
    },
    calver: {
        name: 'calendar versioning',
        link: '](https://calver.org/',
        url: 'https://calver.org/',
        shape: '`YYYY.M.PATCH`: the year and month it shipped, with no leading zero, then how many releases came before it that month (`2026.11.0`, then `2026.11.1`)',
    },
};

/** Semver 2.0.0: no leading zeros, an optional pre-release and build. */
export const SEMVER_VERSION =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A calendar-versioned project's version before its first release, when there is no month to name yet. */
export const UNRELEASED_VERSION = '0.0.0';

/** `YYYY.M.PATCH`, the month without a leading zero, so the version is also valid semver. */
export const CALVER_VERSION = /^(\d{4})\.([1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;

export const isVersioning = (value: unknown): value is Versioning => VERSIONINGS.some((scheme) => scheme === value);
