import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectApiStandards } from '../src/gates/api-standards.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

// ─── Fixtures: an API that satisfies every rule ──────────────────────────────

const VIDEOS = `/**
 * Videos router — mounted at /api/videos.
 *   GET    /           list videos
 *   POST   /           create a video
 *   GET    /:id        one video
 *   DELETE /:id        remove a video
 */
import { Router } from 'express';

export const router = Router();

router.get('/', validate({ query: makePaginationQuery() }), async (req, res) => {
    res.json(await listVideos(req.validatedQuery));
});
router.post('/', requireAuth, async (req, res) => {
    res.status(201).json(await createVideo(req.body));
});
router.get('/:id', async (req, res) => {
    res.json(await getVideo(req.params.id));
});
router.delete('/:id', requireAuth, async (req, res) => {
    res.status(204).end();
});
`;

const CHANNELS = `/**
 * Channels router — mounted at /api/channels.
 *   GET /:handle   one channel
 */
import { Router } from 'express';

export const router = Router();

router.get('/:handle', async (req, res) => {
    res.json(await getChannel(req.params.handle));
});
`;

const INDEX = `import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { config } from '@/lib/config.js';
import { standardLimiter, strictLimiter } from '@/lib/rate-limiters.js';
import { optionalAuth } from '@/middleware/auth.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { router as videosRouter } from '@/routes/videos.js';
import { router as channelsRouter } from '@/routes/channels.js';

const app = express();
const parseJson = express.json({ limit: '1mb' });

app.set('trust proxy', config.trustProxyHops);

app.use(
    helmet({
        frameguard: { action: 'deny' },
    }),
);

app.use(
    cors({
        origin: config.corsOrigin,
        credentials: true,
    }),
);

app.use((req, res, next) => {
    parseJson(req, res, next);
});

app.use(cookieParser());
app.use(optionalAuth);

app.use('/api/videos', standardLimiter, videosRouter);
app.use('/api/channels', strictLimiter, channelsRouter);

app.use(errorHandler);
`;

const TOKEN_BUCKET = `const SCRIPT = \`
local tokens = tonumber(state[1])
\`;

export async function consumeTokenBucket(key, opts, cost = 1) {
    try {
        const res = await getRedis().eval(SCRIPT, 1, key, opts.capacity, opts.refillPerMs, Date.now(), cost);
        return { allowed: res[0] === 1, remaining: res[1], retryAfterMs: res[2] };
    } catch (err) {
        logger.warn({ err, key }, 'Token bucket check failed — allowing (fail-open)');
        return { allowed: true, remaining: 0, retryAfterMs: 0 };
    }
}
`;

const RATE_LIMITERS = `import { consumeTokenBucket } from '@/lib/token-bucket.js';

const tier = (prefix, capacity, windowMs) => {
    const opts = { capacity, refillPerMs: capacity / windowMs };
    return async (req, res, next) => {
        const identity = req.userId ? \`u:\${req.userId}\` : \`ip:\${req.ip}\`;
        const { allowed, remaining, retryAfterMs } = await consumeTokenBucket(\`\${prefix}\${identity}\`, opts);
        res.setHeader('RateLimit-Remaining', String(remaining));
        if (!allowed) {
            res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
            throw new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded');
        }
        next();
    };
};

export const strictLimiter = tier('rl:strict:', 15, 15 * 60 * 1000);
export const standardLimiter = tier('rl:standard:', 100, 60 * 1000);
`;

const SCHEMAS = `import { z } from 'zod';

export const makePaginationQuery = ({ defaultLimit = 24, maxLimit = 100 } = {}) =>
    z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
    });
`;

const CLIENT = `import axios from 'axios';

export const client = axios.create({
    baseURL: '/api',
    withCredentials: true,
});
`;

const PACKAGE_JSON = JSON.stringify({ name: 'api', dependencies: { express: '^5.0.0' } }, null, 2);

const FILES = {
    'api/src/routes/videos.ts': VIDEOS,
    'api/src/routes/channels.ts': CHANNELS,
    'api/src/index.ts': INDEX,
    'api/src/lib/rate-limiters.ts': RATE_LIMITERS,
    'api/src/lib/token-bucket.ts': TOKEN_BUCKET,
    'api/src/lib/schemas.ts': SCHEMAS,
    'api/package.json': PACKAGE_JSON,
    'frontend/src/api/client.ts': CLIENT,
};

const good = (overrides = {}) => ({ ...FILES, ...overrides });

const OPTIONS = {
    routesDir: 'api/src/routes',
    indexFile: 'api/src/index.ts',
    rateLimiters: 'api/src/lib/rate-limiters.ts',
    tokenBucket: 'api/src/lib/token-bucket.ts',
    schemas: 'api/src/lib/schemas.ts',
    apiClient: 'frontend/src/api/client.ts',
    packageJson: 'api/package.json',
    optionalAuth: 'optionalAuth',
};

