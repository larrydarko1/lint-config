import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

// ─── 10. A dropped field fails loudly outside production ─────────────────────

const LOUD_SEND = `import type { Response } from 'express';
import type { z } from 'zod';

import { droppedKeys } from '@acme/shared';

import { config } from '@/lib/config.js';

export function send<S extends z.ZodType>(res: Response, schema: S, data: z.input<S>): void {
    const parsed = schema.parse(data);
    const dropped = droppedKeys(data, parsed);
    if (dropped.length > 0) {
        if (config.isDev) throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');
        res.req.log.error({ dropped }, 'Response carried undeclared fields');
    }
    res.json(parsed);
}
`;

const loud = (helper = LOUD_SEND) => schemaed({ 'api/src/lib/send.ts': helper });
const withDevFlag = () => withResponses({ devFlag: 'config.isDev' });

test('a helper that fails in development and logs in production reports nothing', (t) => {
    assert.deepEqual(whats(tree(t, loud()), withDevFlag()), []);
});

test('a helper that never compares what its schema dropped is reported', (t) => {
    assert.deepEqual(whats(tree(t, schemaed()), withDevFlag()), [
        'never names the fields its schema dropped (`droppedKeys`)',
    ]);
});

test('a helper that only logs a dropped field, even in development, is reported', (t) => {
    const quiet = LOUD_SEND.replace(
        "        if (config.isDev) throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');\n",
        '',
    );
    assert.deepEqual(whats(tree(t, loud(quiet)), withDevFlag()), [
        'does not fail on a dropped field when `config.isDev` holds',
    ]);
});

test('a throw elsewhere in the helper does not count as failing on a dropped field', (t) => {
    const elsewhere = LOUD_SEND.replace(
        "        if (config.isDev) throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');\n",
        '        if (config.isDev) res.req.log.warn({ dropped }, "dropped");\n',
    ).replace(
        '    const parsed = schema.parse(data);\n',
        "    const parsed = schema.parse(data);\n    if (parsed === undefined) throw new AppError(500, 'INTERNAL', 'No data');\n",
    );
    assert.deepEqual(whats(tree(t, loud(elsewhere)), withDevFlag()), [
        'does not fail on a dropped field when `config.isDev` holds',
    ]);
});

test('a dev branch written as a block still counts', (t) => {
    const block = LOUD_SEND.replace(
        "        if (config.isDev) throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');\n",
        "        if (config.isDev) {\n            throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');\n        }\n",
    );
    assert.deepEqual(whats(tree(t, loud(block)), withDevFlag()), []);
});

test('a helper that never logs a dropped field in production is reported', (t) => {
    const unlogged = LOUD_SEND.replace(
        "        res.req.log.error({ dropped }, 'Response carried undeclared fields');\n",
        '',
    );
    assert.deepEqual(whats(tree(t, loud(unlogged)), withDevFlag()), ['does not log a dropped field at error level']);
});

test('a helper is not graded on dropped fields until a devFlag is stated', (t) => {
    assert.deepEqual(whats(tree(t, schemaed()), withResponses()), []);
});

// ─── 5. The request id comes before the body parser ─────────────────────────

const WITH_REQUEST_ID = INDEX.replace('app.use(cookieParser());', 'app.use(cookieParser());\napp.use(requestId);');
const REQUEST_ID_FIRST = INDEX.replace('app.use(\n    cors({', 'app.use(requestId);\n\napp.use(\n    cors({');

test('a request id registered before the body parser is fine', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': REQUEST_ID_FIRST }));
    assert.deepEqual(whats(root, { requestId: 'requestId' }), []);
});

test('a request id registered after the body parser is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': WITH_REQUEST_ID }));
    assert.deepEqual(whats(root, { requestId: 'requestId' }), ['registers `requestId` after express.json()']);
});

test('a stated request id that is never registered is reported', (t) => {
    assert.deepEqual(whats(tree(t, good()), { requestId: 'requestId' }), ['does not register `requestId` globally']);
});

// ─── 11. One API contract ────────────────────────────────────────────────────

const CONTRACT_VIDEOS = VIDEOS.replace(
    "import { Router } from 'express';",
    "import { Router } from 'express';\n\nimport { createVideoBody, videosQuery } from '@acme/shared';",
)
    .replace('validate({ query: makePaginationQuery() })', 'validate({ query: videosQuery })')
    .replace(
        "router.post('/', requireAuth, async",
        "router.post('/', requireAuth, validate({ body: createVideoBody }), async",
    );

const CONTRACT = `export const API_ROUTES = {
    'GET /api/videos': { query: videosQuery, response: videoPageSchema },
    'POST /api/videos': { body: createVideoBody, response: videoSchema },
    'GET /api/videos/:id': { response: videoSchema },
    'DELETE /api/videos/:id': { response: null },
    'GET /api/channels/:handle': { response: channelSchema },
};
`;

const contracted = (overrides = {}) =>
    good({
        'api/src/routes/videos.ts': CONTRACT_VIDEOS,
        'packages/shared/src/contract.ts': CONTRACT,
        ...overrides,
    });

const CONTRACT_OPTIONS = {
    contract: {
        file: 'packages/shared/src/contract.ts',
        sharedPackage: '@acme/shared',
        caller: { instance: 'api', dir: 'frontend/src' },
    },
};

test('a contract listing exactly the served routes, with shared request schemas, reports nothing', (t) => {
    assert.deepEqual(whats(tree(t, contracted()), CONTRACT_OPTIONS), []);
});

