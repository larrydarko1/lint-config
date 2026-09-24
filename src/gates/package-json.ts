/**
 * package.json gate.
 *
 * A manifest is the one file every tool reads and nobody rereads. It drifts
 * quietly: a field goes missing, a range gets pinned during a bad afternoon and
 * stays pinned, the key order wanders until diffs stop being readable.
 *
 * WHY THIS IS ONE GATE. The full-stack copies were byte-identical to each
 * other, and the desktop three differed only in a comment and one entry of a
 * data list. Across the two families three rules were shared — required
 * metadata, semver ranges, field order — and the desktop copy added three more
 * about shipping an Electron app. Those three need no switch: they fire on
 * shapes a web repo does not have (a `build` block, an `electron.vite.config`),
 * so in a web repo they are silent and cost nothing. The one thing that had to
 * be guarded was READING the electron-vite config: the desktop copy read it
 * unconditionally, which in a repo without one is a crash, not a pass.
 *
 * WHAT WAS TAKEN FROM WHICH FAMILY, and why the other spelling is gone:
 *   • the `~` ALLOWLIST is the desktop spelling. The full-stack copy hardcoded
 *     "TypeScript may use `~`, nothing else may". The allowlist says the same
 *     thing and makes the next exception cost a line of prose instead of an
 *     edit to the gate. A patch-pin is a decision; decisions get written down.
 *   • the MULTI-MANIFEST walk is the full-stack spelling, because a
 *     single-manifest repo is just the case where there are no workspaces.
 *     Roles differ: the root manifest is the project's identity and carries the
 *     full set, while workspace manifests are private, never published, and
 *     inherit toolchain facts (engines, packageManager) from the root — so
 *     re-stating those per workspace is duplication that can silently drift.
 *   • UNKNOWN FIELDS FAIL, which is the desktop spelling; the full-stack copy
 *     warned. A warning that nothing enforces is how the ordering rule stops
 *     being total: a field nobody placed sorts nowhere and is checked by
 *     nothing. Placing it costs one line.
 *
 * NOT DECIDED HERE. `CANONICAL_ORDER` is the list both families already agreed
 * on, with one genuine disagreement resolved against `sort-package-json`
 * itself, which the standard names as the authority: `packageManager` comes
 * immediately before `engines`. It is deliberately NOT that tool's full
 * 111-key order, which disagrees with the standard's own written sketch in
 * places that would move a field in every manifest in every repo. That is a
 * question about the standard, not about this gate, and it stays open.
 */
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * The canonical field order — sort-package-json's, as the standard's
 * "Field Ordering" section requires, covering every field these repos use.
 * A field absent from a manifest costs nothing; a field absent from THIS LIST
 * is a failure, so that ordering stays total.
 */
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
    // sort-package-json puts these two here, in this order. The standard names
    // that tool as the authority, and the two families had drifted apart on it.
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

/**
 * Inspect every manifest in the repo. Pure: reads the tree, returns findings.
 */
export function inspectPackageJson({
    root,
    rootRequired = [],
    workspaceRequired = [],
    canonicalOrder = CANONICAL_ORDER,
    tildeAllowed = {},
    electronViteConfig = 'electron.vite.config.ts',
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
    // Only where there is an electron-vite config to compare against. `main`
    // has to name the file it actually emits: get it wrong and the installer
    // opens to nothing, which dev never shows because electron-vite serves the
    // renderer itself.
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
    // electron-builder defaults to including everything, so an allowlist that
    // forgets `out` produces an app bundle with no application in it — and it
    // packages successfully.
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
    // `os` is what npm enforces at install time; `build.mac`/`build.linux` are
    // what CI can actually produce. Drifting them apart means advertising a
    // platform nobody builds, or building one npm refuses to install on.
    // Both halves are about electron-builder, so neither means anything without
    // a `build` block: `os` on its own is an npm install constraint and has no
    // packaging target to disagree with.
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

    return { problems, manifests: manifests.map((m) => m.file) };
}

/**
 * Run the gate and print.
 */
export function checkPackageJson({ root = REPO_ROOT, standard, ...rest }: PackageJsonOptions = {}): void {
    const report = createGateReport({ name: 'package.json', ...(standard === undefined ? {} : { standard }) });
    const { problems, manifests } = inspectPackageJson({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `${manifests.length} manifest(s): required metadata, semver ranges, canonical field order${fs.existsSync(path.join(root, rest.electronViteConfig ?? 'electron.vite.config.ts')) ? ', Electron entry point and packaging' : ''}.`,
        notMachineChecked:
            'Dependency CATEGORY grouping — JSON has no comments, so the groups the standard asks for cannot be read back out of the file. Review that by hand.',
    });
}

export default checkPackageJson;