const run = (root, overrides = {}) => inspectApiStandards({ root, ...OPTIONS, ...overrides });
const whats = (root, overrides) => run(root, overrides).problems.map((problem) => problem.what);
const whys = (root, overrides) => run(root, overrides).problems.map((problem) => problem.why);

// ─── The baseline ────────────────────────────────────────────────────────────

test('an API that satisfies every rule reports nothing', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

test('the counts describe what was walked', (t) => {
    const { counts } = run(tree(t, good()));
    assert.deepEqual(counts, { routes: 5, files: 2, mounts: 2, pending: 0 });
});

test('a router with neither routes nor a route map is skipped rather than failed', (t) => {
    const root = tree(t, good({ 'api/src/routes/helpers.ts': 'export const noop = () => {};\n' }));
    assert.deepEqual(whats(root), []);
});

test('a router file under __tests__ is not graded', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/__tests__/videos.test.ts': "router.get('/undocumented', handler);\n" }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 1. Route documentation parity ───────────────────────────────────────────

test('a route missing from the header is reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/videos.ts': `${VIDEOS}router.patch('/:id', handler);\n` }));
    assert.deepEqual(whats(root), ["1 route not in the file's JSDoc header: PATCH /:id"]);
});

test('several undocumented routes are reported in one finding', (t) => {
    const extra = `${VIDEOS}router.patch('/:id', handler);\nrouter.put('/:id/tags', handler);\n`;
    const root = tree(t, good({ 'api/src/routes/videos.ts': extra }));
    assert.deepEqual(whats(root), ["2 routes not in the file's JSDoc header: PATCH /:id, PUT /:id/tags"]);
});

test('a header documenting a route the file does not declare is reported', (t) => {
    const stale = VIDEOS.replace(
        ' *   GET    /:id        one video\n',
        ' *   GET    /:id        one video\n *   PUT    /:id        replace a video\n',
    );
    const root = tree(t, good({ 'api/src/routes/videos.ts': stale }));
    assert.deepEqual(whats(root), ['the header documents 1 route the file does not declare: PUT /:id']);
});

test('a header written at the mounted path matches a router-relative declaration', (t) => {
    const mounted = CHANNELS.replace(' *   GET /:handle   one channel', ' *   GET /api/channels/:handle   one channel');
    const root = tree(t, good({ 'api/src/routes/channels.ts': mounted }));
    assert.deepEqual(whats(root), []);
});

test('a header written at the mount root matches the router root', (t) => {
    const mounted = VIDEOS.replace(
        ' *   GET    /           list videos',
        ' *   GET    /api/videos           list videos',
    );
    const root = tree(t, good({ 'api/src/routes/videos.ts': mounted }));
    assert.deepEqual(whats(root), []);
});

test('a mount declaration that ends the sentence still strips', (t) => {
    // `\S*` runs to the next space, so "mounted at /api/channels." captured the
    // full stop. The mount then matched no route, every route in the file was
    // reported twice — once undocumented, once phantom — and the finding blamed
    // the routes rather than the punctuation.
    const mounted = CHANNELS.replace(
        ' * Channels router — mounted at /api/channels.',
        ' * Channels router — mounted at /api/channels.',
    ).replace(' *   GET /:handle   one channel', ' *   GET /api/channels/:handle   one channel');
    const root = tree(t, good({ 'api/src/routes/channels.ts': mounted }));
    assert.deepEqual(whats(root), []);
});

test('a mount declaration followed by a parenthetical still strips', (t) => {
    const mounted = CHANNELS.replace(
        ' * Channels router — mounted at /api/channels.',
        ' * Channels router — mounted at /api/channels (all require authentication).',
    ).replace(' *   GET /:handle   one channel', ' *   GET /api/channels/:handle   one channel');
    const root = tree(t, good({ 'api/src/routes/channels.ts': mounted }));
    assert.deepEqual(whats(root), []);
});

test('a commented-out route does not count as declared', (t) => {
    const root = tree(t, good({ 'api/src/routes/videos.ts': `${VIDEOS}// router.patch('/:id', handler);\n` }));
    assert.deepEqual(whats(root), []);
});

test('a route inside a block comment does not count as declared', (t) => {
    // The `//` form never matched anyway — the declaration regex anchors on the
    // line start. A block comment is the shape that DOES put `router.` at column
    // zero, so this is the case that needs the comments blanked.
    const root = tree(t, good({ 'api/src/routes/videos.ts': `${VIDEOS}/*\nrouter.patch('/:id', handler);\n*/\n` }));
    assert.deepEqual(whats(root), []);
});

test('a route declared with the path on the next line is still found', (t) => {
    const wrapped = `${VIDEOS}router.patch(\n    '/:id',\n    handler,\n);\n`;
    const root = tree(t, good({ 'api/src/routes/videos.ts': wrapped }));
    assert.deepEqual(whats(root), ["1 route not in the file's JSDoc header: PATCH /:id"]);
});

test('the parity finding says why a stale map is worse than none', (t) => {
    const root = tree(t, good({ 'api/src/routes/videos.ts': `${VIDEOS}router.patch('/:id', handler);\n` }));
    assert.match(whys(root)[0], /invisible to anyone reading the file top-down/);
});