test('a served route missing from the contract is reported', (t) => {
    const root = tree(
        t,
        contracted({ 'packages/shared/src/contract.ts': CONTRACT.replace(/ {4}'DELETE[^\n]*\n/, '') }),
    );
    assert.deepEqual(whats(root, CONTRACT_OPTIONS), [
        'does not list 1 route the routers serve: DELETE /api/videos/:id',
    ]);
});

test('a contract key no router serves is reported', (t) => {
    const stale = CONTRACT.replace('};', "    'GET /api/videos/:id/likes': { response: likesSchema },\n};");
    const root = tree(t, contracted({ 'packages/shared/src/contract.ts': stale }));
    assert.deepEqual(whats(root, CONTRACT_OPTIONS), ['lists 1 route no router serves: GET /api/videos/:id/likes']);
});

test('a missing contract file is reported', (t) => {
    const root = tree(t, contracted());
    fs.rmSync(path.join(root, 'packages/shared/src/contract.ts'));
    assert.deepEqual(whats(root, CONTRACT_OPTIONS), ['missing']);
});

test('a request schema written in the router is reported at its line', (t) => {
    const root = tree(
        t,
        contracted({
            'api/src/routes/videos.ts': VIDEOS.replace(
                "import { Router } from 'express';",
                "import { Router } from 'express';\n\nimport { createVideoBody } from '@acme/shared';",
            ).replace(
                "router.post('/', requireAuth, async",
                "router.post('/', requireAuth, validate({ body: createVideoBody }), async",
            ),
        }),
    );
    const problems = run(root, CONTRACT_OPTIONS).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        ['api/src/routes/videos.ts:14 validates its query with a schema of its own, not one from @acme/shared'],
    );
});

test('a schema the router did not import from the shared package is reported', (t) => {
    const local = CONTRACT_VIDEOS.replace(
        "import { createVideoBody, videosQuery } from '@acme/shared';",
        "import { videosQuery } from '@acme/shared';\nimport { createVideoBody } from '@/lib/schemas.js';",
    );
    const root = tree(t, contracted({ 'api/src/routes/videos.ts': local }));
    assert.deepEqual(whats(root, CONTRACT_OPTIONS), [
        'validates its body with a schema of its own, not one from @acme/shared',
    ]);
});

test('a frontend module calling the axios instance directly is reported; the client and tests may', (t) => {
    const component = `import { api } from '@/api/client';\n\nexport async function load() {\n    return api.get<Video[]>('/videos');\n}\n`;
    const root = tree(
        t,
        contracted({
            'frontend/src/views/Videos.ts': component,
            'frontend/src/views/__tests__/Videos.test.ts': component,
        }),
    );
    const problems = run(root, CONTRACT_OPTIONS).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        ['frontend/src/views/Videos.ts:4 calls `api` directly'],
    );
});

const VALIDATOR = `import { droppedKeys } from '@acme/shared';

export function validate(schemas) {
    return (req, res, next) => {
        const result = schemas.body.safeParse(req.body);
        const unknown = droppedKeys(req.body, result.data);
        if (unknown.length > 0) return res.status(422).json({ error: 'VALIDATION_FAILED' });
        next();
    };
}
`;

const MOCK_SERVER = `import { requestProblems, responseProblems, routeOf } from '@acme/shared';
import { errorProblems } from '@acme/shared';

server.events.on('response:mocked', ({ request, response }) => {
    const route = routeOf(request.method, new URL(request.url).pathname);
    if (response.status >= 400) return problems.push(...errorProblems(body));
    problems.push(...responseProblems(route, response.status, body));
    problems.push(...requestProblems(route, { body: sent }));
});
`;

const TEST_APP = `import { requestProblems, responseProblems } from '@acme/shared';
import { errorProblems } from '@acme/shared';

res.on('finish', () => {
    if (res.statusCode >= 400) return problems.push(...errorProblems(answered));
    problems.push(...responseProblems(key, res.statusCode, answered));
    problems.push(...requestProblems(key, { body: sentBody }));
});
`;

const WIRED = {
    'api/src/middleware/validate.ts': VALIDATOR,
    'frontend/src/__tests__/server.ts': MOCK_SERVER,
    'api/src/__tests__/test-app.ts': TEST_APP,
};

const WIRED_OPTIONS = {
    contract: {
        ...CONTRACT_OPTIONS.contract,
        validator: 'api/src/middleware/validate.ts',
        testChecks: ['frontend/src/__tests__/server.ts', 'api/src/__tests__/test-app.ts'],
    },
};

test('a strict validator and test setups checking against the contract report nothing', (t) => {
    assert.deepEqual(whats(tree(t, contracted(WIRED)), WIRED_OPTIONS), []);
});

test('a validator that lets an unknown key through is reported', (t) => {
    const stripping = `export function validate(schemas) {
    return (req, res, next) => {
        req.body = schemas.body.parse(req.body);
        next();
    };
}
`;
    const root = tree(t, contracted({ ...WIRED, 'api/src/middleware/validate.ts': stripping }));
    assert.deepEqual(whats(root, WIRED_OPTIONS), ['never calls `droppedKeys` from @acme/shared']);
});

test('a validator that imports droppedKeys but never calls it is reported', (t) => {
    const unused = `import { droppedKeys } from '@acme/shared';\n\nexport const validate = (schemas) => schemas;\n`;
    const root = tree(t, contracted({ ...WIRED, 'api/src/middleware/validate.ts': unused }));
    assert.deepEqual(whats(root, WIRED_OPTIONS), ['never calls `droppedKeys` from @acme/shared']);
});

test('a droppedKeys of its own is not the shared one', (t) => {
    const local = VALIDATOR.replace("from '@acme/shared'", "from '@/lib/dropped.js'");
    const root = tree(t, contracted({ ...WIRED, 'api/src/middleware/validate.ts': local }));
    assert.deepEqual(whats(root, WIRED_OPTIONS), ['never calls `droppedKeys` from @acme/shared']);
});

test('a missing validator is reported', (t) => {
    const { 'api/src/middleware/validate.ts': _gone, ...rest } = WIRED;
    assert.deepEqual(whats(tree(t, contracted(rest)), WIRED_OPTIONS), ['missing']);
});

test('a mock server that checks only the responses is reported', (t) => {
    const half = MOCK_SERVER.replace('    problems.push(...requestProblems(route, { body: sent }));\n', '').replace(
        'requestProblems, ',
        '',
    );
    const root = tree(t, contracted({ ...WIRED, 'frontend/src/__tests__/server.ts': half }));
    const problems = run(root, WIRED_OPTIONS).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        ['frontend/src/__tests__/server.ts never calls `requestProblems` from @acme/shared'],
    );
});

test('a test setup that checks nothing names every check', (t) => {
    const root = tree(t, contracted({ ...WIRED, 'api/src/__tests__/test-app.ts': 'export const app = {};\n' }));
    assert.deepEqual(whats(root, WIRED_OPTIONS), [
        'never calls `requestProblems` or `responseProblems` or `errorProblems` from @acme/shared',
    ]);
});

test('a test setup that never checks refusals is reported', (t) => {
    // A mock answering { error: 'MADE_UP' } tests a path no user can reach.
    const successesOnly = TEST_APP.replace(
        '    if (res.statusCode >= 400) return problems.push(...errorProblems(answered));\n',
        '    if (res.statusCode >= 400) return;\n',
    );
    assert.notEqual(successesOnly, TEST_APP);
    const root = tree(t, contracted({ ...WIRED, 'api/src/__tests__/test-app.ts': successesOnly }));
    assert.deepEqual(whats(root, WIRED_OPTIONS), ['never calls `errorProblems` from @acme/shared']);
});

test('a test setup listed but not on disk is reported', (t) => {
    const { 'api/src/__tests__/test-app.ts': _gone, ...rest } = WIRED;
    assert.deepEqual(whats(tree(t, contracted(rest)), WIRED_OPTIONS), ['missing']);
});

test('a repo that states no contract is not graded on it', (t) => {
    assert.deepEqual(whats(tree(t, good())), []);
});

// ─── 11 with handlers. Each route uses what its contract entry names ─────────

