/**
 * WebSocket / real-time architecture gate — one server, one client, and the
 * order of the handshake.
 *
 * Every rule here is about something that keeps working while being wrong. A
 * gateway with no Redis adapter serves a single pod perfectly and drops every
 * cross-pod notification the moment there are two. A rate limit registered
 * behind the JWT verify still limits — after making each flood attempt pay for
 * a signature verification first, which is the cost the limit existed to avoid.
 * A listener a composable never removes keeps firing into dead state and
 * re-registers on every remount. None of it throws.
 *
 * THE ONE INVERTED RULE. The two repos disagree about the Redis adapter, and
 * not by drift: one MUST have it and the other must NOT. The standard says the
 * adapter is mandatory in multi-pod because each pod holds only its own
 * sockets. The second gateway already gives every pod its own `psubscribe`, so
 * each pod holds every bucket its own sockets need, and the adapter would
 * republish each message across the cluster for every other pod to discard.
 * That is the rare case where following the standard is the regression — so
 * `redisAdapter.mode` is `'required'` or `'forbidden'`, and `'forbidden'`
 * additionally requires the ARGUMENT to be written in the gateway header. A
 * departure nobody can find the reason for is a departure that gets "fixed"
 * back by the next person who knows the standard and not this file.
 *
 * FINDING THE RATE LIMIT WITHOUT MATCHING A NAME. Rule 5 is an ORDER rule: the
 * connection limit runs as the first `io.use()`, ahead of the JWT verify. One
 * copy located the limiter by searching the whole file for the bucket key
 * `rl:ws:conn:`. In the other repo that key is not in the middleware at all —
 * the middleware calls `consumeConnectionToken(clientIp(socket))` and the key
 * lives inside that helper, declared at the BOTTOM of the file, hundreds of
 * bytes AFTER the JWT verify. Merged naively, the rule would have reported
 * "the rate limit does not run before JWT verification" about a gateway where
 * it provably does. So the limiter is recognised by what it DOES, one level of
 * indirection deep: the bucket key inside the first middleware's own span, or a
 * call in that span to a function declared in the same file whose body carries
 * the key. Same shape as the security gate's binding resolver, and the same
 * lesson — a name is not a use.
 *
 * WHERE `jwt.verify` IS ALLOWED TO LIVE. One gateway verifies inline; the other
 * calls the REST API's `verifyAccessToken`, which additionally refuses the 2FA
 * challenge token that shares the secret — a stricter check, not a weaker one.
 * So `authModule` names where the verify really happens, and the secret and
 * algorithm rules are applied to THAT function's body rather than to whichever
 * file the call appears in.
 *
 * THREE RULES WERE MERGED AS A UNION rather than chosen between, because each
 * copy was right about its own repo and neither was wrong:
 *
 *   • INBOUND VALIDATION. One checked for a `.parse()` in the 800 bytes after
 *     the listener; the other, whose listeners delegate to named handlers, for
 *     a schema named after the event. Either satisfies the rule now.
 *
 *   • THE TEARDOWN HOOK. `onScopeDispose` is the right one in a composable —
 *     it fires for a manual `effectScope` too, where `onUnmounted` never runs
 *     because there is no component instance. `onUnmounted` is right in a
 *     component. Either is accepted; neither is.
 *
 *   • DROPPING THE SOCKET ON SIGN-OUT. One repo exports `disconnectSocket` and
 *     calls it from the logout path; the other deliberately does not export it
 *     and registers it with `onSessionCleared`, because exporting it hands any
 *     caller the ability to drop a socket the rest of the app is reading from.
 *     The rule is that the teardown EXISTS and is REACHED, which both satisfy.
 *
 * THE HEADER CONTRACT IS READ IN BOTH DIRECTIONS, the newer copy's version. An
 * event the gateway handles is as much of a contract as one it sends, and a
 * push-only socket documents its empty inbound list explicitly — that empty
 * list is precisely what justifies having no per-message rate limit.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './files.js';
import { createGateReport, plural } from './report.js';
import { REPO_ROOT } from './repo-root.js';
import { braceBlock, callSites } from './source.js';
import { stripComments } from './strip-comments.js';

/** Socket.IO's own events. A listener for one of these is not an app contract. */
const LIFECYCLE = new Set(['connect', 'connection', 'disconnect', 'disconnecting', 'connect_error', 'error']);

