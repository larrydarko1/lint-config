/**
 * REST API architecture: the route map, the middleware order and the limiter contract.
 * ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Each router's JSDoc route map matches its declarations, both ways.
 *   2. Route paths name resources, not the verb the method already says.
 *   3. Routes stay thin: no direct database access.
 *   4. No `/api/v<n>` prefix until a real v2 exists.
 *   5. Middleware order (positions via `callSites`, never indentation; an
 *      `express.json()` alias is resolved to where it is registered).
 *   6. Every mount carries a rate-limit tier.
 *   7. The token-bucket contract, and no fixed-window limiter library beside it.
 *   8. Pagination is capped through the shared schema, never raw `parseInt` on `req.query`.
 *   9. CORS credentials on both the server and the shared client instance.
 *  10. Responses leave through one helper that parses the data with a Zod schema,
 *      and no response schema lets unknown fields through (opt-in: `responses`);
 *      with `devFlag`, the helper fails on a field its schema dropped outside
 *      production and logs it in production.
 *  11. One API contract (opt-in: `contract`): its keys are exactly the routes the
 *      routers serve, both ways; a router validates bodies and queries with
 *      schemas from the shared package, never ones of its own; the frontend
 *      calls the API only through its typed caller; the validator refuses a key
 *      a schema does not declare; and the test setups hold every exchange to it,
 *      refusals included. With `handlers`, each route validates its path,
 *      body and query, answers and takes uploads with exactly what its
 *      contract entry names.
 *      With `coverage`, each setup records the routes it checked and each suite's
 *      global setup fails the run on a route no test checked. With `fuzz`, the
 *      fuzz run is built from the contract alone, its config is the one the
 *      fuzzer reads, every route it names exists, every exception to it says
 *      why, no exception forgives a server error, every tool it installs is
 *      pinned, the API it starts is handed the run's own storage and queues
 *      (`isolate`), and what a run writes is git-ignored.
 *  12. One job contract (opt-in: `jobs`): queues are built only in the producer,
 *      which parses what it queues against the registry and refuses dropped keys;
 *      every worker runs its jobs through the processor that parses them and
 *      fails a malformed one as unrecoverable; every queue is named from the
 *      registry; and the registry's schemas tolerate a field they do not know.
 * Also: `optionalAuth` before the limited mounts (they key on `req.userId`), and no
 * `{ ok: true, data }` success envelope.
 */
import fs from 'node:fs';
import path from 'node:path';