const HANDLED_VIDEOS = `/**
 * Videos router — mounted at /api/videos.
 *   GET    /           list videos
 *   POST   /           create a video
 *   GET    /:id        one video
 *   DELETE /:id        remove a video
 */
import { Router } from 'express';

import { createVideoBody, videoPageSchema, videoSchema, videosQuery } from '@acme/shared';

import { idParams } from '@/lib/schemas.js';

export const router = Router();

const listSchema = { query: videosQuery };

router.get(
    '/',
    ...validated(listSchema, async (req, res) => {
        send(res, videoPageSchema, await listVideos(req.query));
    }),
);
router.post(
    '/',
    requireAuth,
    upload.single('file'),
    ...validated({ body: createVideoBody }, async (req, res) => {
        send(res.status(201), videoSchema, await createVideo(req.body));
    }),
);
router.get('/:id', ...validated(idParams, showVideo));
router.delete('/:id', requireAuth, async (req, res) => {
    res.status(204).end();
});

async function showVideo(req, res) {
    send(res, videoSchema, await getVideo(req.params.id));
}
`;

const HANDLED_CHANNELS = CHANNELS.replace(
    '    res.json(await getChannel(req.params.handle));',
    '    send(res, channelSchema, await getChannel(req.params.handle));',
);

const HANDLED_CONTRACT = CONTRACT.replace(
    "'POST /api/videos': { body: createVideoBody, response: videoSchema },",
    "'POST /api/videos': { body: createVideoBody, files: { file: 'one' }, response: videoSchema },",
).replace(
    "'GET /api/videos/:id': { response: videoSchema },",
    "'GET /api/videos/:id': { params: idParam, response: videoSchema },",
);

const HANDLED = {
    'api/src/routes/videos.ts': HANDLED_VIDEOS,
    'api/src/routes/channels.ts': HANDLED_CHANNELS,
    'api/src/lib/schemas.ts': `${SCHEMAS}import { idParam } from '@acme/shared';\n\nexport const idParams = { params: idParam };\n`,
    'packages/shared/src/contract.ts': HANDLED_CONTRACT,
};

const HANDLER_OPTIONS = {
    contract: {
        ...CONTRACT_OPTIONS.contract,
        handlers: { validate: 'validated', send: 'send', objects: ['api/src/lib/schemas.ts'] },
    },
};

/** The handled routers with `old` replaced in `file`. Fails loudly when the anchor is gone. */
const handled = (file, old, replacement) => {
    assert.ok(HANDLED[file].includes(old), `anchor not in ${file}: ${old}`);
    return { ...HANDLED, [file]: HANDLED[file].replace(old, replacement) };
};

const VIDEOS_FILE = 'api/src/routes/videos.ts';

test('routes validating, answering and uploading with what their entries name report nothing', (t) => {
    assert.deepEqual(whats(tree(t, contracted(HANDLED)), HANDLER_OPTIONS), []);
});

test('a route validating its body with another shared schema is reported at its line', (t) => {
    const swapped = handled(VIDEOS_FILE, 'validated({ body: createVideoBody }', 'validated({ body: videosQuery }');
    const problems = run(tree(t, contracted(swapped)), HANDLER_OPTIONS).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        [
            'api/src/routes/videos.ts:24 POST /api/videos validates its body with `videosQuery`, but the contract names `createVideoBody`',
        ],
    );
});

test('a query the contract names but a named validator object leaves out is reported', (t) => {
    const root = tree(
        t,
        contracted(handled(VIDEOS_FILE, 'const listSchema = { query: videosQuery };', 'const listSchema = {};')),
    );
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'GET /api/videos validates no query, but the contract names `videosQuery`',
    ]);
});

test('a body the router validates but the contract does not name is reported', (t) => {
    const root = tree(
        t,
        contracted(
            handled(
                VIDEOS_FILE,
                '...validated(idParams, showVideo)',
                '...validated({ ...idParams, body: createVideoBody }, showVideo)',
            ),
        ),
    );
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'GET /api/videos/:id validates a body with `createVideoBody`, but the contract names none',
    ]);
});

test('a route validating its path with another shared schema than its entry names is reported', (t) => {
    const renamed = HANDLED_CONTRACT.replace(
        '{ params: idParam, response: videoSchema }',
        '{ params: videoIdParam, response: videoSchema }',
    );
    const root = tree(t, contracted({ ...HANDLED, 'packages/shared/src/contract.ts': renamed }));
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'GET /api/videos/:id validates its path parameters with `idParam`, but the contract names `videoIdParam`',
    ]);
});

test('a path rule written in the router is reported, as its own and as not the one its entry names', (t) => {
    const root = tree(
        t,
        contracted(
            handled(
                VIDEOS_FILE,
                '...validated(idParams, showVideo)',
                '...validated({ params: z.object({ id: z.string() }) }, showVideo)',
            ),
        ),
    );
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'validates its path parameters with a schema of its own, not one from @acme/shared',
        'GET /api/videos/:id validates its path parameters with `z.object({id:z.string()})`, but the contract names `idParam`',
    ]);
});

test("a route checking its own path passes with its entry's schema, and is reported with another", (t) => {
    const checked = HANDLED_CONTRACT.replace(
        "'DELETE /api/videos/:id': { response: null },",
        "'DELETE /api/videos/:id': { params: idParam, response: null },",
    );
    for (const [schema, expected] of [
        ['idParam', []],
        ['slugParam', ['DELETE /api/videos/:id validates no path parameters, but the contract names `idParam`']],
    ]) {
        const files = handled(
            VIDEOS_FILE,
            '    res.status(204).end();',
            `    if (!${schema}.safeParse(req.params).success) throw new AppError(400, 'INVALID_PATH');\n    res.status(204).end();`,
        );
        const root = tree(t, contracted({ ...files, 'packages/shared/src/contract.ts': checked }));
        assert.deepEqual(whats(root, HANDLER_OPTIONS), expected);
    }
});

test('a named handler answering with a schema its entry does not name is reported', (t) => {
    const root = tree(
        t,
        contracted(
            handled(VIDEOS_FILE, 'send(res, videoSchema, await getVideo', 'send(res, videoPageSchema, await getVideo'),
        ),
    );
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'GET /api/videos/:id answers with `videoPageSchema`, which its contract entry does not name',
    ]);
});

test('a route answering any of a union its entry names reports nothing', (t) => {
    const union = HANDLED_CONTRACT.replace(
        "'GET /api/videos/:id': { params: idParam, response: videoSchema },",
        "'GET /api/videos/:id': { params: idParam, response: z.union([videoSchema, videoPageSchema]) },",
    );
    const both = handled(
        VIDEOS_FILE,
        '    send(res, videoSchema, await getVideo(req.params.id));',
        '    if (req.query.page) return send(res, videoPageSchema, await listVideos(req.query));\n    send(res, videoSchema, await getVideo(req.params.id));',
    );
    const root = tree(t, contracted({ ...both, 'packages/shared/src/contract.ts': union }));
    assert.deepEqual(whats(root, HANDLER_OPTIONS), []);
});