// ─── 2. Route path shape ─────────────────────────────────────────────────────

for (const verb of ['create', 'update', 'delete', 'remove', 'get', 'list', 'new', 'edit', 'fetch']) {
    test(`the verb segment '${verb}' in a path is reported`, (t) => {
        const root = tree(t, good({ 'api/src/routes/videos.ts': `${VIDEOS}router.post('/${verb}', handler);\n` }));
        assert.ok(whats(root).some((what) => what.includes(`has the verb segment '${verb}'`)));
    });
}

test('a camelCase path segment is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/videos.ts': `${VIDEOS}router.get('/emailVerifications', handler);\n` }),
    );
    assert.ok(whats(root).some((what) => what.includes("non-kebab-case segment 'emailVerifications'")));
});

test('a kebab-case path segment is accepted', (t) => {
    const patched = VIDEOS.replace(
        ' *   GET    /:id        one video',
        ' *   GET    /:id        one video\n *   GET    /email-verifications   list',
    );
    const root = tree(
        t,
        good({ 'api/src/routes/videos.ts': `${patched}router.get('/email-verifications', handler);\n` }),
    );
    assert.deepEqual(whats(root), []);
});

test('a path parameter is not graded as a segment', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

test('a wildcard segment is not graded', (t) => {
    const patched = VIDEOS.replace(
        ' *   GET    /:id        one video',
        ' *   GET    /:id        one video\n *   GET    /*splat   catch-all',
    );
    const root = tree(t, good({ 'api/src/routes/videos.ts': `${patched}router.get('/*splat', handler);\n` }));
    assert.deepEqual(whats(root), []);
});

test('a versioned /api/v1 mount is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace("'/api/videos'", "'/api/v1/videos'") }));
    assert.ok(whats(root).some((what) => what.includes('versioned `/api/v<n>` prefix')));
});

test('a versioned prefix inside a comment is not reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': `// one day this becomes '/api/v2'\n${INDEX}` }));
    assert.deepEqual(whats(root), []);
});

// ─── 3. Routes stay thin ─────────────────────────────────────────────────────

test('a route calling getDb() is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const rows = await getDb().collection('x').find();\n` }),
    );
    assert.ok(whats(root).some((what) => what === 'reaches the database directly'));
});

test('a route calling db.collection() is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const rows = await db.collection('x').find();\n` }),
    );
    assert.ok(whats(root).some((what) => what === 'reaches the database directly'));
});

test('a database call inside a comment is not reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/channels.ts': `${CHANNELS}// was: await getDb().collection('x')\n` }));
    assert.deepEqual(whats(root), []);
});

test('parseInt on req.query is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const limit = parseInt(req.query.limit);\n` }),
    );
    assert.ok(whats(root).some((what) => what.includes('`parseInt(req.query…)`')));
});

test('parseInt on a stringified req.query is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const limit = parseInt(String(req.query.limit));\n` }),
    );
    assert.ok(whats(root).some((what) => what.includes('`parseInt(req.query…)`')));
});

