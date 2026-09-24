/**
 * REST API architecture gate — the route map, the middleware order, and the
 * limiter contract.
 *
 * The rules here share one failure mode: the server keeps answering. A router
 * mounted without a rate-limit tier serves every request it is given. An error
 * handler registered too early is still a valid four-argument function — Express
 * simply never reaches it, and every `AppError` in the codebase degrades to an
 * unhandled 500 with no line anywhere saying so. A JSDoc route map that has
 * fallen behind the file is worse than no map, because review trusts it: this
 * gate's first run found 13 routes live in production and absent from their own
 * header, plus one documenting Express 4 syntax the code had stopped using.
 *
 * WHAT THE TWO COPIES DISAGREED ABOUT, and how it was settled. Almost nothing,
 * which is itself the finding — this pair had stayed in step where the security
 * gates had not. Three differences:
 *
 *   • THE TIER LIST. One repo has three tiers, the other four. That is a repo's
 *     inventory, not a rule, so `tiers` is an option. The RULE — that every
 *     mount carries one of them — is the same in both.
 *
 *   • READING `.max(maxLimit)`. One copy tolerated whitespace after the paren
 *     and the other did not, so the same schema passed in one repo and failed in
 *     the other the moment Prettier reflowed it. The tolerant one is correct;
 *     a gate that a formatter can flip is not a gate.
 *
 *   • RESOLVING THE `express.json()` ALIAS. The newer copy resolves
 *     `const parseJson = express.json(…)` to the `app.use()` that installs it,
 *     because the ordering rules are about which middleware RUNS first and a
 *     factory call is not a registration. The older one matched the factory
 *     call, which sits at the top of the module — so it read the body parser as
 *     registered before CORS, in a file where it is not. Kept, generalised.
 *
 * NO POSITION IS READ FROM INDENTATION. The older copy located helmet with
 * `indexOf('app.use(\n    helmet(')`, which is four spaces of today's Prettier
 * config written into a security rule. Every position here comes from
 * `callSites`, which counts brackets: find the `helmet(` call, then the
 * `app.use(` that encloses it.
 *
 * FOUR RULES ARE NEW, all of them from the standard rather than from either
 * copy, and all four of the same kind — a thing the standard says in a sentence
 * that no type, test or lint rule can see:
 *
 *   • NO FIXED-WINDOW LIMITER LIBRARY. `express-rate-limit` and
 *     `rate-limiter-flexible` are both fixed-window counters, so neither gives
 *     burst capacity with continuous refill, and both carry the boundary-burst
 *     weakness where a client gets 2× the limit across a window edge. One added
 *     beside the token bucket looks like belt and braces and is a second,
 *     weaker limiter with its own opinion.
 *
 *   • `optionalAuth` MUST BE REGISTERED BEFORE THE RATE-LIMITED MOUNTS. The
 *     limiters key on `req.userId` and fall back to the IP. Registered after
 *     them, the resolve happens too late, `req.userId` is never set, and every
 *     authenticated client silently shares one bucket with everyone behind its
 *     NAT. Nothing breaks; the limits are just wrong for the shared case, which
 *     is the case nobody tests.
 *
 *   • NO RAW `parseInt` ON `req.query`. The standard's own ❌ example. It
 *     bypasses the Zod query schema, so the cap the schema declares is not
 *     applied and `?limit=1000000` goes straight through.
 *
 *   • NO `{ ok: true, data }` ENVELOPE. The standard forbids wrapping every
 *     success, because then every consumer unwraps forever.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createGateReport, plural } from './report.js';
import { REPO_ROOT } from './repo-root.js';
import { callArgs, callSites } from './source.js';
import { stripComments } from './strip-comments.js';
import { walkFiles } from './files.js';

/** The three tiers the standard names. A repo with more states its own list. */
const DEFAULT_TIERS = ['strictLimiter', 'standardLimiter', 'relaxedLimiter'];

/**
 * Path segments that repeat what the HTTP method already said. `POST /videos`,
 * never `POST /videos/create` — two things claiming to say what the request does
 * is two things that can disagree.
 */
const VERB_SEGMENTS = new Set(['create', 'update', 'delete', 'remove', 'get', 'list', 'new', 'edit', 'fetch']);

/** Fixed-window counters wearing a token bucket's job. */
const FIXED_WINDOW_LIBRARIES = ['express-rate-limit', 'rate-limiter-flexible'];

/** Every `router.<verb>('<path>'` declaration, tolerant of the argument list wrapping. */
const ROUTE_DECLARATION = /^router\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']*)'/gm;

/** Route lines in a JSDoc header: ` * GET /videos/:id — one clause`. */
const ROUTE_DOCUMENTATION = /^\s*\*\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/gm;

/**
 * Every REST relationship this repo can be asked about, as a list of problems.
 *
 * @param {import('./api-standards.js').ApiStandardsInput} input
 * @returns {import('./api-standards.js').ApiStandardsInspection}
 */