test('a route the contract says answers with no body but sends one is reported', (t) => {
    const root = tree(
        t,
        contracted(
            handled(
                VIDEOS_FILE,
                '    res.status(204).end();',
                '    send(res, videoSchema, await deleteVideo(req.params.id));',
            ),
        ),
    );
    assert.deepEqual(whats(root, HANDLER_OPTIONS), [
        'DELETE /api/videos/:id answers through `send`, but the contract says it answers with no body',
    ]);
});

test('a route with a response schema that never answers through the helper is reported', (t) => {
    const raw = { ...HANDLED, 'api/src/routes/channels.ts': CHANNELS };
    assert.deepEqual(whats(tree(t, contracted(raw)), HANDLER_OPTIONS), [
        'GET /api/channels/:handle never answers through `send`',
    ]);
});

test('an upload field the contract does not name is reported, by name and by count', (t) => {
    for (const [middleware, taken] of [
        ["upload.single('video')", '`video` (one)'],
        ["upload.array('file', 5)", '`file` (many)'],
        [
            "upload.fields([{ name: 'file', maxCount: 1 }, { name: 'poster', maxCount: 1 }])",
            '`file` (one), `poster` (one)',
        ],
        ['upload.none()', 'none'],
    ]) {
        const root = tree(t, contracted(handled(VIDEOS_FILE, "upload.single('file')", middleware)));
        assert.deepEqual(whats(root, HANDLER_OPTIONS), [
            `POST /api/videos takes the upload fields ${taken}, but the contract names \`file\` (one)`,
        ]);
    }
});

test('a body handed through a spread object is followed', (t) => {
    const spread = handled(VIDEOS_FILE, '...validated({ body: createVideoBody }', '...validated({ ...createParts }');
    spread[VIDEOS_FILE] = spread[VIDEOS_FILE].replace(
        'const listSchema',
        'const createParts = { body: createVideoBody };\nconst listSchema',
    );
    assert.deepEqual(whats(tree(t, contracted(spread)), HANDLER_OPTIONS), []);
});

test('a validator object declared where the gate cannot read it is reported', (t) => {
    const options = { contract: { ...HANDLER_OPTIONS.contract, handlers: { validate: 'validated', send: 'send' } } };
    assert.deepEqual(whats(tree(t, contracted(HANDLED)), options), [
        'hands `validated` `idParams`, which this gate cannot read',
    ]);
});

// ─── 11 with coverage. Every route held to the contract by some test ────────

const RECORDING_MOCK_SERVER = MOCK_SERVER.replace(
    "import { requestProblems, responseProblems, routeOf } from '@acme/shared';",
    "import { inject } from 'vitest';\n\nimport { requestProblems, responseProblems, routeOf } from '@acme/shared';\nimport { recordCheckedRoute } from '@acme/shared/contract-coverage';",
).replace(
    '    problems.push(...requestProblems(route, { body: sent }));\n',
    "    problems.push(...requestProblems(route, { body: sent }));\n    if (response.status < 400) recordCheckedRoute(inject('contractCoverageDir'), route);\n",
);

const RECORDING_TEST_APP = TEST_APP.replace(
    "import { requestProblems, responseProblems } from '@acme/shared';",
    "import { inject } from 'vitest';\n\nimport { requestProblems, responseProblems } from '@acme/shared';\nimport { recordCheckedRoute } from '@acme/shared/contract-coverage';",
).replace(
    '    problems.push(...requestProblems(key, { body: sentBody }));\n',
    "    problems.push(...requestProblems(key, { body: sentBody }));\n    recordCheckedRoute(inject('contractCoverageDir'), key);\n",
);

const COVERAGE_SETUP = `import { openCoverageLog, uncheckedRoutes } from '@acme/shared/contract-coverage';

export function setup(project) {
    const dir = openCoverageLog();
    project.provide('contractCoverageDir', dir);
    return () => {
        const missing = uncheckedRoutes(dir);
        if (missing.length > 0) throw new Error(missing.join('\\n'));
    };
}
`;

const suiteConfig = (setup) => `export default { test: { globalSetup: ['${setup}'] } };\n`;

const COVERED = {
    ...WIRED,
    'frontend/src/__tests__/server.ts': RECORDING_MOCK_SERVER,
    'api/src/__tests__/test-app.ts': RECORDING_TEST_APP,
    'frontend/src/__tests__/contract-coverage.ts': COVERAGE_SETUP,
    'api/src/__tests__/contract-coverage.ts': COVERAGE_SETUP,
    'frontend/vitest.config.ts': suiteConfig('./src/__tests__/contract-coverage.ts'),
    'api/vitest.config.ts': suiteConfig('./src/__tests__/contract-coverage.ts'),
};

const COVERED_OPTIONS = {
    contract: {
        ...WIRED_OPTIONS.contract,
        coverage: {
            module: '@acme/shared/contract-coverage',
            suites: [
                { config: 'frontend/vitest.config.ts', setup: 'frontend/src/__tests__/contract-coverage.ts' },
                { config: 'api/vitest.config.ts', setup: 'api/src/__tests__/contract-coverage.ts' },
            ],
        },
    },
};

const located = (root, options) => run(root, options).problems.map((problem) => `${problem.file} ${problem.what}`);

test('setups that record what they check, and suites that fail on the rest, report nothing', (t) => {
    assert.deepEqual(whats(tree(t, contracted(COVERED)), COVERED_OPTIONS), []);
});

test('a test setup that checks exchanges but records none is reported', (t) => {
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/test-app.ts': TEST_APP }));
    assert.deepEqual(located(root, COVERED_OPTIONS), [
        'api/src/__tests__/test-app.ts never records the routes it checks with `recordCheckedRoute` from @acme/shared/contract-coverage',
    ]);
});

test('importing recordCheckedRoute without calling it records nothing', (t) => {
    const unused = RECORDING_TEST_APP.replace("    recordCheckedRoute(inject('contractCoverageDir'), key);\n", '');
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/test-app.ts': unused }));
    assert.deepEqual(whats(root, COVERED_OPTIONS), [
        'never records the routes it checks with `recordCheckedRoute` from @acme/shared/contract-coverage',
    ]);
});

test('a recorder writing to a log of its own is reported', (t) => {
    const own = RECORDING_TEST_APP.replace("inject('contractCoverageDir')", "'/tmp/routes'");
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/test-app.ts': own }));
    assert.deepEqual(whats(root, COVERED_OPTIONS), ['records the routes it checks into no log the suite provides']);
});

test('a recorder injecting a key its setup never provides is reported', (t) => {
    const renamed = RECORDING_TEST_APP.replace("inject('contractCoverageDir')", "inject('coverageLog')");
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/test-app.ts': renamed }));
    assert.deepEqual(located(root, COVERED_OPTIONS), [
        "api/src/__tests__/contract-coverage.ts never provides `coverageLog`, the log its suite's setups record into",
    ]);
});