test('the parseInt finding says the schema cap is what gets bypassed', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const limit = parseInt(req.query.limit);\n` }),
    );
    assert.ok(whys(root).some((why) => why.includes('?limit=1000000')));
});

test('parseInt on something that is not req.query is fine', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/channels.ts': `${CHANNELS}const limit = parseInt(req.validatedQuery.limit);\n` }),
    );
    assert.deepEqual(whats(root), []);
});

test('an { ok: true, data } success envelope is reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/channels.ts': `${CHANNELS}res.json({ ok: true, data: channel });\n` }));
    assert.ok(whats(root).some((what) => what.includes('`{ ok: true, data }` envelope')));
});

test('a bare { ok: true } health response is not an envelope', (t) => {
    const root = tree(t, good({ 'api/src/routes/channels.ts': `${CHANNELS}res.json({ ok: true });\n` }));
    assert.deepEqual(whats(root), []);
});

// ─── 4. Middleware order ─────────────────────────────────────────────────────

for (const [what, removal] of [
    ['helmet()', (src) => src.replace(/app\.use\(\n {4}helmet\(\{[\s\S]*?\}\),\n\);\n/, '')],
    ['cors()', (src) => src.replace(/app\.use\(\n {4}cors\(\{[\s\S]*?\}\),\n\);\n/, '')],
    [
        'express.json()',
        (src) =>
            src
                .replace("const parseJson = express.json({ limit: '1mb' });\n", '')
                .replace('app.use((req, res, next) => {\n    parseJson(req, res, next);\n});\n', ''),
    ],
    ['errorHandler', (src) => src.replace('app.use(errorHandler);\n', '')],
]) {
    test(`removing ${what} from the stack is reported`, (t) => {
        const root = tree(t, good({ 'api/src/index.ts': removal(INDEX) }));
        assert.ok(
            whats(root).some((problem) => problem === `no longer registers ${what}`),
            whats(root).join(' | '),
        );
    });
}

test('helmet registered after the first route is reported', (t) => {
    const helmetBlock = "app.use(\n    helmet({\n        frameguard: { action: 'deny' },\n    }),\n);\n";
    const moved = INDEX.replace(helmetBlock, '').replace(
        'app.use(errorHandler);',
        `${helmetBlock}\napp.use(errorHandler);`,
    );
    const root = tree(t, good({ 'api/src/index.ts': moved }));
    assert.ok(whats(root).some((what) => what === 'registers helmet() after the first route'));
});

test('cors registered after express.json() is reported', (t) => {
    const corsBlock =
        'app.use(\n    cors({\n        origin: config.corsOrigin,\n        credentials: true,\n    }),\n);\n';
    const moved = INDEX.replace(corsBlock, '').replace(
        'app.use(cookieParser());',
        `${corsBlock}app.use(cookieParser());`,
    );
    const root = tree(t, good({ 'api/src/index.ts': moved }));
    assert.ok(whats(root).some((what) => what === 'registers cors() after express.json()'));
});

test('the error handler registered before the last mount is reported', (t) => {
    const moved = INDEX.replace('app.use(errorHandler);\n', '').replace(
        "app.use('/api/channels', strictLimiter, channelsRouter);",
        "app.use(errorHandler);\napp.use('/api/channels', strictLimiter, channelsRouter);",
    );
    const root = tree(t, good({ 'api/src/index.ts': moved }));
    assert.ok(whats(root).some((what) => what === 'registers errorHandler before the last route'));
});

test('the error-handler finding names the four-argument signature', (t) => {
    const moved = INDEX.replace('app.use(errorHandler);\n', '').replace(
        "app.use('/api/channels', strictLimiter, channelsRouter);",
        "app.use(errorHandler);\napp.use('/api/channels', strictLimiter, channelsRouter);",
    );
    const root = tree(t, good({ 'api/src/index.ts': moved }));
    assert.ok(whys(root).some((why) => why.includes('4-argument signature')));
});

test('the express.json() alias is resolved to the app.use() that installs it, not the factory call', (t) => {
    // The factory sits at the very top, above cors. Reading THAT as the
    // registration reports a body parser running before the origin check, in a
    // file where it plainly does not.
    assert.deepEqual(whats(tree(t, good())), []);
});

test('express.json() registered inline is still found', (t) => {
    const inline = INDEX.replace("const parseJson = express.json({ limit: '1mb' });\n", '').replace(
        'app.use((req, res, next) => {\n    parseJson(req, res, next);\n});',
        "app.use(express.json({ limit: '1mb' }));",
    );
    const root = tree(t, good({ 'api/src/index.ts': inline }));
    assert.deepEqual(whats(root), []);
});

test('helmet is located by brackets, not by indentation', (t) => {
    const reflowed = INDEX.replace(
        "app.use(\n    helmet({\n        frameguard: { action: 'deny' },\n    }),\n);",
        "app.use(helmet({ frameguard: { action: 'deny' } }));",
    );
    const root = tree(t, good({ 'api/src/index.ts': reflowed }));
    assert.deepEqual(whats(root), []);
});

// ─── 5. optionalAuth before the limiters ─────────────────────────────────────

test('optionalAuth registered after the first rate-limited mount is reported', (t) => {
    const moved = INDEX.replace('app.use(optionalAuth);\n', '').replace(
        'app.use(errorHandler);',
        'app.use(optionalAuth);\napp.use(errorHandler);',
    );
    const root = tree(t, good({ 'api/src/index.ts': moved }));
    assert.ok(whats(root).some((what) => what.includes('after the first rate-limited mount')));
});

test('a missing optionalAuth registration is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace('app.use(optionalAuth);\n', '') }));
    assert.ok(whats(root).some((what) => what.includes('does not register `optionalAuth` globally')));
});

test('the optionalAuth finding explains the silent IP fallback', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace('app.use(optionalAuth);\n', '') }));
    assert.ok(whys(root).some((why) => why.includes('NAT')));
});

test('a repo that states no optionalAuth is not graded on it', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace('app.use(optionalAuth);\n', '') }));
    assert.deepEqual(whats(root, { optionalAuth: undefined }), []);
});

// ─── 6. A rate-limit tier on every mount ─────────────────────────────────────

test('a mount with no tier is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': INDEX.replace(
                "app.use('/api/channels', strictLimiter, channelsRouter);",
                "app.use('/api/channels', channelsRouter);",
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what === "mounts '/api/channels' with no rate-limit tier"));
});

test('the tier finding counts the limited mounts it sits beside', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': INDEX.replace(
                "app.use('/api/channels', strictLimiter, channelsRouter);",
                "app.use('/api/channels', channelsRouter);",
            ),
        }),
    );
    assert.ok(whys(root).some((why) => why.includes('1 limited mount')));
});

test('a tier wrapped in a helper call still counts', (t) => {
    const wrapped = INDEX.replace(
        "app.use('/api/channels', strictLimiter, channelsRouter);",
        "app.use('/api/channels', exceptWebhook(strictLimiter), channelsRouter);",
    );
    const root = tree(t, good({ 'api/src/index.ts': wrapped }));
    assert.deepEqual(whats(root), []);
});

test('a repo with a fourth tier states it and passes', (t) => {
    const withAsset = INDEX.replace(
        "app.use('/api/channels', strictLimiter, channelsRouter);",
        "app.use('/api/channels', assetLimiter, channelsRouter);",
    );
    const root = tree(t, good({ 'api/src/index.ts': withAsset }));
    assert.deepEqual(
        whats(root, { tiers: ['strictLimiter', 'standardLimiter', 'relaxedLimiter', 'assetLimiter'] }),
        [],
    );
});

test('a tier this repo does not declare does not satisfy the rule', (t) => {
    const withAsset = INDEX.replace(
        "app.use('/api/channels', strictLimiter, channelsRouter);",
        "app.use('/api/channels', assetLimiter, channelsRouter);",
    );
    const root = tree(t, good({ 'api/src/index.ts': withAsset }));
    assert.ok(whats(root).some((what) => what === "mounts '/api/channels' with no rate-limit tier"));
});

test('a mount outside the prefix is not graded', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': `${INDEX}app.use('/internal/debug', debugRouter);\n` }));
    assert.deepEqual(whats(root), []);
});

// ─── 7. The token-bucket contract ────────────────────────────────────────────

test('a bucket with no Redis eval() is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/token-bucket.ts': TOKEN_BUCKET.replace('.eval(', '.evaluate(') }));
    assert.ok(whats(root).some((what) => what.includes('no Redis `eval()`')));
});

test('the atomicity finding explains the two-pod race', (t) => {
    const root = tree(t, good({ 'api/src/lib/token-bucket.ts': TOKEN_BUCKET.replace('.eval(', '.evaluate(') }));
    assert.ok(whys(root).some((why) => why.includes('two pods refill the same bucket')));
});

test('a bucket that fails closed is reported', (t) => {
    const closed = TOKEN_BUCKET.replace('return { allowed: true, remaining: 0, retryAfterMs: 0 };', 'throw err;');
    const root = tree(t, good({ 'api/src/lib/token-bucket.ts': closed }));
    assert.ok(whats(root).some((what) => what.includes('no longer fails OPEN')));
});

test('a bucket that returns allowed:true but has no catch is still reported', (t) => {
    // Both halves of the rule matter: a bucket can carry the fail-open VALUE and
    // never reach it, because nothing catches the Redis error in the first place.
    const uncaught = `const OPEN = { allowed: true, remaining: 0, retryAfterMs: 0 };

export async function consumeTokenBucket(key, opts, cost = 1) {
    const res = await getRedis().eval(SCRIPT, 1, key, opts.capacity, Date.now(), cost);
    return { allowed: res[0] === 1, remaining: res[1], retryAfterMs: res[2] };
}
`;
    const root = tree(t, good({ 'api/src/lib/token-bucket.ts': uncaught }));
    assert.ok(whats(root).some((what) => what.includes('no longer fails OPEN')));
});

test('a bucket with a catch but no fail-open value is reported', (t) => {
    const closed = TOKEN_BUCKET.replace(
        'return { allowed: true, remaining: 0, retryAfterMs: 0 };',
        'return { allowed: false };',
    );
    const root = tree(t, good({ 'api/src/lib/token-bucket.ts': closed }));
    assert.ok(whats(root).some((what) => what.includes('no longer fails OPEN')));
});

test('limiters that set no Retry-After are reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/rate-limiters.ts': RATE_LIMITERS.replace("'Retry-After'", "'X-Wait'") }));
    assert.ok(whats(root).some((what) => what.includes('does not set `Retry-After`')));
});

test('the Retry-After finding says the limiter otherwise generates its own load', (t) => {
    const root = tree(t, good({ 'api/src/lib/rate-limiters.ts': RATE_LIMITERS.replace("'Retry-After'", "'X-Wait'") }));
    assert.ok(whys(root).some((why) => why.includes('generates the load it exists to shed')));
});

test('limiters that set no RateLimit-Remaining are reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/rate-limiters.ts': RATE_LIMITERS.replace("'RateLimit-Remaining'", "'Budget'") }),
    );
    assert.ok(whats(root).some((what) => what.includes('does not set `RateLimit-Remaining`')));
});

test('a double-quoted RateLimit-Remaining counts', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/rate-limiters.ts': RATE_LIMITERS.replace("'RateLimit-Remaining'", '"RateLimit-Remaining"'),
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('an X-RateLimit- header is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/rate-limiters.ts': RATE_LIMITERS.replace("'RateLimit-Remaining'", "'X-RateLimit-Remaining'"),
        }),
    );
    assert.ok(whats(root).some((what) => what === 'uses an `X-RateLimit-*` header'));
});

test('an X-RateLimit- header in the bucket is reported too', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/token-bucket.ts': `${TOKEN_BUCKET}// header name: X-RateLimit-Reset\nconst H = 'X-RateLimit-Reset';\n`,
        }),
    );
    assert.ok(whats(root).some((what) => what === 'uses an `X-RateLimit-*` header'));
});