export function inspectApiStandards(input) {
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
    } = input;

    /** @type {import('./api-standards.js').ApiProblem[]} */
    const problems = [];
    /**
     * @param {string | null} file
     * @param {string} what
     * @param {string} why
     */
    const fail = (file, what, why) => {
        problems.push({ file, what, why });
    };

    /** @param {string} rel */
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    /** @param {string} rel */
    const exists = (rel) => fs.existsSync(path.join(root, rel));
    /** Comments blanked: a commented-out route must not answer for a live one. */
    const code = (rel) => stripComments(read(rel));

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

        // A header may write routes at their mounted path (`/api/videos/:id`) or
        // relative to the router (`/:id`). Strip the mount when the header states
        // one, so both spellings compare against the same declarations.
        //
        // The trailing punctuation is trimmed because `\S*` runs to the next space:
        // a header ending the sentence — "mounted at /api/reports." — captured the
        // full stop, which matches no route, so the mount silently stopped being
        // stripped and EVERY route in the file was reported twice, once as
        // undocumented and once as phantom. Both copies had it.
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
    const installedAt = (token) => index.indexOf(token);

    const helmetAt = installedAt('helmet(');
    const corsAt = installedAt('cors({');
    // THE ORDERING RULES ARE ABOUT WHAT RUNS FIRST, and a factory call is not a
    // registration. `const parseJson = express.json(…)` is state, which the
    // declaration-order gate requires ABOVE every side effect — so the factory
    // sits at the top of the module, above cors, while the `app.use()` that
    // calls it sits two hundred lines below. Reading the factory as the
    // registration reports a body parser running before the origin check in a
    // file where it plainly does not. Resolve the alias to where it is CALLED,
    // and fall back to the factory only when the parser is registered inline,
    // so removing express.json() altogether is still caught as missing.
    const jsonAlias = /const\s+([A-Za-z_$][\w$]*)\s*=\s*express\.json\(/.exec(index)?.[1];
    const jsonUseAt = jsonAlias === undefined ? -1 : installedAt(`${jsonAlias}(req`);
    const jsonAt = jsonUseAt !== -1 ? jsonUseAt : installedAt('express.json(');
    const errorHandlerAt = index.indexOf('app.use(errorHandler)');
    const firstRouteAt = index.search(/app\.(use|get)\(\s*['"]\//);

    for (const [what, at] of /** @type {[string, number][]} */ ([
        ['helmet()', helmetAt],
        ['cors()', corsAt],
        ['express.json()', jsonAt],
        ['errorHandler', errorHandlerAt],
    ])) {
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

    if (!/\.eval\(/.test(bucket)) {
        fail(
            tokenBucket,
            'no Redis `eval()` — the refill-and-consume is no longer one atomic script',
            'Read-modify-write across API replicas must be atomic or two pods refill the same bucket concurrently and the limit is not a limit. A single Lua EVAL is what makes it atomic without a distributed lock.',
        );
    }
    if (!/allowed:\s*true/.test(bucket) || !/catch/.test(bucket)) {
        fail(
            tokenBucket,
            'no longer fails OPEN on a Redis error',
            'A cache blip must not lock every client out of the platform. On a Redis failure the bucket allows the request and logs a warning — never denies. Failing closed turns a dependency outage into a total outage.',
        );
    }
    if (!/Retry-After/.test(limiters)) {
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

    // A fixed-window library beside the token bucket is a second limiter with a
    // weaker opinion, and whichever runs first decides.
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
    if (!/makePaginationQuery/.test(schemaSource)) {
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
            // READ IT FROM THE INSTANCE, NOT THE FILE. Both repos also pass
            // `{ withCredentials: true }` on the one refresh call that needs it
            // explicitly, further down the same module. A file-wide search finds
            // THAT and passes — so a client whose shared instance had lost the
            // setting entirely, and which therefore drops the refresh cookie on
            // every other request in the app, read as correct.
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

    const routes = routeFiles.reduce((total, rel) => total + [...code(rel).matchAll(ROUTE_DECLARATION)].length, 0);

    return { problems, counts: { routes, files: routeFiles.length, mounts: mounts.length } };
}

/**
 * Run the gate and print.
 *
 * @param {import('./api-standards.js').ApiStandardsOptions} options
 * @returns {void}
 */
export function checkApiStandards({ root = REPO_ROOT, standard, ...rest }) {
    const report = createGateReport({ name: 'REST API standards', ...(standard === undefined ? {} : { standard }) });
    const { problems, counts } = inspectApiStandards({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `REST API architecture OK — ${plural(counts.routes, 'route')} across ${plural(counts.files, 'router file')}, ` +
            `each one documented in its own header; middleware ordered with the error handler last, ` +
            `${plural(counts.mounts, 'mount')} all carrying a rate-limit tier, token bucket atomic and fail-open, pagination capped.`,
        notMachineChecked:
            'Whether a status code is the RIGHT one, whether independent awaits were parallelised, cache TTL judgement, or whether a given POST is idempotent. Nor whether a route header describes what the route actually does — only that the two lists match.',
    });
}

export default checkApiStandards;