/**
 * The brace-balanced body of whatever declares `name` in this file — a function
 * declaration or a `const` bound to an arrow. `''` when nothing declares it,
 * which every caller reads as "cannot confirm", never as "fine".
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function declaredBody(source, name) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return '';
    const declaration = braceBlock(source, new RegExp(String.raw`function\s+${name}\s*\(`));
    if (declaration !== '') return declaration;
    return braceBlock(source, new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=`));
}

/**
 * Every `try { … } catch { … }` pair in a file, brace-balanced.
 *
 * Whether a control degrades gracefully is a property of the PAIR: the attempt
 * says what was guarded and the recovery says what happens when it fails. The
 * copy this replaces matched `/try\s*\{([\s\S]*?)\}\s*catch[\s\S]*?\{([\s\S]*?)\n {4}\}/`,
 * which stops at the first `}` and ends on four spaces of today's indentation —
 * so one nested object inside the try hid the rest of it.
 *
 * @param {string} source
 * @returns {{ attempt: string, recovery: string }[]}
 */
function tryCatchPairs(source) {
    /** @type {{ attempt: string, recovery: string }[]} */
    const pairs = [];

    for (const match of source.matchAll(/\btry\s*\{/g)) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let j = open; j < source.length; j++) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}' && --depth === 0) {
                const rest = source.slice(j + 1);
                // Only a catch that IMMEDIATELY follows belongs to this try; the
                // next one down the file belongs to something else entirely.
                const recovery = /^\s*catch\b/.test(rest) ? braceBlock(rest, /catch\s*(?:\([^)]*\))?\s*\{/) : '';
                pairs.push({ attempt: source.slice(open + 1, j), recovery });
                break;
            }
        }
    }

    return pairs;
}

/**
 * Every real-time relationship this repo can be asked about, as a list of problems.
 *
 * @param {import('./ws-standards.js').WsStandardsInput} input
 * @returns {import('./ws-standards.js').WsStandardsInspection}
 */