for (const library of ['express-rate-limit', 'rate-limiter-flexible']) {
    test(`importing ${library} is reported`, (t) => {
        const root = tree(t, good({ 'api/src/index.ts': `import rateLimit from '${library}';\n${INDEX}` }));
        assert.ok(whats(root).some((what) => what === `imports \`${library}\``));
    });

    test(`depending on ${library} is reported`, (t) => {
        const manifest = JSON.stringify({ name: 'api', dependencies: { [library]: '^7.0.0' } }, null, 2);
        const root = tree(t, good({ 'api/package.json': manifest }));
        assert.ok(whats(root).some((what) => what === `depends on \`${library}\``));
    });

    test(`${library} as a devDependency is reported too`, (t) => {
        const manifest = JSON.stringify({ name: 'api', devDependencies: { [library]: '^7.0.0' } }, null, 2);
        const root = tree(t, good({ 'api/package.json': manifest }));
        assert.ok(whats(root).some((what) => what === `depends on \`${library}\``));
    });
}

test('the fixed-window finding names the boundary burst', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': `import rateLimit from 'express-rate-limit';\n${INDEX}` }));
    assert.ok(whys(root).some((why) => why.includes('2× the limit across a window boundary')));
});

test('a repo that states no package.json is not graded on its dependencies', (t) => {
    const manifest = JSON.stringify({ name: 'api', dependencies: { 'express-rate-limit': '^7.0.0' } }, null, 2);
    const root = tree(t, good({ 'api/package.json': manifest }));
    assert.deepEqual(whats(root, { packageJson: undefined }), []);
});

