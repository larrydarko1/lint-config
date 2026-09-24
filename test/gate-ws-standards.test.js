import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectWsStandards } from '../src/gates/ws-standards.js';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

// ─── Fixtures: a push-only gateway that satisfies every rule ─────────────────

const GATEWAY = `/**
 * WebSocket gateway — Socket.IO server for real-time notifications.
 * Event contract:
 * Server → Client:
 *     notification:new — NotificationPayload { _id, type, groupKey, count }.
 *         Sent on a new notification, or when a group's count changes.
 * Client → Server:
 *     (none — push-only)
 */
import { Server } from 'socket.io';

import { config } from '@/lib/config.js';
import { logger } from '@/lib/logger.js';
import { consumeTokenBucket } from '@/lib/token-bucket.js';
import { verifyAccessToken } from '@/middleware/auth.js';

const CONN_BUCKET = { capacity: 10, refillPerMs: 1 / 6_000 };

let io;

export async function initSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: config.corsOrigin,
            credentials: true,
        },
        path: '/socket.io',
        allowRequest: (req, callback) => {
            const origin = req.headers.origin;
            callback(null, origin === undefined || origin === config.corsOrigin);
        },
    });

    try {
        const { Redis } = await import('ioredis');
        const { createAdapter } = await import('@socket.io/redis-adapter');
        const pubClient = new Redis(config.redis.url);
        const subClient = pubClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('Socket.IO Redis adapter connected');
    } catch {
        logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');
    }

    io.use((socket, next) => {
        void (async () => {
            if (!(await consumeConnectionToken(clientIp(socket)))) {
                return next(new Error('Too many connection attempts — slow down'));
            }
            next();
        })();
    });

    io.use((socket, next) => {
        const token = socket.handshake.auth?.['token'];
        if (token === undefined || token === '') return next(new Error('Missing token'));
        const userId = verifyAccessToken(token);
        if (userId === null) return next(new Error('Invalid token'));
        socket.userId = userId;
        next();
    });

    io.on('connection', (socket) => {
        void socket.join(\`user:\${socket.userId}\`);
    });
}

export function emitNotification(userId, payload) {
    if (io === undefined) return;
    io.to(\`user:\${userId}\`).emit('notification:new', payload);
}

async function consumeConnectionToken(ip) {
    const { allowed } = await consumeTokenBucket(\`rl:ws:conn:\${ip}\`, CONN_BUCKET);
    return allowed;
}

function clientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const parts = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return socket.handshake.address;
    return parts[Math.max(0, parts.length - config.trustProxyHops)] ?? socket.handshake.address;
}
`;

const AUTH = `import jwt from 'jsonwebtoken';

import { config } from '@/lib/config.js';

export function verifyAccessToken(token) {
    try {
        const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
        if (payload.kind !== 'access') return null;
        return payload.sub;
    } catch {
        return null;
    }
}
`;

const SERVICE = `import { emitNotification } from '@/gateway/socket.js';

export async function notify(userId, payload) {
    await saveNotification(userId, payload);
    emitNotification(userId, payload);
}
`;

const CLIENT = `import { io } from 'socket.io-client';
import { ref } from 'vue';

import { findAccessToken, isAuthenticated } from '@/api/client';

let socket = null;
const connected = ref(false);

export function useSocket() {
    const sock = createSocket();
    if (isAuthenticated() && !sock.connected) sock.connect();
    return { socket: sock, connected };
}

export function disconnectSocket() {
    if (socket !== null) {
        socket.disconnect();
        socket = null;
    }
}

function createSocket() {
    if (socket !== null) return socket;
    socket = io(window.location.origin, {
        path: '/socket.io',
        autoConnect: false,
        auth: (cb) => cb({ token: findAccessToken() }),
    });
    return socket;
}
`;

const LOGOUT = `import { disconnectSocket } from '@/api/socket';

export async function logout() {
    await clearSession();
    disconnectSocket();
}
`;

const COMPOSABLE = `import { onUnmounted } from 'vue';

import { useSocket } from '@/api/socket';

export function useNotifications() {
    const { socket } = useSocket();
    const onNew = (payload) => push(payload);
    socket.on('notification:new', onNew);
    onUnmounted(() => {
        socket.off('notification:new', onNew);
    });
}
`;

const FILES = {
    'api/src/gateway/socket.ts': GATEWAY,
    'api/src/middleware/auth.ts': AUTH,
    'api/src/services/notify.ts': SERVICE,
    'frontend/src/api/socket.ts': CLIENT,
    'frontend/src/api/auth.ts': LOGOUT,
    'frontend/src/composables/useNotifications.ts': COMPOSABLE,
};

const good = (overrides = {}) => ({ ...FILES, ...overrides });

const OPTIONS = {
    gateway: 'api/src/gateway/socket.ts',
    gatewayDir: 'api/src/gateway',
    serverDirs: 'api/src',
    client: 'frontend/src/api/socket.ts',
    clientDirs: 'frontend/src',
    authModule: { file: 'api/src/middleware/auth.ts', fn: 'verifyAccessToken' },
    redisAdapter: { mode: 'required' },
    rooms: { join: 'personal', prefix: 'user:' },
    emitHelpers: true,
};

const run = (root, overrides = {}) => inspectWsStandards({ root, ...OPTIONS, ...overrides });
const whats = (root, overrides) => run(root, overrides).problems.map((problem) => problem.what);
const whys = (root, overrides) => run(root, overrides).problems.map((problem) => problem.why);

// ─── The baseline ────────────────────────────────────────────────────────────

