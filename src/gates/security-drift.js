/**
 * Security-standards drift gate.
 *
 * Every rule here is a control whose failure is SILENT. Nothing on this list
 * throws, fails a test or shows up in a diff review as anything other than a
 * plausible line: `trust proxy` set to `true` instead of a hop count, an HSTS
 * max-age that lost a zero, a throttle counter keyed by the raw email, a
 * rotation that mints a fresh expiry. The app boots, the suite is green, and the
 * control is gone. That is the whole reason this gate exists rather than a
 * checklist.
 *
 * WHY THIS IS ONE GATE WITH OPTIONAL GROUPS AND NO FAMILY SWITCH. Both copies
 * are full-stack; there is no second architecture to reconcile. What differs is
 * not how a rule works but whether the repo has the thing the rule is about —
 * one repo terminates TLS at nginx and Traefik and sends password-reset email,
 * the other does neither. So those rules are groups you state or leave out, and
 * the copy that left them out had already written down WHY in a comment, which
 * is the behaviour worth keeping: an absent group should be a recorded decision,
 * not an oversight. The shim says what it omits and why.
 *
 * WHAT WAS TAKEN FROM WHICH COPY, and the two that were wrong rather than older:
 *
 *   • THE THROTTLE-KEY RULE FOLLOWED A NAME. One copy allowed any argument
 *     whose identifier matched `/^(?:\w*[Ii]ndex|throttleKey)$/`. `const
 *     emailIndex = req.body.email` satisfies that perfectly, and the raw email
 *     then lands in a Redis key where it outlives the request and an operator
 *     can read it. The rule now resolves the argument to its binding and asks
 *     whether a credential reaches it without passing through a derivation —
 *     the use, not the name.
 *
 *   • THE HSTS MAX-AGE WAS READ FROM THE WHOLE FILE. `src.match(/maxAge:
 *     \s*(\d+)/)` takes the FIRST max-age in the entry file, which is the HSTS
 *     one only by luck of ordering: add a session cookie above the helmet call
 *     and the rule starts grading the cookie. It is now read out of the
 *     brace-balanced `strictTransportSecurity` block, and so is `preload`.
 *
 *   • ARGON2 PARAMETERS are read from the encoded hash BY NAME (`m=`, `t=`,
 *     `p=`), not by position. The other copy's positional pattern reports drift
 *     on a hash that is entirely correct but written in another order.
 *
 *   • THE SANITIZER RULE is the union: `$`-prefixed keys, the prototype keys
 *     (`__proto__`, `constructor`, `prototype`) and dotted keys. Both repos'
 *     sanitizers already strip all three; only one gate checked the second and
 *     neither checked the third, and a dotted key is a Mongo path — `{"a.b":
 *     1}` reaches into a subdocument the handler never meant to expose.
 *
 *   • `v-html` IS NOT CHECKED HERE, although one copy checked it. `vue/no-v-html`
 *     is an error in the shared ESLint config for both families, and the
 *     standard names ESLint as its owner. A rule with two owners drifts between
 *     them, and the ESLint one reports the line.
 *
 *   • COMMENTS ARE BLANKED before any rule asks whether the code does
 *     something. Neither copy did this for the raw-HTML sink scan, so a comment
 *     reading "never assign to .innerHTML" failed the gate.
 *
 * ONE RULE IS NEW, from the standard rather than from either copy: the Argon2
 * parameters must still meet the OWASP floor (`memoryCost` ≥ 64 MB, `timeCost`
 * ≥ 3). The existing rule only proved config and the dummy hash AGREE — they
 * agree just as well at `memoryCost: 4096`, which is the shape of the change
 * someone makes to speed up a slow test suite.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createGateReport, plural } from './report.js';
import { REPO_ROOT } from './repo-root.js';
import { braceBlock, callArgs, catchBodies, evalProduct, fnBody } from './source.js';
import { stripComments } from './strip-comments.js';

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

/**
 * True when a CSP `script-src` list carries neither unsafe token.
 *
 * Reads the directive rather than the file: `unsafe-inline` is a documented,
 * accepted exception on `style-src` (Vue's `:style` bindings render as inline
 * style attributes, which no nonce or hash can cover), so a file-wide search
 * would fail every correct config in both families.
 *
 * @param {string} directives The `scriptSrc: [...]` array body or an nginx `script-src …` run.
 * @returns {boolean}
 */