test('a fixed-window library named only in a comment is not reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': `// deliberately NOT from 'express-rate-limit'\n${INDEX}` }));
    assert.deepEqual(whats(root), []);
});

// ─── 8. The pagination cap ───────────────────────────────────────────────────

test('a missing makePaginationQuery factory is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/schemas.ts': 'export const mongoId = z.string();\n' }));
    assert.ok(whats(root).some((what) => what === 'no `makePaginationQuery` factory'));
});

test('an uncapped limit is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/schemas.ts': SCHEMAS.replace('.max(maxLimit)', '') }));
    assert.ok(whats(root).some((what) => what.includes('not capped by `maxLimit`')));
});

test('the cap finding names it a denial-of-service parameter', (t) => {
    const root = tree(t, good({ 'api/src/lib/schemas.ts': SCHEMAS.replace('.max(maxLimit)', '') }));
    assert.ok(whys(root).some((why) => why.includes('denial-of-service parameter with a friendly name')));
});

test('a cap written with whitespace after the paren still counts', (t) => {
    const reflowed = SCHEMAS.replace('.max(maxLimit)', '.max(\n            maxLimit,\n        )');
    const root = tree(t, good({ 'api/src/lib/schemas.ts': reflowed }));
    assert.deepEqual(whats(root), []);
});

test('a page with no min(1) is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/schemas.ts': SCHEMAS.replace(/\.min\(1\)/g, '') }));
    assert.ok(whats(root).some((what) => what.includes('no `min(1)`')));
});

test('the min(1) finding explains the negative skip', (t) => {
    const root = tree(t, good({ 'api/src/lib/schemas.ts': SCHEMAS.replace(/\.min\(1\)/g, '') }));
    assert.ok(whys(root).some((why) => why.includes('negative `skip`')));
});

// ─── 9. CORS and credentials, both halves ────────────────────────────────────

test('a literal CORS origin is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/index.ts': INDEX.replace('origin: config.corsOrigin', "origin: 'https://example.com'") }),
    );
    assert.ok(whats(root).some((what) => what.includes('cors() origin is not `config.corsOrigin`')));
});

test('a missing credentials: true is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace('        credentials: true,\n', '') }));
    assert.ok(whats(root).some((what) => what.includes('missing `credentials: true`')));
});

test('the credentials finding explains the silent session expiry', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': INDEX.replace('        credentials: true,\n', '') }));
    assert.ok(whys(root).some((why) => why.includes('silently ends at access-token expiry')));
});

test('a client missing withCredentials is reported', (t) => {
    const root = tree(t, good({ 'frontend/src/api/client.ts': CLIENT.replace('    withCredentials: true,\n', '') }));
    assert.ok(whats(root).some((what) => what.includes('missing `withCredentials: true`')));
});

test('a missing client module is reported', (t) => {
    const files = good();
    delete files['frontend/src/api/client.ts'];
    assert.ok(whats(tree(t, files)).some((what) => what === 'missing'));
});

test('a repo with no frontend is not graded on the client half', (t) => {
    const files = good();
    delete files['frontend/src/api/client.ts'];
    assert.deepEqual(whats(tree(t, files), { apiClient: undefined }), []);
});