export function inspectWsStandards(input) {
    const {
        root = REPO_ROOT,
        gateway,
        gatewayDir,
        serverDirs,
        client,
        clientDirs,
        authModule,
        redisAdapter = { mode: 'required' },
        upgradeOrigin = false,
        rooms,
        emitHelpers = false,
        connectionKey = 'rl:ws:conn:',
        messageKeyPrefix = 'rl:ws:',
        tokenAccessor = 'findAccessToken',
        teardownFn = 'disconnectSocket',
        sessionTeardown,
    } = input;

    /** @type {import('./ws-standards.js').WsProblem[]} */
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
    /** @param {string} rel */
    const code = (rel) => stripComments(read(rel));

    const source = read(gateway);
    const header = /^\/\*\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
    // The header is prose and the body is code. Splitting them is what lets the
    // contract rule compare what is WRITTEN against what the code DOES, instead
    // of finding the documented event name in the documentation.
    const body = stripComments(source.slice(header.length));

    const serverFiles = walkFiles(root, serverDirs, {
        match: /\.ts$/,
        exclude: (rel) => rel.includes('__tests__'),
    });
    const clientFiles = walkFiles(root, clientDirs, {
        match: /\.(ts|vue)$/,
        exclude: (rel) => rel.includes('__tests__'),
    });

    // ── 1. One Socket.IO server, on the existing HTTP listener ──────────────
    for (const rel of serverFiles) {
        if (rel.startsWith(gatewayDir)) continue;
        if (/from\s+'socket\.io'/.test(code(rel))) {
            fail(
                rel,
                'imports `socket.io` outside the gateway',
                `One Socket.IO server, owned by ${gatewayDir}. Import the gateway's helpers instead — a second server is a second listener with its own auth and its own reconnect loop.`,
            );
        }
    }

    const servers = [...body.matchAll(/new Server\(\s*(\w+)/g)];
    if (servers.length !== 1) {
        fail(
            gateway,
            `constructs ${plural(servers.length, 'Socket.IO server')}`,
            'Exactly one `new Server(httpServer, …)`. A second server is a second listener, with its own handshake, its own limits and its own idea of who is connected.',
        );
    } else if (!/httpServer|server/i.test(servers[0]?.[1] ?? '')) {
        fail(
            gateway,
            `new Server() is not passed the HTTP server (got \`${servers[0]?.[1] ?? ''}\`)`,
            'Attach to the existing Express HTTP server, never a port of its own — a second port is a second thing to expose, proxy, probe and firewall.',
        );
    }

    // ── 2. The Redis adapter — required here, forbidden there ───────────────
    if (redisAdapter.mode === 'required') {
        if (!/@socket\.io\/redis-adapter/.test(body)) {
            fail(
                gateway,
                'no Redis adapter',
                'Mandatory for multi-pod: each pod holds only its own sockets, so without the adapter an emit raised on one pod never reaches a user connected to another. It is invisible in single-pod dev, which is exactly where it gets written.',
            );
        }
        // The install must be inside a try/catch that WARNS: a gateway that dies
        // because Redis was slow to accept a connection is worse than one running
        // on the in-memory adapter, and a silent fallback looks identical to a
        // working cluster until the day there are two pods.
        const guarded = tryCatchPairs(body).find((pair) => /io\.adapter\(/.test(pair.attempt));

        if (guarded === undefined) {
            fail(
                gateway,
                'the adapter is not installed inside a try/catch',
                'Degrade to the in-memory adapter when Redis is unavailable — never crash the server because the adapter did not connect.',
            );
        } else if (!/logger\.warn\(/.test(guarded.recovery)) {
            fail(
                gateway,
                'the adapter catch does not warn',
                'Falling back to a single-pod in-memory adapter must be loud. Silently, it is indistinguishable from a working cluster right up until a second pod exists.',
            );
        } else if (/\bthrow\b|process\.exit/.test(guarded.recovery)) {
            fail(
                gateway,
                'the adapter catch rethrows or exits',
                'Degrade gracefully with a warning; the in-memory adapter is the correct behaviour for single-pod dev.',
            );
        }
    } else {
        if (/@socket\.io\/redis-adapter|io\.adapter\(/.test(body)) {
            fail(gateway, 'installs a Socket.IO Redis adapter', redisAdapter.why);
        }
        if (!new RegExp(redisAdapter.headerPhrase, 'i').test(header)) {
            fail(
                gateway,
                'the header no longer explains why there is no Redis adapter',
                `This gateway departs from the standard on purpose, so the argument has to live where the next person looks. Expected the header to still say "${redisAdapter.headerPhrase}".`,
            );
        }
    }

    // ── 3. The origin check on the upgrade ──────────────────────────────────
    if (upgradeOrigin) {
        if (!/allowRequest:/.test(body)) {
            fail(
                gateway,
                'no `allowRequest` origin check',
                'CORS does not govern a WebSocket upgrade. The `cors` option covers the polling transport only, so a client that opens with `transports: ["websocket"]` skips it entirely and any origin can hold a socket.',
            );
        } else if (!/allowRequest:[\s\S]{0,400}?config\.corsOrigin/.test(body)) {
            fail(
                gateway,
                '`allowRequest` does not compare against config.corsOrigin',
                'The same single allowed origin as REST, from the same Zod-validated env value. Two sources for one origin is one that will disagree.',
            );
        }
    }
    if (!/cors:\s*\{[\s\S]{0,200}?origin:\s*config\.corsOrigin/.test(body)) {
        fail(
            gateway,
            'the `cors` option is not `config.corsOrigin`',
            'The polling-transport half of the same setting, and the same Zod-validated value the REST API uses.',
        );
    }

    // ── 4. Handshake auth: same secret, pinned algorithm, inside io.use() ───
    const inlineVerifyAt = body.indexOf('jwt.verify');
    const delegateAt = authModule === undefined ? -1 : body.indexOf(`${authModule.fn}(`);
    const verifyAt = inlineVerifyAt !== -1 ? inlineVerifyAt : delegateAt;
    // The secret and the algorithm are properties of the function that calls
    // jwt.verify, not of the file the call site happens to sit in.
    const verifySource =
        inlineVerifyAt !== -1
            ? body
            : authModule === undefined
              ? ''
              : braceBlock(code(authModule.file), new RegExp(String.raw`function\s+${authModule.fn}\s*\(`));

    const uses = callSites(body, 'io.use(');

    if (verifyAt === -1) {
        fail(
            gateway,
            'no jwt.verify() on the handshake',
            `Verify the access token in an io.use() middleware${authModule === undefined ? '' : ` (inline, or through ${authModule.fn})`} and stash the user id on the socket. An unauthenticated socket must never reach a handler.`,
        );
    } else {
        if (!uses.some((site) => verifyAt > site.index && verifyAt < site.end)) {
            fail(
                gateway,
                'the handshake verify is not inside an io.use() middleware',
                'Authentication belongs in io.use(), which runs before the connection is established. Anywhere else and an unauthenticated socket is already connected while it is being checked.',
            );
        }
        if (!/jwt\.verify\([\s\S]{0,200}?config\.jwt\.secret/.test(verifySource)) {
            fail(
                gateway,
                'the handshake does not verify with `config.jwt.secret`',
                'The same secret as the REST API — a socket is not a separate trust domain, and a second secret is a second thing to rotate.',
            );
        }
        if (!/jwt\.verify\([\s\S]{0,200}?algorithms:\s*\['HS256'\]/.test(verifySource)) {
            fail(
                gateway,
                'jwt.verify() does not pin `algorithms`',
                "Pin `{ algorithms: ['HS256'] }`. An unpinned verify accepts a token whose algorithm the attacker chose, which is how `alg: none` and the RS256-to-HS256 confusion both work.",
            );
        }
        if (!/handshake\.auth/.test(body)) {
            fail(
                gateway,
                'the handshake token is not read from `handshake.auth`',
                'Never the query string — it is written verbatim into every proxy and access log along the way.',
            );
        }
    }

    // ── 5. The rate limit is the FIRST io.use() ─────────────────────────────
    {
        const first = uses[0];
        const span = first === undefined ? '' : body.slice(first.index, first.end);
        // The limiter is recognised by what it does, resolved one level deep —
        // see the header. A call in the span to a local function whose body
        // carries the bucket key counts as the limiter running in that span.
        const keyInSpan = span.includes(connectionKey);
        const viaHelper = [...span.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].some((call) =>
            declaredBody(body, call[1] ?? '').includes(connectionKey),
        );
        const limited = keyInSpan || viaHelper;

        if (uses.length < 2) {
            fail(
                gateway,
                `only ${plural(uses.length, 'io.use() middleware')}`,
                'Expected two: the connection rate limit, then JWT verification. Collapsing them into one means the flood pays for the verify.',
            );
        } else if (!limited) {
            fail(
                gateway,
                'the first io.use() does not run the connection rate limit',
                `Nothing in the first middleware consumes \`${connectionKey}\`, directly or through a helper declared in this file. Run the limit first — it sheds handshake floods before any auth or database work.`,
            );
        } else if (verifyAt !== -1 && verifyAt < (first?.end ?? 0)) {
            fail(
                gateway,
                'the JWT verify runs inside the first io.use(), ahead of or alongside the rate limit',
                'The rate limit must be the FIRST middleware and nothing else. Behind or beside auth, every flood attempt still pays for a signature verification.',
            );
        }

        if (!new RegExp(`${connectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\$\\{`).test(body)) {
            fail(
                gateway,
                'the connection bucket is not keyed per client',
                `Key on the resolved client IP (\`${connectionKey}\${ip}\`), or every connection in the world shares one bucket and the first flood locks out everybody.`,
            );
        }
        if (!/capacity:\s*\d+[\s\S]{0,40}refillPerMs:/.test(body)) {
            fail(
                gateway,
                'no token-bucket options for the connection limit',
                'Declare `{ capacity, refillPerMs }` so the burst and the sustained rate are both visible at the call site rather than buried in a default.',
            );
        }
    }

    // ── 6. The client IP mirrors the Express hop count ──────────────────────
    if (!/headers\[['"]x-forwarded-for['"]\]/i.test(body)) {
        fail(
            gateway,
            'X-Forwarded-For is not parsed',
            'Socket.IO does not honour Express `trust proxy` — it has no such setting. Without parsing the header here, every rate limit keys off the proxy address and collapses to one shared bucket.',
        );
    } else {
        if (!/config\.trustProxyHops/.test(body)) {
            fail(
                gateway,
                'the hop count is not `config.trustProxyHops`',
                'Mirror the Express setting from the same config value. Two hop counts that can disagree eventually will, and the one that is wrong is the one nothing tests.',
            );
        }
        if (!/parts\.length\s*-\s*config\.trustProxyHops/.test(body)) {
            fail(
                gateway,
                'the trusted hop is not counted from the end of X-Forwarded-For',
                'Proxies append, so the trusted entries are the rightmost ones. Counting from the left takes a value the client prepended and controls.',
            );
        }
    }

    // ── 7. Rooms, and emits confined to the gateway ─────────────────────────
    if (rooms.join === 'personal') {
        const prefix = rooms.prefix;
        if (!new RegExp(`socket\\.join\\(\`${prefix}\\$\\{`).test(body)) {
            fail(
                gateway,
                `no personal room joined on connect`,
                `\`socket.join(\\\`${prefix}\${userId}\\\`)\` — without it there is no address to push to from outside the connection handler, and a service has to know which socket the user is on.`,
            );
        }
        for (const [, room = ''] of body.matchAll(/\.to\(`([^`]*)`\)/g)) {
            if (!room.startsWith(prefix)) {
                fail(
                    gateway,
                    `emits to the non-personal room \`${room}\``,
                    `The room convention is \`${prefix}\${userId}\`. A new kind of room needs its own join site and its own line in the header contract, or it is an address nothing ever joins.`,
                );
            }
        }
    } else {
        for (const { args } of callSites(body, '.to(')) {
            if (/^\s*['"`]/.test(args)) {
                fail(
                    gateway,
                    `emits to the literal room ${args.trim()}`,
                    'Room names are built by a helper so the join site and the emit site cannot spell them differently. A mismatch is a silent feed, not an error.',
                );
            }
        }
    }

    for (const rel of serverFiles) {
        if (rel.startsWith(gatewayDir)) continue;
        if (/\.emit\(/.test(code(rel))) {
            fail(
                rel,
                'emits on a socket directly',
                `Nothing outside ${gatewayDir} holds an \`io\` handle. A service that can emit is a service that can await one, and then a socket failure fails the request that triggered it.`,
            );
        }
    }

    if (emitHelpers) {
        const helpers = [...body.matchAll(/export function (emit\w+)\(/g)].map((match) => match[1] ?? '');
        if (helpers.length === 0) {
            fail(
                gateway,
                'no exported emit helper',
                'Expose thin `emitX(userId, payload)` helpers so services never hold an io handle of their own.',
            );
        }
        for (const rel of serverFiles) {
            const src = code(rel);
            for (const helper of helpers) {
                if (new RegExp(String.raw`await\s+${helper}\(`).test(src)) {
                    fail(
                        rel,
                        `awaits ${helper}()`,
                        "Socket emits are fire-and-forget. Awaiting one couples the request to the socket layer's latency and failures — persist first, then emit, and never wait for it.",
                    );
                }
            }
        }
    }

    // ── 8. The header contract matches the wire, in both directions ─────────
    const outbound = new Set([...body.matchAll(/\.emit\(\s*'([^']+)'/g)].map((match) => match[1] ?? ''));
    const inbound = [...body.matchAll(/socket\.on\(\s*'([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .filter((event) => !LIFECYCLE.has(event));
    const onTheWire = new Set([...outbound, ...inbound]);
    // An event line in the header is a `resource:action` token that OPENS its
    // line. Anchoring on a fixed indent instead would encode today's formatting
    // as the contract, and prose mentioning an event would satisfy the rule.
    const documented = new Set(
        [...header.matchAll(/^\s*\*\s+([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\b/gm)].map((match) => match[1] ?? ''),
    );

    for (const event of onTheWire) {
        if (!documented.has(event)) {
            fail(
                gateway,
                `\`${event}\` is on the wire but not in the header contract`,
                "The header is this file's route map, and review trusts it. Add the event and its payload shape under the direction it travels.",
            );
        }
    }
    for (const event of documented) {
        if (!onTheWire.has(event)) {
            fail(
                gateway,
                `the header documents \`${event}\`, which nothing sends or handles`,
                'Remove it, or implement it. A contract listing an event that does not exist is worse than no contract — it is a promise the code never made.',
            );
        }
    }
    if (!/^\s*\*\s+Server\s*→\s*Client:\s*$/m.test(header)) {
        fail(
            gateway,
            'the header has no `Server → Client:` event list',
            "Document the event contract — direction and payload shape per event. It is the socket equivalent of a router file's JSDoc route map.",
        );
    }
    if (!/^\s*\*\s+Client\s*→\s*Server:\s*$/m.test(header)) {
        fail(
            gateway,
            'the header does not state the `Client → Server:` direction',
            'Say it explicitly, even when empty (`(none — push-only)`). That empty list is exactly what justifies having no per-message rate limit.',
        );
    }

    // ── 9. Inbound events are validated and rate limited ────────────────────
    for (const event of inbound) {
        const at = body.indexOf(`socket.on('${event}'`);
        const handler = body.slice(at, at + 800);
        // Either shape counts: a parse in the listener itself, or — when the
        // listener delegates to a named handler — a parse of the schema named
        // after the event (`candle:watch` → `candleWatchSchema`).
        const camel = event.replace(/:(.)/g, (_match, letter) => String(letter).toUpperCase());
        const validated =
            /\.(parse|safeParse)\(/.test(handler) ||
            new RegExp(String.raw`${camel}\w*[Ss]chema\.(?:safeParse|parse)\(`).test(body);
        if (!validated) {
            fail(
                gateway,
                `inbound event \`${event}\` has no Zod parse`,
                'Validate the payload exactly like a request body. An authenticated socket is still untrusted input — the user is known, the bytes are not.',
            );
        }
    }
    if (inbound.length > 0) {
        const messageBucket = new RegExp(
            `${messageKeyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${connectionKey.slice(messageKeyPrefix.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
        );
        if (!messageBucket.test(body)) {
            fail(
                gateway,
                'inbound events exist with no per-message rate limit',
                'Connection-time limiting alone is only sufficient for a push-only socket. An inbound event is client-controlled work on an already-established connection, and needs its own bucket.',
            );
        }
    }

    // ── 10. The frontend half ───────────────────────────────────────────────
    if (!exists(client)) {
        fail(client, 'missing', 'One socket client module for the whole frontend — one connection per tab.');
    } else {
        const clientSource = code(client);

        if (!/auth:\s*\(/.test(clientSource)) {
            fail(
                client,
                'the handshake token is captured, not re-read per attempt',
                'Pass `auth` as a callback — socket.io-client re-invokes it before every reconnect, so a reconnect after a silent refresh carries the new token instead of the expired one it was constructed with.',
            );
        }
        if (!new RegExp(String.raw`${tokenAccessor}\(\)`).test(clientSource)) {
            fail(
                client,
                'no access token on the handshake',
                `Read it through \`${tokenAccessor}()\` so the socket and the HTTP client agree on where the session lives.`,
            );
        }
        if (!/autoConnect:\s*false/.test(clientSource)) {
            fail(
                client,
                'the socket connects before authentication',
                'Set `autoConnect: false` and connect once authenticated. An anonymous handshake just burns a connection-bucket token and is refused.',
            );
        }

        if (!new RegExp(String.raw`function\s+${teardownFn}\b`).test(clientSource)) {
            fail(
                client,
                `no ${teardownFn}()`,
                'Define one so the session teardown can drop the connection and discard the singleton.',
            );
        } else if (sessionTeardown !== undefined) {
            if (!new RegExp(String.raw`${sessionTeardown}\(\s*${teardownFn}\s*\)`).test(clientSource)) {
                fail(
                    client,
                    `${teardownFn}() is not wired to the session teardown`,
                    `Register it with \`${sessionTeardown}\` — a socket authenticated as the previous user must not survive a sign-out, and leaving that to each caller means one of them forgets.`,
                );
            }
        } else {
            const callers = clientFiles.filter(
                (rel) => rel !== client && new RegExp(String.raw`${teardownFn}\(\)`).test(code(rel)),
            );
            if (callers.length === 0) {
                fail(
                    client,
                    `${teardownFn}() is never called`,
                    'Call it from the sign-out path. Otherwise the socket stays connected under the previous user’s token until the server happens to drop it.',
                );
            }
        }

        for (const rel of clientFiles) {
            if (rel === client) continue;
            const src = code(rel);
            if (/socket\.io-client/.test(src) && /\bio\(/.test(src)) {
                fail(
                    rel,
                    'opens a second socket.io-client connection',
                    `One connection per tab, from ${client}. A second is a second handshake, a second reconnect loop and a second bucket charge under the same token.`,
                );
            }
        }
    }

    for (const rel of clientFiles) {
        if (rel === client) continue;
        const src = code(rel);
        const listeners = [...src.matchAll(/socket\.on\(\s*'([^']+)'/g)].map((match) => match[1] ?? '');
        if (listeners.length === 0) continue;

        // Either teardown hook. `onScopeDispose` is the right one in a composable:
        // it fires for a manual effectScope too, where `onUnmounted` never runs
        // because there is no component instance to unmount.
        const hooks = [src.indexOf('onScopeDispose('), src.indexOf('onUnmounted(')].filter((at) => at !== -1);
        if (hooks.length === 0) {
            fail(
                rel,
                'registers a socket listener with no teardown hook',
                'A listener left behind keeps firing into dead state, and re-registers on every remount so it fires twice, then three times. Clean up in `onScopeDispose` (or `onUnmounted` in a component).',
            );
            continue;
        }
        const teardown = src.slice(Math.min(...hooks));
        for (const event of listeners) {
            if (!new RegExp(String.raw`\.off\(\s*'${event}'`).test(teardown)) {
                fail(
                    rel,
                    `listens for \`${event}\` but never removes it`,
                    'Remove every listener the composable added — `socket.off(event, handler)` in the teardown hook, with the same handler reference it was added with.',
                );
            }
        }
    }

    return { problems, counts: { outbound: outbound.size, inbound: inbound.length, documented: documented.size } };
}

/**
 * Run the gate and print.
 *
 * @param {import('./ws-standards.js').WsStandardsOptions} options
 * @returns {void}
 */
export function checkWsStandards({ root = REPO_ROOT, standard, ...rest }) {
    const report = createGateReport({ name: 'WebSocket standards', ...(standard === undefined ? {} : { standard }) });
    const { problems, counts } = inspectWsStandards({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const adapter =
        rest.redisAdapter?.mode === 'forbidden'
            ? 'no Redis adapter and the reason still written down'
            : 'Redis adapter degrading to in-memory';

    report.done({
        summary:
            `WebSocket architecture OK — one server on the existing HTTP listener, ${adapter}, ` +
            `handshake auth pinned and the rate limit ahead of it, hop count mirrored, emits confined to the gateway; ` +
            `${plural(counts.outbound, 'outbound event')} and ${plural(counts.inbound, 'inbound event')} all matching the header contract, ` +
            `frontend on one client module with every listener cleaned up.`,
        notMachineChecked:
            'Whether a given feature should be a socket at all rather than REST, whether a payload is small enough to push, whether the connection bucket’s capacity is the right number, or whether a reconnect resubscribes to everything it was watching.',
    });
}

export default checkWsStandards;
