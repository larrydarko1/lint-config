/**
 * package.json across the root and every workspace manifest:
 *
 *   1. Required metadata. The root carries identity and toolchain facts; workspaces
 *      are private and inherit engines and packageManager.
 *   2. `^` ranges, with `~` only for allowlisted packages (each with a reason).
 *   3. Field order, per CANONICAL_ORDER. An unknown field fails, so the order stays total.
 *   4–6. Electron packaging (`main`, `build.files`, `os`), only where the shapes exist.
 *   7. A project depending on this package lists none of what it installs. This
 *      package pins exactly because its lockfile never reaches the projects.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_CLIS, SELF_NAME, providedPackages } from '../toolchain.ts';
import { REPO_ROOT } from './repo-root.ts';
import { createGateReport } from './report.ts';

export type PackageJsonProblem = {
    /** The manifest the finding belongs to. */
    file: string;
    what: string;
    why: string;
};

export type PackageJsonInspection = {
    problems: PackageJsonProblem[];
    /** Every manifest read: the root, plus each workspace that has one. */
    manifests: string[];
};

export type PackageJsonOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
    /** Fields the root manifest owes: the project's identity and its toolchain facts. */
    rootRequired?: string[];
    /** Fields a workspace manifest owes. Toolchain facts are inherited from the root, so they are not here. */
    workspaceRequired?: string[];
    /** Field order. Defaults to `CANONICAL_ORDER`; a field missing from it fails. */
    canonicalOrder?: string[];
    /** Packages allowed a `~` range, mapped to the reason. Anything else must be `^`. */
    tildeAllowed?: Record<string, string>;
    /** Where the electron-vite config lives. Absent means the Electron rules stay silent. */
    electronViteConfig?: string;
    /**
     * What this package installs so the project does not, name → the exact version it
     * pins. Defaults to its own manifest; only consulted when the project depends on it.
     */
    provided?: Record<string, string>;
};

export type PackageJsonInput = Omit<PackageJsonOptions, 'standard' | 'root'> & { root: string };

/** A manifest as the file wrote it. Only the keys this gate reads by name are named. */
type Manifest = {
    private?: unknown;
    version?: unknown;
    main?: unknown;
    os?: unknown;
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    build?: { files?: unknown; [key: string]: unknown };
    [key: string]: unknown;
};

/** The canonical field order, after sort-package-json. A field absent from this list fails. */
export const CANONICAL_ORDER: string[] = [
    'name',
    'version',
    'description',
    'keywords',
    'homepage',
    'bugs',
    'license',
    'author',
    'contributors',
    'funding',
    'type',
    'files',
    'main',
    // electron-builder reads this for the Linux .desktop file name.
    'desktopName',
    'browser',
    'module',
    'types',
    'typings',
    'exports',
    'sideEffects',
    'imports',
    'bin',
    'man',
    'directories',
    'repository',
    'scripts',
    'config',
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'optionalDependencies',
    'bundleDependencies',
    'overrides',
    'resolutions',
    // sort-package-json's order for these two.
    'packageManager',
    'engines',
    'os',
    'cpu',
    'private',
    'publishConfig',
    'workspaces',
    // Tool config blocks last: they are the largest and the least often read.
    'browserslist',
    'build',
    'lint-staged',
];

/** Ranges that are not a version at all — a workspace link, a tarball, a git URL. */
const NOT_A_RANGE = /^(?:workspace:|file:|link:|npm:|git\+|https?:|github:|\*$)/;

/** `1.2.3`, optionally with a prerelease tag. What a release workflow can order. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** An `os` entry and the electron-builder target block that would produce it. */
const OS_TO_TARGET: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' };