test('a per-call withCredentials does not answer for the shared instance', (t) => {
    // Both real clients pass `{ withCredentials: true }` on the one refresh call
    // that needs it explicitly. A file-wide search finds that and passes — while
    // every other request in the app has quietly stopped sending the cookie.
    const perCall = CLIENT.replace('    withCredentials: true,\n', '').concat(
        "\nexport const refresh = () => client.post('/auth/refresh', null, { withCredentials: true });\n",
    );
    const root = tree(t, good({ 'frontend/src/api/client.ts': perCall }));
    assert.ok(whats(root).some((what) => what === 'the shared HTTP client is missing `withCredentials: true`'));
});

test('a client built by something the repo has not named is reported', (t) => {
    const custom = "export const client = makeHttpClient({ baseURL: '/api', withCredentials: true });\n";
    const root = tree(t, good({ 'frontend/src/api/client.ts': custom }));
    assert.ok(whats(root).some((what) => what.includes('does not construct the shared client')));
});

test('a repo naming its own client factory is graded through it', (t) => {
    const custom = "export const client = makeHttpClient({ baseURL: '/api', withCredentials: true });\n";
    const root = tree(t, good({ 'frontend/src/api/client.ts': custom }));
    assert.deepEqual(whats(root, { clientFactory: 'makeHttpClient(' }), []);
});

test('withCredentials inside a comment does not satisfy the rule', (t) => {
    const root = tree(
        t,
        good({
            'frontend/src/api/client.ts': CLIENT.replace(
                '    withCredentials: true,\n',
                '    // withCredentials: true,\n',
            ),
        }),
    );
    assert.ok(whats(root).some((what) => what.includes('missing `withCredentials: true`')));
});

// ─── 10. Responses go through a schema ───────────────────────────────────────

const SEND = `import type { Response } from 'express';
import type { z } from 'zod';

export function send<S extends z.ZodType>(res: Response, schema: S, data: z.input<S>): void {
    res.json(schema.parse(data));
}
`;

const RESPONSE_SCHEMAS = `import { z } from 'zod';

export const videoSchema = z.object({
    videoId: z.string(),
    title: z.string(),
    captionJobs: z.record(z.string(), z.object({ status: z.enum(['queued', 'failed']) })).optional(),
});
`;

const SCHEMAED_VIDEOS = VIDEOS.replaceAll(/res(\.status\(201\))?\.json\(([^;]*)\);/g, 'send(res$1, videoSchema, $2);');
const SCHEMAED_CHANNELS = CHANNELS.replace(
    'res.json(await getChannel(req.params.handle));',
    'send(res, channelSchema, await getChannel(req.params.handle));',
);

const schemaed = (overrides = {}) =>
    good({
        'api/src/routes/videos.ts': SCHEMAED_VIDEOS,
        'api/src/routes/channels.ts': SCHEMAED_CHANNELS,
        'api/src/lib/send.ts': SEND,
        'packages/shared/src/schemas/media.ts': RESPONSE_SCHEMAS,
        ...overrides,
    });

const RESPONSES = { helper: 'api/src/lib/send.ts', schemasDir: 'packages/shared/src/schemas' };
const withResponses = (extra = {}) => ({ responses: { ...RESPONSES, ...extra } });

test('routes answering through the schema helper report nothing', (t) => {
    assert.deepEqual(whats(tree(t, schemaed()), withResponses()), []);
});

test('a repo that states no responses is not graded on them', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

test('a raw res.json is reported at its line', (t) => {
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': CHANNELS }));
    const problems = run(root, withResponses()).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        ['api/src/routes/channels.ts:10 sends a response without its schema'],
    );
});

test('a raw res.status(201).json is reported', (t) => {
    const raw = SCHEMAED_VIDEOS.replace(
        'send(res.status(201), videoSchema, await createVideo(req.body));',
        'res.status(201).json(await createVideo(req.body));',
    );
    const root = tree(t, schemaed({ 'api/src/routes/videos.ts': raw }));
    assert.deepEqual(whats(root, withResponses()), ['sends a response without its schema']);
});

test('a res chain split over lines is still found', (t) => {
    const raw = `${SCHEMAED_CHANNELS}res\n    .status(200)\n    .json(channel);\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': raw }));
    assert.deepEqual(whats(root, withResponses()), ['sends a response without its schema']);
});

test('res.send and res.end with a payload are raw too', (t) => {
    const raw = `${SCHEMAED_CHANNELS}res.send(channel);\nres.end(JSON.stringify(channel));\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': raw }));
    assert.equal(whats(root, withResponses()).length, 2);
});

test('an empty res.status(204).end() sends nothing and is fine', (t) => {
    assert.ok(SCHEMAED_VIDEOS.includes('res.status(204).end();'));
    assert.deepEqual(whats(tree(t, schemaed()), withResponses()), []);
});

