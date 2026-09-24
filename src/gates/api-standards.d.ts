/** REST API architecture gate — the route map, the middleware order, the limiter contract. See api-standards.js. */

export interface ApiProblem {
    file: string | null;
    what: string;
    why: string;
}

export interface ApiStandardsInput {
    /** Repository root. Defaults to the nearest ancestor holding a package.json. */
    root?: string;
    /** The directory of router files, each opening with its JSDoc route map. */
    routesDir: string;
    /** The server entry point, where the middleware stack and the mounts live. */
    indexFile: string;
    /** The module exporting one Express middleware per tier. */
    rateLimiters: string;
    /** The module holding the atomic Redis Lua bucket. */
    tokenBucket: string;
    /** The shared Zod schemas, where `makePaginationQuery` lives. */
    schemas: string;
    /** The frontend HTTP client, which carries the other half of `credentials: true`. */
    apiClient?: string;
    /** The API's package.json, checked for a fixed-window limiter dependency. */
    packageJson?: string;
    /** The rate-limit tiers this repo exports. Defaults to strict/standard/relaxed. */
    tiers?: string[];
    /** The mount prefix every router sits under. Defaults to `/api/`. */
    mountPrefix?: string;
    /** The global token-resolving middleware that must precede the limiters. */
    optionalAuth?: string;
    /** What builds the shared client instance. Defaults to `axios.create(`. */
    clientFactory?: string;
}

export interface ApiStandardsInspection {
    problems: ApiProblem[];
    counts: { routes: number; files: number; mounts: number };
}

export interface ApiStandardsOptions extends Omit<ApiStandardsInput, 'root'> {
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
}

/** Every REST relationship this repo can be asked about, as a list of problems. */
export declare function inspectApiStandards(input: ApiStandardsInput): ApiStandardsInspection;

/** Run the gate and print. */
export declare function checkApiStandards(options: ApiStandardsOptions): void;

export default checkApiStandards;