test('a gateway that satisfies every rule reports nothing', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

test('the counts describe the contract that was read', (t) => {
    const { counts } = run(tree(t, good()));
    assert.deepEqual(counts, { outbound: 1, inbound: 0, documented: 1 });
});

// ─── 1. One server, on the existing listener ─────────────────────────────────

test('a socket.io import outside the gateway is reported', (t) => {
    const root = tree(t, good({ 'api/src/services/push.ts': "import { Server } from 'socket.io';\n" }));
    assert.ok(whats(root).some((what) => what === 'imports `socket.io` outside the gateway'));
});

test('a socket.io import inside the gateway directory is fine', (t) => {
    const root = tree(t, good({ 'api/src/gateway/rooms.ts': "import type { Server } from 'socket.io';\n" }));
    assert.deepEqual(whats(root), []);
});

test('a socket.io import in a test file is not graded', (t) => {
    const root = tree(t, good({ 'api/src/services/__tests__/push.test.ts': "import { Server } from 'socket.io';\n" }));
    assert.deepEqual(whats(root), []);
});

test('a socket.io import inside a comment is not reported', (t) => {
    const root = tree(t, good({ 'api/src/services/push.ts': "// was: import { Server } from 'socket.io';\n" }));
    assert.deepEqual(whats(root), []);
});

test('a second Socket.IO server is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/gateway/socket.ts': `${GATEWAY}const second = new Server(otherServer, {});\n` }),
    );
    assert.ok(whats(root).some((what) => what === 'constructs 2 Socket.IO servers'));
});

test('no Socket.IO server at all is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/gateway/socket.ts': GATEWAY.replace('new Server(httpServer, {', 'makeServer({') }),
    );
    assert.ok(whats(root).some((what) => what === 'constructs 0 Socket.IO servers'));
});

test('a server given something other than the HTTP server is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/gateway/socket.ts': GATEWAY.replace('new Server(httpServer,', 'new Server(4001,') }),
    );
    assert.ok(whats(root).some((what) => what.includes('is not passed the HTTP server')));
});

test('the second-server finding explains what a second listener costs', (t) => {
    const root = tree(
        t,
        good({ 'api/src/gateway/socket.ts': `${GATEWAY}const second = new Server(otherServer, {});\n` }),
    );
    assert.ok(whys(root).some((why) => why.includes('its own idea of who is connected')));
});

// ─── 2. The Redis adapter, required ──────────────────────────────────────────

test('a missing Redis adapter is reported where it is required', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace('@socket.io/redis-adapter', 'ioredis') }));
    assert.ok(whats(root).some((what) => what === 'no Redis adapter'));
});

test('the missing-adapter finding explains the cross-pod silence', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace('@socket.io/redis-adapter', 'ioredis') }));
    assert.ok(whys(root).some((why) => why.includes('never reaches a user connected to another')));
});

test('an adapter installed outside a try/catch is reported', (t) => {
    const unguarded = GATEWAY.replace('    try {\n', '    {\n').replace(
        "    } catch {\n        logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');\n    }\n",
        '    }\n',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unguarded }));
    assert.ok(whats(root).some((what) => what === 'the adapter is not installed inside a try/catch'));
});

test('an adapter catch that does not warn is reported', (t) => {
    const quiet = GATEWAY.replace(
        "logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');",
        '// nothing',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': quiet }));
    assert.ok(whats(root).some((what) => what === 'the adapter catch does not warn'));
});

test('an adapter catch that rethrows is reported', (t) => {
    const fatal = GATEWAY.replace(
        "logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');",
        "logger.warn('Redis adapter unavailable');\n        throw new Error('no adapter');",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': fatal }));
    assert.ok(whats(root).some((what) => what === 'the adapter catch rethrows or exits'));
});

test('an adapter catch that exits the process is reported', (t) => {
    const fatal = GATEWAY.replace(
        "logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');",
        "logger.warn('Redis adapter unavailable');\n        process.exit(1);",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': fatal }));
    assert.ok(whats(root).some((what) => what === 'the adapter catch rethrows or exits'));
});

test('a nested object inside the try does not truncate the block', (t) => {
    // The copy this replaces matched `\\{([^}]*)\\}`, which stops at the first
    // closing brace — one nested literal hid the adapter install from the rule.
    const nested = GATEWAY.replace(
        '        const pubClient = new Redis(config.redis.url);',
        '        const options = { lazyConnect: true, retry: { max: 3 } };\n        const pubClient = new Redis(config.redis.url, options);',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': nested }));
    assert.deepEqual(whats(root), []);
});

test('a later unrelated try/catch does not lend its catch to the adapter', (t) => {
    const unguarded = GATEWAY.replace('    try {\n', '    {\n')
        .replace(
            "    } catch {\n        logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');\n    }\n",
            '    }\n',
        )
        .concat(
            "\nfunction other() {\n    try {\n        work();\n    } catch {\n        logger.warn('other');\n    }\n}\n",
        );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unguarded }));
    assert.ok(whats(root).some((what) => what === 'the adapter is not installed inside a try/catch'));
});

test('a try with no catch does not borrow the catch of a later one', (t) => {
    // Without pairing each catch to ITS try, `braceBlock` finds the next catch
    // anywhere below — so an adapter installed in a `try/finally` is graded on
    // the recovery of some unrelated function further down the file, and passes.
    const finallyOnly = GATEWAY.replace(
        "    } catch {\n        logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');\n    }\n",
        "    } finally {\n        logger.info('adapter setup done');\n    }\n",
    ).concat(
        "\nfunction other() {\n    try {\n        work();\n    } catch {\n        logger.warn('other failed');\n    }\n}\n",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': finallyOnly }));
    assert.ok(
        whats(root).some((what) => what === 'the adapter catch does not warn'),
        whats(root).join(' | '),
    );
});

// ─── 2b. The Redis adapter, forbidden — the inverted rule ────────────────────

const FORBIDDEN = {
    mode: 'forbidden',
    headerPhrase: 'no Redis adapter',
    why: 'Deliberately absent: every pod already subscribes to every bucket its own sockets need.',
};

/** The same gateway with the adapter removed and the reason written into the header. */
const NO_ADAPTER = GATEWAY.replace(
    ' * Event contract:',
    ' * There is deliberately no Redis adapter: every pod already subscribes to\n * every bucket its own sockets need.\n * Event contract:',
).replace(
    "    try {\n        const { Redis } = await import('ioredis');\n        const { createAdapter } = await import('@socket.io/redis-adapter');\n        const pubClient = new Redis(config.redis.url);\n        const subClient = pubClient.duplicate();\n        io.adapter(createAdapter(pubClient, subClient));\n        logger.info('Socket.IO Redis adapter connected');\n    } catch {\n        logger.warn('Redis adapter unavailable — using in-memory adapter (single-pod only)');\n    }\n\n",
    '',
);

test('a gateway that states why it has no adapter passes the forbidden rule', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': NO_ADAPTER }));
    assert.deepEqual(whats(root, { redisAdapter: FORBIDDEN }), []);
});

test('an adapter reappearing where it is forbidden is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY }));
    assert.ok(whats(root, { redisAdapter: FORBIDDEN }).some((what) => what === 'installs a Socket.IO Redis adapter'));
});