test('an error body is exempt: it carries a code, never data', (t) => {
    const errors = `${SCHEMAED_CHANNELS}res.status(502).json({ error: 'STORAGE_UNAVAILABLE' });\nres.status(422).json({\n    error: 'VALIDATION_FAILED',\n    errors,\n});\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': errors }));
    assert.deepEqual(whats(root, withResponses()), []);
});

test('a body with error beside data is not an error body', (t) => {
    const raw = `${SCHEMAED_CHANNELS}res.json({ channel, error: null });\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': raw }));
    assert.deepEqual(whats(root, withResponses()), ['sends a response without its schema']);
});

test('.json() on something other than res is not a response', (t) => {
    const other = `${SCHEMAED_CHANNELS}const body = await upstream.json();\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': other }));
    assert.deepEqual(whats(root, withResponses()), []);
});

test('a raw response inside a comment is not reported', (t) => {
    const commented = `${SCHEMAED_CHANNELS}// res.json(channel);\n`;
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': commented }));
    assert.deepEqual(whats(root, withResponses()), []);
});

test('a pending file may still answer raw', (t) => {
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': CHANNELS }));
    const pending = { 'api/src/routes/channels.ts': 'not migrated yet' };
    assert.deepEqual(whats(root, withResponses({ pending })), []);
});

test('a pending file with no raw response left must leave the list', (t) => {
    const pending = { 'api/src/routes/channels.ts': 'not migrated yet' };
    assert.deepEqual(whats(tree(t, schemaed()), withResponses({ pending })), [
        'answers through the schema helper now, but is still in `responses.pending`',
    ]);
});

test('a pending entry naming no route file is reported', (t) => {
    const pending = { 'api/src/routes/gone.ts': 'deleted since' };
    assert.deepEqual(whats(tree(t, schemaed()), withResponses({ pending })), [
        'is in `responses.pending` but is not a route file',
    ]);
});

test('the counts include the pending files', (t) => {
    const root = tree(t, schemaed({ 'api/src/routes/channels.ts': CHANNELS }));
    const pending = { 'api/src/routes/channels.ts': 'not migrated yet' };
    assert.equal(run(root, withResponses({ pending })).counts.pending, 1);
});

test('a missing helper is reported', (t) => {
    const root = tree(t, schemaed());
    fs.rmSync(path.join(root, 'api/src/lib/send.ts'));
    assert.deepEqual(whats(root, withResponses()), ['missing']);
});

test('a helper that never parses is reported', (t) => {
    const lazy = SEND.replace('res.json(schema.parse(data));', 'res.json(data);');
    const root = tree(t, schemaed({ 'api/src/lib/send.ts': lazy }));
    assert.deepEqual(whats(root, withResponses()), ['never parses the data with a schema']);
});

test('a helper using safeParse counts as parsing', (t) => {
    const safe = SEND.replace('res.json(schema.parse(data));', 'res.json(schema.safeParse(data).data);');
    const root = tree(t, schemaed({ 'api/src/lib/send.ts': safe }));
    assert.deepEqual(whats(root, withResponses()), []);
});

for (const [name, loose] of [
    ['`z.looseObject()`', 'z.looseObject({ id: z.string() })'],
    ['`.passthrough()`', 'z.object({ id: z.string() }).passthrough()'],
    ['`.loose()`', 'z.object({ id: z.string() }).loose()'],
    ['`.catchall()`', 'z.object({ id: z.string() }).catchall(z.string())'],
    ['`z.any()`', 'z.object({ extra: z.any() })'],
    ['`z.unknown()`', 'z.object({ extra: z.unknown() })'],
    ['`z.json()`', 'z.object({ extra: z.json() })'],
    ['`z.custom()`', 'z.object({ extra: z.custom() })'],
]) {
    test(`a response schema using ${name} is reported`, (t) => {
        const schemas = `${RESPONSE_SCHEMAS}export const looseSchema = ${loose};\n`;
        const root = tree(t, schemaed({ 'packages/shared/src/schemas/media.ts': schemas }));
        assert.ok(whats(root, withResponses()).includes(`a response schema uses ${name}`));
    });
}

test('a record of strings is reported', (t) => {
    const schemas = `${RESPONSE_SCHEMAS}export const bagSchema = z.record(z.string(), z.string());\n`;
    const root = tree(t, schemaed({ 'packages/shared/src/schemas/media.ts': schemas }));
    assert.deepEqual(whats(root, withResponses()), ['a response schema uses a record of strings']);
});

test('a record of numbers or objects is fine', (t) => {
    const schemas = `${RESPONSE_SCHEMAS}export const countsSchema = z.record(z.string(), z.number());\n`;
    const root = tree(t, schemaed({ 'packages/shared/src/schemas/media.ts': schemas }));
    assert.deepEqual(whats(root, withResponses()), []);
});

test('a loose schema inside a comment is not reported', (t) => {
    const schemas = `${RESPONSE_SCHEMAS}// z.looseObject({}) would let anything through\n`;
    const root = tree(t, schemaed({ 'packages/shared/src/schemas/media.ts': schemas }));
    assert.deepEqual(whats(root, withResponses()), []);
});