const scriptSrcClean = (directives) => !/unsafe-inline|unsafe-eval/.test(directives);

/**
 * `{ m, t, p }` out of an encoded Argon2 hash, read by NAME.
 *
 * The encoding is `$argon2id$v=19$m=65536,t=3,p=4$…`. Reading the three numbers
 * positionally — as one copy of this gate did — reports drift on a hash that is
 * entirely correct but whose parameters were written in another order.
 *
 * @param {string} source
 * @returns {Record<string, number>}
 */
function encodedArgonParams(source) {
    const encoded = /\$argon2id\$v=\d+\$([^$]+)\$/.exec(source)?.[1] ?? '';
    return Object.fromEntries([...encoded.matchAll(/([mtp])=(\d+)/g)].map((f) => [f[1] ?? '', Number(f[2])]));
}

/**
 * Every `location … { … }` block of an nginx config, brace-balanced.
 *
 * @param {string} source Comment-stripped nginx configuration.
 * @returns {{ name: string, body: string }[]}
 */
function nginxLocations(source) {
    /** @type {{ name: string, body: string }[]} */
    const blocks = [];
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

/**
 * Source with every `function name(` blanked, so a rule asking whether something
 * is CALLED cannot be answered by the line that DEFINES it.
 *
 * This is the trap that cost the most in this port and the last one. A file
 * route was asked whether it calls `isSameOrigin(req)`; deleting the call left
 * `function isSameOrigin(req)` behind, and the rule reported the control intact
 * on a route that had stopped checking anything.
 *
 * @param {string} source
 * @returns {string}
 */
const callsOnly = (source) => source.replace(/\bfunction\s+(\w+)\s*\(/g, (m) => ' '.repeat(m.length));

/**
 * The expression a local `const name = …` was last bound to before `before`.
 *
 * Nearest-preceding rather than first-in-file, because the same short name
 * (`key`) is legitimately rebound once per function in these modules, and
 * grading a call against a binding from three functions above it is how a rule
 * ends up right for the wrong reason.
 *
 * @param {string} source
 * @param {string} name
 * @param {number} before Offset of the call site.
 * @returns {string | null} The right-hand side, or null when nothing binds it here.
 */
function bindingBefore(source, name, before) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

    const re = new RegExp(
        String.raw`\b(?:const|let|var)\s+${name}\s*=\s*([^;\n]*(?:\n(?!\s*(?:const|let|var|return)\b)[^;\n]*)*)`,
        'g',
    );
    /** @type {string | null} */
    let found = null;
    /** @type {RegExpExecArray | null} */
    let match;

    while ((match = re.exec(source)) !== null) {
        if (match.index > before) break;
        found = (match[1] ?? '').trim();
    }

    return found;
}

/**
 * Every security invariant this repo can be asked about, as a list of problems.
 *
 * Pure: it reads files and returns findings. The printing runner is
 * `checkSecurityDrift`, so the rules can be tested without capturing stdout.
 *
 * @param {import('./security-drift.js').SecurityDriftInput} input
 * @returns {import('./security-drift.js').SecurityDriftInspection}
 */
export function inspectSecurityDrift(input) {
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

    /** @type {import('./security-drift.js').SecurityProblem[]} */
    const problems = [];
    const fail = (/** @type {string} */ file, /** @type {string} */ what, /** @type {string} */ why) => {
        problems.push({ file, what, why });
    };

    const abs = (/** @type {string} */ rel) => path.join(root, rel);
    const exists = (/** @type {string} */ rel) => fs.existsSync(abs(rel));
    const read = (/** @type {string} */ rel) => fs.readFileSync(abs(rel), 'utf8');
    /** Source with every comment blanked — see the header on why this is not optional. */
    const code = (/** @type {string} */ rel) => stripComments(read(rel));

    /**
     * Every file under `dirs` that is shipped rather than tested.
     *
     * @param {string[]} dirs
     * @param {RegExp} match
     * @returns {string[]}
     */
    const sources = (dirs, match) => {
        /** @type {string[]} */
        const out = [];
        const visit = (/** @type {string} */ rel) => {
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
    // Every rule below finds its subject by a landmark inside a named file. When
    // one moves, the rule that depends on it stops testing anything and PASSES —
    // the single most dangerous failure mode a security gate has, because the
    // output is indistinguishable from the control being intact. So the
    // landmarks are asserted first and a missing one is a hard stop.
    /** @type {{ file: string, contains: string[] }[]} */
    const anchors = [
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
    ];

    /** @type {string[]} */
    const brokenAnchors = [];
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
            fail(
                broken.split(' — ')[0] ?? null,
                broken.split(' — ')[1] ?? 'landmark missing',
                'The gate can no longer locate what it validates, so every rule that reads this file would pass without testing anything. Confirm the control still exists, then update the path or landmark in the check script.',
            );
        }
        return { problems, counts: { rules: 0 } };
    }

    const entrySource = code(entry);
    const configSource = code(config);
    const backend = sources(backendDirs, /\.ts$/);
    const frontend = sources(frontendDirs, /\.(?:ts|vue)$/);
    /** What the summary counts, so a green tick says how much was actually looked at. */
    const counts = { backend: backend.length, frontend: frontend.length, locations: 0, throttleCalls: 0 };

    // ── 1. JWT: verify pins the algorithm, sign sets an expiry ────────────────
    // An unpinned verify accepts whatever the TOKEN says it was signed with, and
    // `alg: none` is a token anyone can mint. A sign with no expiry is a
    // credential that never stops working.
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
    // The block is read brace-balanced, not by a file-wide `maxAge:` search: the
    // first max-age in an entry file is the HSTS one only by luck of ordering.
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
    if (!/Permissions-Policy/.test(entrySource)) {
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
    if (trustArg === undefined || !/^config\./.test(trustArg)) {
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
    const unit = (/** @type {string} */ value) => (/mb$/i.test(value) ? 1024 * 1024 : /kb$/i.test(value) ? 1024 : 1);
    const bytes = limit === undefined ? 0 : Number(limit.replace(/[a-z]+$/i, '')) * unit(limit);

    if (bytes <= 0 || bytes > 10 * 1024 * 1024) {
        fail(
            entry,
            limit === undefined ? 'passes no `limit` to express.json()' : `caps JSON bodies at \`${limit}\``,
            'Without a cap, one request can buffer as much memory as the client is willing to send. The standard caps JSON at 10 MB; file uploads go through a streaming route, not through the JSON parser.',
        );
    }

    // ── 8. Protocol-attack timeouts ──────────────────────────────────────────
    // Absent and `= 0` are read apart on purpose: both leave the socket
    // unbounded, but only one of them is somebody having decided to.
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
    // Two separate failures. Disagreement reopens the timing oracle the dummy
    // hash exists to close; agreement at a lowered cost is a password store that
    // is cheap to crack, and the two gates that checked the first never checked
    // the second.
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
    // Bounded at the next export. Slicing to end of file — which both copies did
    // — lets any OTHER schema below satisfy the character classes.
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
    // The function's OWN braces. Both copies sliced to end of file, and the
    // `clearRefreshCookie` that sits directly below sets the same four flags —
    // so weakening the real one to `sameSite: 'lax'` passed the gate silently.
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
    // Checked on the CATCH BODIES, not on the function. A throttle legitimately
    // throws 429 after the catch, on a lock it actually read, so "does this
    // function throw" cannot tell a working control from one that denies every
    // login the moment Redis blinks.
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
        for (const body_ of catches) {
            if (/\bthrow\b/.test(body_)) {
                fail(
                    auth.throttleFile,
                    `${name}() rethrows from its catch`,
                    'That is fail-closed. A Redis outage then locks every user out of the platform — a worse availability failure than briefly relaxed throttling.',
                );
            }
            if (!/logger\.(?:warn|error)\(/.test(body_)) {
                fail(
                    auth.throttleFile,
                    `${name}() swallows its Redis error without logging`,
                    'Failing open is correct and invisible. Without the warning, the throttle can be off for days and nothing anywhere says so.',
                );
            }
        }
    }

    // ── 15. Throttle counters are keyed by a DERIVED identifier ──────────────
    // The rule one copy of this gate shipped allowed any argument whose NAME
    // matched `/\w*[Ii]ndex|throttleKey/`, which `const emailIndex =
    // req.body.email` satisfies exactly. This follows the binding instead: a
    // credential may reach the key, but only through a hash or a blind index.
    const credentialWord = new RegExp(String.raw`\b(?:${credentials.join('|')})\b`, 'i');
    const derivationCall = new RegExp(String.raw`\b(?:${derivations.join('|')})\s*\(`);

    for (const rel of backend) {
        // The module that DEFINES them takes the key as a parameter; there is no
        // binding to follow and nothing to prove.
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
                // An identifier is graded on what it was bound to; anything else
                // on itself. A bare parameter name has no binding, so it falls
                // back to its own text — which is how `assertLoginAllowed(email)`
                // is reported as the credential it is rather than as unresolvable.
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

    // `sha256(rawToken)` is blanked before the search — the raw name legitimately
    // appears INSIDE the hash call, and a plain scan reads that as storing it.
    const hashedOnly = tokensSource.replace(/(?:sha256|createHash)\([\s\S]{0,200}?\)/g, 'HASHED');
    // `tokenHash` is written both ways — `tokenHash: sha256(raw)` inline, and
    // `const tokenHash = crypto.createHash(…)` then shorthand into the insert —
    // so the rule asks what produced it rather than where it was written.
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
    // Optional: a repo with no email, no template and no server-rendered page
    // has nothing to escape, and gating a function it does not have would only
    // teach people to add an empty one.
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
    // Optional: one of the two repos has no email address on an account at all,
    // so recovery is a single-use code gated by the refresh-token rules above.
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

        if (!/deleteOne\(/.test(reset) || !/revokeAllUserTokens\(/.test(reset)) {
            fail(
                auth.passwordReset.file,
                'completing a reset is not single-use, or does not revoke the sessions',
                'A password reset is the user saying "someone else may be in here". It has to consume its own token and log every existing session out.',
            );
        }
    }

    // ── 22. The reverse proxy repeats every header ──────────────────────────
    // Optional: a repo with no deployment manifest has nowhere to put this, and
    // the rule returns with the manifest when one lands.
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
        if (!/options:/.test(ingress) || !ingress.includes(traefik.optionName)) {
            fail(
                traefik.ingress,
                `does not reference the \`${traefik.optionName}\` TLSOption`,
                'A TLSOption nothing references is a file that passes review and changes nothing about what the edge accepts.',
            );
        }
    }

    // ── 24. Only the named mounts are unauthenticated ───────────────────────
    // Optional: it only means anything where auth is applied AT the mount. Where
    // each router applies it internally, every mount looks unauthenticated here
    // and the rule would report the whole API.
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
        const controls = [
            {
                what: 'validates every path segment against a regex',
                re: /z\.string\(\)\.regex\(/,
                why: 'a pattern that cannot express a separator or a `..` segment makes traversal unreachable before sendFile is asked anything',
            },
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
            // Named, not inferred. An earlier draft also accepted "the word
            // `origin` near `config.`", which the route's own isSameOrigin
            // DEFINITION satisfies — so deleting the call left the rule green.
            {
                what: 'checks the request origin',
                re: route.originCheck ?? /isSameOrigin\s*\(/,
                why: 'an <img> carries no token, so the origin is the only thing distinguishing the app from a scraper',
            },
            // Two tokens, not one pattern: the policy string is normally a named
            // constant declared far from the setHeader call that sends it.
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

/**
 * Run the gate and print.
 *
 * @param {import('./security-drift.js').SecurityDriftOptions} options
 * @returns {void}
 */
export function checkSecurityDrift({ root = REPO_ROOT, standard, ...rest }) {
    const report = createGateReport({ name: 'Security drift', ...(standard === undefined ? {} : { standard }) });
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

export default checkSecurityDrift;