test('the forbidden finding carries the project’s own argument', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY }));
    assert.ok(whys(root, { redisAdapter: FORBIDDEN }).some((why) => why === FORBIDDEN.why));
});

test('an io.adapter() call alone is enough to trip the forbidden rule', (t) => {
    const sneaky = NO_ADAPTER.replace(
        '    io.use((socket, next) => {',
        '    io.adapter(createAdapter(pub, sub));\n\n    io.use((socket, next) => {',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': sneaky }));
    assert.ok(whats(root, { redisAdapter: FORBIDDEN }).some((what) => what === 'installs a Socket.IO Redis adapter'));
});

test('dropping the reason from the header is reported even with no adapter', (t) => {
    const silent = NO_ADAPTER.replace(
        ' * There is deliberately no Redis adapter: every pod already subscribes to\n * every bucket its own sockets need.\n',
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': silent }));
    assert.ok(
        whats(root, { redisAdapter: FORBIDDEN }).some((what) =>
            what.includes('no longer explains why there is no Redis adapter'),
        ),
    );
});

test('the header-phrase finding quotes the phrase it wanted', (t) => {
    const silent = NO_ADAPTER.replace(
        ' * There is deliberately no Redis adapter: every pod already subscribes to\n * every bucket its own sockets need.\n',
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': silent }));
    assert.ok(whys(root, { redisAdapter: FORBIDDEN }).some((why) => why.includes('"no Redis adapter"')));
});

test('the reason must be in the header, not buried in the body', (t) => {
    // The point of the rule is that the argument sits where the next person
    // looks. A comment beside the code is not the file header.
    const buried = NO_ADAPTER.replace(
        ' * There is deliberately no Redis adapter: every pod already subscribes to\n * every bucket its own sockets need.\n',
        '',
    ).replace(
        '    io.use((socket, next) => {',
        '    // there is deliberately no Redis adapter here\n    io.use((socket, next) => {',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': buried }));
    assert.ok(whats(root, { redisAdapter: FORBIDDEN }).some((what) => what.includes('no longer explains why')));
});

// ─── 3. The origin check on the upgrade (standard in every repo) ─────────────

const CHECK = `        allowRequest: (req, callback) => {
            const origin = req.headers.origin;
            callback(null, origin === undefined || origin === config.corsOrigin);
        },
`;
const WITHOUT_ORIGIN_CHECK = GATEWAY.replace(CHECK, '');

test('a missing allowRequest is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': WITHOUT_ORIGIN_CHECK }));
    assert.ok(whats(root).some((what) => what === 'no `allowRequest` origin check'));
});

test('the allowRequest finding explains why cors does not cover the upgrade', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': WITHOUT_ORIGIN_CHECK }));
    assert.ok(whys(root).some((why) => why.includes('transports: ["websocket"]')));
});

