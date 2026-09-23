export type EnvProblem = {
    /** `path` or `path:line`. */
    file: string;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
};

/** One deployable process: its schema, its documentation, and the env it boots with. */
export type EnvService = {
    /** How the service is named in output, e.g. `api`. */
    name: string;
    /** The config module holding the Zod schema, e.g. `api/src/lib/config.ts`. */
    config: string;
    /** The committed file documenting its keys, e.g. `api/.env.example`. */
    example: string;
    /** The entry file dotenv must be imported first in, e.g. `api/src/index.ts`. */
    entry: string;
    /**
     * The gitignored env it actually boots with. Omitted when the service has
     * none. Its drift is reported as a warning and can never fail a build.
     */
    local?: string;
};

export type EnvDriftInput = {
    /** Repository root; every path below is relative to it. */
    root: string;
    /** Every deployable process in the repo. */
    services: EnvService[];
    /**
     * The module holding the shared Zod fragments the configs spread in
     * (`...mongoEnv`). Omit in a repo where each service declares its own keys.
     */
    sharedEnv?: string;
    /**
     * Config module → the groups its exported `config` object must carry.
     * The canonical tree is a cross-standard interface, so a rename here is a
     * breaking change in files that never import this one.
     */
    canonicalGroups?: Record<string, string[]>;
    /** Every committed `.env.example` to sweep for real secrets. */
    exampleFiles?: string[];
    /** Keys the runtime injects, so neither side has to declare them. Default: `['NODE_ENV']`. */
    ignored?: string[];
    /** Set false where git cannot be asked (a vendored tree). Default: true. */
    gitignore?: boolean;
    /**
     * Source directories to sweep for `process.env` read outside the schema.
     * Each service's own config module and entry file are exempt, as are tests.
     */
    businessDirs?: string[];
};

export type EnvDriftInspection = {
    problems: EnvProblem[];
    /** Advisories that must never fail a build — the local `.env`, and a rule that could not run. */
    warnings: string[];
    services: { name: string; keys: number }[];
};

export type EnvDriftOptions = Omit<EnvDriftInput, 'root'> & {
    /** Defaults to the repository root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

export declare function inspectEnvDrift(input: EnvDriftInput): EnvDriftInspection;
export declare function checkEnvDrift(options: EnvDriftOptions): void;
export default checkEnvDrift;