import { gitIgnores, walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { braceBlock, callArgs, callSites, declaredBody, splitTopLevel } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

export type ApiStandardsOptions = {
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
    /** The shared Zod schemas. */
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
    /** Response schemas (rule 10). A repo that states none is not graded on it. */
    responses?: ResponseSchemaOptions;
    /**
     * The middleware that gives each request its id and its logger (rule 5). Stated,
     * it must be registered before the body parser, so a body that will not parse
     * still reaches the error handler with an id and somewhere to log.
     */
    requestId?: string;
    /** The API contract (rule 11). A repo that states none is not graded on it. */
    contract?: ContractOptions;
    /** The job contract between the API and its worker (rule 12). A repo that states none is not graded on it. */
    jobs?: JobsOptions;
};

export type ContractOptions = {
    /** The module holding the contract table: one `'METHOD /api/path': { … }` key per route. */
    file: string;
    /** The package routers import their request schemas from, e.g. `@acme/shared`. */
    sharedPackage: string;
    /**
     * The frontend's typed caller lives in `apiClient`; no other frontend module may
     * call the axios `instance` directly, since that is where a response type is
     * written by hand. `dir` is the frontend source root.
     */
    caller?: { instance: string; dir: string };
    /**
     * The request validator. It must refuse a key the schema does not declare with
     * the rest of the 422, so it must call the shared `droppedKeys`: a Zod object
     * alone strips the key and answers 2xx.
     */
    validator?: string;
    /**
     * The test setups that hold exchanges to the contract: the frontend's mock
     * server and the API's test app. Each must call the shared `requestProblems`,
     * `responseProblems` and `errorProblems`: a refusal is part of the contract
     * too, and a mock answering with a code the API never sends tests a path no
     * user can reach.
     */
    testChecks?: string[];
    /**
     * The contract-coverage log (needs `testChecks`). A route no test calls is
     * never checked, so its schemas can be wrong while every test stays green.
     * Each setup in `testChecks` must record the routes it checked, into the
     * log its suite's global setup provides; that setup must fail the run on
     * the routes nobody recorded.
     */
    coverage?: ContractCoverage;
    /**
     * The API fuzz run (Schemathesis). It sends generated requests to a real API
     * and fails on a server error or an answer the contract refuses, so it is only
     * as good as the document it reads and the exceptions its config allows.
     */
    fuzz?: ContractFuzz;
    /**
     * How a route names its schemas. Stated, every route declaration must hand
     * the validator the `body` and `query` its contract entry names, answer
     * through the helper with a schema its `response` names (and never for
     * `null`), and take the upload fields its `files` names. Without it, a router
     * can validate or answer with a schema the contract does not name, and only
     * a test that happens to send the difference notices.
     */
    handlers?: ContractHandlers;
};

export type ContractHandlers = {
    /** The validator a route hands `{ body, query, params }` and its handler, e.g. `validated`. */
    validate: string;
    /** The helper a route answers through, with the schema as its second argument, e.g. `send`. */
    send: string;
    /** Modules besides the router where a validator's schema object may be declared, e.g. shared params objects. */
    objects?: string[];
};

export type ContractCoverage = {
    /** The module `openCoverageLog`, `recordCheckedRoute` and `uncheckedRoutes` come from. */
    module: string;
    /** One per test suite: its Vitest config, and the global setup the config registers. */
    suites: { config: string; setup: string }[];
};

export type ContractFuzz = {
    /** The module that builds the OpenAPI document from the contract table, and the function it exports for that. */
    document: { file: string; name: string };
    /** The script that writes the document fresh and starts the fuzzer on it. */
    runner: string;
    /** The fuzzer's `schemathesis.toml`, which the runner must hand it by path. */
    config: string;
    /** The pip requirements file that pins the fuzzer, and anything the run starts beside it. Every line is pinned with `==`. */
    requirements: string;
    /**
     * The env keys the runner must set itself for the API it starts: where the
     * run's storage and queues are (`S3_ENDPOINT`, `REDIS_PORT`). An API fills a
     * key it is not given from its dev env file, so a run that leaves one out
     * writes its uploads and jobs into the dev services, where they outlive it.
     */
    isolate?: string[];
    /**
     * What a run writes besides the fuzzer's own cache: the virtualenv, the
     * reports. Each must be git-ignored. The cache (`.schemathesis/`) is always
     * checked, at the repository root and beside `config`.
     */
    outputs: string[];
};

export type JobsOptions = {
    /** The registry module: one `{ queue, data }` entry per job. */
    file: string;
    /** The registry's exported name, e.g. `JOBS`. */
    table: string;
    /** The API module that builds the queues and adds every job to them. */
    producer: string;
    /** The worker's wrapper that parses `job.data` before a handler sees it. */
    processor: { file: string; name: string };
    /** The worker modules that build BullMQ `Worker`s. */
    workers: string[];
};

export type ResponseSchemaOptions = {
    /** The module holding the helper every route answers through. It must parse with a schema. */
    helper: string;
    /** The directory of response schemas, checked for shapes that let unknown fields through. */
    schemasDir: string;
    /** Route files still answering raw, each with a reason. A ratchet: remove entries, never add. */
    pending?: Record<string, string>;
    /**
     * The expression that is true outside production, e.g. `config.isDev`. Stated,
     * the helper must name the fields its schema dropped (`droppedKeys`), throw on
     * them when this holds, and log them at error level otherwise.
     */
    devFlag?: string;
};

type ApiStandardsInspection = {
    problems: GateFailure[];
    counts: { routes: number; files: number; mounts: number; pending: number };
};

type ContractContext = {
    routeFiles: string[];
    read: (rel: string) => string;
    code: (rel: string) => string;
    exists: (rel: string) => boolean;
    fail: (file: string | null, what: string, why: string) => void;
    apiClient: string | undefined;
    root: string;
};

/** The three tiers the standard names. A repo with more states its own list. */
const DEFAULT_TIERS = ['strictLimiter', 'standardLimiter', 'relaxedLimiter'];

/** Path segments that repeat the HTTP method: `POST /videos`, never `POST /videos/create`. */
const VERB_SEGMENTS = new Set(['create', 'update', 'delete', 'remove', 'get', 'list', 'new', 'edit', 'fetch']);

/** Fixed-window counters wearing a token bucket's job. */
const FIXED_WINDOW_LIBRARIES = ['express-rate-limit', 'rate-limiter-flexible'];

/** Every `router.<verb>('<path>'` declaration, tolerant of the argument list wrapping. */
const ROUTE_DECLARATION = /^router\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']*)'/gm;

/** Route lines in a JSDoc header: ` * GET /videos/:id — one clause`. */
const ROUTE_DOCUMENTATION = /^\s*\*\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/gm;

/** A `res` chain right before the call: `res.`, `res.status(201).`, `res.set('X', 'y').`. */
const RES_RECEIVER = /\bres(?:\s*\.\s*\w+\s*\([^()]*\))*\s*\.\s*$/;

/** An error body: `{ error: 'CODE' }` carries a machine code, never data. */
const ERROR_BODY = /^\s*\{\s*error\s*[:,}]/;

/** Schema escape hatches: each one lets a field through that no one declared. */
const LOOSE_SCHEMA: [RegExp, string][] = [
    [/\bz\.looseObject\(/, '`z.looseObject()`'],
    [/\.passthrough\(/, '`.passthrough()`'],
    [/\.loose\(/, '`.loose()`'],
    [/\.catchall\(/, '`.catchall()`'],
    [/\bz\.any\(/, '`z.any()`'],
    [/\bz\.unknown\(/, '`z.unknown()`'],
    [/\bz\.json\(/, '`z.json()`'],
    [/\bz\.custom\(/, '`z.custom()`'],
];

/** A contract key: `'GET /api/videos/:id': {`. */
const CONTRACT_KEY = /['"]((?:GET|POST|PUT|PATCH|DELETE) \/[^'"]*)['"]\s*:/g;

/** The shared contract checks the test setups call. */
const CONTRACT_CHECKS = ['requestProblems', 'responseProblems', 'errorProblems'];

/** A `params:`, `body:` or `query:` key in a validator's schema object, and the first token of its value. */
const REQUEST_SCHEMA_SLOT = /(?<![\w.$])(params|body|query)\s*:\s*([A-Za-z_$][\w$]*)(\s*[.(]?)/g;

/** A route written as a string, keyed or listed: `'GET /api/videos'`. */
const ROUTE_LITERAL = /['"`](?:GET|POST|PUT|PATCH|DELETE) \/[^'"`]*['"`]/g;

/** The checks a fuzz run exists for. Never switched off, anywhere. */
const FUZZ_CORE_CHECKS = ['not_a_server_error', 'response_schema_conformance'];

/** The `schemathesis.toml` filters that name operations: by operation id (the contract key), by exact path, by path pattern. */
const FUZZ_ID_FILTERS = ['include-operation-id', 'exclude-operation-id'];
const FUZZ_PATH_FILTERS = ['include-path', 'exclude-path'];
const FUZZ_PATTERN_FILTERS = ['include-path-regex', 'exclude-path-regex'];

/** Every problem found, without printing. */
export function inspectApiStandards(input: ApiStandardsOptions): ApiStandardsInspection {
    const {
        root = REPO_ROOT,
        routesDir,
        indexFile,
        rateLimiters,
        tokenBucket,
        schemas,
        apiClient,
        packageJson,
        tiers = DEFAULT_TIERS,
        mountPrefix = '/api/',
        optionalAuth,
        clientFactory = 'axios.create(',
        responses,
        requestId,
        contract,
        jobs,
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));
    /** Comments blanked: a commented-out route must not answer for a live one. */
    const code = (rel: string) => stripComments(read(rel));

    const routeFiles = walkFiles(root, routesDir, {
        match: /\.ts$/,
        exclude: (rel) => rel.includes('__tests__'),
    });

    // ── 1. Route documentation parity ───────────────────────────────────────
    for (const rel of routeFiles) {
        const source = read(rel);
        const header = /^\/\*\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
        const declared = new Set(
            [...code(rel).matchAll(ROUTE_DECLARATION)].map(
                ([, verb = '', routePath]) => `${verb.toUpperCase()} ${routePath}`,
            ),
        );

        // Headers may write mounted (`/api/videos/:id`) or relative (`/:id`) paths;
        // strip the stated mount. Trailing punctuation is trimmed off the mount.
        const mount = (/mounted at (\/\S*)/.exec(header)?.[1] ?? '').replace(/[.,;:)]+$/, '') || null;
        const documented = new Set(
            [...header.matchAll(ROUTE_DOCUMENTATION)].map(([, verb, documentedPath = '']) => {
                let route = documentedPath;
                if (mount !== null && route.startsWith(mount)) {
                    route = route.slice(mount.length);
                    if (route === '') route = '/';
                }
                return `${verb} ${route}`;
            }),
        );

        const undocumented = [...declared].filter((route) => !documented.has(route));
        const phantom = [...documented].filter((route) => !declared.has(route));

        if (undocumented.length > 0) {
            fail(
                rel,
                `${plural(undocumented.length, 'route')} not in the file's JSDoc header: ${undocumented.join(', ')}`,
                'The header is the only index of this router. A route missing from it is invisible to anyone reading the file top-down, and to any review of what the API exposes.',
            );
        }
        if (phantom.length > 0) {
            fail(
                rel,
                `the header documents ${plural(phantom.length, 'route')} the file does not declare: ${phantom.join(', ')}`,
                'The route was renamed or removed and the header was not. It now points callers at a 404.',
            );
        }
    }

    // ── 2. Route path shape ─────────────────────────────────────────────────
    for (const rel of routeFiles) {
        for (const [, , routePath = ''] of code(rel).matchAll(ROUTE_DECLARATION)) {
            for (const segment of routePath.split('/')) {
                // A parameter or a wildcard is named by the code, not by the URL.
                if (segment === '' || segment.startsWith(':') || segment.startsWith('*')) continue;
                if (VERB_SEGMENTS.has(segment)) {
                    fail(
                        rel,
                        `route path '${routePath}' has the verb segment '${segment}'`,
                        'The HTTP method does the verbing — `POST /videos`, not `POST /videos/create`. A verb in the path means two things claim to say what the request does.',
                    );
                }
                if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment)) {
                    fail(
                        rel,
                        `route path '${routePath}' has the non-kebab-case segment '${segment}'`,
                        'Resource paths are kebab-case: /email-verifications, not /emailVerifications. URLs are case-sensitive and camelCase in one reads as a typo next to the rest.',
                    );
                }
            }
        }
    }

    // ── 3. Routes stay thin ─────────────────────────────────────────────────
    for (const rel of routeFiles) {
        const source = code(rel);
        if (/\bgetDb\(\)/.test(source) || /\bdb\.collection\(/.test(source)) {
            fail(
                rel,
                'reaches the database directly',
                'Routes are thin wrappers: validate → call service → respond. A query in a route is untestable without HTTP and invisible to anyone auditing data access by service.',
            );
        }
        if (/\bparseInt\(\s*(?:String\()?req\.query\b/.test(source)) {
            fail(
                rel,
                'reads a query parameter with `parseInt(req.query…)`',
                'That bypasses the Zod query schema, and with it the cap the schema declares — `?limit=1000000` goes straight through. Attach `validate({ query })` and read `req.validatedQuery`.',
            );
        }
        if (/res\.json\(\s*\{\s*ok:\s*true\s*,\s*data\b/.test(source)) {
            fail(
                rel,
                'wraps a success response in an `{ ok: true, data }` envelope',
                'Success returns the resource directly. An envelope on every response is noise every consumer has to unwrap forever, and the status code already carries the ok.',
            );
        }
    }

    // ── 4. Route path versioning ────────────────────────────────────────────
    const index = code(indexFile);
    if (/['"]\/api\/v\d/.test(index)) {
        fail(
            indexFile,
            'mounts a versioned `/api/v<n>` prefix',
            'Routes stay flat under /api/ until a real v2 exists. Premature versioning puts a number in every path that nothing ever increments.',
        );
    }

    // ── 5. Middleware order ─────────────────────────────────────────────────
    /** Where a middleware is installed. `-1` when it is not. */
    const installedAt = (token: string) => index.indexOf(token);

    const helmetAt = installedAt('helmet(');
    const corsAt = installedAt('cors({');
    // Order is where a middleware is registered, not created: resolve
    // `const parseJson = express.json(…)` to its `app.use()`, falling back to the
    // factory only when registered inline.
    const jsonAlias = /const\s+([A-Za-z_$][\w$]*)\s*=\s*express\.json\(/.exec(index)?.[1];
    const jsonUseAt = jsonAlias === undefined ? -1 : installedAt(`${jsonAlias}(req`);
    const jsonAt = jsonUseAt !== -1 ? jsonUseAt : installedAt('express.json(');
    const errorHandlerAt = index.indexOf('app.use(errorHandler)');
    const firstRouteAt = index.search(/app\.(use|get)\(\s*['"]\//);

    for (const [what, at] of [
        ['helmet()', helmetAt],
        ['cors()', corsAt],
        ['express.json()', jsonAt],
        ['errorHandler', errorHandlerAt],
    ] as [string, number][]) {
        if (at === -1) {
            fail(
                indexFile,
                `no longer registers ${what}`,
                'The middleware stack is load-bearing: helmet sets every security header, cors gates the origin, json parses bodies, errorHandler is the single response boundary.',
            );
        }
    }

    if (helmetAt !== -1 && firstRouteAt !== -1 && helmetAt > firstRouteAt) {
        fail(
            indexFile,
            'registers helmet() after the first route',
            'Headers set after a route has already responded are set on nothing. helmet must be the first middleware.',
        );
    }
    if (requestId !== undefined && jsonAt !== -1) {
        const requestIdAt = installedAt(`app.use(${requestId})`);
        if (requestIdAt === -1) {
            fail(
                indexFile,
                `does not register \`${requestId}\` globally`,
                'Every log line about a request carries its id, and every response returns it — that is how a 5xx a user reports is found in the logs. Without it, a failure is a time and a guess.',
            );
        } else if (requestIdAt > jsonAt) {
            fail(
                indexFile,
                `registers \`${requestId}\` after express.json()`,
                'A body that will not parse fails inside the parser, before the id and the request logger exist. The error handler then has no logger to call, crashes itself, and Express answers a bare 500 with the stack on stderr: a client typo becomes an untraceable server error.',
            );
        }
    }
    if (corsAt !== -1 && jsonAt !== -1 && corsAt > jsonAt) {
        fail(
            indexFile,
            'registers cors() after express.json()',
            'Body parsing must not run before the origin check — a rejected origin should never have had its payload read.',
        );
    }

    const mounts = callSites(index, 'app.use(').filter((site) => new RegExp(`^\\s*['"]${mountPrefix}`).test(site.args));
    const lastMountAt = mounts.length === 0 ? -1 : (mounts.at(-1)?.index ?? -1);

    if (errorHandlerAt !== -1 && lastMountAt !== -1 && errorHandlerAt < lastMountAt) {
        fail(
            indexFile,
            'registers errorHandler before the last route',
            'Express identifies the error handler by its 4-argument signature and only reaches it through routes registered BEFORE it. Registered early it never fires — and nothing fails loudly; every AppError degrades to an unhandled 500.',
        );
    }

    if (optionalAuth !== undefined) {
        const optionalAuthAt = index.indexOf(`app.use(${optionalAuth})`);
        const firstLimitedMount = mounts.find((site) => tiers.some((tier) => site.args.includes(tier)));
        if (optionalAuthAt === -1) {
            fail(
                indexFile,
                `does not register \`${optionalAuth}\` globally`,
                'The rate limiters key on `req.userId` and fall back to the IP. Without a global resolve ahead of them, every authenticated client is limited as its IP — and everyone behind one NAT shares a bucket.',
            );
        } else if (firstLimitedMount !== undefined && optionalAuthAt > firstLimitedMount.index) {
            fail(
                indexFile,
                `registers \`${optionalAuth}\` after the first rate-limited mount`,
                'Order is the whole rule: the token has to be resolved BEFORE the limiter reads `req.userId`. Registered after, `req.userId` is never set when the limiter runs, so it silently keys by IP and nothing anywhere reports it.',
            );
        }
    }

    // ── 6. A rate-limit tier on every mount ─────────────────────────────────
    const limited = mounts.filter((site) => tiers.some((tier) => site.args.includes(tier)));
    for (const site of mounts) {
        if (tiers.some((tier) => site.args.includes(tier))) continue;
        const mountPath = /^\s*(['"][^'"]*['"])/.exec(site.args)?.[1] ?? '?';
        fail(
            indexFile,
            `mounts ${mountPath} with no rate-limit tier`,
            `A router mounted without one is unlimited, and it reads exactly like the ${plural(limited.length, 'limited mount')} around it. Every ${mountPrefix}* mount takes one of: ${tiers.join(', ')}.`,
        );
    }

    // ── 7. The token-bucket contract ────────────────────────────────────────
    const bucket = code(tokenBucket);
    const limiters = code(rateLimiters);

    if (!bucket.includes('.eval(')) {
        fail(
            tokenBucket,
            'no Redis `eval()` — the refill-and-consume is no longer one atomic script',
            'Read-modify-write across API replicas must be atomic or two pods refill the same bucket concurrently and the limit is not a limit. A single Lua EVAL is what makes it atomic without a distributed lock.',
        );
    }
    if (!/allowed:\s*true/.test(bucket) || !bucket.includes('catch')) {
        fail(
            tokenBucket,
            'no longer fails OPEN on a Redis error',
            'A cache blip must not lock every client out of the platform. On a Redis failure the bucket allows the request and logs a warning — never denies. Failing closed turns a dependency outage into a total outage.',
        );
    }
    if (!limiters.includes('Retry-After')) {
        fail(
            rateLimiters,
            'does not set `Retry-After` on a 429',
            'Without it a throttled client has no idea how long to wait and retries immediately — the limiter then generates the load it exists to shed.',
        );
    }
    if (!/'RateLimit-Remaining'|"RateLimit-Remaining"/.test(limiters)) {
        fail(
            rateLimiters,
            'does not set `RateLimit-Remaining`',
            'Clients cannot back off before hitting the wall if the budget is invisible.',
        );
    }
    for (const rel of [rateLimiters, tokenBucket]) {
        if (/X-RateLimit-/i.test(code(rel))) {
            fail(
                rel,
                'uses an `X-RateLimit-*` header',
                'The IETF standard names carry no `X-` prefix (RFC 6648 deprecated it). Use `RateLimit-Remaining` / `Retry-After`.',
            );
        }
    }

    const limiterSources = [rateLimiters, tokenBucket, indexFile, ...routeFiles];
    for (const library of FIXED_WINDOW_LIBRARIES) {
        const importers = limiterSources.filter((rel) => new RegExp(`from\\s+'${library}'`).test(code(rel)));
        for (const rel of importers) {
            fail(
                rel,
                `imports \`${library}\``,
                'It is a fixed-window counter, not a token bucket: no burst capacity with continuous refill, and a client gets up to 2× the limit across a window boundary. The Redis Lua bucket is the one limiter.',
            );
        }
        if (packageJson !== undefined && exists(packageJson)) {
            const manifest = JSON.parse(read(packageJson));
            if (manifest.dependencies?.[library] !== undefined || manifest.devDependencies?.[library] !== undefined) {
                fail(
                    packageJson,
                    `depends on \`${library}\``,
                    'A fixed-window limiter in the dependency list is one import away from being registered beside the token bucket, where whichever runs first decides the limit.',
                );
            }
        }
    }

    // ── 8. The pagination cap ───────────────────────────────────────────────
    const schemaSource = code(schemas);
    if (!schemaSource.includes('makePaginationQuery')) {
        fail(
            schemas,
            'no `makePaginationQuery` factory',
            'It is the single definition of the pagination contract — page ≥ 1, limit capped. Per-route hand-rolled schemas drift apart.',
        );
    } else {
        if (!/\.max\(\s*maxLimit/.test(schemaSource)) {
            fail(
                schemas,
                'the pagination `limit` is not capped by `maxLimit`',
                'An uncapped limit is a client-controlled query cost: `?limit=1000000` is a denial-of-service parameter with a friendly name.',
            );
        }
        if (!/\.min\(\s*1/.test(schemaSource)) {
            fail(
                schemas,
                'the pagination `page` has no `min(1)`',
                'A page of 0 or negative produces a negative `skip`, which Mongo rejects at query time as a 500 instead of a 422.',
            );
        }
    }

    // ── 9. CORS and credentials, both halves ────────────────────────────────
    if (!/origin:\s*config\.corsOrigin/.test(index)) {
        fail(
            indexFile,
            'cors() origin is not `config.corsOrigin`',
            'The single allowed origin comes from the Zod-validated env schema. A literal or a wildcard here bypasses that validation and, with credentials:true, is a cross-origin credential leak.',
        );
    }
    if (!/credentials:\s*true/.test(index)) {
        fail(
            indexFile,
            'cors() is missing `credentials: true`',
            'Without it the browser drops the httpOnly refresh cookie and every session silently ends at access-token expiry.',
        );
    }
    if (apiClient !== undefined) {
        if (!exists(apiClient)) {
            fail(
                apiClient,
                'missing',
                'One HTTP client module for the whole frontend — it is where the credential setting lives.',
            );
        } else {
            // From the shared instance, not the file: a per-call `withCredentials` elsewhere must not satisfy it.
            const clientSource = code(apiClient);
            const [construction] = callArgs(clientSource, clientFactory);
            if (construction === undefined) {
                fail(
                    apiClient,
                    `does not construct the shared client with \`${clientFactory})\``,
                    'The credential setting is checked on the shared instance, not anywhere in the file — a per-call option cannot answer for it. Point `clientFactory` at whatever builds the singleton.',
                );
            } else if (!/withCredentials:\s*true/.test(construction)) {
                fail(
                    apiClient,
                    'the shared HTTP client is missing `withCredentials: true`',
                    'The client half of the same setting. `credentials: true` on the server alone does nothing — the browser still withholds the cookie unless the request asks for it, so every request but the ones that opt in individually loses the session.',
                );
            }
        }
    }

    // ── 10. Responses go through a schema ───────────────────────────────────
    if (responses !== undefined) {
        const { helper, schemasDir, pending = {}, devFlag } = responses;

        if (!exists(helper)) {
            fail(
                helper,
                'missing',
                'It is the one door every response leaves through. Without it there is nowhere to check that a response was cut down to its schema.',
            );
        } else {
            const source = code(helper);
            if (!/\.(?:safeParse|parse)\(/.test(source)) {
                fail(
                    helper,
                    'never parses the data with a schema',
                    'Parsing is the part that matters: a Zod object drops every field it does not declare, so a response can only carry what its schema lists. A helper that just calls `res.json()` checks nothing.',
                );
            }
            if (devFlag !== undefined) inspectLoudDrops(helper, source, devFlag, fail);
        }

        for (const rel of routeFiles) {
            const raw = rawResponses(code(rel));
            if (rel in pending) {
                if (raw.length === 0) {
                    fail(
                        rel,
                        'answers through the schema helper now, but is still in `responses.pending`',
                        'Remove the entry. A file left on the list is allowed to send raw responses again, and nothing would notice.',
                    );
                }
                continue;
            }
            for (const line of raw) {
                fail(
                    `${rel}:${line}`,
                    'sends a response without its schema',
                    'Whatever the service returned goes on the wire, including a field added to the database tomorrow. Answer with the schema helper, which drops every field the schema does not list. Error bodies (`{ error: CODE }`) are exempt: they carry a code, never data.',
                );
            }
        }

        for (const rel of Object.keys(pending).sort()) {
            if (!routeFiles.includes(rel)) {
                fail(
                    rel,
                    'is in `responses.pending` but is not a route file',
                    'It was moved or deleted. Remove the entry, or fix the path, so the list only names files it is really excusing.',
                );
            }
        }

        const schemaFiles = walkFiles(root, schemasDir, {
            match: /\.ts$/,
            exclude: (rel) => rel.includes('__tests__'),
        });
        for (const rel of schemaFiles) {
            const source = code(rel);
            for (const [pattern, name] of LOOSE_SCHEMA) {
                if (pattern.test(source)) {
                    fail(
                        rel,
                        `a response schema uses ${name}`,
                        'It lets through fields no one declared, so the schema stops being a list of what may leave the server. Name every field instead.',
                    );
                }
            }
            if (callArgs(source, 'z.record(').some((args) => lastArgument(args).startsWith('z.string('))) {
                fail(
                    rel,
                    'a response schema uses a record of strings',
                    'A map from any key to any string is a bag a secret fits in, unnamed. Use an object with named fields, or a record whose values are numbers, enums or objects.',
                );
            }
        }
    }

    // ── 11. One API contract ────────────────────────────────────────────────
    if (contract !== undefined) {
        inspectContract(contract, { routeFiles, read, code, exists, fail, apiClient, root });
    }

    // ── 12. One job contract ────────────────────────────────────────────────
    if (jobs !== undefined) {
        inspectJobs(jobs, { routeFiles, read, code, exists, fail, apiClient, root });
    }

    const routes = routeFiles.reduce((total, rel) => total + [...code(rel).matchAll(ROUTE_DECLARATION)].length, 0);

    const pending = Object.keys(responses?.pending ?? {}).length;

    return { problems, counts: { routes, files: routeFiles.length, mounts: mounts.length, pending } };
}

/** Run the gate and print. */
export function checkApiStandards(options: ApiStandardsOptions): void {
    const report = createGateReport({ name: 'REST API standards' });
    const { problems, counts } = inspectApiStandards(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const contract =
        options.contract === undefined
            ? ''
            : ` The contract lists every served route, and routers validate with the shared schemas${
                  options.contract.handlers === undefined
                      ? ''
                      : ', each route with exactly the path parameters, body, query, answer and upload fields its entry names'
              }${options.contract.validator === undefined ? '' : '; unknown request keys are refused'}${
                  options.contract.testChecks === undefined
                      ? '.'
                      : `; every exchange in ${plural(options.contract.testChecks.length, 'test setup')} is checked against it, refusals included${
                            options.contract.coverage === undefined
                                ? '.'
                                : `, and ${plural(options.contract.coverage.suites.length, 'suite')} fail on a route no test checked.`
                        }`
              }`;
    const jobs =
        options.jobs === undefined
            ? ''
            : ` Jobs are parsed against \`${options.jobs.table}\` when queued and when run, with every queue named from it.`;
    const responses =
        options.responses === undefined
            ? ''
            : ` No raw responses in ${plural(counts.files - counts.pending, 'router file')}, the response helper parses, no loose response schema${
                  counts.pending === 0 ? '.' : ` — ${counts.pending} router files still pending migration.`
              }${
                  options.responses.devFlag === undefined
                      ? ''
                      : ' A dropped field fails outside production and is logged inside it.'
              }`;

    report.done({
        summary:
            `REST API architecture OK — ${plural(counts.routes, 'route')} across ${plural(counts.files, 'router file')}, ` +
            `each one documented in its own header; middleware ordered with the error handler last, ` +
            `${plural(counts.mounts, 'mount')} all carrying a rate-limit tier, token bucket atomic and fail-open, pagination capped.${
                responses
            }${contract}${jobs}`,
        notMachineChecked:
            'Whether a status code is the RIGHT one, whether independent awaits were parallelised, cache TTL judgement, or whether a given POST is idempotent. Nor whether a route header describes what the route actually does — only that the two lists match. ' +
            'Nor whether a field a schema DOES declare should be public — a secret under a declared name passes; the response-leak tripwire is what catches that.',
    });
}

/** The last top-level argument in an argument list: the value schema of `z.record(key, value)`. */
const lastArgument = (args: string): string => {
    let depth = 0;
    let start = 0;
    for (let i = 0; i < args.length; i++) {
        const ch = args[i];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) start = i + 1;
    }
    return args.slice(start).trim();
};

/**
 * Every response a route sends without the schema helper, as its line number:
 * `res.json(…)` with anything but an error body, `res.send(…)` and `res.end(…)`
 * with a payload. A bare `res.status(204).end()` sends nothing, so it is fine.
 */
function rawResponses(source: string): number[] {
    const lines: number[] = [];
    for (const method of ['json', 'send', 'end']) {
        for (const site of callSites(source, `.${method}(`)) {
            if (!RES_RECEIVER.test(source.slice(Math.max(0, site.index - 120), site.index + 1))) continue;
            if (site.args.trim() === '') continue;
            if (method === 'json' && ERROR_BODY.test(site.args)) continue;
            lines.push(source.slice(0, site.index).split('\n').length);
        }
    }
    return lines.sort((a, b) => a - b);
}

/** Rule 11: the contract's keys, the routers' request schemas, the frontend's one caller. */
function inspectContract(contract: ContractOptions, ctx: ContractContext): void {
    const { routeFiles, read, code, exists, fail, apiClient, root } = ctx;
    const { file, sharedPackage, caller, validator, testChecks = [], coverage, fuzz, handlers } = contract;

    if (!exists(file)) {
        fail(
            file,
            'missing',
            'It is the one place that says what each route takes and answers. Both test suites check against it; without it each mocks an API of its own.',
        );
        return;
    }

    // The routes the routers serve, by their full path: the header's mount plus the declared path.
    const served = new Map<string, string>();
    const mounts = new Map<string, string>();
    for (const rel of routeFiles) {
        const header = /^\/\*\*[\s\S]*?\*\//.exec(read(rel))?.[0] ?? '';
        const mount = (/mounted at (\/\S*)/.exec(header)?.[1] ?? '').replace(/[.,;:)]+$/, '');
        const declared = [...code(rel).matchAll(ROUTE_DECLARATION)];
        if (declared.length === 0) continue;
        if (mount === '') {
            fail(
                rel,
                'states no `mounted at` path in its header',
                'The contract keys every route by its full path, and the header is where this router says where it sits.',
            );
            continue;
        }
        mounts.set(rel, mount);
        for (const [, verb = '', routePath = ''] of declared) {
            served.set(`${verb.toUpperCase()} ${mount}${routePath === '/' ? '' : routePath}`, rel);
        }
    }

    const listed = new Set([...code(file).matchAll(CONTRACT_KEY)].map(([, key = '']) => key));
    const unlisted = [...served.keys()].filter((route) => !listed.has(route)).sort();
    const unserved = [...listed].filter((route) => !served.has(route)).sort();
    if (unlisted.length > 0) {
        fail(
            file,
            `does not list ${plural(unlisted.length, 'route')} the routers serve: ${unlisted.join(', ')}`,
            'A route missing from the contract is one the frontend cannot call through its typed caller and its tests cannot mock. Add it, with the schemas its router validates and answers with.',
        );
    }
    if (unserved.length > 0) {
        fail(
            file,
            `lists ${plural(unserved.length, 'route')} no router serves: ${unserved.join(', ')}`,
            'The route was renamed or removed and the contract was not. Every test that mocks it is testing the frontend against an API that does not exist.',
        );
    }

    // A router validates with the shared request schemas: the frontend builds its requests from the same ones.
    for (const rel of routeFiles) {
        const source = code(rel);
        const shared = importedFrom(source, sharedPackage);
        for (const match of source.matchAll(REQUEST_SCHEMA_SLOT)) {
            const [, slot = '', value = '', after = ''] = match;
            if (after.trim() === '' && shared.has(value)) continue;
            fail(
                `${rel}:${source.slice(0, match.index).split('\n').length}`,
                `validates its ${slot === 'params' ? 'path parameters' : slot} with a schema of its own, not one from ${sharedPackage}`,
                slot === 'params'
                    ? 'The contract names the schema a path is held to, and only one from the shared package can be the same one. A rule written in the router is a second definition: tighten it here and the contract, the fuzz document and every client still describe the old one. Move it to the shared package and import it.'
                    : `The frontend builds this ${slot} from the shared schemas. A schema written in the router is a second definition the frontend never sees: rename a field here and the frontend keeps sending the old one, refused with a 422 nobody tested. Move it to the shared package and import it.`,
            );
        }
    }

    // The frontend calls the API through its typed caller only.
    if (caller !== undefined && apiClient !== undefined) {
        const direct = new RegExp(
            `\\b${caller.instance}\\s*\\.\\s*(?:get|post|put|patch|delete|head|options|request)\\s*[<(]`,
            'g',
        );
        const frontendFiles = walkFiles(root, caller.dir, {
            match: /\.(?:ts|vue)$/,
            exclude: (rel) => rel.includes('__tests__') || /\.(?:test|spec)\.ts$/.test(rel),
        });
        for (const rel of frontendFiles) {
            if (rel === apiClient) continue;
            const source = code(rel);
            for (const match of source.matchAll(direct)) {
                fail(
                    `${rel}:${source.slice(0, match.index).split('\n').length}`,
                    `calls \`${caller.instance}\` directly`,
                    'A direct call names its path as a string and its response type by hand — the drift the contract exists to stop. Call the route through the typed caller by its contract key, which types the body, the query and the answer from the schemas the API uses.',
                );
            }
        }
    }

    // The validator refuses what a schema does not declare.
    if (validator !== undefined) {
        const missing = missingSharedCalls(validator, ['droppedKeys'], sharedPackage, ctx);
        if (missing === null) {
            fail(
                validator,
                'missing',
                'Every request body and query passes through it; without it nothing is validated.',
            );
        } else if (missing.length > 0) {
            fail(
                validator,
                `never calls \`droppedKeys\` from ${sharedPackage}`,
                'A Zod object strips a key it does not declare and the request goes on to a 2xx. The client meant something by that key — a renamed field, a stale form, a probe for `role` — and the 2xx tells it the change was saved. Name the stripped keys with `droppedKeys` and refuse them with the rest of the 422.',
            );
        }
    }

    // The test setups hold every exchange to the contract.
    for (const rel of testChecks) {
        const missing = missingSharedCalls(rel, CONTRACT_CHECKS, sharedPackage, ctx);
        if (missing === null) {
            fail(
                rel,
                'missing',
                'It is listed in `contract.testChecks` as a test setup that holds exchanges to the contract. Fix the path, or remove the entry if the setup moved.',
            );
        } else if (missing.length > 0) {
            fail(
                rel,
                `never calls ${missing.map((name) => `\`${name}\``).join(' or ')} from ${sharedPackage}`,
                'A test double is a second, hand-written copy of the API. Unchecked, it drifts from the real one while every test stays green: a mock answers a route the API does not serve, a body the API never sends, or a refusal with a code the API does not have. Check every exchange the setup answers against the contract, refusals included.',
            );
        }
    }

    if (coverage !== undefined) inspectContractCoverage(coverage, testChecks, ctx);
    if (fuzz !== undefined) inspectContractFuzz(fuzz, file, listed, ctx);
    if (handlers !== undefined) inspectContractHandlers(handlers, file, mounts, ctx);
}

/** Each contract entry's properties as source text: `{ body: 'loginBody', response: 'z.union([…])' }`. */
function contractEntries(source: string): Map<string, Map<string, string>> {
    const entries = new Map<string, Map<string, string>>();
    for (const match of source.matchAll(CONTRACT_KEY)) {
        const [, key = ''] = match;
        const rest = source.slice(match.index + match[0].length);
        if (!/^\s*\{/.test(rest)) continue;
        entries.set(key, objectProperties(braceBlock(rest, /^\s*/)));
    }
    return entries;
}

/** An object literal's inside as `key → value source`; a shorthand `key` is its own value, a spread is keyed `...name`. */
function objectProperties(inside: string): Map<string, string> {
    const properties = new Map<string, string>();
    for (const part of splitTopLevel(inside, ',')) {
        const pair = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(part);
        if (pair !== null) properties.set(pair[1] ?? '', compact(pair[2] ?? ''));
        else properties.set(part.startsWith('...') ? part.replace(/\s+/g, '') : part, part);
    }
    return properties;
}

/** Source text with its whitespace removed, so a wrapped expression compares equal to an unwrapped one. */
const compact = (text: string): string => text.replace(/\s+/g, '');

/** The upload fields a route's multer middleware takes: `.single('file')` is one, `.array('files', 10)` many. */
function uploadFields(source: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const [, kind, name = ''] of source.matchAll(/\.(single|array)\(\s*['"]([^'"]+)['"]/g)) {
        fields.set(name, kind === 'single' ? 'one' : 'many');
    }
    for (const args of callArgs(source, '.fields(')) {
        for (const entry of args.match(/\{[^{}]*\}/g) ?? []) {
            const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(entry)?.[1];
            if (name !== undefined) fields.set(name, /\bmaxCount\s*:\s*1\b/.test(entry) ? 'one' : 'many');
        }
    }
    return fields;
}

/** Rule 11 with `handlers`: each route validates, answers and uploads with what its contract entry names. */
function inspectContractHandlers(
    handlers: ContractHandlers,
    contractFile: string,
    mounts: Map<string, string>,
    ctx: ContractContext,
): void {
    const { code, exists, fail } = ctx;
    const { validate, send, objects = [] } = handlers;
    const entries = contractEntries(code(contractFile));
    const objectSources = objects.filter(exists).map(code);

    for (const [rel, mount] of mounts) {
        const source = code(rel);
        for (const declaration of source.matchAll(ROUTE_DECLARATION)) {
            const [, verb = '', routePath = ''] = declaration;
            const key = `${verb.toUpperCase()} ${mount}${routePath === '/' ? '' : routePath}`;
            const entry = entries.get(key);
            if (entry === undefined) continue; // reported as unlisted above
            const call = callArgs(source.slice(declaration.index), `router.${verb}(`)[0] ?? '';
            const at = `${rel}:${source.slice(0, declaration.index).split('\n').length}`;

            // What the validator is handed, with spreads and named objects followed.
            const handed = new Map<string, string>();
            const unreadable: string[] = [];
            const collect = (text: string, seen: Set<string>): void => {
                const name = text.trim().replace(/^\.\.\./, '');
                if (text.trim().startsWith('{')) {
                    for (const [prop, value] of objectProperties(braceBlock(text, /^\s*/))) {
                        if (prop.startsWith('...')) collect(prop, seen);
                        else handed.set(prop, value);
                    }
                    return;
                }
                if (!/^[A-Za-z_$][\w$]*$/.test(name) || seen.has(name)) return;
                seen.add(name);
                const declared = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*(?=\\{)`);
                const home = [source, ...objectSources].find((text2) => declared.test(text2));
                if (home === undefined) {
                    unreadable.push(name);
                    return;
                }
                const match = declared.exec(home);
                if (match !== null) collect(`{${braceBlock(home.slice(match.index), declared)}}`, seen);
            };
            const validated = callArgs(call, `${validate}(`)[0];
            if (validated !== undefined) collect(splitTopLevel(validated, ',')[0] ?? '', new Set());
            if (unreadable.length > 0) {
                fail(
                    at,
                    `hands \`${validate}\` ${unreadable.map((name) => `\`${name}\``).join(', ')}, which this gate cannot read`,
                    `The gate compares the schemas a route validates with the ones its contract entry names. Declare the object in the router, or list the module that declares it in \`contract.handlers.objects\`.`,
                );
            }
            // The route's code: its own, and that of a handler it names, last in the route or
            // last in the validator's arguments.
            const handlerNames = [
                splitTopLevel(call, ',').at(-1),
                validated === undefined ? undefined : splitTopLevel(validated, ',').at(-1),
            ]
                .map((arg) => arg?.trim() ?? '')
                .filter((arg) => /^[A-Za-z_$][\w$]*$/.test(arg));
            const body = [call, ...handlerNames.map((name) => declaredBody(source, name))].join('\n');

            // An object it cannot read is reported above; what it holds is unknown, not missing.
            for (const slot of unreadable.length > 0 ? [] : ['params', 'body', 'query']) {
                const named = entry.get(slot);
                // A route may check its path itself, with the contract's schema: one that answers
                // a bad path as a probe rather than a form to correct.
                const checksItself =
                    slot === 'params' &&
                    named !== undefined &&
                    /^[A-Za-z_$][\w$]*$/.test(named) &&
                    new RegExp(`(?<![\\w$.])${named}\\.(?:safeParse|parse)\\(`).test(body);
                const used = handed.get(slot) ?? (checksItself ? named : undefined);
                if (named === used) continue;
                const what = slot === 'params' ? 'path parameters' : slot;
                const some = slot === 'params' ? what : `a ${slot}`;
                fail(
                    at,
                    used === undefined
                        ? `${key} validates no ${what}, but the contract names \`${named}\``
                        : named === undefined
                          ? `${key} validates ${some} with \`${used}\`, but the contract names none`
                          : `${key} validates its ${what} with \`${used}\`, but the contract names \`${named}\``,
                    slot === 'params'
                        ? 'The contract says what a path may hold, and the fuzz document describes each route from it. A router validating with another schema refuses paths the contract allows, or takes ones it never declared, and no type error says so. Make the router and the contract name the same schema.'
                        : `The frontend builds this ${slot} from the schema the contract names, and its tests are checked against it. A router validating with another one refuses what the frontend sends, or takes what it never declared, and no type error says so. Make the router and the contract name the same schema.`,
                );
            }

            const answers = callArgs(body, `${send}(`).map((args) => compact(splitTopLevel(args, ',')[1] ?? ''));
            const response = entry.get('response');
            if (response === 'null') {
                if (answers.length > 0) {
                    fail(
                        at,
                        `${key} answers through \`${send}\`, but the contract says it answers with no body`,
                        'The frontend is typed from the contract, so it never reads this body: whatever it carries is sent for nobody, and a client typed by hand may come to depend on it. Answer 204, or name the schema in the contract.',
                    );
                }
            } else if (response !== undefined && response !== "'raw'" && response !== '"raw"') {
                if (answers.length === 0) {
                    fail(
                        at,
                        `${key} never answers through \`${send}\``,
                        `The contract names a schema for this route's answer, and \`${send}\` is what holds the data to it. Answer through it with that schema.`,
                    );
                }
                for (const schema of answers) {
                    const escaped = schema.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
                    if (schema !== '' && new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`).test(response)) continue;
                    fail(
                        at,
                        `${key} answers with \`${schema}\`, which its contract entry does not name`,
                        'The frontend is typed from the schema the contract names. A route answering with another one sends fields the frontend never reads, or lacks ones it does, and only a test that checks this exact answer notices. Answer with the schema the contract names, or change the entry.',
                    );
                }
            }

            // What the route takes as files.
            const listedFiles = new Map(
                [...(entry.get('files') ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:\s*['"](one|many)['"]/g)].map(
                    ([, name = '', kind = '']) => [name, kind],
                ),
            );
            const taken = uploadFields(call);
            const describe = (fields: Map<string, string>): string =>
                fields.size === 0
                    ? 'none'
                    : [...fields]
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([name, kind]) => `\`${name}\` (${kind})`)
                          .join(', ');
            if (describe(listedFiles) !== describe(taken)) {
                fail(
                    at,
                    `${key} takes the upload fields ${describe(taken)}, but the contract names ${describe(listedFiles)}`,
                    'The frontend appends its files under the names the contract gives them. The upload middleware refuses a field it was not told about, so a name that differs is an upload that fails for every user.',
                );
            }
        }
    }
}

/** The key a `provide('key', …)` or an `inject('key')` names, wherever it sits in `source`. */
function providedKeys(source: string, call: 'provide' | 'inject'): Set<string> {
    return new Set(
        [...source.matchAll(new RegExp(`\\b${call}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g'))].map(([, key = '']) => key),
    );
}

/** Rule 11 with `coverage`: every setup records what it checked, every suite fails on what nobody did. */
function inspectContractCoverage(coverage: ContractCoverage, testChecks: string[], ctx: ContractContext): void {
    const { read, code, exists, fail } = ctx;
    const { module, suites } = coverage;
    const suiteOf = (rel: string) => suites.find(({ config }) => rel.startsWith(`${path.dirname(config)}/`));

    // What each suite's recorders inject, so its setup can be checked to provide the same key.
    const injected = new Map<string, Set<string>>();
    for (const rel of testChecks) {
        if (!exists(rel)) continue; // reported above
        const missing = missingSharedCalls(rel, ['recordCheckedRoute'], module, ctx);
        if (missing !== null && missing.length > 0) {
            fail(
                rel,
                `never records the routes it checks with \`recordCheckedRoute\` from ${module}`,
                'A route no test calls is never held to the contract, and the run stays green while its schemas are wrong. Record each route this setup checked, so the run can name the ones nobody checked.',
            );
            continue;
        }
        const recorded = callArgs(code(rel), 'recordCheckedRoute(');
        const keys = new Set(recorded.flatMap((args) => [...providedKeys(args, 'inject')]));
        if (keys.size === 0) {
            fail(
                rel,
                'records the routes it checks into no log the suite provides',
                "Each test worker records into the log its suite's global setup opened, reached with `inject('<key>')`. Pass that as the first argument; a path of its own is a log nobody reads.",
            );
            continue;
        }
        const suite = suiteOf(rel);
        if (suite === undefined) {
            fail(
                rel,
                'records into a log no suite in `contract.coverage.suites` reads',
                "The routes it records are read back by its suite's global setup, which fails the run on the ones nobody checked. List the suite this setup runs in, with its config and that global setup.",
            );
            continue;
        }
        injected.set(suite.setup, new Set([...(injected.get(suite.setup) ?? []), ...keys]));
    }

    for (const { config, setup } of suites) {
        const missing = missingSharedCalls(setup, ['openCoverageLog', 'uncheckedRoutes'], module, ctx);
        if (missing === null) {
            fail(
                setup,
                'missing',
                `It is the global setup ${config} registers to open the coverage log and read it back.`,
            );
            continue;
        }
        if (missing.length > 0) {
            fail(
                setup,
                `never calls ${missing.map((name) => `\`${name}\``).join(' or ')} from ${module}`,
                'The global setup opens the log before any test runs and reads it once they all have. Without both, nothing is recorded or nothing is read.',
            );
        }
        const source = code(setup);
        if (!/\bthrow\b/.test(source)) {
            fail(
                setup,
                'never fails the run on a route nobody checked',
                'A list printed under a green run is a list nobody reads. Throw from the teardown with the routes `uncheckedRoutes` returned, so the run fails and names them.',
            );
        }
        const provided = providedKeys(source, 'provide');
        for (const key of injected.get(setup) ?? []) {
            if (provided.has(key)) continue;
            fail(
                setup,
                `never provides \`${key}\`, the log its suite's setups record into`,
                'The recorders reach the log by this key. A key nobody provides is undefined in every worker, so nothing is recorded and every route looks unchecked — or, if the recorder skips on undefined, the whole check goes quiet.',
            );
        }
        if (!exists(config)) {
            fail(config, 'missing', `It is the suite config that registers ${setup} as a global setup.`);
            continue;
        }
        const name = path.basename(setup).replace(/\.[cm]?[jt]s$/, '');
        if (!new RegExp(`globalSetup\\s*:\\s*\\[?[^\\]]*['"][^'"]*${name}`).test(stripComments(read(config)))) {
            fail(
                config,
                `does not register \`${setup}\` as a globalSetup`,
                'A global setup nothing registers never runs: no log is opened, and a route nobody checked fails nothing.',
            );
        }
    }
}

/** The exported name of the table the contract's route keys sit in: the last `export const` above the first key. */
function contractTable(source: string): string | null {
    const first = source.search(new RegExp(CONTRACT_KEY.source));
    if (first === -1) return null;
    return [...source.slice(0, first).matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)].at(-1)?.[1] ?? null;
}

/** A TOML file with each comment blanked to the end of its line. A `#` inside a quoted string stays; line numbers do not move. */
function tomlCode(source: string): string {
    return source
        .split('\n')
        .map((line) => {
            let quote: string | null = null;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (quote === null) {
                    if (ch === '#') return line.slice(0, i);
                    if (ch === '"' || ch === "'") quote = ch;
                } else if (ch === '\\' && quote === '"') i++;
                else if (ch === quote) quote = null;
            }
            return line;
        })
        .join('\n');
}

/** A TOML basic string's contents, its escapes resolved: `"^\\d+$"` is the pattern `^\d+$`. */
function tomlBasic(text: string): string {
    try {
        const value: unknown = JSON.parse(`"${text}"`);
        return typeof value === 'string' ? value : text;
    } catch {
        return text; // an escape JSON does not share with TOML; the raw text is the closest reading
    }
}

/** Every string assigned to `key` in a comment-free TOML file: `key = "a"`, or `key = ["a", "b"]` over any number of lines. */
function tomlStrings(code: string, key: string): { line: number; values: string[] }[] {
    const escaped = key.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    const assignment = new RegExp(
        `^[ \\t]*${escaped}[ \\t]*=[ \\t]*(\\[[^\\]]*\\]|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`,
        'gm',
    );
    return [...code.matchAll(assignment)].map((match) => ({
        line: code.slice(0, match.index).split('\n').length,
        values: [...(match[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(([, basic, literal]) =>
            basic === undefined ? (literal ?? '') : tomlBasic(basic),
        ),
    }));
}

/** Rule 11 with `fuzz`: the fuzz run reads the contract as it is today, with exceptions that say why and forgive no 5xx. */
function inspectContractFuzz(
    fuzz: ContractFuzz,
    contractFile: string,
    listed: Set<string>,
    ctx: ContractContext,
): void {
    const { root, read, code, exists, fail } = ctx;
    const { document, runner, config, requirements, outputs, isolate = [] } = fuzz;

    // The document is built from the contract table, so it lists exactly the routes the contract does.
    if (!exists(document.file)) {
        fail(document.file, 'missing', 'It turns the contract into the OpenAPI document the fuzzer reads.');
    } else {
        const source = code(document.file);
        const table = contractTable(code(contractFile));
        const body = source.replace(/^[ \t]*import\b[^;]*?\bfrom\s*['"][^'"]+['"];?/gm, '');
        if (table !== null && !new RegExp(`(?<![\\w$])${table}\\b`).test(body)) {
            fail(
                document.file,
                `never reads \`${table}\`, the contract table`,
                'A document written by hand is a second copy of the API. The fuzzer tests the routes it lists rather than the ones the API serves, and a route added later is never fuzzed. Build every path from the contract table.',
            );
        }
        for (const match of source.matchAll(ROUTE_LITERAL)) {
            fail(
                `${document.file}:${source.slice(0, match.index).split('\n').length}`,
                `names the route ${match[0]} itself`,
                'Every route the document holds comes from the contract table. One written here is fuzzed as it was the day someone wrote it, whatever the contract says now.',
            );
        }
        const exported = new RegExp(
            `\\bexport\\s+(?:async\\s+)?function\\s+${document.name}\\b|\\bexport\\s+const\\s+${document.name}\\b`,
        );
        if (!exported.test(source)) {
            fail(
                document.file,
                `does not export \`${document.name}\``,
                'The runner builds the document by calling it.',
            );
        }
    }

    // The runner builds the document on every run and hands the fuzzer its config by path.
    if (!exists(runner)) {
        fail(runner, 'missing', 'It writes the document and starts the fuzzer on it.');
    } else {
        const source = code(runner).replace(new RegExp(`\\bfunction\\s+${document.name}\\s*\\(`, 'g'), '');
        if (!new RegExp(`(?<![\\w$])${document.name}\\s*\\(`).test(source)) {
            fail(
                runner,
                `never calls \`${document.name}\``,
                'A run must fuzz the contract as it is today. A document written once and read back from disk keeps the routes and schemas of the day it was written, and the fuzzer passes an API that has moved on.',
            );
        }
        if (!/['"`]--config-file(?:=[^'"`]*)?['"`]/.test(source) || !source.includes(path.basename(config))) {
            fail(
                runner,
                `never hands the fuzzer \`${config}\` with \`--config-file\``,
                'Schemathesis looks for `schemathesis.toml` only in the directory it starts in and the ones above it. Started anywhere else it reads no config at all: every exception stops applying and the routes it kept out are fuzzed — a payment provider, a mail server — while the run looks the same.',
            );
        }
        for (const key of isolate) {
            const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
            if (
                new RegExp(`(?<![\\w$])['"]?${escaped}['"]?\\s*:|\\[\\s*['"]${escaped}['"]\\s*\\]\\s*=(?!=)`).test(
                    source,
                )
            ) {
                continue;
            }
            fail(
                runner,
                `never sets \`${key}\` for the API it starts`,
                "The API fills a key it is not given from its own dev env file, so the run would reach the dev service that key names: uploads land in the dev buckets, jobs wait in the dev queues, and both outlive the run. Start the run's own service and hand the API its address.",
            );
        }
    }

    if (!exists(requirements)) {
        fail(requirements, 'missing', 'It pins the fuzzer the runner installs.');
    } else {
        const pinned = /^[\w.-]+(?:\[[^\]]*\])?[ \t]*==[ \t]*[\w.+!-]+[ \t]*(?:#.*)?$/;
        const lines = read(requirements).split('\n');
        if (!lines.some((line) => /^[ \t]*schemathesis(?:\[|[ \t]*[=<>~!]|[ \t]*$)/.test(line))) {
            fail(requirements, 'does not list `schemathesis`', 'It is the fuzzer the runner installs from this file.');
        }
        for (const [i, line] of lines.entries()) {
            const requirement = line.trim();
            if (requirement === '' || requirement.startsWith('#') || pinned.test(requirement)) continue;
            fail(
                `${requirements}:${i + 1}`,
                `\`${requirement}\` is not pinned to one version with \`==\``,
                'Each release changes what the run does: the fuzzer adds checks and generates requests differently, a stand-in answers differently. Unpinned, a run turns red or green for a reason in no diff, and the seed a failed run printed no longer replays it.',
            );
        }
    }

    if (!exists(config)) {
        fail(
            config,
            'missing',
            'It says what the fuzz run judges and where a valid request may still be refused. Without it the runner has nothing to hand the fuzzer.',
        );
    } else {
        inspectFuzzConfig(config, read(config), listed, fail);
    }

    // What a run writes stays out of git. The cache is the fuzzer's, wherever it ran from.
    const caches = [...new Set(['.schemathesis', path.posix.join(path.posix.dirname(config), '.schemathesis')])];
    for (const out of [...outputs, ...caches]) {
        // Asked about a path inside it, so a directory-only pattern (`report/`) answers too.
        const ignored = gitIgnores(root, `${out}/probe`);
        if (ignored === null) {
            fail(
                '.gitignore',
                `could not ask git whether \`${out}\` is ignored`,
                'This rule asks git, which needs a repository. Run the gate inside one.',
            );
        } else if (!ignored) {
            fail(
                '.gitignore',
                `does not ignore \`${out}\``,
                caches.includes(out)
                    ? 'Schemathesis keeps the requests that failed in `.schemathesis/`, in the directory it runs from, beside the absolute path of the document it read: a home folder and a user name. Committed, that is published along with a pile of failures nobody else can replay.'
                    : 'A run writes it afresh every time. Committed, it shows up in every diff after a run, and a report holds the requests the fuzzer sent.',
            );
        }
    }
}

/** The fuzz config: every route it names exists, every exception says why, and none forgives a server error. */
function inspectFuzzConfig(
    config: string,
    raw: string,
    listed: Set<string>,
    fail: (file: string | null, what: string, why: string) => void,
): void {
    const source = tomlCode(raw);
    const lines = raw.split('\n');
    const codeLines = source.split('\n');
    // A reason sits in the comment directly above, or at the end of the line itself.
    const reasoned = (i: number) => lines[i - 1]?.trim().startsWith('#') === true || codeLines[i] !== lines[i];

    let table = '';
    for (const [i, line] of codeLines.entries()) {
        const header = /^[ \t]*\[\[?[ \t]*([\w.-]+)[ \t]*\]\]?/.exec(line);
        if (header !== null) {
            table = header[1] ?? '';
            if (/^[ \t]*\[\[[ \t]*operations[ \t]*\]\]/.test(line) && !reasoned(i)) {
                fail(
                    `${config}:${i + 1}`,
                    'an `[[operations]]` group with no comment saying why',
                    'Each group is an exception: routes the run treats differently from the rest. Without the reason, nobody can tell whether it still holds, so it outlives the state that made it true and quietly hides what the run was meant to find. Write the reason in a comment directly above it.',
                );
            }
            continue;
        }
        const setting = /^[ \t]*([\w.-]+)[ \t]*=[ \t]*false[ \t]*$/.exec(line)?.[1];
        if (setting === undefined) continue;
        const key = [table.replace(/^operations\.?/, ''), setting].filter(Boolean).join('.');
        if (!/(?:^|\.)enabled$/.test(key)) continue;
        const check = /(?:^|\.)checks\.([\w-]+)\.enabled$/.exec(key)?.[1];
        if (key === 'checks.enabled' || (check !== undefined && FUZZ_CORE_CHECKS.includes(check))) {
            fail(
                `${config}:${i + 1}`,
                `switches \`${key}\` off`,
                `${FUZZ_CORE_CHECKS.map((name) => `\`${name}\``).join(' and ')} are what the run is for: no request may crash the API, and no answer may break the contract. A route that cannot meet them is a bug to fix or a route to exclude with its reason, never a check to switch off.`,
            );
            continue;
        }
        if (table === 'operations') continue; // the group's own comment says why
        if (!reasoned(i)) {
            fail(
                `${config}:${i + 1}`,
                `switches \`${key}\` off with no comment saying why`,
                'Every check is on unless the config turns it off, so each line turning one off is the whole record of what the run no longer judges. Write the reason in a comment directly above it.',
            );
        }
    }

    for (const match of source.matchAll(/^[ \t]*[\w.-]*expected-statuses[ \t]*=[ \t]*\[([^\]]*)\]/gm)) {
        if (!/(?<![\w])5(?:\d\d|XX|xx)(?![\w])/.test(match[1] ?? '')) continue;
        fail(
            `${config}:${source.slice(0, match.index).split('\n').length}`,
            'lets an exception expect a server error',
            'A 5xx is the one answer the API never means to give, so the run fails on one everywhere. An exception allows the refusals a state the fuzzer cannot reach explains, never a crash.',
        );
    }

    const paths = new Set(
        [...listed].map((route) => route.slice(route.indexOf(' ') + 1).replace(/[:*](\w+)/g, '{$1}')),
    );
    const stale =
        'The route was renamed or removed and the config was not. An exception for a route nobody serves is dead, and one meant for its replacement is missing, so the replacement is judged by rules the exception was written to relax.';
    for (const key of FUZZ_ID_FILTERS) {
        for (const { line, values } of tomlStrings(source, key)) {
            for (const value of values.filter((id) => !listed.has(id))) {
                fail(`${config}:${line}`, `names \`${value}\`, which the contract does not list`, stale);
            }
        }
    }
    for (const key of FUZZ_PATH_FILTERS) {
        for (const { line, values } of tomlStrings(source, key)) {
            for (const value of values.filter((p) => !paths.has(p))) {
                fail(`${config}:${line}`, `names the path \`${value}\`, which the contract does not list`, stale);
            }
        }
    }
    for (const key of FUZZ_PATTERN_FILTERS) {
        for (const { line, values } of tomlStrings(source, key)) {
            for (const value of values) {
                let pattern: RegExp;
                try {
                    pattern = new RegExp(value);
                } catch {
                    continue; // Python syntax JavaScript cannot read; the fuzzer reports a pattern that is wrong for it
                }
                if ([...paths].some((p) => pattern.test(p))) continue;
                fail(`${config}:${line}`, `\`${value}\` matches no path the contract lists`, stale);
            }
        }
    }
}

/** Rule 12: one job contract, parsed on both ends of the queue. */
function inspectJobs(jobs: JobsOptions, ctx: ContractContext): void {
    const { root, code, exists, fail } = ctx;
    const { file, table, producer, processor, workers } = jobs;
    const literal = /^['"`]/;

    if (!exists(file)) {
        fail(
            file,
            'missing',
            'It is the one place that says which queue each job goes to and what data it carries. The API and the worker each parse against it.',
        );
    } else {
        const source = code(file);
        if (!new RegExp(`\\bexport\\s+const\\s+${table}\\b`).test(source)) {
            fail(
                file,
                `does not export \`${table}\``,
                'The producer and the worker reach each job by its entry in this table.',
            );
        }
        const queues = [...source.matchAll(/\bqueue\s*:/g)].length;
        const schemas = [...source.matchAll(/\bdata\s*:/g)].length;
        if (queues !== schemas) {
            fail(
                file,
                `names ${plural(queues, 'queue')} but ${plural(schemas, 'data schema')}`,
                'Every job is a queue name and the schema of the data it carries. An entry without one is a job the worker cannot check, or a schema nothing is queued against.',
            );
        }
        if (/\.strict\s*\(|\bz\.strictObject\s*\(/.test(source)) {
            fail(
                file,
                'a job schema refuses fields it does not declare',
                'A job waits in Redis while the API and the worker deploy one at a time. A worker that refuses an unknown field fails every job a newer API queued with one, through no fault of either. The producer already refuses fields its schema would drop, so the worker can safely ignore them.',
            );
        }
    }

    if (!exists(producer)) {
        fail(producer, 'missing', 'It is the one module the API queues jobs through.');
    } else {
        const source = code(producer);
        if (!new RegExp(`\\b${table}\\b`).test(source)) {
            fail(
                producer,
                `never reads \`${table}\``,
                'Queue names and job data both come from the registry, so the producer and the worker cannot disagree.',
            );
        }
        if (!/\.(?:safeParse|parse)\s*\(/.test(source)) {
            fail(
                producer,
                "never parses a job's data before queueing it",
                'A malformed job fails in the request that made it when the producer parses it, with the caller still there to see why. Unparsed, it fails later in a worker log nobody connects to the request.',
            );
        }
        if (!/\bdroppedKeys\s*\(/.test(source)) {
            fail(
                producer,
                'never refuses a field the job schema would drop (`droppedKeys`)',
                'The worker ignores fields it does not know, so a misspelt or stray field would travel through Redis unnoticed. Refusing it at the producer is what makes the tolerant worker safe.',
            );
        }
    }

    // A queue built anywhere else in the API is a way to add jobs nothing parses.
    const workspace = producer.split('/')[0] ?? '';
    const apiFiles = walkFiles(root, workspace, {
        match: /\.ts$/,
        exclude: (rel) => rel.includes('__tests__') || /\.(?:test|spec)\.ts$/.test(rel) || rel.includes('node_modules'),
    });
    for (const rel of apiFiles) {
        if (rel === producer) continue;
        const source = code(rel);
        for (const site of callSites(source, 'new Queue(')) {
            fail(
                `${rel}:${source.slice(0, site.index).split('\n').length}`,
                `builds a queue outside ${producer}`,
                'Every job the API queues goes through the producer, which parses it against the registry. A queue built here adds jobs nothing checks.',
            );
        }
    }

    if (!exists(processor.file)) {
        fail(
            processor.file,
            'missing',
            `It holds \`${processor.name}\`, which parses each job before its handler runs.`,
        );
    } else {
        const body = declaredBody(code(processor.file), processor.name);
        if (body === '') {
            fail(processor.file, `does not declare \`${processor.name}\``, 'Every worker runs its jobs through it.');
        } else {
            if (!/\.(?:safeParse|parse)\s*\(/.test(body)) {
                fail(
                    processor.file,
                    `\`${processor.name}\` never parses the job's data`,
                    'The job may have been queued by an older or newer API than this worker. A type says nothing about what is actually in Redis; parsing does.',
                );
            }
            if (!/\bnew\s+UnrecoverableError\s*\(/.test(body)) {
                fail(
                    processor.file,
                    `\`${processor.name}\` does not fail a malformed job as unrecoverable`,
                    'Data that does not parse will not parse on the next attempt either. A plain error spends every retry on it and buries the reason under the retries; `UnrecoverableError` fails it once, with the reason.',
                );
            }
        }
    }

    for (const rel of workers) {
        if (!exists(rel)) {
            fail(rel, 'missing', 'It is listed in `jobs.workers` as a module that builds workers.');
            continue;
        }
        const source = code(rel);
        const line = (index: number) => `${rel}:${source.slice(0, index).split('\n').length}`;
        const sites = (['new Worker(', 'new Queue('] as const)
            .flatMap((token) => callSites(source, token).map((site) => ({ ...site, token })))
            .sort((a, b) => a.index - b.index);
        for (const { token, ...site } of sites) {
            const [name = '', handler = ''] = splitTopLevel(site.args, ',').map((arg) => arg.trim());
            if (literal.test(name) || !name.startsWith(`${table}.`)) {
                fail(
                    line(site.index),
                    `names its queue \`${name}\` instead of from \`${table}\``,
                    'A queue name typed twice is two names: rename it in one place and the producer fills a queue no worker reads, with no error anywhere.',
                );
            }
            if (token === 'new Worker(' && !handler.startsWith(`${processor.name}(`)) {
                fail(
                    line(site.index),
                    `runs its jobs without \`${processor.name}\``,
                    'The handler would read `job.data` as whatever it was declared to be, not what is actually in Redis. Wrap it, so a malformed job fails once, unrecoverable, before the handler sees it.',
                );
            }
        }
    }
}

/**
 * The names `source` imports from `pkg`, by the local name each is used under.
 * Type-only imports count too: a schema imported as a type is still the shared one.
 */
function importedFrom(source: string, pkg: string): Set<string> {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const sharedImport = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${escaped}['"]`, 'g');
    return new Set(
        [...source.matchAll(sharedImport)].flatMap(([, names = '']) =>
            names
                .split(',')
                .map(
                    (name) =>
                        name
                            .trim()
                            .replace(/^type\s+/, '')
                            .split(/\s+as\s+/)
                            .pop() ?? '',
                )
                .filter((name) => name !== ''),
        ),
    );
}

/**
 * The names `rel` does not both import from `pkg` and call: a name imported and
 * never called checks nothing. `null` when the file does not exist.
 */
function missingSharedCalls(rel: string, names: string[], pkg: string, ctx: ContractContext): string[] | null {
    if (!ctx.exists(rel)) return null;
    const source = ctx.code(rel);
    const shared = importedFrom(source, pkg);
    return names.filter((name) => !shared.has(name) || !new RegExp(`\\b${name}\\s*\\(`).test(source));
}

/** Rule 10 with `devFlag`: a dropped field fails outside production and is logged inside it. */
function inspectLoudDrops(
    helper: string,
    source: string,
    devFlag: string,
    fail: (file: string | null, what: string, why: string) => void,
): void {
    if (!/\bdroppedKeys\s*\(/.test(source)) {
        fail(
            helper,
            'never names the fields its schema dropped (`droppedKeys`)',
            'The schema keeps an undeclared field off the wire, silently. Nothing leaks, but nobody learns that a mapper hands over a whole document or a field nobody listed — and a schema that is quietly wrong stays wrong forever. Compare the data with what the schema kept.',
        );
        return;
    }
    // The throw must be the dev branch's own: the helper already throws when the data does not fit.
    const flag = devFlag.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const devThrow = new RegExp(`\\bif\\s*\\([^)]*${flag}[^)]*\\)\\s*(?:\\{[^}]*?)?\\bthrow\\b`);
    if (!devThrow.test(source)) {
        fail(
            helper,
            `does not fail on a dropped field when \`${devFlag}\` holds`,
            'Outside production a dropped field must fail the response, so the unit test, the E2E run or the developer clicking through meets it the day it appears. A log line in development is read by nobody.',
        );
    }
    if (!/\.error\s*\(/.test(source)) {
        fail(
            helper,
            'does not log a dropped field at error level',
            'In production the user keeps a working page with the field dropped. The error log is then the only place the field is named; without it the bug lives on unseen.',
        );
    }
}