test('an allowRequest that checks the configured origin passes', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

test('an expression-bodied allowRequest that checks the configured origin passes', (t) => {
    const checked = GATEWAY.replace(
        CHECK,
        '        allowRequest: (req, callback) => callback(null, req.headers.origin === config.corsOrigin),\n',
    );
    assert.deepEqual(whats(tree(t, good({ 'api/src/gateway/socket.ts': checked }))), []);
});

test('an allowRequest that checks something else is reported', (t) => {
    const checked = GATEWAY.replace(CHECK, '        allowRequest: (req, callback) => callback(null, true),\n');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': checked }));
    assert.ok(whats(root).some((what) => what.includes('does not compare against config.corsOrigin')));
});

test("an allowRequest is not credited with its neighbour's config.corsOrigin", (t) => {
    // The option that most often follows it names the origin too. A fixed
    // window after `allowRequest:` read THAT and passed an allow-all check.
    const checked = WITHOUT_ORIGIN_CHECK.replace(
        '        cors: {',
        '        allowRequest: (req, callback) => callback(null, true),\n        cors: {',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': checked }));
    assert.ok(whats(root).some((what) => what.includes('does not compare against config.corsOrigin')));
});

test('an allowRequest written last, with no trailing comma, is read up to its own brace', (t) => {
    // Without a comma to end it, the value ends at the options object's `}` —
    // reading past it reached a later mention of the origin and passed.
    const checked = WITHOUT_ORIGIN_CHECK.replace(
        "        path: '/socket.io',\n    });",
        "        path: '/socket.io',\n        allowRequest: (req, callback) => callback(null, true)\n    });\n    logger.info({ origin: config.corsOrigin }, 'socket ready');",
    );
    assert.notEqual(checked, WITHOUT_ORIGIN_CHECK);
    const root = tree(t, good({ 'api/src/gateway/socket.ts': checked }));
    assert.ok(whats(root).some((what) => what.includes('does not compare against config.corsOrigin')));
});

test('a longer key that merely ends in allowRequest is not the origin check', (t) => {
    const checked = WITHOUT_ORIGIN_CHECK.replace(
        "        path: '/socket.io',",
        "        path: '/socket.io',\n        disallowRequest: config.corsOrigin,",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': checked }));
    assert.ok(whats(root).some((what) => what === 'no `allowRequest` origin check'));
});

test('an allowRequest that is only commented out is reported as missing', (t) => {
    const checked = WITHOUT_ORIGIN_CHECK.replace(
        "        path: '/socket.io',",
        "        path: '/socket.io',\n        // allowRequest: (req, callback) => callback(null, req.headers.origin === config.corsOrigin),",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': checked }));
    assert.ok(whats(root).some((what) => what === 'no `allowRequest` origin check'));
});

test('a cors option that is not config.corsOrigin is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/gateway/socket.ts': GATEWAY.replace('origin: config.corsOrigin', "origin: '*'") }),
    );
    assert.ok(whats(root).some((what) => what.includes('the `cors` option is not `config.corsOrigin`')));
});

// ─── 4. Handshake auth ───────────────────────────────────────────────────────

test('no verify at all on the handshake is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace('verifyAccessToken(token)', 'token') }));
    assert.ok(whats(root).some((what) => what === 'no jwt.verify() on the handshake'));
});

test('a verify delegated to the REST module is checked in THAT module', (t) => {
    // The gateway calls verifyAccessToken; the secret and the pinned algorithm
    // live in api/src/middleware/auth.ts. Reading the gateway alone would report
    // both as missing from a gateway that is correct.
    assert.deepEqual(whats(tree(t, good())), []);
});

test('a delegated verify with the wrong secret is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/middleware/auth.ts': AUTH.replace('config.jwt.secret', 'process.env.SOCKET_SECRET') }),
    );
    assert.ok(whats(root).some((what) => what.includes('does not verify with `config.jwt.secret`')));
});

test('a delegated verify with no pinned algorithm is reported', (t) => {
    const root = tree(t, good({ 'api/src/middleware/auth.ts': AUTH.replace(", { algorithms: ['HS256'] }", '') }));
    assert.ok(whats(root).some((what) => what.includes('does not pin `algorithms`')));
});

test('the pinned-algorithm finding names the confusion attack', (t) => {
    const root = tree(t, good({ 'api/src/middleware/auth.ts': AUTH.replace(", { algorithms: ['HS256'] }", '') }));
    assert.ok(whys(root).some((why) => why.includes('RS256-to-HS256')));
});

test('an inline jwt.verify is read in the gateway itself', (t) => {
    const inline = GATEWAY.replace(
        "        const userId = verifyAccessToken(token);\n        if (userId === null) return next(new Error('Invalid token'));\n        socket.userId = userId;",
        "        const { sub } = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });\n        socket.userId = sub;",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': inline }));
    assert.deepEqual(whats(root, { authModule: undefined }), []);
});

test('an inline verify with no pinned algorithm is reported', (t) => {
    const inline = GATEWAY.replace(
        "        const userId = verifyAccessToken(token);\n        if (userId === null) return next(new Error('Invalid token'));\n        socket.userId = userId;",
        '        const { sub } = jwt.verify(token, config.jwt.secret);\n        socket.userId = sub;',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': inline }));
    assert.ok(whats(root, { authModule: undefined }).some((what) => what.includes('does not pin `algorithms`')));
});

test('a verify outside any io.use() is reported', (t) => {
    const outside = GATEWAY.replace(
        "    io.use((socket, next) => {\n        const token = socket.handshake.auth?.['token'];",
        "    const early = verifyAccessToken(socket.handshake.auth?.['token']);\n\n    io.use((socket, next) => {\n        const token = socket.handshake.auth?.['token'];",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': outside }));
    assert.ok(whats(root).some((what) => what.includes('not inside an io.use() middleware')));
});

test('a token read from the query string is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                "socket.handshake.auth?.['token']",
                "socket.handshake.query['token']",
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what.includes('not read from `handshake.auth`')));
});

test('the query-string finding names the proxy logs', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                "socket.handshake.auth?.['token']",
                "socket.handshake.query['token']",
            ),
        }),
    );
    assert.ok(whys(root).some((why) => why.includes('proxy and access log')));
});

// ─── 5. The rate limit is the first io.use() ─────────────────────────────────

test('a limiter reached through a helper declared below the verify still counts', (t) => {
    // THE TRAP. The bucket key `rl:ws:conn:` lives in consumeConnectionToken,
    // declared at the bottom of the file — hundreds of bytes AFTER the JWT
    // verify. A rule that located the limit by searching the whole file for the
    // key would report it as running second, in a gateway where it runs first.
    assert.deepEqual(whats(tree(t, good())), []);
});