test('a recorder in no listed suite is reported', (t) => {
    const options = {
        contract: {
            ...COVERED_OPTIONS.contract,
            coverage: { ...COVERED_OPTIONS.contract.coverage, suites: [COVERED_OPTIONS.contract.coverage.suites[0]] },
        },
    };
    assert.deepEqual(located(tree(t, contracted(COVERED)), options), [
        'api/src/__tests__/test-app.ts records into a log no suite in `contract.coverage.suites` reads',
    ]);
});

test('a global setup that never reads the log back is reported', (t) => {
    const writeOnly = `import { openCoverageLog } from '@acme/shared/contract-coverage';

export function setup(project) {
    project.provide('contractCoverageDir', openCoverageLog());
    return () => {
        throw new Error('unreachable');
    };
}
`;
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/contract-coverage.ts': writeOnly }));
    assert.deepEqual(whats(root, COVERED_OPTIONS), [
        'never calls `uncheckedRoutes` from @acme/shared/contract-coverage',
    ]);
});

test('a global setup that prints the unchecked routes instead of failing is reported', (t) => {
    const printing = COVERAGE_SETUP.replace('throw new Error(missing.join', 'console.warn(missing.join');
    const root = tree(t, contracted({ ...COVERED, 'api/src/__tests__/contract-coverage.ts': printing }));
    assert.deepEqual(whats(root, COVERED_OPTIONS), ['never fails the run on a route nobody checked']);
});

test('a global setup the suite config never registers is reported', (t) => {
    const root = tree(t, contracted({ ...COVERED, 'api/vitest.config.ts': 'export default { test: {} };\n' }));
    assert.deepEqual(located(root, COVERED_OPTIONS), [
        'api/vitest.config.ts does not register `api/src/__tests__/contract-coverage.ts` as a globalSetup',
    ]);
});

test('a registration left in a comment does not count', (t) => {
    const commented =
        "export default {\n    test: {\n        // globalSetup: ['./src/__tests__/contract-coverage.ts'],\n    },\n};\n";
    const root = tree(t, contracted({ ...COVERED, 'api/vitest.config.ts': commented }));
    assert.deepEqual(whats(root, COVERED_OPTIONS), [
        'does not register `api/src/__tests__/contract-coverage.ts` as a globalSetup',
    ]);
});

test('a listed global setup that is not on disk is reported', (t) => {
    const { 'api/src/__tests__/contract-coverage.ts': _gone, ...rest } = COVERED;
    assert.deepEqual(located(tree(t, contracted(rest)), COVERED_OPTIONS), [
        'api/src/__tests__/contract-coverage.ts missing',
    ]);
});

// ─── 11 with fuzz. The fuzz run reads the contract as it is today ────────────

const OPENAPI = `/** Builds the document Schemathesis reads, e.g. 'GET /api/videos' as /api/videos. */
import { API_ROUTES } from '#contract.js';

export function openApiDocument() {
    return { paths: Object.keys(API_ROUTES) };
}
`;

const FUZZ_RUNNER = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { openApiDocument } from '@acme/shared/openapi';

writeFileSync('e2e/fuzz/report/openapi.json', JSON.stringify(openApiDocument()));
spawn('schemathesis', ['--config-file', 'e2e/fuzz/schemathesis.toml', 'run', 'e2e/fuzz/report/openapi.json']);
`;

const FUZZ_CONFIG = `workers = 4

[checks]
# Express answers a method no route takes with 404, not 405.
unsupported_method.enabled = false

# The fuzz user cannot own the video it deletes.
[[operations]]
include-operation-id = [
    # one id per line
    "DELETE /api/videos/:id",
]
checks.positive_data_acceptance.expected-statuses = ["2XX", 404, 422]

# Channels belong to another team's fuzz run.
[[operations]]
include-path-regex = "^/api/channels/"
enabled = false
`;

const FUZZED = {
    'packages/shared/src/openapi.ts': OPENAPI,
    'e2e/fuzz/run.ts': FUZZ_RUNNER,
    'e2e/fuzz/schemathesis.toml': FUZZ_CONFIG,
    'e2e/fuzz/requirements.txt': 'schemathesis==4.29.1\n',
    '.gitignore': '/e2e/fuzz/.venv\n/e2e/fuzz/report\n.schemathesis/\n',
};

const FUZZ_OPTIONS = {
    contract: {
        ...CONTRACT_OPTIONS.contract,
        fuzz: {
            document: { file: 'packages/shared/src/openapi.ts', name: 'openApiDocument' },
            runner: 'e2e/fuzz/run.ts',
            config: 'e2e/fuzz/schemathesis.toml',
            requirements: 'e2e/fuzz/requirements.txt',
            outputs: ['e2e/fuzz/.venv', 'e2e/fuzz/report'],
        },
    },
};

/** A contracted repo with the fuzz run wired, inside a git repository so `.gitignore` can be asked. */
const fuzzed = (t, overrides = {}) => {
    const root = tree(t, contracted({ ...FUZZED, ...overrides }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
};

/** The fuzz config with `old` replaced. Fails loudly when the anchor is gone, so a test never passes on an unchanged file. */
const fuzzConfig = (old, replacement) => {
    assert.ok(FUZZ_CONFIG.includes(old), `anchor not in FUZZ_CONFIG: ${old}`);
    return { 'e2e/fuzz/schemathesis.toml': FUZZ_CONFIG.replace(old, replacement) };
};

test('a fuzz run built from the contract, with a pinned fuzzer and reasoned exceptions, reports nothing', (t) => {
    assert.deepEqual(whats(fuzzed(t), FUZZ_OPTIONS), []);
});

test('a missing document is reported', (t) => {
    const root = fuzzed(t);
    fs.rmSync(path.join(root, 'packages/shared/src/openapi.ts'));
    assert.deepEqual(located(root, FUZZ_OPTIONS), ['packages/shared/src/openapi.ts missing']);
});

test('a document that imports the contract table but never reads it is reported', (t) => {
    const handWritten = OPENAPI.replace('Object.keys(API_ROUTES)', 'PATHS');
    assert.deepEqual(whats(fuzzed(t, { 'packages/shared/src/openapi.ts': handWritten }), FUZZ_OPTIONS), [
        'never reads `API_ROUTES`, the contract table',
    ]);
});

test('a route written into the document is reported where it sits; one in a comment is not', (t) => {
    const extra = OPENAPI.replace('Object.keys(API_ROUTES)', "[...Object.keys(API_ROUTES), 'GET /api/health']");
    assert.deepEqual(located(fuzzed(t, { 'packages/shared/src/openapi.ts': extra }), FUZZ_OPTIONS), [
        "packages/shared/src/openapi.ts:5 names the route 'GET /api/health' itself",
    ]);
});

test('a document that does not export the named builder is reported', (t) => {
    const renamed = OPENAPI.replace('export function openApiDocument', 'export function buildDocument');
    assert.deepEqual(whats(fuzzed(t, { 'packages/shared/src/openapi.ts': renamed }), FUZZ_OPTIONS), [
        'does not export `openApiDocument`',
    ]);
});

test('a runner that reads a document from disk instead of building it is reported', (t) => {
    const stale = FUZZ_RUNNER.replace(
        "writeFileSync('e2e/fuzz/report/openapi.json', JSON.stringify(openApiDocument()));\n",
        '',
    );
    assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/run.ts': stale }), FUZZ_OPTIONS), ['never calls `openApiDocument`']);
});

test('a runner declaring a builder of that name without calling it is reported', (t) => {
    const declared = FUZZ_RUNNER.replace(
        "import { openApiDocument } from '@acme/shared/openapi';\n\nwriteFileSync('e2e/fuzz/report/openapi.json', JSON.stringify(openApiDocument()));\n",
        "function openApiDocument() {\n    return JSON.parse(readFileSync('openapi.json', 'utf8'));\n}\n",
    );
    assert.notEqual(declared, FUZZ_RUNNER);
    assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/run.ts': declared }), FUZZ_OPTIONS), [
        'never calls `openApiDocument`',
    ]);
});

test('a runner that leaves the fuzzer to find its config is reported, a flag in a comment included', (t) => {
    const found = FUZZ_RUNNER.replace("'--config-file', 'e2e/fuzz/schemathesis.toml', ", '');
    const commented = `${found}// spawn('schemathesis', ['--config-file', 'e2e/fuzz/schemathesis.toml']);\n`;
    for (const runner of [found, commented]) {
        assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/run.ts': runner }), FUZZ_OPTIONS), [
            'never hands the fuzzer `e2e/fuzz/schemathesis.toml` with `--config-file`',
        ]);
    }
});

