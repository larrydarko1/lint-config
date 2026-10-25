/**
 * Security controls whose failure is silent: the app boots and the suite stays
 * green. Rules are numbered in the body. Groups a repo does not have (reset flow,
 * reverse proxy, TLS config, …) are omitted, and the shim says why.
 * Comments are blanked before any rule asks what the code does, and definitions
 * are blanked where a rule asks whether something is called. `v-html` is ESLint's.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { braceBlock, callArgs, catchBodies, evalProduct, fnBody } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

/** The auth surface: the files the credential rules read, and the names inside them. */
type AuthSurface = {
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
    /**
     * The request sanitizer, and the prefix of its strip helpers (`stripDollarKeys` → `strip`).
     * It strips what it finds and refuses the request when it found anything.
     */
    sanitizer: { file: string; fn: string; strip?: string };
    /** The auth middleware's name, for the unauthenticated-mount rule. Defaults to `requireAuth`. */
    requireAuth?: string;
    /** Where `escapeHtml` lives. Omit where the server renders no HTML. */
    escapeHtmlFile?: string;
    /** Password reset, and the config key holding its TTL. Omit where there is no reset flow. */
    passwordReset?: { file: string; ttlKey: string };
};

/** An unauthenticated `sendFile` route and the controls that stand in for its authentication. */
type FileRoute = {
    file: string;
    why: string;
    originCheck?: RegExp;
    /**
     * Where the route's path-segment schema is declared, when it is not in the
     * route file: a contract that keeps every request schema in a shared package
     * (`api-standards`' `contract`) forbids one there. The route must hand the
     * validator `params: <schema>`, and the schema must give each `:segment` a
     * `z.string().regex(…)`.
     */
    params?: { file: string; schema: string };
};

type SecurityDriftInput = {
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
    fileRoutes?: FileRoute[];
    /** Names that hold a submitted credential. Defaults cover email/username/password/identifier/phone. */
    credentials?: string[];
    /** Calls that make a credential safe to store. Defaults cover blind indexes and hashes. */
    derivations?: string[];
};

type SecurityDriftInspection = {
    problems: GateFailure[];
    counts: { backend: number; frontend: number; locations: number; throttleCalls: number };
};

export type SecurityDriftOptions = Omit<SecurityDriftInput, 'root'> & {
    root?: string;
};

/** OWASP's Argon2id floor. Raising these is fine; the gate only catches a fall. */
const OWASP_ARGON2 = { memoryCost: 64 * 1024, timeCost: 3 };

/** The six headers a reverse proxy has to repeat in every `location` block. */
const PROXY_HEADERS = [
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Content-Security-Policy',
    'Strict-Transport-Security',
];

