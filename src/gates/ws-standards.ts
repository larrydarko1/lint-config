/**
 * WebSocket architecture: one server, one client, and the order of the handshake.
 * ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. One Socket.IO server, on the existing HTTP listener.
 *   2. The Redis adapter, `required` or `forbidden` (see RedisAdapter).
 *   3. The origin is checked on the upgrade (CORS does not cover it).
 *   4. Handshake auth inside io.use(), checked in `authModule` when the verify is not inline.
 *   5. The connection rate limit is the first io.use(), recognised by its bucket key
 *      in the middleware or in a same-file function it calls.
 *   6. The client IP mirrors the Express hop count.
 *   7. Rooms, and emits confined to the gateway.
 *   8. The gateway header lists the events, both directions.
 *   9. Inbound events are validated (a parse in the listener, or a schema named
 *      after the event) and rate limited.
 *  10. The frontend: one client, listeners torn down (`onScopeDispose` or
 *      `onUnmounted`), the socket dropped on sign-out.
 *  11. Outbound payloads have schemas (opt-in: `events`): the shared event table
 *      lists exactly the events the gateway emits, and the gateway reads it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { braceBlock, callSites, declaredBody, propertyValue } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

export type WsStandardsOptions = {
    /** Repository root. Defaults to the nearest ancestor holding a package.json. */
    root?: string;
    /** The gateway module that constructs the Socket.IO server. */
    gateway: string;
    /** The directory that owns the socket. Nothing outside it may import socket.io. */
    gatewayDir: string;
    /** Server directories swept for stray imports and stray emits. */
    serverDirs: string | string[];
    /** The one frontend socket client module. */
    client: string;
    /** Frontend directories swept for second connections and leaked listeners. */
    clientDirs: string | string[];
    /** Where the handshake verify really happens, when it is not inline. */
    authModule?: { file: string; fn: string };
    /** Required here, forbidden there. Defaults to required. */
    redisAdapter?: RedisAdapterRule;
    /** How rooms are addressed. */
    rooms: RoomRule;
    /** Require exported `emitX` helpers that nothing awaits. Defaults to false. */
    emitHelpers?: boolean;
    /** The connection bucket key prefix. Defaults to `rl:ws:conn:`. */
    connectionKey?: string;
    /** The prefix every socket bucket key shares. Defaults to `rl:ws:`. */
    messageKeyPrefix?: string;
    /** The function the client reads the access token through. Defaults to `findAccessToken`. */
    tokenAccessor?: string;
    /** The client's teardown function. Defaults to `disconnectSocket`. */
    teardownFn?: string;
    /** The session hook the teardown registers with. Absent means "called from the sign-out path". */
    sessionTeardown?: string;
    /**
     * The shared table of outbound events and their payload schemas (rule 11):
     * `file` holds `export const <table> = { 'event:name': schema, … }`. A repo that
     * states none is not graded on it.
     */
    events?: { file: string; table: string };
};

/**
 * Mandatory where a pod holds only its own sockets; a regression where every pod
 * already subscribes to every bucket. `'forbidden'` requires the reason in the gateway header.
 */
type RedisAdapterRule =
    | { mode: 'required' }
    | {
          mode: 'forbidden';
          /** What the header must still say, matched case-insensitively. */
          headerPhrase: string;
          /** The argument itself, reported when an adapter reappears. */
          why: string;
      };

/** How this gateway addresses its clients. */
type RoomRule = { join: 'personal'; prefix: string } | { join: 'helpers' };

type WsStandardsInspection = {
    problems: GateFailure[];
    counts: { outbound: number; inbound: number; documented: number };
};

/** Socket.IO's own events. A listener for one of these is not an app contract. */
const LIFECYCLE = new Set(['connect', 'connection', 'disconnect', 'disconnecting', 'connect_error', 'error']);

/** Every `try { … } catch { … }` pair in a file, brace-balanced. */
function tryCatchPairs(source: string): { attempt: string; recovery: string }[] {
    const pairs: { attempt: string; recovery: string }[] = [];

    for (const match of source.matchAll(/\btry\s*\{/g)) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let j = open; j < source.length; j++) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}' && --depth === 0) {
                const rest = source.slice(j + 1);
                // Only a catch that immediately follows belongs to this try.
                const recovery = /^\s*catch\b/.test(rest) ? braceBlock(rest, /catch\s*(?:\([^)]*\))?\s*\{/) : '';
                pairs.push({ attempt: source.slice(open + 1, j), recovery });
                break;
            }
        }
    }

    return pairs;
}