test('a fuzzer pinned to anything but one version is reported', (t) => {
    for (const pin of ['schemathesis>=4.29.1', 'schemathesis', 'schemathesis~=4.29']) {
        assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/requirements.txt': `${pin}\n` }), FUZZ_OPTIONS), [
            `\`${pin}\` is not pinned to one version with \`==\``,
        ]);
    }
    assert.deepEqual(
        whats(fuzzed(t, { 'e2e/fuzz/requirements.txt': 'schemathesis[cli]==4.29.1  # pinned\n' }), FUZZ_OPTIONS),
        [],
    );
});

test('every tool the run installs is pinned, each unpinned line reported where it is', (t) => {
    const requirements = "# the fuzzer\nschemathesis==4.29.1\n\n# the run's storage\nmoto[server]>=5\nwerkzeug\n";
    const problems = run(fuzzed(t, { 'e2e/fuzz/requirements.txt': requirements }), FUZZ_OPTIONS).problems;
    assert.deepEqual(
        problems.map((problem) => `${problem.file} ${problem.what}`),
        [
            'e2e/fuzz/requirements.txt:5 `moto[server]>=5` is not pinned to one version with `==`',
            'e2e/fuzz/requirements.txt:6 `werkzeug` is not pinned to one version with `==`',
        ],
    );
});

test('requirements that never list the fuzzer are reported', (t) => {
    assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/requirements.txt': 'moto[server]==5.2.3\n' }), FUZZ_OPTIONS), [
        'does not list `schemathesis`',
    ]);
});

test('a runner that hands the API every isolated key reports nothing; one it leaves out is reported', (t) => {
    const options = {
        contract: {
            ...FUZZ_OPTIONS.contract,
            fuzz: { ...FUZZ_OPTIONS.contract.fuzz, isolate: ['S3_ENDPOINT', 'REDIS_PORT'] },
        },
    };
    const isolated = FUZZ_RUNNER.replace(
        "spawn('schemathesis'",
        "process.env['REDIS_PORT'] = '6390';\nspawn('api', [], { env: { ...process.env, S3_ENDPOINT: 'http://127.0.0.1:4566' } });\nspawn('schemathesis'",
    );
    assert.notEqual(isolated, FUZZ_RUNNER);
    assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/run.ts': isolated }), options), []);
    // Named only in a comment, or only read, the key is not set.
    const leaky = isolated.replace(
        "process.env['REDIS_PORT'] = '6390';",
        "// REDIS_PORT: the dev one\nconsole.log(process.env['REDIS_PORT']);",
    );
    assert.deepEqual(whats(fuzzed(t, { 'e2e/fuzz/run.ts': leaky }), options), [
        'never sets `REDIS_PORT` for the API it starts',
    ]);
});

test('an operations group with no comment above it is reported at its line', (t) => {
    const root = fuzzed(t, fuzzConfig("# Channels belong to another team's fuzz run.\n", ''));
    assert.deepEqual(located(root, FUZZ_OPTIONS), [
        'e2e/fuzz/schemathesis.toml:15 an `[[operations]]` group with no comment saying why',
    ]);
});

test('a check switched off with no reason is reported; a reason above or on the line is enough', (t) => {
    const bare = fuzzConfig('# Express answers a method no route takes with 404, not 405.\n', '');
    assert.deepEqual(located(fuzzed(t, bare), FUZZ_OPTIONS), [
        'e2e/fuzz/schemathesis.toml:4 switches `checks.unsupported_method.enabled` off with no comment saying why',
    ]);
    const inline = fuzzConfig(
        '# Express answers a method no route takes with 404, not 405.\nunsupported_method.enabled = false\n',
        'unsupported_method.enabled = false  # Express answers 404, not 405\n',
    );
    assert.deepEqual(whats(fuzzed(t, inline), FUZZ_OPTIONS), []);
});

test('a phase switched off is an exception like any other', (t) => {
    const stateful = fuzzConfig('workers = 4\n', 'workers = 4\n\n[phases]\nstateful.enabled = false\n');
    assert.deepEqual(whats(fuzzed(t, stateful), FUZZ_OPTIONS), [
        'switches `phases.stateful.enabled` off with no comment saying why',
    ]);
});

test('the checks the run exists for cannot be switched off, with a reason or in a group', (t) => {
    const cases = [
        [
            'unsupported_method.enabled = false\n',
            'unsupported_method.enabled = false\n# flaky\nnot_a_server_error.enabled = false\n',
        ],
        ['workers = 4\n', 'workers = 4\n\n# noisy\n[checks.response_schema_conformance]\nenabled = false\n'],
        ['"^/api/channels/"\nenabled = false\n', '"^/api/channels/"\nchecks.not_a_server_error.enabled = false\n'],
    ];
    const expected = [
        'switches `checks.not_a_server_error.enabled` off',
        'switches `checks.response_schema_conformance.enabled` off',
        'switches `checks.not_a_server_error.enabled` off',
    ];
    cases.forEach(([old, replacement], i) => {
        assert.deepEqual(whats(fuzzed(t, fuzzConfig(old, replacement)), FUZZ_OPTIONS), [expected[i]]);
    });
});