/** Inspect every manifest in the repo without printing. */
export function inspectPackageJson({
    root,
    rootRequired = [],
    workspaceRequired = [],
    canonicalOrder = CANONICAL_ORDER,
    tildeAllowed = {},
    electronViteConfig = 'electron.vite.config.ts',
    provided = providedPackages(),
}: PackageJsonInput): PackageJsonInspection {
    const problems: PackageJsonProblem[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };

    const read = (rel: string): Manifest => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    const rootPkg = read('package.json');

    const manifests = [
        { file: 'package.json', pkg: rootPkg, required: rootRequired, isRoot: true },
        ...(rootPkg.workspaces ?? [])
            .map((dir) => ({ file: path.posix.join(dir, 'package.json'), required: workspaceRequired, isRoot: false }))
            .filter((m) => fs.existsSync(path.join(root, m.file)))
            .map((m) => ({ ...m, pkg: read(m.file) })),
    ];

    for (const { file, pkg, required, isRoot } of manifests) {
        const keys = Object.keys(pkg);

        // ── 1. Required metadata ────────────────────────────────────────────
        for (const field of required) {
            const value = pkg[field];
            if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
                fail(
                    file,
                    `is missing the required field \`${field}\``,
                    'Identity, provenance and toolchain facts — the fields a reader or a build tool has no other source for.',
                );
            }
        }

        if (pkg.private !== undefined && pkg.private !== true) {
            fail(
                file,
                '`private` is not `true`',
                'It is the only guard against a stray `npm publish` of something never meant for the registry.',
            );
        }

        if (isRoot && typeof pkg.version === 'string' && !SEMVER.test(pkg.version)) {
            fail(
                file,
                `\`version\` ("${pkg.version}") is not semver`,
                'The release workflow reads it to build the tag and the installer filenames; a non-semver value produces a tag nobody can order.',
            );
        }

        // ── 2. Semver prefixes ──────────────────────────────────────────────
        for (const field of ['dependencies', 'devDependencies'] as const) {
            for (const [name, range] of Object.entries(pkg[field] ?? {})) {
                if (NOT_A_RANGE.test(range)) continue;

                if (range.startsWith('~')) {
                    if (!Object.hasOwn(tildeAllowed, name)) {
                        fail(
                            file,
                            `${field}.${name} is "${range}" — a \`~\` range is not on the allowlist`,
                            'Patch-only is a deliberate decision. Add it to `tildeAllowed` with the reason, or use `^`.',
                        );
                    }
                    continue;
                }

                if (Object.hasOwn(tildeAllowed, name)) {
                    fail(
                        file,
                        `${field}.${name} is "${range}" — it is on the \`~\` allowlist`,
                        tildeAllowed[name] ?? '',
                    );
                    continue;
                }

                if (!range.startsWith('^')) {
                    fail(
                        file,
                        `${field}.${name} is pinned exactly to "${range}"`,
                        'An exact pin opts out of security patches while adding nothing — package-lock.json is what actually pins the installed tree.',
                    );
                }
            }
        }

        // ── 3. Field order ──────────────────────────────────────────────────
        const unplaced = keys.filter((k) => !canonicalOrder.includes(k));
        if (unplaced.length > 0) {
            fail(
                file,
                `has field(s) this gate does not know where to sort: ${unplaced.join(', ')}`,
                'Add them to `canonicalOrder` at the position they belong, so the ordering rule stays total rather than quietly skipping them.',
            );
        }

        const ranked = keys.filter((k) => canonicalOrder.includes(k));
        const sorted = [...ranked].sort((a, b) => canonicalOrder.indexOf(a) - canonicalOrder.indexOf(b));
        if (ranked.join(',') !== sorted.join(',')) {
            const at = ranked.findIndex((k, i) => k !== sorted[i]);
            fail(
                file,
                `field order diverges at \`${ranked[at]}\` (expected \`${sorted[at]}\`)`,
                `Canonical order is: ${sorted.join(', ')}`,
            );
        }
    }

    // ── 4. The Electron entry point ─────────────────────────────────────────
    // `main` must name the file electron-vite emits; dev never shows the mismatch.
    const viteConfigPath = path.join(root, electronViteConfig);
    if (fs.existsSync(viteConfigPath)) {
        const viteConfig = fs.readFileSync(viteConfigPath, 'utf8');
        const mainInput = /main:\s*\{[\s\S]*?input:\s*\{\s*index:\s*resolve\(__dirname,\s*'([^']+)'/.exec(viteConfig);

        if (typeof rootPkg.main !== 'string') {
            fail(
                'package.json',
                '`main` is not a string',
                'Electron resolves the main process from it; without it the app has no entry point.',
            );
        } else {
            if (!/^out\//.test(rootPkg.main)) {
                fail(
                    'package.json',
                    `\`main\` is "${rootPkg.main}", which is not under \`out/\``,
                    'electron-vite builds into out/. Pointing main at src/ ships TypeScript to a runtime that cannot read it.',
                );
            }
            if (mainInput !== null) {
                const expected = `out/${(mainInput[1] ?? '').replace(/^src\//, '').replace(/\.ts$/, '.js')}`;
                if (rootPkg.main !== expected) {
                    fail(
                        'package.json',
                        `\`main\` is "${rootPkg.main}" but electron-vite emits "${expected}"`,
                        'A packaging-only failure: dev works because electron-vite launches the process itself, so this surfaces first as an installer that opens to nothing.',
                    );
                }
            }
        }
    }

    // ── 5. `build.files` ships the build output ─────────────────────────────
    // An allowlist that forgets `out` still packages, with no app inside.
    if (rootPkg.build !== undefined) {
        const buildFiles = rootPkg.build.files;
        if (!Array.isArray(buildFiles)) {
            fail(
                'package.json',
                '`build.files` is not an array',
                'Without an explicit allowlist electron-builder packages the whole tree, including node_modules and src.',
            );
        } else {
            const shipsOut = buildFiles.some((entry) =>
                typeof entry === 'string' ? /(^|\/)out/.test(entry) : entry?.from === 'out',
            );
            if (!shipsOut) {
                fail(
                    'package.json',
                    '`build.files` does not include the `out` directory',
                    'electron-builder would produce a bundle with no application in it, and it would package successfully.',
                );
            }
            if (!buildFiles.includes('package.json')) {
                fail(
                    'package.json',
                    '`build.files` does not include `package.json`',
                    'Electron reads `main` from the packaged manifest at launch; omit it and the app has no entry point.',
                );
            }
        }
    }

    // ── 6. `os` agrees with the build targets ───────────────────────────────
    // Only with a `build` block: `os` alone is just an install constraint.
    const declaredOs =
        rootPkg.build === undefined || !Array.isArray(rootPkg.os)
            ? []
            : rootPkg.os.filter((e): e is string => typeof e === 'string');

    for (const osName of declaredOs) {
        const target = OS_TO_TARGET[osName];
        if (target !== undefined && rootPkg.build?.[target] === undefined) {
            fail(
                'package.json',
                `\`os\` lists "${osName}" but \`build.${target}\` has no target`,
                'Advertising a platform CI cannot produce an installer for. The README support claim and the release assets come apart.',
            );
        }
    }
    for (const [osName, target] of Object.entries(OS_TO_TARGET)) {
        if (rootPkg.build?.[target] !== undefined && !declaredOs.includes(osName)) {
            fail(
                'package.json',
                `\`build.${target}\` builds an installer but \`os\` does not list "${osName}"`,
                'npm refuses to install on a platform absent from `os`, so the build target is for a platform contributors cannot set up.',
            );
        }
    }

    // ── 7. The lint toolchain comes from this package ───────────────────────
    // Only in a project that depends on it: a project copy would shadow the pinned one.
    const dependsOnSelf = [rootPkg.dependencies, rootPkg.devDependencies].some(
        (deps) => deps !== undefined && Object.hasOwn(deps, SELF_NAME),
    );

    if (dependsOnSelf) {
        for (const { file, pkg } of manifests) {
            for (const field of ['dependencies', 'devDependencies'] as const) {
                for (const name of Object.keys(pkg[field] ?? {})) {
                    if (Object.hasOwn(provided, name)) {
                        fail(
                            file,
                            `${field}.${name} is installed by ${SELF_NAME}`,
                            'Remove it. The project copy is the one scripts, git hooks and the editor would run, and version bumps belong in one place.',
                        );
                    }
                }
            }
        }

        // A symlinked `file:` install keeps its dependencies inside it, so nothing hoists.
        for (const name of Object.keys(PROJECT_CLIS)) {
            const pinned = provided[name];
            if (pinned === undefined) continue;
            const manifest = path.join('node_modules', name, 'package.json');
            if (!fs.existsSync(path.join(root, manifest))) {
                fail(
                    manifest,
                    `\`${name}\` is not installed at the top of node_modules`,
                    `Scripts, git hooks and editors look for it there. If ${SELF_NAME} is a \`file:\` dependency, set \`install-links=true\` in .npmrc so npm installs it as a copy rather than a symlink, then reinstall.`,
                );
                continue;
            }
            const { version } = read(manifest);
            if (version !== pinned) {
                fail(
                    manifest,
                    `\`${name}\` resolves to ${String(version)}, but ${SELF_NAME} pins ${pinned}`,
                    `Another package put its own copy at the top of node_modules, so that is the one scripts, hooks and editors run. \`npm explain ${name}\` names it.`,
                );
            }
        }
    }

    return { problems, manifests: manifests.map((m) => m.file) };
}

/** Run the gate and print. */
export function checkPackageJson({ root = REPO_ROOT, standard, ...rest }: PackageJsonOptions = {}): void {
    const report = createGateReport({ name: 'package.json', ...(standard === undefined ? {} : { standard }) });
    const { problems, manifests } = inspectPackageJson({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `${manifests.length} manifest(s): required metadata, semver ranges, canonical field order, the lint toolchain${fs.existsSync(path.join(root, rest.electronViteConfig ?? 'electron.vite.config.ts')) ? ', Electron entry point and packaging' : ''}.`,
        notMachineChecked:
            'Dependency CATEGORY grouping — JSON has no comments, so the groups the standard asks for cannot be read back out of the file. Review that by hand.',
    });
}
