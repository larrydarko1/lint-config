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

/** The canonical field order, per the standard's "Field Ordering" section. */
export declare const CANONICAL_ORDER: string[];

export declare function inspectPackageJson(options: PackageJsonInput): PackageJsonInspection;
export declare function checkPackageJson(options?: PackageJsonOptions): void;
export default checkPackageJson;