test('switching every check off at once is switching the core ones off', (t) => {
    const all = fuzzConfig('[checks]\n', '[checks]\n# too slow\nenabled = false\n');
    assert.deepEqual(whats(fuzzed(t, all), FUZZ_OPTIONS), ['switches `checks.enabled` off']);
});

test('an exception expecting a server error is reported, as a number or a class', (t) => {
    for (const status of ['500', '"5XX"']) {
        const root = fuzzed(t, fuzzConfig('["2XX", 404, 422]', `["2XX", 404, 422, ${status}]`));
        assert.deepEqual(located(root, FUZZ_OPTIONS), [
            'e2e/fuzz/schemathesis.toml:13 lets an exception expect a server error',
        ]);
    }
});

test('an exception naming a route the contract does not list is reported', (t) => {
    const cases = [
        [
            '"DELETE /api/videos/:id"',
            '"DELETE /api/videos/:videoId"',
            'names `DELETE /api/videos/:videoId`, which the contract does not list',
        ],
        [
            'include-path-regex = "^/api/channels/"',
            'include-path-regex = "^/api/users/"',
            '`^/api/users/` matches no path the contract lists',
        ],
        [
            'include-path-regex = "^/api/channels/"',
            'include-path = ["/api/channels/{handle}", "/api/channel"]',
            'names the path `/api/channel`, which the contract does not list',
        ],
    ];
    for (const [old, replacement, expected] of cases) {
        assert.deepEqual(whats(fuzzed(t, fuzzConfig(old, replacement)), FUZZ_OPTIONS), [expected]);
    }
});

test('a route in a comment, or a `#` inside a quoted name, is read as TOML reads it', (t) => {
    const commented = fuzzConfig('    # one id per line\n', '    # was "DELETE /api/videos/:videoId"\n');
    assert.deepEqual(whats(fuzzed(t, commented), FUZZ_OPTIONS), []);
    const hashed = fuzzConfig('"DELETE /api/videos/:id"', '"DELETE /api/videos/:id#1"');
    assert.deepEqual(whats(fuzzed(t, hashed), FUZZ_OPTIONS), [
        'names `DELETE /api/videos/:id#1`, which the contract does not list',
    ]);
});

test("a path pattern is read with TOML's escapes resolved", (t) => {
    const escaped = fuzzConfig('"^/api/channels/"', '"^/api/videos\\\\b"');
    assert.deepEqual(whats(fuzzed(t, escaped), FUZZ_OPTIONS), []);
});

test('a path pattern only Python can read is left to the fuzzer', (t) => {
    const python = fuzzConfig('"^/api/channels/"', '"^/api/(?P<area>channels)/"');
    assert.deepEqual(whats(fuzzed(t, python), FUZZ_OPTIONS), []);
});

test('the crash cache and every output must be git-ignored', (t) => {
    const root = fuzzed(t, { '.gitignore': '/e2e/fuzz/.venv\n' });
    assert.deepEqual(located(root, FUZZ_OPTIONS), [
        '.gitignore does not ignore `e2e/fuzz/report`',
        '.gitignore does not ignore `.schemathesis`',
        '.gitignore does not ignore `e2e/fuzz/.schemathesis`',
    ]);
});

test('a directory-only ignore pattern counts', (t) => {
    const root = fuzzed(t, { '.gitignore': 'e2e/fuzz/.venv/\ne2e/fuzz/report/\n.schemathesis/\n' });
    assert.deepEqual(whats(root, FUZZ_OPTIONS), []);
});

test('outside a git repository the ignore rule says it could not ask, rather than passing or failing', (t) => {
    assert.deepEqual(whats(tree(t, contracted(FUZZED)), FUZZ_OPTIONS), [
        'could not ask git whether `e2e/fuzz/.venv` is ignored',
        'could not ask git whether `e2e/fuzz/report` is ignored',
        'could not ask git whether `.schemathesis` is ignored',
        'could not ask git whether `e2e/fuzz/.schemathesis` is ignored',
    ]);
});

test('missing runner, config and requirements are each reported', (t) => {
    const root = fuzzed(t);
    for (const rel of ['e2e/fuzz/run.ts', 'e2e/fuzz/schemathesis.toml', 'e2e/fuzz/requirements.txt']) {
        fs.rmSync(path.join(root, rel));
    }
    assert.deepEqual(located(root, FUZZ_OPTIONS), [
        'e2e/fuzz/run.ts missing',
        'e2e/fuzz/requirements.txt missing',
        'e2e/fuzz/schemathesis.toml missing',
    ]);
});

// ─── 12. One job contract ────────────────────────────────────────────────────

const JOB_REGISTRY = `import { z } from 'zod';

export const JOBS = {
    transcode: { queue: 'transcode', data: z.object({ videoId: z.uuid() }) },
    cleanup: { queue: 'account-cleanup', data: z.object({ userId: z.string() }) },
};
`;

const PRODUCER = `import { Queue } from 'bullmq';

import { JOBS, droppedKeys } from '@acme/shared';

const queues = new Map();

export async function enqueueTranscode(data) {
    await enqueue(JOBS.transcode, 'transcode', data);
}

async function enqueue(entry, name, data) {
    const parsed = entry.data.safeParse(data);
    if (!parsed.success) throw new Error('malformed job');
    if (droppedKeys(data, parsed.data).length > 0) throw new Error('undeclared fields');
    await queueFor(entry.queue).add(name, parsed.data);
}

function queueFor(name) {
    let queue = queues.get(name);
    if (queue === undefined) {
        queue = new Queue(name, { connection });
        queues.set(name, queue);
    }
    return queue;
}
`;

const PROCESSOR = `import { UnrecoverableError } from 'bullmq';

export function jobProcessor(entry, handle) {
    return async (job) => {
        const parsed = entry.data.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('malformed job');
        await handle(parsed.data, job);
    };
}
`;

const WORKER = `import { Queue, Worker } from 'bullmq';

import { JOBS } from '@acme/shared';

import { jobProcessor } from './lib/jobs.js';

const cleanupQueue = new Queue(JOBS.cleanup.queue, { connection });
const transcoder = new Worker(JOBS.transcode.queue, jobProcessor(JOBS.transcode, transcode), { connection });
const cleaner = new Worker(
    JOBS.cleanup.queue,
    jobProcessor(JOBS.cleanup, async ({ userId }) => {
        await cleanup(userId);
    }),
    { connection },
);
`;

const JOB_FILES = {
    'packages/shared/src/jobs.ts': JOB_REGISTRY,
    'api/src/lib/queue.ts': PRODUCER,
    'worker/src/lib/jobs.ts': PROCESSOR,
    'worker/src/index.ts': WORKER,
};

const JOB_OPTIONS = {
    jobs: {
        file: 'packages/shared/src/jobs.ts',
        table: 'JOBS',
        producer: 'api/src/lib/queue.ts',
        processor: { file: 'worker/src/lib/jobs.ts', name: 'jobProcessor' },
        workers: ['worker/src/index.ts'],
    },
};