test('a limiter written inline in the first middleware counts', (t) => {
    const inline = GATEWAY.replace(
        '            if (!(await consumeConnectionToken(clientIp(socket)))) {',
        '            const { allowed } = await consumeTokenBucket(`rl:ws:conn:${clientIp(socket)}`, CONN_BUCKET);\n            if (!allowed) {',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': inline }));
    assert.deepEqual(whats(root), []);
});

test('a first middleware that does no limiting is reported', (t) => {
    const unlimited = GATEWAY.replace(
        "            if (!(await consumeConnectionToken(clientIp(socket)))) {\n                return next(new Error('Too many connection attempts — slow down'));\n            }\n",
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unlimited }));
    assert.ok(whats(root).some((what) => what === 'the first io.use() does not run the connection rate limit'));
});

test('the limiter finding says it looked one level deep', (t) => {
    const unlimited = GATEWAY.replace(
        "            if (!(await consumeConnectionToken(clientIp(socket)))) {\n                return next(new Error('Too many connection attempts — slow down'));\n            }\n",
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unlimited }));
    assert.ok(whys(root).some((why) => why.includes('through a helper declared in this file')));
});

test('only one io.use() is reported', (t) => {
    const one = GATEWAY.replace(
        "    io.use((socket, next) => {\n        const token = socket.handshake.auth?.['token'];\n        if (token === undefined || token === '') return next(new Error('Missing token'));\n        const userId = verifyAccessToken(token);\n        if (userId === null) return next(new Error('Invalid token'));\n        socket.userId = userId;\n        next();\n    });\n\n",
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': one }));
    assert.ok(whats(root).some((what) => what === 'only 1 io.use() middleware'));
});

test('the verify moved into the first middleware is reported', (t) => {
    const merged = GATEWAY.replace(
        '            if (!(await consumeConnectionToken(clientIp(socket)))) {',
        "            const userId = verifyAccessToken(socket.handshake.auth?.['token']);\n            if (!(await consumeConnectionToken(clientIp(socket)))) {",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': merged }));
    assert.ok(whats(root).some((what) => what.includes('ahead of or alongside the rate limit')));
});

test('the ordering finding says the flood otherwise pays for a verify', (t) => {
    const merged = GATEWAY.replace(
        '            if (!(await consumeConnectionToken(clientIp(socket)))) {',
        "            const userId = verifyAccessToken(socket.handshake.auth?.['token']);\n            if (!(await consumeConnectionToken(clientIp(socket)))) {",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': merged }));
    assert.ok(whys(root).some((why) => why.includes('pays for a signature verification')));
});

test('a connection bucket keyed by a constant is reported', (t) => {
    const shared = GATEWAY.replace('`rl:ws:conn:${ip}`', "'rl:ws:conn:all'");
    const root = tree(t, good({ 'api/src/gateway/socket.ts': shared }));
    assert.ok(whats(root).some((what) => what === 'the connection bucket is not keyed per client'));
});

test('the shared-bucket finding says the first flood locks everybody out', (t) => {
    const shared = GATEWAY.replace('`rl:ws:conn:${ip}`', "'rl:ws:conn:all'");
    const root = tree(t, good({ 'api/src/gateway/socket.ts': shared }));
    assert.ok(whys(root).some((why) => why.includes('locks out everybody')));
});

test('missing token-bucket options are reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                'const CONN_BUCKET = { capacity: 10, refillPerMs: 1 / 6_000 };',
                'const CONN_BUCKET = DEFAULTS;',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'no token-bucket options for the connection limit'));
});

// ─── 6. The client IP mirrors the hop count ──────────────────────────────────

test('an unparsed X-Forwarded-For is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                "socket.handshake.headers['x-forwarded-for']",
                'socket.handshake.address',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'X-Forwarded-For is not parsed'));
});

test('the X-Forwarded-For finding says Socket.IO has no trust proxy', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                "socket.handshake.headers['x-forwarded-for']",
                'socket.handshake.address',
            ),
        }),
    );
    assert.ok(whys(root).some((why) => why.includes('it has no such setting')));
});

test('a hop count that is not the config value is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace(/config\.trustProxyHops/g, '1') }));
    assert.ok(whats(root).some((what) => what === 'the hop count is not `config.trustProxyHops`'));
});

test('counting the trusted hop from the left is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                'parts.length - config.trustProxyHops',
                'config.trustProxyHops',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what.includes('not counted from the end')));
});

test('the hop-direction finding says proxies append', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                'parts.length - config.trustProxyHops',
                'config.trustProxyHops',
            ),
        }),
    );
    assert.ok(whys(root).some((why) => why.includes('Proxies append')));
});

// ─── 7. Rooms and emits ──────────────────────────────────────────────────────

test('no personal room joined on connect is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace('void socket.join(`user:${socket.userId}`);', '// no room'),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'no personal room joined on connect'));
});

test('an emit to a non-personal room is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace('io.to(`user:${userId}`)', 'io.to(`broadcast:${userId}`)'),
        }),
    );
    assert.ok(whats(root).some((what) => what.includes('non-personal room `broadcast:${userId}`')));
});

test('a repo addressing rooms through helpers reports a literal room instead', (t) => {
    const literal = GATEWAY.replace('io.to(`user:${userId}`)', "io.to('everyone')");
    const root = tree(t, good({ 'api/src/gateway/socket.ts': literal }));
    assert.ok(
        whats(root, { rooms: { join: 'helpers' } }).some((what) =>
            what.includes("emits to the literal room 'everyone'"),
        ),
    );
});