/** Every problem found, without printing. */
export function inspectWsStandards(input: WsStandardsOptions): WsStandardsInspection {
    const {
        root = REPO_ROOT,
        gateway,
        gatewayDir,
        serverDirs,
        client,
        clientDirs,
        authModule,
        redisAdapter = { mode: 'required' },
        rooms,
        emitHelpers = false,
        connectionKey = 'rl:ws:conn:',
        messageKeyPrefix = 'rl:ws:',
        tokenAccessor = 'findAccessToken',
        teardownFn = 'disconnectSocket',
        sessionTeardown,
        events,
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));
    const code = (rel: string) => stripComments(read(rel));

    const source = read(gateway);
    const header = /^\/\*\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
    // Split header from body so documented events are not found in the documentation.
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
        // The install must be in a try/catch that warns: neither crash nor silent fallback.
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
    const originCheck = propertyValue(body, 'allowRequest');
    if (originCheck === null) {
        fail(
            gateway,
            'no `allowRequest` origin check',
            'CORS does not govern a WebSocket upgrade. The `cors` option covers the polling transport only, so a client that opens with `transports: ["websocket"]` skips it entirely and any origin can hold a socket.',
        );
    } else if (!originCheck.includes('config.corsOrigin')) {
        fail(
            gateway,
            '`allowRequest` does not compare against config.corsOrigin',
            'The same single allowed origin as REST, from the same Zod-validated env value. Two sources for one origin is one that will disagree.',
        );
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
        // A call to a local function carrying the bucket key counts as the limiter.
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

    // ── 11. Every outbound event has a payload schema ───────────────────────
    if (events !== undefined) {
        const tablePath = path.join(root, events.file);
        if (!fs.existsSync(tablePath)) {
            fail(
                events.file,
                'missing',
                'It holds the schema every pushed payload is checked against, and the type the frontend socket is built from. Without it a payload is whatever the emitting service happened to build.',
            );
        } else {
            const tableSource = stripComments(fs.readFileSync(tablePath, 'utf8'));
            const block = braceBlock(tableSource, new RegExp(`const\\s+${events.table}\\s*=\\s*\\{`));
            const tabled = new Set(
                [...block.matchAll(/['"]([a-z][\w-]*:[\w-]+)['"]\s*:/g)].map((match) => match[1] ?? ''),
            );
            for (const event of [...outbound].filter((name) => !tabled.has(name)).sort()) {
                fail(
                    gateway,
                    `emits \`${event}\`, which ${events.table} does not list`,
                    'Its payload goes out unchecked: no schema trims it, so a field the service added reaches every connected client, and the frontend types its listener by hand. Add the event and its payload schema to the table.',
                );
            }
            for (const event of [...tabled].filter((name) => !outbound.has(name)).sort()) {
                fail(
                    events.file,
                    `${events.table} lists \`${event}\`, which the gateway never emits`,
                    'The frontend can listen for it, typed and all, and nothing will ever arrive. Remove it, or emit it.',
                );
            }
            if (!new RegExp(`\\b${events.table}\\b`).test(body)) {
                fail(
                    gateway,
                    `never reads ${events.table}`,
                    'The table only protects the wire if every push is parsed through it. A gateway that does not read it sends payloads exactly as the services built them.',
                );
            }
        }
    }
    const inbound = [...body.matchAll(/socket\.on\(\s*'([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .filter((event) => !LIFECYCLE.has(event));
    const onTheWire = new Set([...outbound, ...inbound]);
    // An event line is a `resource:action` token that opens its line, so prose does not count.
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
        // A parse in the listener, or of the schema named after the event (`candle:watch` → `candleWatchSchema`).
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

        // Either hook; `onScopeDispose` also fires for a manual effectScope.
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

/** Run the gate and print. */
export function checkWsStandards(options: WsStandardsOptions): void {
    const report = createGateReport({ name: 'WebSocket standards' });
    const { problems, counts } = inspectWsStandards(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const adapter =
        options.redisAdapter?.mode === 'forbidden'
            ? 'no Redis adapter and the reason still written down'
            : 'Redis adapter degrading to in-memory';

    report.done({
        summary:
            `WebSocket architecture OK — one server on the existing HTTP listener, ${adapter}, ` +
            `upgrade origin checked, handshake auth pinned and the rate limit ahead of it, hop count mirrored, emits confined to the gateway; ` +
            `${plural(counts.outbound, 'outbound event')} and ${plural(counts.inbound, 'inbound event')} all matching the header contract, ` +
            `frontend on one client module with every listener cleaned up.`,
        notMachineChecked:
            'Whether a given feature should be a socket at all rather than REST, whether a payload is small enough to push, whether the connection bucket’s capacity is the right number, or whether a reconnect resubscribes to everything it was watching.',
    });
}