const jobbed = (overrides = {}) => good({ ...JOB_FILES, ...overrides });

test('jobs parsed on both ends of the queue, named from the registry, report nothing', (t) => {
    assert.deepEqual(whats(tree(t, jobbed()), JOB_OPTIONS), []);
});

test('a missing job registry is reported', (t) => {
    const { 'packages/shared/src/jobs.ts': _gone, ...rest } = JOB_FILES;
    assert.deepEqual(located(tree(t, good(rest)), JOB_OPTIONS), ['packages/shared/src/jobs.ts missing']);
});

test('a registry under another name is reported', (t) => {
    const renamed = JOB_REGISTRY.replace('export const JOBS', 'export const QUEUES');
    const root = tree(t, jobbed({ 'packages/shared/src/jobs.ts': renamed }));
    assert.deepEqual(whats(root, JOB_OPTIONS), ['does not export `JOBS`']);
});

test('a job entry without a data schema is reported', (t) => {
    const bare = JOB_REGISTRY.replace(', data: z.object({ userId: z.string() }) }', ' }');
    const root = tree(t, jobbed({ 'packages/shared/src/jobs.ts': bare }));
    assert.deepEqual(whats(root, JOB_OPTIONS), ['names 2 queues but 1 data schema']);
});

test('a strict job schema is reported, in either spelling', (t) => {
    for (const strict of [
        JOB_REGISTRY.replace('z.object({ videoId: z.uuid() })', 'z.object({ videoId: z.uuid() }).strict()'),
        JOB_REGISTRY.replace('z.object({ videoId: z.uuid() })', 'z.strictObject({ videoId: z.uuid() })'),
    ]) {
        const root = tree(t, jobbed({ 'packages/shared/src/jobs.ts': strict }));
        assert.deepEqual(whats(root, JOB_OPTIONS), ['a job schema refuses fields it does not declare']);
    }
});

test('a producer that queues without parsing is reported', (t) => {
    const unparsed = PRODUCER.replace(
        `    const parsed = entry.data.safeParse(data);
    if (!parsed.success) throw new Error('malformed job');
    if (droppedKeys(data, parsed.data).length > 0) throw new Error('undeclared fields');
    await queueFor(entry.queue).add(name, parsed.data);`,
        '    await queueFor(entry.queue).add(name, data);',
    );
    const root = tree(t, jobbed({ 'api/src/lib/queue.ts': unparsed }));
    assert.deepEqual(whats(root, JOB_OPTIONS), [
        "never parses a job's data before queueing it",
        'never refuses a field the job schema would drop (`droppedKeys`)',
    ]);
});

test('a producer that parses but lets undeclared fields through is reported', (t) => {
    const stripping = PRODUCER.replace(
        "    if (droppedKeys(data, parsed.data).length > 0) throw new Error('undeclared fields');\n",
        '',
    );
    const root = tree(t, jobbed({ 'api/src/lib/queue.ts': stripping }));
    assert.deepEqual(whats(root, JOB_OPTIONS), ['never refuses a field the job schema would drop (`droppedKeys`)']);
});

test('a producer that never reads the registry is reported', (t) => {
    const local = PRODUCER.replace('JOBS.transcode', "{ queue: 'transcode', data: schema }").replace(
        "import { JOBS, droppedKeys } from '@acme/shared';",
        "import { droppedKeys } from '@acme/shared';",
    );
    const root = tree(t, jobbed({ 'api/src/lib/queue.ts': local }));
    assert.deepEqual(whats(root, JOB_OPTIONS), ['never reads `JOBS`']);
});

test('a queue built elsewhere in the API is reported, tests aside', (t) => {
    const sideDoor =
        "import { Queue } from 'bullmq';\n\nconst q = new Queue('transcode', { connection });\nawait q.add('x', {});\n";
    const root = tree(
        t,
        jobbed({
            'api/src/services/reprocess.ts': sideDoor,
            'api/src/lib/__tests__/queue.test.ts': sideDoor,
        }),
    );
    assert.deepEqual(located(root, JOB_OPTIONS), [
        'api/src/services/reprocess.ts:3 builds a queue outside api/src/lib/queue.ts',
    ]);
});

test('a worker that hands its handler the raw job is reported', (t) => {
    const raw = WORKER.replace('jobProcessor(JOBS.transcode, transcode)', 'async (job) => transcode(job.data, job)');
    const root = tree(t, jobbed({ 'worker/src/index.ts': raw }));
    assert.deepEqual(located(root, JOB_OPTIONS), ['worker/src/index.ts:8 runs its jobs without `jobProcessor`']);
});

test('a queue or worker named with a string is reported', (t) => {
    const typed = WORKER.replace('new Queue(JOBS.cleanup.queue', "new Queue('account-cleanup'").replace(
        'new Worker(JOBS.transcode.queue',
        "new Worker('transcode'",
    );
    const root = tree(t, jobbed({ 'worker/src/index.ts': typed }));
    assert.deepEqual(located(root, JOB_OPTIONS), [
        "worker/src/index.ts:7 names its queue `'account-cleanup'` instead of from `JOBS`",
        "worker/src/index.ts:8 names its queue `'transcode'` instead of from `JOBS`",
    ]);
});

test('a processor that never parses, or retries what will not parse, is reported', (t) => {
    const trusting = `export function jobProcessor(entry, handle) {
    return async (job) => {
        await handle(job.data, job);
    };
}
`;
    const retrying = PROCESSOR.replace('new UnrecoverableError(', 'new Error(');
    assert.deepEqual(whats(tree(t, jobbed({ 'worker/src/lib/jobs.ts': trusting })), JOB_OPTIONS), [
        "`jobProcessor` never parses the job's data",
        '`jobProcessor` does not fail a malformed job as unrecoverable',
    ]);
    assert.deepEqual(whats(tree(t, jobbed({ 'worker/src/lib/jobs.ts': retrying })), JOB_OPTIONS), [
        '`jobProcessor` does not fail a malformed job as unrecoverable',
    ]);
});

test('a processor file that does not declare the processor is reported', (t) => {
    const renamed = PROCESSOR.replace('function jobProcessor', 'function parsedJob');
    const root = tree(t, jobbed({ 'worker/src/lib/jobs.ts': renamed }));
    assert.deepEqual(whats(root, JOB_OPTIONS), ['does not declare `jobProcessor`']);
});

test('a listed worker module that is not on disk is reported', (t) => {
    const { 'worker/src/index.ts': _gone, ...rest } = JOB_FILES;
    assert.deepEqual(located(tree(t, good(rest)), JOB_OPTIONS), ['worker/src/index.ts missing']);
});

test('a repo that states no job contract is not graded on it', (t) => {
    assert.deepEqual(whats(tree(t, jobbed())), []);
});
