export type DbProblem = {
    /** The file the problem is in. */
    file: string;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
};

/** One entry of the index manifest, reduced to what this gate reads. */
export type IndexSpec = {
    collection: string;
    keys?: Record<string, unknown>;
    options?: { expireAfterSeconds?: number };
    /** Which query or constraint the index serves. The standard requires it on every entry. */
    why?: string;
};

/** A deployable process that holds a database connection. */
export type DbService = {
    name: string;
    /** Its entry file, which must handle SIGTERM/SIGINT. */
    entry: string;
    /** Set false for a process that closes its client some other way. Default: true. */
    closes?: boolean;
};

/**
 * An ordered drain. Each stage must appear, and in this order — from the thing
 * that produces work to the thing that stores it.
 */
export type DrainOrder = {
    file: string;
    stages: { what: string; pattern: RegExp }[];
};

export type OpsOptions = {
    /** Destructive scripts that must refuse to run when NODE_ENV=production. */
    productionRefusals?: string[];
    /**
     * The wipe script — the most dangerous file in the repo, so it is defended
     * in depth: a TTY check, and a prompt that makes you type the database name.
     */
    wipe?: {
        file: string;
        /** How the script names the target database, e.g. `cfg.mongoDb`. */
        dbNameExpression: string;
    };
    /** The backup script, which must fail loudly rather than dump nothing. */
    backup?: { file: string };
    /** The restore script, which must flush Redis BEFORE it re-queues. */
    restore?: { file: string };
    /** Scripts that must all read env through one loader, so they cannot target different databases. */
    envLoaderConsumers?: string[];
    /** The loader's module path fragment. Default: `lib/env`. */
    envLoader?: string;
};

export type BackupOptions = {
    /** The restore-drill log. An untested backup is not a backup. */
    drills: string;
    /** The fixed-path manifest of the most recent backup. */
    latest?: string;
    /** The dump directory, which git must ignore. */
    dir?: string;
    /** How stale a drill may be before it warns. Default: 90. */
    maxAgeDays?: number;
};

export type DbDriftInput = {
    /** Repository root; every path below is relative to it. */
    root: string;
    /** The index manifest — the one definition site. Imported, not parsed. */
    manifest: string;
    /** How the bootstrap migration imports it, e.g. `@orchid/shared/db/indexes`. */
    manifestSpecifier: string;
    /** The export holding the collection list. Default: `COLLECTIONS`. */
    collectionsExport?: string;
    /** The exports holding index specs. Default: `['INDEXES']`. */
    indexExports?: string[];
    /** The module declaring the document types. */
    typesFile: string;
    /** Collection name → the type that declares its document shape. */
    collectionTypes: Record<string, string>;
    /** Collections that deliberately carry no index, mapped to the reason. */
    noIndexByDesign?: Record<string, string>;
    /** Field names that mean an index is meant to expire documents. */
    ttlFields?: string[];
    /** The migration that creates the collections on a fresh database. */
    bootstrap: string;
    /** The schema reference doc. */
    architecture: string;
    examplesDir: string;
    migrationsDir: string;
    testsDir: string;
    /** The committed checksum file that makes a merged migration immutable. */
    checksums: string;
    /** Source directories to sweep for an index dropped outside a migration. */
    appDirs?: string[];
    /** Every process that holds a connection. */
    services?: DbService[];
    /** A queue worker's ordered shutdown. */
    drainOrder?: DrainOrder;
    /**
     * Where the manifest is applied at boot. A list, because splitting it
     * across the processes that write those collections is legitimate — but an
     * index export no applier names is one nothing ever creates.
     */
    indexAppliers?: { file: string; applies: string[]; fn?: string }[];
    /** Manifests to check for a migrate-down script. */
    packageManifests?: string[];
    /** Operational script safety. Omit in a repo with no ops scripts. */
    ops?: OpsOptions;
    /** Backup health. Omit in a repo with no backup pipeline — and say so in the shim. */
    backups?: BackupOptions;
};

export type DbDriftInspection = {
    problems: DbProblem[];
    /** Advisories that must never fail a build — a stale drill, a late backup. */
    warnings: string[];
    collections: string[];
    indexes: number;
    migrations: number;
};

export type DbDriftOptions = Omit<DbDriftInput, 'root'> & {
    /** Defaults to the repository root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

export declare function inspectDbDrift(input: DbDriftInput): Promise<DbDriftInspection>;
export declare function checkDbDrift(options: DbDriftOptions): Promise<void>;
export default checkDbDrift;