test('a helper-built room satisfies the helper rule', (t) => {
    const helper = GATEWAY.replace('io.to(`user:${userId}`)', 'io.to(userRoom(userId))');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': helper }));
    assert.deepEqual(whats(root, { rooms: { join: 'helpers' } }), []);
});

test('the helper-room finding says a mismatch is a silent feed', (t) => {
    const literal = GATEWAY.replace('io.to(`user:${userId}`)', "io.to('everyone')");
    const root = tree(t, good({ 'api/src/gateway/socket.ts': literal }));
    assert.ok(whys(root, { rooms: { join: 'helpers' } }).some((why) => why.includes('a silent feed, not an error')));
});

test('a service emitting on a socket directly is reported', (t) => {
    const root = tree(t, good({ 'api/src/services/notify.ts': `${SERVICE}io.to('x').emit('y', {});\n` }));
    assert.ok(whats(root).some((what) => what === 'emits on a socket directly'));
});

test('a service awaiting an emit helper is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/notify.ts': SERVICE.replace(
                'emitNotification(userId, payload);',
                'await emitNotification(userId, payload);',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'awaits emitNotification()'));
});

test('the awaited-emit finding says persist first then emit', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/notify.ts': SERVICE.replace(
                'emitNotification(userId, payload);',
                'await emitNotification(userId, payload);',
            ),
        }),
    );
    assert.ok(whys(root).some((why) => why.includes('persist first, then emit')));
});

test('a gateway with no exported emit helper is reported where helpers are required', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                'export function emitNotification',
                'function emitNotification',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'no exported emit helper'));
});

test('a repo that does not use emit helpers is not graded on them', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': GATEWAY.replace(
                'export function emitNotification',
                'function emitNotification',
            ),
        }),
    );
    assert.deepEqual(whats(root, { emitHelpers: false }), []);
});

// ─── 8. The header contract ──────────────────────────────────────────────────

test('an emitted event missing from the header is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/gateway/socket.ts': `${GATEWAY}export function emitBadge(id) { io.to(\`user:\${id}\`).emit('badge:awarded', {}); }\n`,
        }),
    );
    assert.ok(
        whats(root).some((what) => what.includes('`badge:awarded` is on the wire but not in the header contract')),
    );
});

test('a documented event nothing sends is reported', (t) => {
    const phantom = GATEWAY.replace(' * Client → Server:', ' *     badge:awarded — BadgePayload.\n * Client → Server:');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': phantom }));
    assert.ok(whats(root).some((what) => what.includes('documents `badge:awarded`, which nothing sends or handles')));
});

test('the phantom-event finding calls it a promise the code never made', (t) => {
    const phantom = GATEWAY.replace(' * Client → Server:', ' *     badge:awarded — BadgePayload.\n * Client → Server:');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': phantom }));
    assert.ok(whys(root).some((why) => why.includes('a promise the code never made')));
});

test('an inbound event is held to the contract too', (t) => {
    const inbound = GATEWAY.replace(
        '        void socket.join(`user:${socket.userId}`);',
        "        void socket.join(`user:${socket.userId}`);\n        socket.on('chart:watch', (p) => watchSchema.parse(p));",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': inbound }));
    assert.ok(whats(root).some((what) => what.includes('`chart:watch` is on the wire but not in the header contract')));
});

test('a lifecycle listener is not treated as a contract event', (t) => {
    const lifecycle = GATEWAY.replace(
        '        void socket.join(`user:${socket.userId}`);',
        "        void socket.join(`user:${socket.userId}`);\n        socket.on('disconnect', () => cleanup());",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': lifecycle }));
    assert.deepEqual(whats(root), []);
});

test('a missing Server → Client heading is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace(' * Server → Client:\n', '') }));
    assert.ok(whats(root).some((what) => what.includes('no `Server → Client:` event list')));
});

test('a missing Client → Server heading is reported', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace(' * Client → Server:\n', '') }));
    assert.ok(whats(root).some((what) => what.includes('does not state the `Client → Server:` direction')));
});

test('the empty-direction finding says it is what justifies no per-message limit', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': GATEWAY.replace(' * Client → Server:\n', '') }));
    assert.ok(whys(root).some((why) => why.includes('no per-message rate limit')));
});

