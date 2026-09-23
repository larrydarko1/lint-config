/** Security-standards drift gate. See security-drift.js for what each rule is for. */

export interface SecurityProblem {
    /** `path` or `path:line`, relative to the repo root. */
    file: string | null;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
}

/** The auth surface: the files the credential rules read, and the names inside them. */
export interface AuthSurface {
    /** Where the refresh cookie is set. */
    cookieFile: string;
    /** The function header, when it is not `function setRefreshCookie`. */
    cookieFn?: string;
    /** The scoped cookie path. Defaults to `/api/auth`. */
    cookiePath?: string;
    /** Login, rotation and `DUMMY_HASH`. */
    tokensFile: string;
    /** Exported login function name. Defaults to `loginUser`. */
    loginFn?: string;
    /** Exported rotation function name. Defaults to `rotateRefreshToken`. */
    rotateFn?: string;
    /** The call rotation issues the replacement through. Defaults to `issueRefreshToken`. */
    issueFn?: string;
    /** The three throttle functions. Its own call sites are exempt from rule 15. */
    throttleFile: string;
    /** Where the password schema lives. */
    schemasFile: string;
    /** The schema's name. Defaults to `passwordSchema`. */
    passwordSchema?: string;
    /** The request sanitizer, and the prefix of its strip helpers (`stripDollarKeys` → `strip`). */
    sanitizer: { file: string; fn: string; strip?: string };
    /** The auth middleware's name, for the unauthenticated-mount rule. Defaults to `requireAuth`. */
    requireAuth?: string;
    /** Where `escapeHtml` lives. Omit where the server renders no HTML. */
    escapeHtmlFile?: string;
    /** Password reset, and the config key holding its TTL. Omit where there is no reset flow. */
    passwordReset?: { file: string; ttlKey: string };
}

export interface SecurityDriftInput {
    root: string;
    /** The Express entry: helmet, cors, trust proxy, the timeouts, the mounts. */
    entry: string;
    /** The config module: Argon2 parameters, TTLs, the hop-count schema. */
    config: string;
    /** The shared env module holding `DEV_PLACEHOLDERS`. */
    envModule: string;
    /** Every shipped backend tree — JWT calls, throttle call sites. Tests are skipped. */
    backendDirs: string[];
    /** Shipped frontend trees, scanned for raw-HTML sinks. */
    frontendDirs?: string[];
    /** Trees scanned for regexes built from input. Defaults to `backendDirs`. */
    regexDirs?: string[];
    auth: AuthSurface;
    /** The reverse-proxy config, when the repo ships one. */
    nginx?: string;
    /** The Traefik TLS floor, when the repo ships one. */
    traefik?: { tlsOption: string; ingress: string; optionName: string };
    /** Mounts that are open by design. Omit where auth is applied inside each router. */
    unauthenticatedMounts?: string[];
    /** Unauthenticated `sendFile` routes, why each one is open, and how it checks the origin. */
    fileRoutes?: { file: string; why: string; originCheck?: RegExp }[];
    /** Names that hold a submitted credential. Defaults cover email/username/password/identifier/phone. */
    credentials?: string[];
    /** Calls that make a credential safe to store. Defaults cover blind indexes and hashes. */
    derivations?: string[];
}

export interface SecurityDriftInspection {
    problems: SecurityProblem[];
    counts: { backend: number; frontend: number; locations: number; throttleCalls: number };
}

export interface SecurityDriftOptions extends Omit<SecurityDriftInput, 'root'> {
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
}

/** Every security invariant this repo can be asked about, as a list of problems. */
export declare function inspectSecurityDrift(input: SecurityDriftInput): SecurityDriftInspection;

/** Run the gate and print. */
export declare function checkSecurityDrift(options: SecurityDriftOptions): void;

export default checkSecurityDrift;