/** Assignments and calls that hand a string straight to the HTML parser. */
const HTML_SINKS = [
    { what: '.innerHTML =', re: /\.innerHTML\s*=[^=]/ },
    { what: '.outerHTML =', re: /\.outerHTML\s*=[^=]/ },
    { what: '.insertAdjacentHTML(', re: /\.insertAdjacentHTML\s*\(/ },
    { what: 'document.write(', re: /document\.write(?:ln)?\s*\(/ },
];

/** The substrings the standard names for the production dev-placeholder denylist. */
const DEV_PLACEHOLDERS = ['dev_secret', 'change', 'replace-me', 'your-'];

/** Names that hold a submitted credential, and must never key a cache entry raw. */
const CREDENTIAL_WORDS = ['email', 'username', 'password', 'identifier', 'phone'];

/** Calls that turn a credential into something safe to store — a hash or a blind index. */
const DERIVATIONS = ['emailBlindIndex', 'blindIndex', 'throttleKey', 'createHash', 'sha256', 'hmac'];

/** The three functions a login throttle is made of. */
const THROTTLE_FNS = ['assertLoginAllowed', 'recordLoginFailure', 'clearLoginFailures'];

/** Every problem found, without printing; `checkSecurityDrift` prints. */
export function inspectSecurityDrift(input: SecurityDriftInput): SecurityDriftInspection {
    const {
        root,
        entry,
        config,
        envModule,
        backendDirs,
        frontendDirs = [],
        regexDirs = backendDirs,
        auth,
        nginx,
        traefik,
        unauthenticatedMounts,
        fileRoutes = [],
        credentials = CREDENTIAL_WORDS,
        derivations = DERIVATIONS,
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const abs = (rel: string) => path.join(root, rel);
    const exists = (rel: string) => fs.existsSync(abs(rel));
    const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
    /** Source with every comment blanked. */
    const code = (rel: string) => stripComments(read(rel));

    /** Every file under `dirs` that is shipped rather than tested. */
    const sources = (dirs: string[], match: RegExp): string[] => {
        const out: string[] = [];
        const visit = (rel: string) => {
            if (!exists(rel)) return;
            for (const dirent of fs.readdirSync(abs(rel), { withFileTypes: true })) {
                const child = `${rel}/${dirent.name}`;
                if (dirent.isDirectory()) visit(child);
                else if (match.test(child) && !/(^|\/)__tests__\/|\.(?:test|spec)\.[jt]s$/.test(child)) out.push(child);
            }
        };
        for (const dir of dirs) visit(dir);
        return out.sort();
    };

    // ── Anchors ──────────────────────────────────────────────────────────────
    // A missing landmark is a hard stop, so no rule passes on nothing.
    const anchors: { file: string; contains: string[] }[] = [
        { file: entry, contains: ['helmet(', 'cors(', 'strictTransportSecurity'] },
        { file: config, contains: ['argon2:', 'memoryCost'] },
        { file: envModule, contains: ['DEV_PLACEHOLDERS'] },
        { file: auth.cookieFile, contains: [auth.cookieFn ?? 'function setRefreshCookie'] },
        { file: auth.tokensFile, contains: ['DUMMY_HASH', `export async function ${auth.loginFn ?? 'loginUser'}`] },
        { file: auth.throttleFile, contains: [`export async function ${THROTTLE_FNS[0]}`] },
        { file: auth.schemasFile, contains: [auth.passwordSchema ?? 'passwordSchema'] },
        { file: auth.sanitizer.file, contains: [`export function ${auth.sanitizer.fn}`] },
        ...(auth.escapeHtmlFile === undefined
            ? []
            : [{ file: auth.escapeHtmlFile, contains: ['function escapeHtml'] }]),
        ...(auth.passwordReset === undefined
            ? []
            : [{ file: auth.passwordReset.file, contains: ['export async function resetPassword'] }]),
        ...(nginx === undefined ? [] : [{ file: nginx, contains: ['location'] }]),
        ...(traefik === undefined
            ? []
            : [
                  { file: traefik.tlsOption, contains: ['kind: TLSOption'] },
                  { file: traefik.ingress, contains: ['kind: IngressRoute'] },
              ]),
        ...fileRoutes.map((route) => ({ file: route.file, contains: ['sendFile'] })),
        ...fileRoutes.flatMap((route) =>
            route.params === undefined
                ? []
                : [{ file: route.params.file, contains: [`export const ${route.params.schema} =`] }],
        ),
    ];

    const brokenAnchors: string[] = [];
    for (const anchor of anchors) {
        if (!exists(anchor.file)) {
            brokenAnchors.push(`${anchor.file} — not found (moved or renamed?)`);
            continue;
        }
        const source = read(anchor.file);
        for (const landmark of anchor.contains) {
            if (!source.includes(landmark)) brokenAnchors.push(`${anchor.file} — missing landmark \`${landmark}\``);
        }
    }

    if (brokenAnchors.length > 0) {
        for (const broken of brokenAnchors) {
            const [file = broken, what = 'landmark missing'] = broken.split(' — ');
            fail(
                file,
                what,
                'The gate can no longer locate what it validates, so every rule that reads this file would pass without testing anything. Confirm the control still exists, then update the path or landmark in the check script.',
            );
        }
        return { problems, counts: { backend: 0, frontend: 0, locations: 0, throttleCalls: 0 } };
    }

    const entrySource = code(entry);
    const configSource = code(config);
    const backend = sources(backendDirs, /\.ts$/);
    const frontend = sources(frontendDirs, /\.(?:ts|vue)$/);
    /** What the summary counts, so a green tick says how much was actually looked at. */
    const counts = { backend: backend.length, frontend: frontend.length, locations: 0, throttleCalls: 0 };

    // ── 1. JWT: verify pins the algorithm, sign sets an expiry ────────────────
    for (const rel of backend) {
        const source = code(rel);
        for (const args of callArgs(source, 'jwt.verify(')) {
            if (!/algorithms\s*:/.test(args)) {
                fail(
                    rel,
                    'calls jwt.verify() without pinning `algorithms`',
                    'Unpinned, the token itself chooses the algorithm it is checked against — including `none`, which needs no key at all.',
                );
            }
        }
        for (const args of callArgs(source, 'jwt.sign(')) {
            if (!/expiresIn\s*:/.test(args)) {
                fail(
                    rel,
                    'calls jwt.sign() without `expiresIn`',
                    'A token with no expiry is a permanent credential: revoking it means rotating the signing secret and logging out every user at once.',
                );
            }
        }
    }

    // ── 2. CORS is the configured allowlist ──────────────────────────────────
    if (/origin\s*:\s*['"]\*['"]/.test(entrySource) || !/cors\(\s*\{[\s\S]*?origin\s*:\s*config\./.test(entrySource)) {
        fail(
            entry,
            'does not set the CORS origin from config',
            "`origin: '*'` lets any site on the internet call this API with the browser's credentials attached. The allowlist has to come from config so it differs between environments.",
        );
    }

    // ── 3. helmet CSP ────────────────────────────────────────────────────────
    const cspMissing = [
        { key: 'defaultSrc', want: "'self'", re: /defaultSrc:\s*\["'(?:self|none)'"\]/ },
        { key: 'objectSrc', want: "'none'", re: /objectSrc:\s*\["'none'"\]/ },
        { key: 'frameAncestors', want: "'none'", re: /frameAncestors:\s*\["'none'"\]/ },
    ].filter((directive) => !directive.re.test(entrySource));

    if (cspMissing.length > 0) {
        fail(
            entry,
            `helmet CSP does not lock ${cspMissing.map((d) => d.key).join(', ')}`,
            'These three are what stop a page from loading scripts off another origin, embedding a Flash-era plugin object, and being framed by a clickjacking site.',
        );
    }

    const helmetScriptSrc = /scriptSrc\s*:\s*\[([^\]]*)\]/.exec(entrySource)?.[1] ?? '';
    if (!scriptSrcClean(helmetScriptSrc)) {
        fail(
            entry,
            'helmet CSP `script-src` allows unsafe-inline or unsafe-eval',
            'Either one gives injected markup a way to execute, which is the single thing CSP exists to prevent. `style-src` may carry `unsafe-inline` as a documented exception; `script-src` may not.',
        );
    }

    // ── 4. HSTS + Permissions-Policy ─────────────────────────────────────────
    // Read from the brace-balanced block, not the first `maxAge:` in the file.
    const hsts = braceBlock(entrySource, /strictTransportSecurity\s*:\s*\{/);
    const maxAge = Number((/maxAge:\s*([\d_]+)/.exec(hsts)?.[1] ?? '0').replace(/_/g, ''));

    if (maxAge < 31_536_000 || !/includeSubDomains:\s*true/.test(hsts)) {
        fail(
            entry,
            `helmet HSTS is ${maxAge === 0 ? 'not set' : `max-age=${maxAge}`} without a full year and includeSubDomains`,
            'HSTS is what closes the first-request downgrade window a TLS floor cannot. Under a year, or without subdomains, the window stays open on exactly the requests an attacker picks.',
        );
    }
    if (!/preload:\s*(?:true|false)/.test(hsts)) {
        fail(
            entry,
            'helmet HSTS leaves `preload` to the library default',
            'Preloading is hard to reverse and forces HTTPS on every present and future subdomain. Writing `preload: false` records that the decision was made; omitting the key leaves nothing showing it was ever considered.',
        );
    }
    if (!entrySource.includes('Permissions-Policy')) {
        fail(
            entry,
            'sends no Permissions-Policy header',
            'Camera, microphone and geolocation stay available to anything that gets script onto the page until this header turns them off.',
        );
    }

    // ── 5. helmet's three fixed headers ──────────────────────────────────────
    const fixedMissing = [];
    if (!/frameguard:\s*\{\s*action:\s*['"]deny['"]/.test(entrySource))
        fixedMissing.push("frameguard: { action: 'deny' }");
    if (!/noSniff:\s*true/.test(entrySource)) fixedMissing.push('noSniff: true');
    if (!/referrerPolicy:\s*\{\s*policy:\s*['"](?:strict-origin-when-cross-origin|no-referrer)['"]/.test(entrySource)) {
        fixedMissing.push('referrerPolicy: strict-origin-when-cross-origin | no-referrer');
    }
    if (fixedMissing.length > 0) {
        fail(
            entry,
            `helmet does not explicitly set ${fixedMissing.join(', ')}`,
            'Each is one line and each has a default that has moved between helmet majors. Written out, an upgrade cannot quietly change what the app sends.',
        );
    }

    // ── 6. trust proxy is a hop COUNT ────────────────────────────────────────
    const trustArg = /app\.set\(\s*['"]trust proxy['"]\s*,\s*([^)]+?)\s*\)/.exec(entrySource)?.[1];
    if (!trustArg?.startsWith('config.')) {
        fail(
            entry,
            trustArg === undefined
                ? "does not call app.set('trust proxy', …)"
                : `sets \`trust proxy\` to \`${trustArg}\``,
            'It must be the validated numeric hop count from config. With `true`, a client can prepend its own X-Forwarded-For entry and become any IP it likes — defeating every rate limit, dedup and IP-bound token at once.',
        );
    }
    if (
        !/TRUST_PROXY_HOPS:\s*z\.coerce\.number\(\)[\s\S]{0,120}?\.int\(\)[\s\S]{0,80}?\.nonnegative\(\)/.test(
            configSource,
        )
    ) {
        fail(
            config,
            'does not validate TRUST_PROXY_HOPS as a non-negative integer',
            'A hop count that parses as NaN, or as a boolean, makes Express fall back to trusting everything — the exact state the rule above exists to prevent.',
        );
    }

    // ── 7. Request-size cap ──────────────────────────────────────────────────
    const limit = /express\.json\(\s*\{[^}]*limit:\s*['"]([^'"]+)['"]/.exec(entrySource)?.[1];
    const unit = (value: string) => (/mb$/i.test(value) ? 1024 * 1024 : /kb$/i.test(value) ? 1024 : 1);
    const bytes = limit === undefined ? 0 : Number(limit.replace(/[a-z]+$/i, '')) * unit(limit);

    if (bytes <= 0 || bytes > 10 * 1024 * 1024) {
        fail(
            entry,
            limit === undefined ? 'passes no `limit` to express.json()' : `caps JSON bodies at \`${limit}\``,
            'Without a cap, one request can buffer as much memory as the client is willing to send. The standard caps JSON at 10 MB; file uploads go through a streaming route, not through the JSON parser.',
        );
    }

    // ── 8. Protocol-attack timeouts ──────────────────────────────────────────
    // Absent and `= 0` are reported separately.
    const headersExpr = /server\.headersTimeout\s*=\s*([\d_*\s]+);/.exec(entrySource)?.[1];
    const requestExpr = /server\.requestTimeout\s*=\s*([\d_*\s]+);/.exec(entrySource)?.[1];
    const headersTimeout = evalProduct(headersExpr);
    const requestTimeout = evalProduct(requestExpr);

    if (headersTimeout <= 0 || headersTimeout > 60_000) {
        fail(
            entry,
            headersExpr === undefined
                ? 'does not set server.headersTimeout'
                : `sets server.headersTimeout to ${headersTimeout} ms`,
            'Slowloris holds sockets open by dribbling out headers. This is the only timeout that bounds it, and its default has moved across Node majors — so it is set explicitly, at a minute or less.',
        );
    }
    if (requestTimeout <= 0) {
        fail(
            entry,
            requestExpr === undefined ? 'does not set server.requestTimeout' : 'sets server.requestTimeout to 0',
            'Zero disables it. A slow POST then holds a connection for as long as it likes, which is the other half of the same attack.',
        );
    }

    // ── 9. Argon2: config matches the dummy hash, and both meet the floor ────
    // Disagreement reopens the timing oracle; agreement below the floor is cheap to crack.
    const memoryCost = evalProduct(/memoryCost:\s*([\d*\s]+?)\s*,/.exec(configSource)?.[1]);
    const timeCost = Number(/timeCost:\s*(\d+)/.exec(configSource)?.[1] ?? 0);
    const parallelism = Number(/parallelism:\s*(\d+)/.exec(configSource)?.[1] ?? 0);
    const encoded = encodedArgonParams(read(auth.tokensFile));

    if (encoded['m'] !== memoryCost || encoded['t'] !== timeCost || encoded['p'] !== parallelism) {
        fail(
            auth.tokensFile,
            `DUMMY_HASH is m=${String(encoded['m'])},t=${String(encoded['t'])},p=${String(encoded['p'])} but config is m=${memoryCost},t=${timeCost},p=${parallelism}`,
            'The dummy hash is verified against on the unknown-user path so it costs the same wall-clock time as a real login. Computed with different parameters it costs a different time, and the difference is a probe for which accounts exist. Regenerate it.',
        );
    }
    if (memoryCost < OWASP_ARGON2.memoryCost || timeCost < OWASP_ARGON2.timeCost) {
        fail(
            config,
            `Argon2 is configured below the OWASP floor (memoryCost ${memoryCost}, timeCost ${timeCost})`,
            `The floor is memoryCost ${OWASP_ARGON2.memoryCost} (64 MB) and timeCost ${OWASP_ARGON2.timeCost}. Lowering it is how a slow test suite gets fixed, and it makes every stored password proportionally cheaper to crack offline.`,
        );
    }

    // ── 10. Password schema ──────────────────────────────────────────────────
    const passwordSource = code(auth.schemasFile);
    // Bounded at the next export, so another schema cannot satisfy it.
    const passwordFn = fnBody(passwordSource, auth.passwordSchema ?? 'passwordSchema');
    const classes = [
        { what: 'a minimum length of 8', re: /length\s*<\s*8/ },
        { what: 'a maximum length of 128', re: /length\s*>\s*128/ },
        { what: 'an uppercase letter', re: /\[A-Z\]/ },
        { what: 'a lowercase letter', re: /\[a-z\]/ },
        { what: 'a digit', re: /\[0-9\]|\\d/ },
        { what: 'a special character', re: /\[\^A-Za-z0-9\]/ },
    ].filter((c) => !c.re.test(passwordFn));

    if (classes.length > 0) {
        fail(
            auth.schemasFile,
            `the password schema does not require ${classes.map((c) => c.what).join(', ')}`,
            'This is the OWASP baseline, and the maximum matters as much as the minimum: Argon2 hashes whatever it is given, so an unbounded password is an unbounded amount of work per login attempt.',
        );
    }

    // ── 11. Refresh cookie flags ─────────────────────────────────────────────
    const cookieSource = code(auth.cookieFile);
    // The function's own braces, so `clearRefreshCookie` below cannot satisfy it.
    const cookieHeader = auth.cookieFn ?? 'function setRefreshCookie';
    const cookieFn = braceBlock(cookieSource, new RegExp(cookieHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const cookiePath = auth.cookiePath ?? '/api/auth';
    const flags = [
        { what: 'httpOnly', re: /httpOnly:\s*true/, why: 'script on the page can read a cookie without it' },
        { what: 'secure', re: /secure:/, why: 'the cookie travels over plain HTTP without it' },
        {
            what: "sameSite: 'strict'",
            re: /sameSite:\s*['"]strict['"]/,
            why: 'another site can make the browser send it without this',
        },
        {
            what: `path: '${cookiePath}'`,
            re: new RegExp(String.raw`path:\s*(?:['"]${cookiePath}['"]|\w*COOKIE_PATH)`),
            why: 'an unscoped path attaches the refresh token to every request the app makes',
        },
    ].filter((flag) => !flag.re.test(cookieFn));

    if (flags.length > 0) {
        fail(
            auth.cookieFile,
            `the refresh cookie is missing ${flags.map((f) => f.what).join(', ')}`,
            `The refresh token is the long-lived credential — ${flags.map((f) => f.why).join('; ')}.`,
        );
    }

    // ── 12. The NoSQL / prototype-pollution sanitizer ────────────────────────
    const sanitizerSource = code(auth.sanitizer.file);
    const sanitizerFn = fnBody(sanitizerSource, `export function ${auth.sanitizer.fn}`);
    const stripper = auth.sanitizer.strip ?? 'strip';
    const uncovered = ['body', 'query'].filter(
        (target) => !new RegExp(String.raw`${stripper}\w*\(\s*req\.${target}\b`).test(sanitizerFn),
    );

    if (uncovered.length > 0) {
        fail(
            auth.sanitizer.file,
            `${auth.sanitizer.fn}() never passes ${uncovered.map((t) => `req.${t}`).join(' or ')} to a strip function`,
            'A query string is an attack surface exactly like a body: `?role[$ne]=` is parsed into an object by Express before any handler sees it.',
        );
    }

    const keyShapes = [
        {
            what: 'a leading `$`',
            re: /startsWith\(\s*['"]\$['"]\s*\)/,
            why: 'a `$`-prefixed key is a Mongo operator, so `{"$ne": null}` in a body turns an equality check into "anything"',
        },
        {
            what: 'a dot',
            re: /includes\(\s*['"]\.['"]\s*\)|\.\s*indexOf\(\s*['"]\.['"]/,
            why: 'a dotted key is a Mongo path: `{"profile.role": "admin"}` reaches into a subdocument the handler never named',
        },
        {
            what: 'the prototype keys',
            re: /__proto__/,
            why: '`__proto__` in a parsed body is prototype pollution — one request changing the default value of a property on every object in the process',
        },
    ].filter((shape) => !shape.re.test(sanitizerSource));

    if (keyShapes.length > 0) {
        for (const shape of keyShapes)
            fail(auth.sanitizer.file, `no longer strips keys by ${shape.what}`, `${shape.why}.`);
    }

    // Stripping alone answers the probe with a 2xx: refusing is what tells it no, and logs it
    if (!/\bnext\(\s*new\s+\w+/.test(sanitizerFn)) {
        fail(
            auth.sanitizer.file,
            `${auth.sanitizer.fn}() never refuses a request that carried one of those keys`,
            'No client the app ships sends a `$`, dotted or prototype key, so a request carrying one is a probe. Stripped and answered 2xx, it reads as a success to the prober and leaves no trace for you; and it lets the most dangerous unknown key through where the validator refuses every harmless one. Compare what was sent with the stripped copy and pass an error to `next()`, as a security event.',
        );
    }

    // ── 13. The production dev-placeholder denylist ──────────────────────────
    const envSource = code(envModule);
    const denylist = /DEV_PLACEHOLDERS\s*=\s*\[([^\]]*)\]/.exec(envSource)?.[1] ?? '';
    const absent = DEV_PLACEHOLDERS.filter((placeholder) => !denylist.includes(`'${placeholder}'`));

    if (absent.length > 0) {
        fail(
            envModule,
            `the dev-placeholder denylist no longer covers ${absent.join(', ')}`,
            'These are the substrings a copy-pasted `.env.example` value carries. Without them production boots on a placeholder secret and nothing says so.',
        );
    }
    if (!/isProd\(\)[\s\S]{0,60}DEV_PLACEHOLDERS\.some/.test(envSource)) {
        fail(
            envModule,
            'the denylist is no longer applied behind a production guard',
            'Applied everywhere it blocks local development, and the first person it inconveniences deletes it. Applied nowhere it does nothing. It has to be production-only to survive.',
        );
    }

    // ── 14. The login throttle fails OPEN ────────────────────────────────────
    // On the catch bodies: the function legitimately throws 429 elsewhere.
    const throttleSource = code(auth.throttleFile);
    for (const name of THROTTLE_FNS) {
        const body = fnBody(throttleSource, `export async function ${name}`);
        if (body === '') {
            fail(
                auth.throttleFile,
                `${name}() is gone`,
                'The throttle is made of these three: assert before, record on failure, clear on success. Losing one leaves counters that never reset or failures that never count.',
            );
            continue;
        }

        const catches = catchBodies(body);
        if (catches.length === 0) {
            fail(
                auth.throttleFile,
                `${name}() has no catch around its Redis call`,
                'An unhandled Redis error propagates as a 500 from the login route, which is fail-closed with extra steps: a cache blip becomes a total auth outage.',
            );
        }
        for (const catchBody of catches) {
            if (/\bthrow\b/.test(catchBody)) {
                fail(
                    auth.throttleFile,
                    `${name}() rethrows from its catch`,
                    'That is fail-closed. A Redis outage then locks every user out of the platform — a worse availability failure than briefly relaxed throttling.',
                );
            }
            if (!/logger\.(?:warn|error)\(/.test(catchBody)) {
                fail(
                    auth.throttleFile,
                    `${name}() swallows its Redis error without logging`,
                    'Failing open is correct and invisible. Without the warning, the throttle can be off for days and nothing anywhere says so.',
                );
            }
        }
    }

    // ── 15. Throttle counters are keyed by a DERIVED identifier ──────────────
    // Follows the binding, not the name: a credential may reach the key only through a hash or blind index.
    const credentialWord = new RegExp(String.raw`\b(?:${credentials.join('|')})\b`, 'i');
    const derivationCall = new RegExp(String.raw`\b(?:${derivations.join('|')})\s*\(`);

    for (const rel of backend) {
        // The defining module takes the key as a parameter.
        if (rel === auth.throttleFile) continue;
        const source = callsOnly(code(rel));

        for (const name of THROTTLE_FNS) {
            const token = `${name}(`;
            let at = 0;
            while ((at = source.indexOf(token, at)) !== -1) {
                const [argument = ''] = callArgs(source.slice(at), token);
                at += token.length;
                const trimmed = argument.trim();
                if (trimmed === '') continue;

                counts.throttleCalls += 1;
                // An identifier is graded on its binding, or on its own name when it has none.
                const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(trimmed);
                const binding = isIdentifier ? bindingBefore(source, trimmed, at) : null;
                const expression = binding ?? trimmed;

                if (credentialWord.test(expression) && !derivationCall.test(expression)) {
                    fail(
                        rel,
                        `${name}() is keyed by \`${expression.slice(0, 60)}\``,
                        'That is the submitted credential itself. It then lives in a Redis key, readable by anyone with access to the cache and outliving the request that carried it. Key by a blind index or a hash of it instead.',
                    );
                } else if (isIdentifier && binding === null) {
                    fail(
                        rel,
                        `${name}(${trimmed}) — nothing in this file binds \`${trimmed}\``,
                        'The gate cannot see what this key is made of, so it cannot tell a blind index from a raw email. Bind it locally, next to the call it keys.',
                    );
                }
            }
        }
    }

    // ── 16. Login is timing-uniform and answers with ONE error ───────────────
    const tokensSource = code(auth.tokensFile);
    const loginFn = fnBody(tokensSource, `export async function ${auth.loginFn ?? 'loginUser'}`);
    const verifyAt = loginFn.search(/argon2\.verify\(/);
    const branchAt = loginFn.search(/if\s*\(\s*user\s*===?\s*null/);

    if (!/\?\?\s*DUMMY_HASH/.test(loginFn) || verifyAt === -1 || branchAt < verifyAt) {
        fail(
            auth.tokensFile,
            'login branches on user existence before running a hash verify',
            'A login against an account that does not exist has to cost the same time as one against an account that does. Skipping the verify makes the response time an oracle for which addresses are registered.',
        );
    }

    const codes = new Set([...loginFn.matchAll(/new AppError\(\s*401\s*,\s*'([A-Z_]+)'/g)].map((m) => m[1]));
    if (codes.size !== 1) {
        fail(
            auth.tokensFile,
            codes.size === 0
                ? 'login throws no 401'
                : `login throws ${codes.size} different 401 codes (${[...codes].join(', ')})`,
            'Unknown user and wrong password must be indistinguishable. Two codes tell an attacker which half of the guess was right, which turns a password-spray into an account enumeration.',
        );
    }

    // ── 17. Refresh rotation ─────────────────────────────────────────────────
    const rotateFn = fnBody(tokensSource, `export async function ${auth.rotateFn ?? 'rotateRefreshToken'}`);

    if (!/findOneAndUpdate\(\s*\{[^}]*tokenHash[\s\S]{0,120}?\$exists:\s*false/.test(rotateFn)) {
        fail(
            auth.tokensFile,
            'rotation does not claim the old token atomically',
            'Without a conditional claim, two refreshes arriving together both succeed, and the session quietly forks into two live token families.',
        );
    }

    const reuseBranch = braceBlock(rotateFn, /if\s*\(\s*record\s*===?\s*null\s*\)\s*\{/);
    if (reuseBranch === '' || !/deleteMany\([^;]*familyId/.test(reuseBranch)) {
        fail(
            auth.tokensFile,
            'the reuse branch does not revoke the whole token family',
            'A token that was already rotated out coming back means it was stolen. Revoking only that one leaves the thief holding the newer one they took it from.',
        );
    }

    const issued = callArgs(rotateFn, `${auth.issueFn ?? 'issueRefreshToken'}(`);
    if (
        issued.length === 0 ||
        !issued.every((args) => /\bexpiresAt:\s*record\.expiresAt\b/.test(args)) ||
        /new Date\(\s*Date\.now\(\)\s*\+/.test(rotateFn)
    ) {
        fail(
            auth.tokensFile,
            'rotation does not carry `record.expiresAt` forward',
            'This is the quietest way to lose the absolute session ceiling: minting a fresh expiry on every refresh turns a seven-day limit into a sliding window, so a session never ends. Nothing errors and no test fails.',
        );
    }

    // Blank `sha256(rawToken)` first: the raw name legitimately appears inside it.
    const hashedOnly = tokensSource.replace(/(?:sha256|createHash)\([\s\S]{0,200}?\)/g, 'HASHED');
    // Checks what produced `tokenHash`, inline or via a binding.
    const hashedAtRest = /tokenHash\s*[:=]\s*[\w.]*(?:sha256|createHash)\s*\(/.test(tokensSource);
    if (!hashedAtRest || /insertOne\(\s*\{[^}]*\braw[A-Z]\w*\b/.test(hashedOnly)) {
        fail(
            auth.tokensFile,
            'refresh tokens are not stored hashed',
            'Anyone who can read the collection — a backup, a support query, a leaked dump — would otherwise be holding usable session credentials for every logged-in user.',
        );
    }

    // ── 18. Raw-HTML sinks in shipped frontend code ─────────────────────────
    for (const rel of frontend) {
        const source = code(rel);
        for (const sink of HTML_SINKS) {
            if (sink.re.test(source)) {
                fail(
                    rel,
                    `uses ${sink.what}`,
                    'Everything on the right-hand side is parsed as HTML, so any user-controlled substring can carry a script. The framework bindings and `textContent` escape for you; these four do not.',
                );
            }
        }
    }

    // ── 19. No regex built from unescaped user input ────────────────────────
    for (const rel of sources(regexDirs, /\.ts$/)) {
        const source = code(rel);

        for (const args of callArgs(source, 'new RegExp(')) {
            const pattern = args.trim();
            if (/^(['"]).*\1\s*(?:,|$)/s.test(pattern) || pattern.includes('escapeRegex(')) continue;
            // A template literal is allowed only when every interpolation sits in
            // a `{…}` quantifier slot, where the value can only be a number.
            const slots = [...pattern.matchAll(/\$\{[^}]*\}/g)];
            const quantifiedOnly =
                pattern.startsWith('`') &&
                slots.length > 0 &&
                slots.every(
                    (slot) =>
                        pattern[(slot.index ?? 0) - 1] === '{' && pattern[(slot.index ?? 0) + slot[0].length] === '}',
                );
            if (!quantifiedOnly) {
                fail(
                    rel,
                    `builds \`new RegExp(${pattern.slice(0, 40)}…)\` from a value, not a literal`,
                    'A user-supplied pattern is two attacks at once: `(a+)+$` makes the engine backtrack forever, and a stray `.` or `*` silently widens whatever the regex was matching. Wrap it in escapeRegex().',
                );
            }
        }

        for (const match of source.matchAll(/\$regex:\s*([^,}\n]+)/g)) {
            const value = (match[1] ?? '').trim();
            if (/^['"`]/.test(value) || value.includes('escapeRegex(')) continue;
            const bound =
                /^[A-Za-z_$][\w$]*$/.test(value) &&
                new RegExp(String.raw`\b${value}\s*=\s*[^;\n]*(?:escapeRegex\(|new RegExp\()`).test(source);
            if (!bound) {
                fail(
                    rel,
                    `passes \`$regex: ${value.slice(0, 40)}\` straight to Mongo`,
                    'The database runs it as a pattern. An unescaped search term is a query someone else gets to write, and the engine has no timeout.',
                );
            }
        }
    }

    // ── 20. escapeHtml, where the server renders HTML ────────────────────────
    // Optional: only where the server renders HTML.
    if (auth.escapeHtmlFile !== undefined) {
        const source = code(auth.escapeHtmlFile);
        const escapeFn = braceBlock(source, /function escapeHtml/);
        const uncoveredChars = ['&amp;', '&lt;', '&gt;', '&quot;', '&#x27;'].filter(
            (entity) => !escapeFn.includes(entity),
        );
        if (uncoveredChars.length > 0) {
            fail(
                auth.escapeHtmlFile,
                `escapeHtml() does not emit ${uncoveredChars.join(', ')}`,
                'All five OWASP characters or none: escaping four of them leaves one attribute-breaking character, which is all an injected payload needs.',
            );
        }
    }

    // ── 21. Password-reset tokens ───────────────────────────────────────────
    // Optional: only where there is a reset flow.
    if (auth.passwordReset !== undefined) {
        const resetSource = code(auth.passwordReset.file);
        const forgot = fnBody(resetSource, 'export async function forgotPassword');
        const reset = fnBody(resetSource, 'export async function resetPassword');

        if (
            !/createHash\(\s*['"]sha256['"]\s*\)/.test(forgot) ||
            !/insertOne\(\s*\{[\s\S]{0,120}?tokenHash/.test(forgot)
        ) {
            fail(
                auth.passwordReset.file,
                'reset tokens are not hashed at rest',
                'The raw token should exist only in the emailed link. Stored raw, reading the collection is enough to take over any account with a pending reset.',
            );
        }

        const ttl = evalProduct(
            new RegExp(String.raw`${auth.passwordReset.ttlKey}:\s*([\d*\s]+?)\s*,`).exec(configSource)?.[1],
        );
        if (ttl <= 0 || ttl > 60 * 60 * 1000) {
            fail(
                config,
                ttl === 0 ? `${auth.passwordReset.ttlKey} is not set` : `reset tokens live for ${ttl} ms`,
                'An hour at most. A reset link sits in an inbox, and an inbox is exactly what gets read later by somebody else.',
            );
        }

        if (!reset.includes('deleteOne(') || !reset.includes('revokeAllUserTokens(')) {
            fail(
                auth.passwordReset.file,
                'completing a reset is not single-use, or does not revoke the sessions',
                'A password reset is the user saying "someone else may be in here". It has to consume its own token and log every existing session out.',
            );
        }
    }

    // ── 22. The reverse proxy repeats every header ──────────────────────────
    // Optional: only where the repo ships a proxy config.
    if (nginx !== undefined) {
        const source = read(nginx).replace(/^\s*#.*$/gm, '');
        const blocks = nginxLocations(source);
        counts.locations = blocks.length;

        for (const block of blocks) {
            const missing = PROXY_HEADERS.filter((header) => !block.body.includes(header));
            if (missing.length > 0) {
                fail(
                    nginx,
                    `\`${block.name}\` is missing ${missing.join(', ')}`,
                    'nginx `add_header` does not inherit into a block that sets any header of its own, so one location with its own cache header silently loses all six. They are repeated in every block for that reason.',
                );
            }
        }

        const nginxScriptSrc = /script-src([^;"]*)/.exec(source)?.[1] ?? '';
        if (!scriptSrcClean(nginxScriptSrc)) {
            fail(
                nginx,
                'the proxy CSP `script-src` allows unsafe-inline or unsafe-eval',
                'The proxy header is the one the browser gets for the static app. A strict policy on the API and a loose one here protects nothing.',
            );
        }
    }

    // ── 23. The TLS floor is pinned and referenced ──────────────────────────
    if (traefik !== undefined) {
        if (!/minVersion:\s*VersionTLS1[23]/.test(read(traefik.tlsOption))) {
            fail(
                traefik.tlsOption,
                'does not pin a TLS 1.2 floor',
                'Traefik does not do this by default. Without the pin the edge negotiates whatever the client asks for, including versions with known downgrade attacks.',
            );
        }
        const ingress = read(traefik.ingress);
        if (!ingress.includes('options:') || !ingress.includes(traefik.optionName)) {
            fail(
                traefik.ingress,
                `does not reference the \`${traefik.optionName}\` TLSOption`,
                'A TLSOption nothing references is a file that passes review and changes nothing about what the edge accepts.',
            );
        }
    }

    // ── 24. Only the named mounts are unauthenticated ───────────────────────
    // Optional: only where auth is applied at the mount.
    if (unauthenticatedMounts !== undefined) {
        const mounted = [...entrySource.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"][^\n]*\)/g)]
            .filter((match) => !match[0].includes(auth.requireAuth ?? 'requireAuth'))
            .map((match) => match[1] ?? '');
        const unexpected = mounted.filter((mount) => !unauthenticatedMounts.includes(mount));
        const gone = unauthenticatedMounts.filter((mount) => !mounted.includes(mount));

        if (unexpected.length > 0) {
            fail(
                entry,
                `mounts ${unexpected.join(', ')} without requireAuth`,
                'The credential surface has to be open — you cannot require a token to obtain one. Anything else is a data route that lost its guard, and it looks exactly like the ten lines above it.',
            );
        }
        if (gone.length > 0) {
            fail(
                entry,
                `no longer mounts ${gone.join(', ')} at all`,
                'The list of deliberately open mounts is only worth anything while it matches reality. A stale entry hides the next addition to it.',
            );
        }
    }

    // ── 25. An unauthenticated static-file route keeps its stand-in controls ─
    for (const route of fileRoutes) {
        const source = callsOnly(code(route.file));
        const unchecked = uncheckedSegments(source, route, code);
        if (unchecked.length > 0) {
            fail(
                route.file,
                `no longer validates every path segment against a regex (${unchecked.join(', ')})`,
                `${route.why} Each control stands in for the authentication this route does not have: a pattern that cannot express a separator or a \`..\` segment makes traversal unreachable before sendFile is asked anything.`,
            );
        }
        const controls = [
            {
                what: 'confines sendFile to a root',
                re: /root:\s*\w/,
                why: 'root confinement is what turns a path that did get through into a 404 instead of a file read',
            },
            {
                what: 'denies dotfiles',
                re: /dotfiles:\s*['"]deny['"]/,
                why: 'without it the route serves `.env` and `.git/config` from inside that root',
            },
            {
                what: 'checks the request origin',
                re: route.originCheck ?? /isSameOrigin\s*\(/,
                why: 'an <img> carries no token, so the origin is the only thing distinguishing the app from a scraper',
            },
            // Two tokens: the policy string is usually a constant declared elsewhere.
            {
                what: 'sets a Content-Security-Policy on the response',
                re: /Content-Security-Policy/,
                why: 'an SVG served from this origin is a document, not a picture — it runs whatever it contains unless the response forbids it',
            },
            {
                what: 'sandboxes that policy',
                re: /\bsandbox\b/,
                why: 'the `sandbox` directive is the half that denies the document its own origin, and a CSP without it still lets the SVG talk back',
            },
        ].filter((control) => !control.re.test(source));

        if (controls.length > 0) {
            for (const control of controls) {
                fail(
                    route.file,
                    `no longer ${control.what}`,
                    `${route.why} Each control stands in for the authentication this route does not have: ${control.why}.`,
                );
            }
        }
    }

    return { problems, counts };
}

/** Run the gate and print. */
export function checkSecurityDrift({ root = REPO_ROOT, ...rest }: SecurityDriftOptions): void {
    const report = createGateReport({ name: 'Security drift' });
    const { problems, counts } = inspectSecurityDrift({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Security invariants hold across ${plural(counts.backend, 'backend file')} and ${plural(counts.frontend, 'frontend file')}: ` +
            'headers and CSP locked, the proxy trusted by hop count, Argon2 at the OWASP floor and matching its dummy hash, ' +
            `the throttle failing open on ${plural(counts.throttleCalls, 'derived key', 'derived keys')}, rotation atomic and ceilinged, ` +
            'and no regex or HTML built from user input.',
        notMachineChecked:
            'Whether the values are the RIGHT values for this deployment, whether a route that should require auth does, whether the secrets in production are the ones you think, and everything only observable at runtime — the contract tests own that half.',
    });
}

/**
 * True when a CSP `script-src` list carries neither unsafe token. Per directive:
 * `unsafe-inline` is accepted on `style-src` for Vue's `:style`.
 *
 * @param directives The `scriptSrc: [...]` array body or an nginx `script-src …` run.
 */
const scriptSrcClean = (directives: string): boolean => !/unsafe-inline|unsafe-eval/.test(directives);

/** `{ m, t, p }` out of an encoded Argon2 hash (`$argon2id$v=19$m=65536,t=3,p=4$…`), by name. */
function encodedArgonParams(source: string): Record<string, number> {
    const encoded = /\$argon2id\$v=\d+\$([^$]+)\$/.exec(source)?.[1] ?? '';
    return Object.fromEntries([...encoded.matchAll(/([mtp])=(\d+)/g)].map((f) => [f[1] ?? '', Number(f[2])]));
}

/**
 * Every `location … { … }` block of an nginx config, brace-balanced.
 *
 * @param source Comment-stripped nginx configuration.
 */
function nginxLocations(source: string): { name: string; body: string }[] {
    const blocks: { name: string; body: string }[] = [];
    let i = 0;

    while ((i = source.indexOf('location', i)) !== -1) {
        const open = source.indexOf('{', i);
        if (open === -1) break;
        let depth = 0;
        let closed = false;
        for (let j = open; j < source.length; j++) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}') {
                depth -= 1;
                if (depth === 0) {
                    blocks.push({ name: source.slice(i, open).trim(), body: source.slice(open, j) });
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }
        if (!closed) break;
    }

    return blocks;
}

/** Source with every `function name(` blanked, so a definition cannot answer for a call. */
const callsOnly = (source: string): string => source.replace(/\bfunction\s+(\w+)\s*\(/g, (m) => ' '.repeat(m.length));

/**
 * The expression a local `const name = …` was last bound to before `before`
 * (nearest, since short names are rebound per function).
 *
 * @param before Offset of the call site.
 * @returns The right-hand side, or null when nothing binds it here.
 */
function bindingBefore(source: string, name: string, before: number): string | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

    const re = new RegExp(
        String.raw`\b(?:const|let|var)\s+${name}\s*=\s*([^;\n]*(?:\n(?!\s*(?:const|let|var|return)\b)[^;\n]*)*)`,
        'g',
    );
    let found: string | null = null;
    let match: RegExpExecArray | null;

    while ((match = re.exec(source)) !== null) {
        if (match.index > before) break;
        found = (match[1] ?? '').trim();
    }

    return found;
}

/**
 * The `:segments` of a file route that no `z.string().regex(…)` checks. The
 * schema is read from the route file, or from the module `params` names — in
 * which case the route must also hand that schema to its validator.
 *
 * @returns The unchecked segments, `:name` each; `params` itself when the route never validates with it.
 */
function uncheckedSegments(source: string, route: FileRoute, code: (rel: string) => string): string[] {
    const segments = [...source.matchAll(/\.(?:get|head)\(\s*['"`]([^'"`]+)['"`]/g)].flatMap((m) =>
        [...(m[1] ?? '').matchAll(/:(\w+)/g)].map((s) => s[1] ?? ''),
    );
    let schema = source;
    if (route.params !== undefined) {
        const { file, schema: name } = route.params;
        if (!new RegExp(String.raw`\bparams:\s*${name}\b`).test(source)) return [`params: ${name}`];
        schema = braceBlock(code(file), new RegExp(String.raw`export const ${name}\s*=\s*z\.object\(\s*\{`));
    }
    if (segments.length === 0) return schema.includes('z.string().regex(') ? [] : ['every segment'];
    return segments
        .filter((name) => !new RegExp(String.raw`\b${name}:\s*z\.string\(\)\.regex\(`).test(schema))
        .map((name) => `:${name}`);
}