test('the contract is read at whatever indent the header uses', (t) => {
    const reindented = GATEWAY.replace(
        ' *     notification:new — NotificationPayload',
        ' *   notification:new — NotificationPayload',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': reindented }));
    assert.deepEqual(whats(root), []);
});

test('a contract documented beside the helper instead of in the file header is reported', (t) => {
    // The same JSDoc shape, one function down. The rule is that the map lives in
    // the FILE header, where someone opening the file finds it — so the header is
    // sliced off and only it is read. Searching the whole file would accept a
    // contract scattered across the helpers it describes.
    const moved = GATEWAY.replace(
        ' *     notification:new — NotificationPayload { _id, type, groupKey, count }.\n',
        '',
    ).replace(
        'export function emitNotification',
        '/**\n * Server → Client:\n *     notification:new — NotificationPayload.\n */\nexport function emitNotification',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': moved }));
    assert.ok(
        whats(root).some((what) => what.includes('`notification:new` is on the wire but not in the header contract')),
    );
});

test('an event named in a line comment does not satisfy the contract', (t) => {
    const moved = GATEWAY.replace(
        ' *     notification:new — NotificationPayload { _id, type, groupKey, count }.\n',
        '',
    ).replace(
        'export function emitNotification',
        '// emits notification:new to the personal room\nexport function emitNotification',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': moved }));
    assert.ok(
        whats(root).some((what) => what.includes('`notification:new` is on the wire but not in the header contract')),
    );
});

// ─── 9. Inbound validation and limiting ──────────────────────────────────────

/** The same gateway, taking one inbound event, documented and limited. */
const INBOUND = GATEWAY.replace(' *     (none — push-only)', ' *     chart:watch — { symbol }.')
    .replace(
        '        void socket.join(`user:${socket.userId}`);',
        "        void socket.join(`user:${socket.userId}`);\n        socket.on('chart:watch', (payload) => void watchChart(socket, payload));",
    )
    .concat(
        '\nasync function watchChart(socket, payload) {\n    const parsed = chartWatchSchema.safeParse(payload);\n    if (!parsed.success) return;\n    const { allowed } = await consumeTokenBucket(`rl:ws:watch:${socket.userId}`, WATCH_BUCKET);\n    if (!allowed) return;\n}\n',
    );

test('an inbound event validated through a schema named after it passes', (t) => {
    const root = tree(t, good({ 'api/src/gateway/socket.ts': INBOUND }));
    assert.deepEqual(whats(root), []);
});

test('the counts pick up the inbound half of the contract', (t) => {
    const { counts } = run(tree(t, good({ 'api/src/gateway/socket.ts': INBOUND })));
    assert.deepEqual(counts, { outbound: 1, inbound: 1, documented: 2 });
});

test('an inbound event validated inline in the listener passes', (t) => {
    const inline = GATEWAY.replace(' *     (none — push-only)', ' *     chart:watch — { symbol }.').replace(
        '        void socket.join(`user:${socket.userId}`);',
        "        void socket.join(`user:${socket.userId}`);\n        socket.on('chart:watch', (payload) => {\n            const parsed = schema.safeParse(payload);\n            if (!parsed.success) return;\n            void consumeTokenBucket(`rl:ws:watch:${socket.userId}`, WATCH_BUCKET);\n        });",
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': inline }));
    assert.deepEqual(whats(root), []);
});

test('an unvalidated inbound event is reported', (t) => {
    const raw = INBOUND.replace(
        '    const parsed = chartWatchSchema.safeParse(payload);\n    if (!parsed.success) return;\n',
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': raw }));
    assert.ok(whats(root).some((what) => what.includes('inbound event `chart:watch` has no Zod parse')));
});

test('the validation finding says the user is known but the bytes are not', (t) => {
    const raw = INBOUND.replace(
        '    const parsed = chartWatchSchema.safeParse(payload);\n    if (!parsed.success) return;\n',
        '',
    );
    const root = tree(t, good({ 'api/src/gateway/socket.ts': raw }));
    assert.ok(whys(root).some((why) => why.includes('the user is known, the bytes are not')));
});

test('inbound events with no per-message bucket are reported', (t) => {
    const unlimited = INBOUND.replace('`rl:ws:watch:${socket.userId}`', '`watch:${socket.userId}`');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unlimited }));
    assert.ok(whats(root).some((what) => what === 'inbound events exist with no per-message rate limit'));
});

test('the connection bucket alone does not satisfy the per-message rule', (t) => {
    const unlimited = INBOUND.replace('`rl:ws:watch:${socket.userId}`', '`rl:ws:conn:${socket.userId}`');
    const root = tree(t, good({ 'api/src/gateway/socket.ts': unlimited }));
    assert.ok(whats(root).some((what) => what === 'inbound events exist with no per-message rate limit'));
});

test('a push-only socket is not asked for a per-message bucket', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

// ─── 10. The frontend half ───────────────────────────────────────────────────

test('a missing client module is reported', (t) => {
    const files = good();
    delete files['frontend/src/api/socket.ts'];
    assert.ok(whats(tree(t, files)).some((what) => what === 'missing'));
});

test('a captured handshake token is reported', (t) => {
    const captured = CLIENT.replace(
        'auth: (cb) => cb({ token: findAccessToken() }),',
        'auth: { token: findAccessToken() },',
    );
    const root = tree(t, good({ 'frontend/src/api/socket.ts': captured }));
    assert.ok(whats(root).some((what) => what.includes('captured, not re-read per attempt')));
});

test('the captured-token finding explains the silent refresh', (t) => {
    const captured = CLIENT.replace(
        'auth: (cb) => cb({ token: findAccessToken() }),',
        'auth: { token: findAccessToken() },',
    );
    const root = tree(t, good({ 'frontend/src/api/socket.ts': captured }));
    assert.ok(whys(root).some((why) => why.includes('reconnect after a silent refresh')));
});

test('a client that reads no access token is reported', (t) => {
    const root = tree(
        t,
        good({ 'frontend/src/api/socket.ts': CLIENT.replace('findAccessToken()', 'localStorage.token') }),
    );
    assert.ok(whats(root).some((what) => what === 'no access token on the handshake'));
});

test('a repo naming its own token accessor is graded on that name', (t) => {
    const renamed = CLIENT.replace(/findAccessToken/g, 'readSessionToken');
    const root = tree(t, good({ 'frontend/src/api/socket.ts': renamed }));
    assert.deepEqual(whats(root, { tokenAccessor: 'readSessionToken' }), []);
});

test('a socket that connects before authentication is reported', (t) => {
    const root = tree(
        t,
        good({ 'frontend/src/api/socket.ts': CLIENT.replace('autoConnect: false,', 'autoConnect: true,') }),
    );
    assert.ok(whats(root).some((what) => what === 'the socket connects before authentication'));
});

test('a missing teardown function is reported', (t) => {
    const root = tree(
        t,
        good({
            'frontend/src/api/socket.ts': CLIENT.replace(
                'export function disconnectSocket',
                'export function dropSocket',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'no disconnectSocket()'));
});

test('a teardown nothing ever calls is reported', (t) => {
    const files = good();
    delete files['frontend/src/api/auth.ts'];
    assert.ok(whats(tree(t, files)).some((what) => what === 'disconnectSocket() is never called'));
});

test('the uncalled-teardown finding names the previous user’s token', (t) => {
    const files = good();
    delete files['frontend/src/api/auth.ts'];
    assert.ok(whys(tree(t, files)).some((why) => why.includes('previous user’s token')));
});

test('a teardown registered with a session hook passes without being exported', (t) => {
    const registered = CLIENT.replace('export function disconnectSocket', 'function disconnectSocket').concat(
        '\nonSessionCleared(disconnectSocket);\n',
    );
    const files = good({ 'frontend/src/api/socket.ts': registered });
    delete files['frontend/src/api/auth.ts'];
    assert.deepEqual(whats(tree(t, files), { sessionTeardown: 'onSessionCleared' }), []);
});

test('a teardown that is not wired to the session hook is reported', (t) => {
    const unwired = CLIENT.replace('export function disconnectSocket', 'function disconnectSocket');
    const files = good({ 'frontend/src/api/socket.ts': unwired });
    delete files['frontend/src/api/auth.ts'];
    assert.ok(
        whats(tree(t, files), { sessionTeardown: 'onSessionCleared' }).some((what) =>
            what.includes('not wired to the session teardown'),
        ),
    );
});

test('the unwired-teardown finding says leaving it to callers means one forgets', (t) => {
    const unwired = CLIENT.replace('export function disconnectSocket', 'function disconnectSocket');
    const files = good({ 'frontend/src/api/socket.ts': unwired });
    delete files['frontend/src/api/auth.ts'];
    assert.ok(
        whys(tree(t, files), { sessionTeardown: 'onSessionCleared' }).some((why) =>
            why.includes('one of them forgets'),
        ),
    );
});

test('a second socket.io-client connection is reported', (t) => {
    const second = "import { io } from 'socket.io-client';\n\nconst admin = io('/admin');\n";
    const root = tree(t, good({ 'frontend/src/api/admin-socket.ts': second }));
    assert.ok(whats(root).some((what) => what === 'opens a second socket.io-client connection'));
});

test('a module that imports socket.io-client for types only is not a second connection', (t) => {
    const types = "import type { Socket } from 'socket.io-client';\n\nexport type Handle = Socket;\n";
    const root = tree(t, good({ 'frontend/src/api/types.ts': types }));
    assert.deepEqual(whats(root), []);
});

test('a second connection in a test file is not graded', (t) => {
    const second = "import { io } from 'socket.io-client';\n\nconst fake = io('/test');\n";
    const root = tree(t, good({ 'frontend/src/api/__tests__/socket.test.ts': second }));
    assert.deepEqual(whats(root), []);
});

// ─── 10b. Listener cleanup ───────────────────────────────────────────────────

test('a listener with no teardown hook is reported', (t) => {
    const leaky = COMPOSABLE.replace(
        /onUnmounted\(\(\) => \{\n {8}socket\.off\('notification:new', onNew\);\n {4}\}\);\n/,
        '',
    );
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': leaky }));
    assert.ok(whats(root).some((what) => what === 'registers a socket listener with no teardown hook'));
});

test('the leak finding says it re-registers on every remount', (t) => {
    const leaky = COMPOSABLE.replace(
        /onUnmounted\(\(\) => \{\n {8}socket\.off\('notification:new', onNew\);\n {4}\}\);\n/,
        '',
    );
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': leaky }));
    assert.ok(whys(root).some((why) => why.includes('re-registers on every remount')));
});

test('onScopeDispose is accepted as the teardown hook', (t) => {
    const scoped = COMPOSABLE.replace(/onUnmounted/g, 'onScopeDispose');
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': scoped }));
    assert.deepEqual(whats(root), []);
});

test('a listener never removed in the teardown is reported', (t) => {
    const partial = COMPOSABLE.replace("socket.off('notification:new', onNew);", '// nothing');
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': partial }));
    assert.ok(whats(root).some((what) => what.includes('listens for `notification:new` but never removes it')));
});

test('an off() before the teardown hook does not satisfy the rule', (t) => {
    const early = COMPOSABLE.replace(
        "    socket.on('notification:new', onNew);",
        "    socket.off('notification:new', onNew);\n    socket.on('notification:new', onNew);",
    ).replace("socket.off('notification:new', onNew);\n    });", '// nothing\n    });');
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': early }));
    assert.ok(whats(root).some((what) => what.includes('never removes it')));
});

test('the client module itself is not graded for listener cleanup', (t) => {
    const listening = CLIENT.replace(
        '    return socket;\n}',
        "    socket.on('connect', () => {});\n    return socket;\n}",
    );
    const root = tree(t, good({ 'frontend/src/api/socket.ts': listening }));
    assert.deepEqual(whats(root), []);
});

test('a listener registered inside a comment is not graded', (t) => {
    const commented = `${COMPOSABLE}// socket.on('badge:awarded', onBadge);\n`;
    const root = tree(t, good({ 'frontend/src/composables/useNotifications.ts': commented }));
    assert.deepEqual(whats(root), []);
});

test('a component file with no listeners is skipped', (t) => {
    const root = tree(t, good({ 'frontend/src/components/Plain.vue': '<template><div /></template>\n' }));
    assert.deepEqual(whats(root), []);
});
