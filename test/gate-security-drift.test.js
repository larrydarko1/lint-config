import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectSecurityDrift } from '../src/gates/security-drift.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

// ─── Fixtures: a repo that passes every rule ─────────────────────────────────

const ENTRY = `import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from '@/lib/config.js';

const app = express();

app.set('trust proxy', config.trustProxyHops);

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
            },
        },
        frameguard: { action: 'deny' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        noSniff: true,
        strictTransportSecurity: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: false,
        },
    }),
);
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    next();
});
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRouter);
app.use('/api/media', requireAuth, mediaRouter);

const server = app.listen(config.port);
server.headersTimeout = 60_000;
server.requestTimeout = 5 * 60_000;
`;

const CONFIG = `import argon2 from 'argon2';
import { z } from 'zod';

const Env = z.object({
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),
});

export const config = {
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    passwordResetTokenExpiry: 60 * 60 * 1000,
    argon2: {
        type: argon2.argon2id,
        memoryCost: 64 * 1024,
        timeCost: 3,
        parallelism: 4,
    },
} as const;
`;

const ENV = `export const DEV_PLACEHOLDERS = ['dev_secret', 'change', 'replace-me', 'your-'];

export const requiredSecret = (min: number) =>
    z.string().min(min).refine((v) => !isProd() || !DEV_PLACEHOLDERS.some((p) => v.includes(p)));
`;

const COOKIE = `const REFRESH_COOKIE_PATH = '/api/auth';

function setRefreshCookie(res: Response, token: string): void {
    res.cookie('refresh', token, {
        httpOnly: true,
        secure: config.isProd,
        sameSite: 'strict',
        path: REFRESH_COOKIE_PATH,
    });
}
`;

const TOKENS = `import crypto from 'node:crypto';
import argon2 from 'argon2';

const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export async function issueRefreshToken(userId: string, opts: { expiresAt: Date }): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await tokens.insertOne({ userId, tokenHash, expiresAt: opts.expiresAt });
    return rawToken;
}

export async function loginUser(email: string, password: string): Promise<Session> {
    const emailIndex = emailBlindIndex(email);
    await assertLoginAllowed(emailIndex);

    const user = await users.findOne({ emailIndex });
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password);
    if (user === null || !ok) {
        await recordLoginFailure(emailIndex);
        throw new AppError(401, 'INVALID_CREDENTIALS');
    }
    await clearLoginFailures(emailIndex);
    return session(user);
}

export async function rotateRefreshToken(rawToken: string): Promise<Session> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = await tokens.findOneAndUpdate(
        { tokenHash, usedAt: { $exists: false } },
        { $set: { usedAt: new Date() } },
    );
    if (record === null) {
        const used = await tokens.findOne({ tokenHash });
        await tokens.deleteMany({ familyId: used?.familyId });
        throw new AppError(401, 'TOKEN_REUSE');
    }
    return issueRefreshToken(record.userId, { expiresAt: record.expiresAt });
}
`;

const THROTTLE = `export async function assertLoginAllowed(key: string): Promise<void> {
    try {
        const count = await redis.get(\`login:\${key}\`);
        if (Number(count) > 10) throw new AppError(429, 'TOO_MANY_ATTEMPTS');
    } catch (error) {
        logger.warn({ error }, 'login throttle unavailable — allowing');
    }
}

export async function recordLoginFailure(key: string): Promise<number> {
    try {
        return await redis.incr(\`login:\${key}\`);
    } catch (error) {
        logger.warn({ error }, 'login throttle unavailable');
        return 0;
    }
}

export async function clearLoginFailures(key: string): Promise<void> {
    try {
        await redis.del(\`login:\${key}\`);
    } catch (error) {
        logger.warn({ error }, 'login throttle unavailable');
    }
}
`;

const SCHEMAS = `export const passwordSchema = z.string().superRefine((value, ctx) => {
    if (value.length < 8) ctx.addIssue({ message: 'too short' });
    if (value.length > 128) ctx.addIssue({ message: 'too long' });
    if (!/[A-Z]/.test(value)) ctx.addIssue({ message: 'needs an uppercase letter' });
    if (!/[a-z]/.test(value)) ctx.addIssue({ message: 'needs a lowercase letter' });
    if (!/[0-9]/.test(value)) ctx.addIssue({ message: 'needs a digit' });
    if (!/[^A-Za-z0-9]/.test(value)) ctx.addIssue({ message: 'needs a symbol' });
});
`;

const SANITIZER = `const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
    const sent = req.body;
    req.body = stripUnsafeKeys(req.body);
    stripUnsafeKeysInPlace(req.query);
    if (droppedKeys(sent, req.body).length > 0) {
        next(new AppError(422, 'VALIDATION_FAILED', 'Request carried an operator key', { securityEvent: true }));
        return;
    }
    next();
}

function isUnsafeKey(key: string): boolean {
    return key.startsWith('$') || key.includes('.') || POLLUTION_KEYS.has(key);
}
`;

const SERVICE = `import { assertLoginAllowed } from '@/services/auth/login-throttle.js';

export async function startTotp(userId: string): Promise<void> {
    const throttleKey = \`2fa:\${userId}\`;
    await assertLoginAllowed(throttleKey);
}
`;

const APP_VUE = `<template><p>{{ message }}</p></template>
<script setup lang="ts">
const message = 'hello';
</script>
`;

const HELPERS = `export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}
`;

const RESET = `export async function forgotPassword(email: string): Promise<void> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    await resets.insertOne({ tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex') });
}

export async function resetPassword(token: string, password: string): Promise<void> {
    await resets.deleteOne({ tokenHash: sha256(token) });
    await revokeAllUserTokens(userId);
}
`;

const NGINX = `server {
    location / {
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header Referrer-Policy strict-origin-when-cross-origin;
        add_header Permissions-Policy "camera=()";
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
    }

    location /api/ {
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header Referrer-Policy strict-origin-when-cross-origin;
        add_header Permissions-Policy "camera=()";
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
        proxy_pass http://api:3001;
    }
}
`;

const TLS_OPTION = `apiVersion: traefik.io/v1alpha1
kind: TLSOption
metadata:
  name: app-tls
spec:
  minVersion: VersionTLS12
`;

const INGRESS = `apiVersion: traefik.io/v1alpha1
kind: IngressRoute
spec:
  tls:
    options:
      name: app-tls
`;

const LOGOS = `const SVG_SANDBOX = "default-src 'none'; sandbox";

const params = z.object({
    exchange: z.string().regex(/^[a-z]{2,10}$/),
    file: z.string().regex(/^[a-z0-9-]+\\.svg$/),
});

router.get('/:exchange/:file', (req, res) => {
    if (!isSameOrigin(req)) return res.status(403).end();
    res.setHeader('Content-Security-Policy', SVG_SANDBOX);
    res.sendFile(name, { root: config.logos.dir, dotfiles: 'deny' });
});
`;

const FILES = {
    'api/src/index.ts': ENTRY,
    'api/src/lib/config.ts': CONFIG,
    'api/src/lib/schemas.ts': SCHEMAS,
    'api/src/lib/helpers.ts': HELPERS,
    'api/src/middleware/sanitizer.ts': SANITIZER,
    'api/src/routes/identity/auth.ts': COOKIE,
    'api/src/services/auth/auth-tokens.ts': TOKENS,
    'api/src/services/auth/auth-totp.ts': SERVICE,
    'api/src/services/auth/auth-verification.ts': RESET,
    'api/src/services/auth/login-throttle.ts': THROTTLE,
    'packages/shared/src/config/env.ts': ENV,
    'frontend/src/App.vue': APP_VUE,
    'docker/nginx.conf': NGINX,
    'k8s/traefik/tls-option.yaml': TLS_OPTION,
    'k8s/traefik/ingress.yaml': INGRESS,
};

const good = (overrides = {}) => ({ ...FILES, ...overrides });

const OPTIONS = {
    entry: 'api/src/index.ts',
    config: 'api/src/lib/config.ts',
    envModule: 'packages/shared/src/config/env.ts',
    backendDirs: ['api/src'],
    frontendDirs: ['frontend/src'],
    auth: {
        cookieFile: 'api/src/routes/identity/auth.ts',
        tokensFile: 'api/src/services/auth/auth-tokens.ts',
        throttleFile: 'api/src/services/auth/login-throttle.ts',
        schemasFile: 'api/src/lib/schemas.ts',
        sanitizer: { file: 'api/src/middleware/sanitizer.ts', fn: 'sanitizeRequest' },
        escapeHtmlFile: 'api/src/lib/helpers.ts',
        passwordReset: { file: 'api/src/services/auth/auth-verification.ts', ttlKey: 'passwordResetTokenExpiry' },
    },
    nginx: 'docker/nginx.conf',
    traefik: { tlsOption: 'k8s/traefik/tls-option.yaml', ingress: 'k8s/traefik/ingress.yaml', optionName: 'app-tls' },
};

const run = (root, overrides = {}) => inspectSecurityDrift({ root, ...OPTIONS, ...overrides });
const whats = (root, overrides) => run(root, overrides).problems.map((p) => p.what);

// ─── The baseline ────────────────────────────────────────────────────────────

test('a repo that satisfies every rule reports nothing', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('the counts say how much was looked at', (t) => {
    const root = tree(t, good());
    const { counts } = run(root);
    assert.equal(counts.frontend, 1);
    assert.equal(counts.locations, 2);
    assert.equal(counts.throttleCalls, 4);
    assert.ok(counts.backend > 5);
});

// ─── Anchors ─────────────────────────────────────────────────────────────────

test('a missing anchor file stops the gate rather than passing its rules', (t) => {
    const files = good();
    delete files['api/src/services/auth/login-throttle.ts'];
    const root = tree(t, files);
    const problems = run(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0].what, /not found/);
});

test('an anchor whose landmark was renamed stops the gate', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-tokens.ts': TOKENS.replaceAll('DUMMY_HASH', 'PLACEHOLDER_HASH') }),
    );
    const problems = run(root).problems;
    assert.ok(problems.every((p) => /missing landmark/.test(p.what)));
    assert.match(problems[0].what, /DUMMY_HASH/);
});

test('an anchor stop reports once, not once per rule that would have failed', (t) => {
    const files = good();
    delete files['api/src/index.ts'];
    const root = tree(t, files);
    assert.equal(run(root).problems.length, 1);
});

test('optional groups add no anchors when they are not configured', (t) => {
    const files = good();
    delete files['docker/nginx.conf'];
    delete files['k8s/traefik/tls-option.yaml'];
    delete files['k8s/traefik/ingress.yaml'];
    delete files['api/src/lib/helpers.ts'];
    delete files['api/src/services/auth/auth-verification.ts'];
    const root = tree(t, files);
    const problems = inspectSecurityDrift({
        root,
        ...OPTIONS,
        nginx: undefined,
        traefik: undefined,
        auth: { ...OPTIONS.auth, escapeHtmlFile: undefined, passwordReset: undefined },
    }).problems;
    assert.deepEqual(
        problems.map((p) => p.what),
        [],
    );
});

// ─── 1. JWT ──────────────────────────────────────────────────────────────────

test('jwt.verify without algorithms is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/jwt.ts': 'jwt.verify(token, secret);' }));
    assert.deepEqual(whats(root), ['calls jwt.verify() without pinning `algorithms`']);
});

test('jwt.verify with algorithms passes, nested objects and all', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/jwt.ts': "jwt.verify(token, secret, { algorithms: ['HS256'], audience: { a: 1 } });" }),
    );
    assert.deepEqual(whats(root), []);
});

test('jwt.sign without expiresIn is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/jwt.ts': 'jwt.sign(payload, secret);' }));
    assert.deepEqual(whats(root), ['calls jwt.sign() without `expiresIn`']);
});

test('a jwt.verify inside a comment is not a call', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/jwt.ts':
                '// jwt.verify(token, secret) would be unpinned\njwt.verify(t, s, { algorithms: ["HS256"] });',
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('a jwt call in a test file is not scanned', (t) => {
    const root = tree(t, good({ 'api/src/__tests__/jwt.test.ts': 'jwt.verify(token, secret);' }));
    assert.deepEqual(whats(root), []);
});

// ─── 2. CORS ─────────────────────────────────────────────────────────────────

test('a wildcard CORS origin is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('origin: config.corsOrigin', "origin: '*'") }));
    assert.deepEqual(whats(root), ['does not set the CORS origin from config']);
});

test('a hardcoded CORS origin is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/index.ts': ENTRY.replace('origin: config.corsOrigin', "origin: 'https://app.example.com'") }),
    );
    assert.deepEqual(whats(root), ['does not set the CORS origin from config']);
});

// ─── 3. CSP ──────────────────────────────────────────────────────────────────

test('an unlocked objectSrc is reported by name', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('objectSrc: ["\'none\'"],', '') }));
    assert.deepEqual(whats(root), ['helmet CSP does not lock objectSrc']);
});

test('unsafe-inline on script-src is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': ENTRY.replace(
                'scriptSrc: ["\'self\'"]',
                'scriptSrc: ["\'self\'", "\'unsafe-inline\'"]',
            ),
        }),
    );
    assert.deepEqual(whats(root), ['helmet CSP `script-src` allows unsafe-inline or unsafe-eval']);
});

test('unsafe-inline on style-src is the documented exception and passes', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

// ─── 4. HSTS ─────────────────────────────────────────────────────────────────

test('an HSTS max-age under a year is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('maxAge: 31536000', 'maxAge: 86400') }));
    assert.match(whats(root)[0], /max-age=86400/);
});

test('a max-age written with numeric separators is read correctly', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('maxAge: 31536000', 'maxAge: 31_536_000') }));
    assert.deepEqual(whats(root), []);
});

test('a cookie max-age earlier in the file does not become the HSTS answer', (t) => {
    const withCookie = ENTRY.replace(
        'const app = express();',
        'const app = express();\napp.use(session({ cookie: { maxAge: 900 } }));',
    );
    const root = tree(t, good({ 'api/src/index.ts': withCookie }));
    assert.deepEqual(whats(root), []);
});

test('a lowered HSTS max-age is still caught with a cookie max-age above it', (t) => {
    const withCookie = ENTRY.replace(
        'const app = express();',
        'const app = express();\napp.use(session({ cookie: { maxAge: 31536000 } }));',
    ).replace('maxAge: 31536000,\n            includeSubDomains', 'maxAge: 600,\n            includeSubDomains');
    const root = tree(t, good({ 'api/src/index.ts': withCookie }));
    assert.match(whats(root)[0], /max-age=600/);
});

test('HSTS without includeSubDomains is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('includeSubDomains: true,', '') }));
    assert.match(whats(root)[0], /includeSubDomains/);
});

test('an omitted preload key is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('preload: false,', '') }));
    assert.deepEqual(whats(root), ['helmet HSTS leaves `preload` to the library default']);
});

test('preload: true is a recorded decision and passes', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('preload: false,', 'preload: true,') }));
    assert.deepEqual(whats(root), []);
});

test('a nested object inside the HSTS block does not truncate the read', (t) => {
    const nested = ENTRY.replace('preload: false,', 'preload: false,\n            reportTo: { group: "hsts" },');
    const root = tree(t, good({ 'api/src/index.ts': nested }));
    assert.deepEqual(whats(root), []);
});

test('a missing Permissions-Policy is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace(/'Permissions-Policy'[^)]*\)/, "'X-Other', '1')") }));
    assert.deepEqual(whats(root), ['sends no Permissions-Policy header']);
});

// ─── 5. The three fixed headers ──────────────────────────────────────────────

test('a missing frameguard is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace("frameguard: { action: 'deny' },", '') }));
    assert.match(whats(root)[0], /frameguard/);
});

test('a permissive referrer policy is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('strict-origin-when-cross-origin', 'unsafe-url') }));
    assert.match(whats(root)[0], /referrerPolicy/);
});

// ─── 6. trust proxy ──────────────────────────────────────────────────────────

test('trust proxy set to true is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('config.trustProxyHops', 'true') }));
    assert.match(whats(root)[0], /sets `trust proxy` to `true`/);
});

test('trust proxy set to a bare number is reported — it must come from config', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('config.trustProxyHops', '1') }));
    assert.match(whats(root)[0], /sets `trust proxy` to `1`/);
});

test('an unvalidated TRUST_PROXY_HOPS is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/config.ts': CONFIG.replace('z.coerce.number().int().nonnegative()', 'z.string()') }),
    );
    assert.deepEqual(whats(root), ['does not validate TRUST_PROXY_HOPS as a non-negative integer']);
});

// ─── 7. Body size ────────────────────────────────────────────────────────────

test('an uncapped express.json() is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/index.ts': ENTRY.replace("express.json({ limit: '10mb' })", 'express.json()') }),
    );
    assert.match(whats(root)[0], /passes no `limit`/);
});

test('a body cap above 10 MB is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace("'10mb'", "'50mb'") }));
    assert.match(whats(root)[0], /50mb/);
});

test('a cap written in kb is understood', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace("'10mb'", "'512kb'") }));
    assert.deepEqual(whats(root), []);
});

// ─── 8. Timeouts ─────────────────────────────────────────────────────────────

test('an unset headersTimeout is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('server.headersTimeout = 60_000;', '') }));
    assert.match(whats(root)[0], /does not set server.headersTimeout/);
});

test('a headersTimeout over a minute is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': ENTRY.replace('server.headersTimeout = 60_000;', 'server.headersTimeout = 300_000;'),
        }),
    );
    assert.match(whats(root)[0], /300000 ms/);
});

test('a requestTimeout of zero is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': ENTRY.replace('server.requestTimeout = 5 * 60_000;', 'server.requestTimeout = 0;'),
        }),
    );
    assert.deepEqual(whats(root), ['sets server.requestTimeout to 0']);
});

test('a requestTimeout written as a product is evaluated, not read as its first number', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

// ─── 9. Argon2 ───────────────────────────────────────────────────────────────

test('a dummy hash computed with other parameters is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-tokens.ts': TOKENS.replace('m=65536,t=3,p=4', 'm=19456,t=2,p=1') }),
    );
    assert.match(whats(root)[0], /DUMMY_HASH is m=19456,t=2,p=1 but config is m=65536,t=3,p=4/);
});

test('the same parameters written in another order still match', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-tokens.ts': TOKENS.replace('m=65536,t=3,p=4', 'p=4,m=65536,t=3') }),
    );
    assert.deepEqual(whats(root), []);
});

test('parameters lowered in BOTH places are reported against the OWASP floor', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/config.ts': CONFIG.replace('memoryCost: 64 * 1024', 'memoryCost: 4 * 1024').replace(
                'timeCost: 3',
                'timeCost: 1',
            ),
            'api/src/services/auth/auth-tokens.ts': TOKENS.replace('m=65536,t=3,p=4', 'm=4096,t=1,p=4'),
        }),
    );
    assert.deepEqual(whats(root), ['Argon2 is configured below the OWASP floor (memoryCost 4096, timeCost 1)']);
});

test('parameters raised above the floor pass', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/config.ts': CONFIG.replace('memoryCost: 64 * 1024', 'memoryCost: 128 * 1024'),
            'api/src/services/auth/auth-tokens.ts': TOKENS.replace('m=65536,', 'm=131072,'),
        }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 10. Password schema ─────────────────────────────────────────────────────

test('a password schema missing a character class is reported by name', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/schemas.ts': SCHEMAS.replace(
                "if (!/[^A-Za-z0-9]/.test(value)) ctx.addIssue({ message: 'needs a symbol' });",
                '',
            ),
        }),
    );
    assert.match(whats(root)[0], /a special character/);
});

test('a password schema with no maximum is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/schemas.ts': SCHEMAS.replace('value.length > 128', 'value.length > 100000') }),
    );
    assert.match(whats(root)[0], /a maximum length of 128/);
});

// ─── 11. The refresh cookie ──────────────────────────────────────────────────

test('a refresh cookie without httpOnly is reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/identity/auth.ts': COOKIE.replace('httpOnly: true,', '') }));
    assert.match(whats(root)[0], /httpOnly/);
});

test('a refresh cookie with sameSite lax is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/identity/auth.ts': COOKIE.replace("sameSite: 'strict'", "sameSite: 'lax'") }),
    );
    assert.match(whats(root)[0], /sameSite/);
});

test('an unscoped refresh cookie path is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/identity/auth.ts': COOKIE.replace('path: REFRESH_COOKIE_PATH', "path: '/'") }),
    );
    assert.match(whats(root)[0], /path/);
});

test('a literal cookie path is accepted as well as a named constant', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/identity/auth.ts': COOKIE.replace('path: REFRESH_COOKIE_PATH', "path: '/api/auth'") }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 12. The sanitizer ───────────────────────────────────────────────────────

test('a sanitizer that skips req.query is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/middleware/sanitizer.ts': SANITIZER.replace('stripUnsafeKeysInPlace(req.query);', '') }),
    );
    assert.match(whats(root)[0], /req\.query/);
});

test('a sanitizer that skips req.body is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/middleware/sanitizer.ts': SANITIZER.replace('req.body = stripUnsafeKeys(req.body);', '') }),
    );
    assert.match(whats(root)[0], /req\.body/);
});

test('dropping the dollar-prefix test is reported', (t) => {
    const root = tree(t, good({ 'api/src/middleware/sanitizer.ts': SANITIZER.replace("key.startsWith('$') || ", '') }));
    assert.deepEqual(whats(root), ['no longer strips keys by a leading `$`']);
});

test('dropping the dotted-key test is reported', (t) => {
    const root = tree(t, good({ 'api/src/middleware/sanitizer.ts': SANITIZER.replace("key.includes('.') || ", '') }));
    assert.deepEqual(whats(root), ['no longer strips keys by a dot']);
});

test('dropping the prototype keys is reported', (t) => {
    const root = tree(t, good({ 'api/src/middleware/sanitizer.ts': SANITIZER.replace("'__proto__', ", '') }));
    assert.deepEqual(whats(root), ['no longer strips keys by the prototype keys']);
});

test('a comment naming __proto__ does not satisfy the prototype rule', (t) => {
    const root = tree(
        t,
        good({
            'api/src/middleware/sanitizer.ts': SANITIZER.replace("'__proto__', ", '/* __proto__ is handled below */ '),
        }),
    );
    assert.deepEqual(whats(root), ['no longer strips keys by the prototype keys']);
});

test('a sanitizer that strips but never refuses is reported', (t) => {
    const stripsOnly = SANITIZER.replace(
        "next(new AppError(422, 'VALIDATION_FAILED', 'Request carried an operator key', { securityEvent: true }));",
        'next();',
    );
    const root = tree(t, good({ 'api/src/middleware/sanitizer.ts': stripsOnly }));
    assert.deepEqual(whats(root), ['sanitizeRequest() never refuses a request that carried one of those keys']);
});

// ─── 13. The dev-placeholder denylist ────────────────────────────────────────

test('a placeholder dropped from the denylist is named', (t) => {
    const root = tree(t, good({ 'packages/shared/src/config/env.ts': ENV.replace("'replace-me', ", '') }));
    assert.match(whats(root)[0], /replace-me/);
});

test('a denylist applied outside a production guard is reported', (t) => {
    const root = tree(t, good({ 'packages/shared/src/config/env.ts': ENV.replace('!isProd() || ', '') }));
    assert.deepEqual(whats(root), ['the denylist is no longer applied behind a production guard']);
});

// ─── 14. The throttle fails open ─────────────────────────────────────────────

test('a throttle that rethrows from its catch is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/login-throttle.ts': THROTTLE.replace(
                "logger.warn({ error }, 'login throttle unavailable — allowing');",
                'throw error;',
            ),
        }),
    );
    assert.match(whats(root)[0], /rethrows from its catch/);
});

test('a throttle that swallows without logging is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/login-throttle.ts': THROTTLE.replace(
                "logger.warn({ error }, 'login throttle unavailable — allowing');",
                '',
            ),
        }),
    );
    assert.match(whats(root)[0], /swallows its Redis error/);
});

test('a throttle with no catch at all is reported', (t) => {
    const noCatch = `export async function assertLoginAllowed(key: string): Promise<void> {
    await redis.get(key);
}
${THROTTLE.slice(THROTTLE.indexOf('export async function recordLoginFailure'))}`;
    const root = tree(t, good({ 'api/src/services/auth/login-throttle.ts': noCatch }));
    assert.match(whats(root)[0], /no catch around its Redis call/);
});

test('the 429 thrown after the catch is not mistaken for failing closed', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('a throttle function that disappeared is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/login-throttle.ts': THROTTLE.replace(
                'export async function clearLoginFailures',
                'async function clearLoginFailures',
            ),
        }),
    );
    assert.match(whats(root)[0], /clearLoginFailures\(\) is gone/);
});

// ─── 15. The throttle key ────────────────────────────────────────────────────

test('a throttle keyed by the raw email is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/auth-tokens.ts': TOKENS.replace(
                'await assertLoginAllowed(emailIndex);',
                'await assertLoginAllowed(email);',
            ),
        }),
    );
    assert.match(whats(root)[0], /keyed by `email`/);
});

test('a name that LOOKS derived but is bound to the raw email is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/auth-tokens.ts': TOKENS.replace(
                'const emailIndex = emailBlindIndex(email);',
                'const emailIndex = email.toLowerCase();',
            ),
        }),
    );
    assert.match(whats(root)[0], /keyed by `email.toLowerCase\(\)`/);
});

test('a credential that reaches the key through a hash passes', (t) => {
    const hashed = TOKENS.replace(
        'const emailIndex = emailBlindIndex(email);',
        "const emailIndex = crypto.createHash('sha256').update(email).digest('hex');",
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': hashed }));
    assert.deepEqual(whats(root), []);
});

test('a key built from something that is not a credential passes', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('a key with no visible binding is reported rather than assumed safe', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-totp.ts': SERVICE.replace('const throttleKey = `2fa:${userId}`;', '') }),
    );
    assert.match(whats(root)[0], /nothing in this file binds/);
});

test('the throttle module itself is exempt — its key is a parameter', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('the nearest preceding binding is the one graded', (t) => {
    const twice = `${SERVICE}
export async function verifyTotp(email: string): Promise<void> {
    const throttleKey = email;
    await assertLoginAllowed(throttleKey);
}
`;
    const root = tree(t, good({ 'api/src/services/auth/auth-totp.ts': twice }));
    assert.equal(whats(root).length, 1);
    assert.match(whats(root)[0], /keyed by `email`/);
});

// ─── 16. Login ───────────────────────────────────────────────────────────────

test('branching on the user before the hash verify is reported', (t) => {
    const early = TOKENS.replace(
        'const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password);\n    if (user === null || !ok) {',
        "if (user === null) throw new AppError(401, 'INVALID_CREDENTIALS');\n    const ok = await argon2.verify(user.passwordHash ?? DUMMY_HASH, password);\n    if (!ok) {",
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': early }));
    assert.match(whats(root)[0], /branches on user existence before running a hash verify/);
});

test('two different 401 codes from login are reported', (t) => {
    const twoCodes = TOKENS.replace(
        "await recordLoginFailure(emailIndex);\n        throw new AppError(401, 'INVALID_CREDENTIALS');",
        "await recordLoginFailure(emailIndex);\n        if (user === null) throw new AppError(401, 'NO_SUCH_USER');\n        throw new AppError(401, 'BAD_PASSWORD');",
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': twoCodes }));
    assert.match(whats(root).join(' '), /2 different 401 codes/);
});

// ─── 17. Refresh rotation ────────────────────────────────────────────────────

test('a non-atomic claim is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-tokens.ts': TOKENS.replace('usedAt: { $exists: false } },', '},') }),
    );
    assert.match(whats(root)[0], /does not claim the old token atomically/);
});

test('a reuse branch that revokes only one token is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/auth-tokens.ts': TOKENS.replace(
                'await tokens.deleteMany({ familyId: used?.familyId });',
                'await tokens.deleteOne({ tokenHash });',
            ),
        }),
    );
    assert.match(whats(root)[0], /does not revoke the whole token family/);
});

test('a rotation that mints a fresh expiry is reported', (t) => {
    const sliding = TOKENS.replace(
        '{ expiresAt: record.expiresAt }',
        '{ expiresAt: new Date(Date.now() + 7 * 86400000) }',
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': sliding }));
    assert.match(whats(root)[0], /does not carry `record.expiresAt` forward/);
});

test('a refresh token stored raw is reported', (t) => {
    const raw = TOKENS.replace(
        "const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');\n    await tokens.insertOne({ userId, tokenHash, expiresAt: opts.expiresAt });",
        'await tokens.insertOne({ userId, rawToken, expiresAt: opts.expiresAt });',
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': raw }));
    assert.match(whats(root).join(' '), /not stored hashed/);
});

test('the raw token named inside the hash call is not read as storing it', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

// ─── 18. Raw-HTML sinks ──────────────────────────────────────────────────────

test('an innerHTML assignment in shipped frontend code is reported', (t) => {
    const root = tree(t, good({ 'frontend/src/Widget.vue': '<script setup>el.innerHTML = props.body;</script>' }));
    assert.deepEqual(whats(root), ['uses .innerHTML =']);
});

test('reading innerHTML is not assigning to it', (t) => {
    const root = tree(t, good({ 'frontend/src/Widget.vue': '<script setup>const html = el.innerHTML;</script>' }));
    assert.deepEqual(whats(root), []);
});

test('a comment warning about innerHTML is not a use of it', (t) => {
    const root = tree(
        t,
        good({
            'frontend/src/Widget.vue':
                '<script setup>\n// never do el.innerHTML = body\nel.textContent = props.body;\n</script>',
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('document.write is reported', (t) => {
    const root = tree(t, good({ 'frontend/src/legacy.ts': 'document.write("<b>hi</b>");' }));
    assert.deepEqual(whats(root), ['uses document.write(']);
});

test('a sink in a frontend test file is not scanned', (t) => {
    const root = tree(t, good({ 'frontend/src/__tests__/widget.test.ts': 'el.innerHTML = "<b>x</b>";' }));
    assert.deepEqual(whats(root), []);
});

test('v-html is left to ESLint, which owns it', (t) => {
    const root = tree(t, good({ 'frontend/src/Widget.vue': '<template><div v-html="body" /></template>' }));
    assert.deepEqual(whats(root), []);
});

// ─── 19. Regexes built from input ────────────────────────────────────────────

test('a regex built from a bare value is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'const re = new RegExp(term, "i");' }));
    assert.match(whats(root)[0], /builds `new RegExp\(term, "i"…\)`/);
});

test('a regex built through escapeRegex passes', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'const re = new RegExp(escapeRegex(term), "i");' }));
    assert.deepEqual(whats(root), []);
});

test('a template literal interpolating only a quantifier passes', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'const re = new RegExp(`^[a-z]{${max}}$`);' }));
    assert.deepEqual(whats(root), []);
});

test('a template literal interpolating a value outside a quantifier is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'const re = new RegExp(`^${term}$`);' }));
    assert.match(whats(root)[0], /new RegExp/);
});

test('a $regex handed a raw value is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'await media.find({ title: { $regex: term } });' }));
    assert.match(whats(root)[0], /\$regex: term/);
});

test('a $regex handed a value bound through escapeRegex passes', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/search.ts': 'const safe = escapeRegex(term);\nawait media.find({ title: { $regex: safe } });',
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('a regex in a commented-out line is not scanned', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/search.ts': '// const re = new RegExp(term);\nconst re = new RegExp(escapeRegex(term));' }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 20. escapeHtml ──────────────────────────────────────────────────────────

test('an escapeHtml missing one entity is reported', (t) => {
    const root = tree(t, good({ 'api/src/lib/helpers.ts': HELPERS.replace(".replace(/'/g, '&#x27;')", '') }));
    assert.match(whats(root)[0], /&#x27;/);
});

test('escapeHtml is not checked when the repo renders no HTML', (t) => {
    const files = good();
    delete files['api/src/lib/helpers.ts'];
    const root = tree(t, files);
    assert.deepEqual(whats(root, { auth: { ...OPTIONS.auth, escapeHtmlFile: undefined } }), []);
});

// ─── 21. Password reset ──────────────────────────────────────────────────────

test('a reset token stored unhashed is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/services/auth/auth-verification.ts': RESET.replace(
                "await resets.insertOne({ tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex') });",
                'await resets.insertOne({ token: rawToken });',
            ),
        }),
    );
    assert.match(whats(root)[0], /not hashed at rest/);
});

test('a reset TTL longer than an hour is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/config.ts': CONFIG.replace(
                'passwordResetTokenExpiry: 60 * 60 * 1000',
                'passwordResetTokenExpiry: 24 * 60 * 60 * 1000',
            ),
        }),
    );
    assert.match(whats(root)[0], /reset tokens live for 86400000 ms/);
});

test('a reset that does not revoke the sessions is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/services/auth/auth-verification.ts': RESET.replace('await revokeAllUserTokens(userId);', '') }),
    );
    assert.match(whats(root)[0], /does not revoke the sessions/);
});

// ─── 22. The reverse proxy ───────────────────────────────────────────────────

test('a location block missing one header is named', (t) => {
    const root = tree(
        t,
        good({
            'docker/nginx.conf': NGINX.replace(
                '        add_header X-Content-Type-Options nosniff;\n        add_header Referrer-Policy strict-origin-when-cross-origin;\n        add_header Permissions-Policy "camera=()";\n        add_header Content-Security-Policy "default-src \'self\'; script-src \'self\'";\n        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";\n        proxy_pass http://api:3001;',
                '        proxy_pass http://api:3001;',
            ),
        }),
    );
    assert.equal(whats(root).length, 1);
    assert.match(whats(root)[0], /location \/api\/` is missing X-Content-Type-Options/);
});

test('a commented-out header does not count as present', (t) => {
    const root = tree(
        t,
        good({
            'docker/nginx.conf': NGINX.replace(
                '        add_header Permissions-Policy "camera=()";\n        add_header Content-Security-Policy "default-src \'self\'; script-src \'self\'";\n        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";\n        proxy_pass',
                '        # add_header Permissions-Policy "camera=()";\n        add_header Content-Security-Policy "default-src \'self\'; script-src \'self\'";\n        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";\n        proxy_pass',
            ),
        }),
    );
    assert.match(whats(root)[0], /Permissions-Policy/);
});

test('unsafe-inline in the proxy CSP is reported', (t) => {
    const root = tree(
        t,
        good({ 'docker/nginx.conf': NGINX.replaceAll("script-src 'self'", "script-src 'self' 'unsafe-inline'") }),
    );
    assert.deepEqual(whats(root), ['the proxy CSP `script-src` allows unsafe-inline or unsafe-eval']);
});

test('a nested block inside a location does not truncate the header scan', (t) => {
    const nested = NGINX.replace(
        '        proxy_pass http://api:3001;',
        '        if ($request_method = OPTIONS) {\n            return 204;\n        }\n        proxy_pass http://api:3001;',
    );
    const root = tree(t, good({ 'docker/nginx.conf': nested }));
    assert.deepEqual(whats(root), []);
});

// ─── 23. The TLS floor ───────────────────────────────────────────────────────

test('an unpinned TLS floor is reported', (t) => {
    const root = tree(
        t,
        good({ 'k8s/traefik/tls-option.yaml': TLS_OPTION.replace('minVersion: VersionTLS12', 'sniStrict: true') }),
    );
    assert.deepEqual(whats(root), ['does not pin a TLS 1.2 floor']);
});

test('a TLS 1.3 floor is accepted', (t) => {
    const root = tree(t, good({ 'k8s/traefik/tls-option.yaml': TLS_OPTION.replace('VersionTLS12', 'VersionTLS13') }));
    assert.deepEqual(whats(root), []);
});

test('an IngressRoute that never references the TLSOption is reported', (t) => {
    const root = tree(
        t,
        good({ 'k8s/traefik/ingress.yaml': INGRESS.replace('  tls:\n    options:\n      name: app-tls\n', '') }),
    );
    assert.match(whats(root)[0], /does not reference the `app-tls` TLSOption/);
});

// ─── 24. Unauthenticated mounts ──────────────────────────────────────────────

test('a mount outside the open-by-design list is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': ENTRY.replace(
                "app.use('/api/media', requireAuth, mediaRouter);",
                "app.use('/api/media', mediaRouter);",
            ),
        }),
    );
    assert.match(whats(root, { unauthenticatedMounts: ['/api/auth'] })[0], /mounts \/api\/media without requireAuth/);
});

test('an open-by-design mount that vanished is reported', (t) => {
    const root = tree(t, good());
    assert.match(
        whats(root, { unauthenticatedMounts: ['/api/auth', '/api/logos'] })[0],
        /no longer mounts \/api\/logos/,
    );
});

test('the mount rule is skipped where auth is applied inside each router', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

// ─── 25. Unauthenticated file routes ─────────────────────────────────────────

const FILE_ROUTE = { file: 'api/src/routes/asset/logos.ts', why: 'Logos load through <img>, which carries no token.' };

test('a file route with every control passes', (t) => {
    const root = tree(t, good({ 'api/src/routes/asset/logos.ts': LOGOS }));
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), []);
});

test('a file route that stopped denying dotfiles is reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/asset/logos.ts': LOGOS.replace(", dotfiles: 'deny'", '') }));
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), ['no longer denies dotfiles']);
});

test('a file route that stopped checking the origin is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/routes/asset/logos.ts': LOGOS.replace('if (!isSameOrigin(req)) return res.status(403).end();', ''),
        }),
    );
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), ['no longer checks the request origin']);
});

test('a file route whose CSP lost its sandbox is reported', (t) => {
    const root = tree(t, good({ 'api/src/routes/asset/logos.ts': LOGOS.replace('; sandbox', '') }));
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), ['no longer sandboxes that policy']);
});

test('a sandbox named far from the setHeader call still counts', (t) => {
    const root = tree(t, good({ 'api/src/routes/asset/logos.ts': LOGOS }));
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), []);
});

test('a file route that lost its segment validation is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/asset/logos.ts': LOGOS.replaceAll('z.string().regex(', 'z.string().min(') }),
    );
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), [
        'no longer validates every path segment against a regex (:exchange, :file)',
    ]);
});

test('a file route that validates one segment and not the other names the other', (t) => {
    const root = tree(
        t,
        good({ 'api/src/routes/asset/logos.ts': LOGOS.replace('file: z.string().regex(', 'file: z.string().min(') }),
    );
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), [
        'no longer validates every path segment against a regex (:file)',
    ]);
});

// A contract that keeps every request schema in a shared package forbids one in the route file
const SHARED_LOGOS = LOGOS.replace(/const params = z\.object\(\{[^}]*\}\);\n\n/, '').replace(
    "router.get('/:exchange/:file', (req, res) => {",
    "router.get('/:exchange/:file', ...validated({ params: logoParams }, (req, res) => {",
);

const PARAMS = `export const idParam = z.object({ id: mongoId('id') });

export const logoParams = z.object({
    exchange: z.string().regex(/^[A-Z]{2,10}$/),
    file: z.string().regex(/^[A-Z0-9][A-Z0-9.:-]{0,14}\\.svg$/),
});

export const nameParam = z.object({ name: z.string().min(1) });
`;

const SHARED_ROUTE = {
    ...FILE_ROUTE,
    params: { file: 'packages/shared/src/requests/params.ts', schema: 'logoParams' },
};

const sharedTree = (t, params = PARAMS, route = SHARED_LOGOS) =>
    tree(t, good({ 'api/src/routes/asset/logos.ts': route, 'packages/shared/src/requests/params.ts': params }));

test('a file route whose segment schema lives in the shared package passes', (t) => {
    assert.deepEqual(whats(sharedTree(t), { fileRoutes: [SHARED_ROUTE] }), []);
});

test('a shared segment schema that lost a regex is reported', (t) => {
    const loose = PARAMS.replace('exchange: z.string().regex(', 'exchange: z.string().min(');
    assert.deepEqual(whats(sharedTree(t, loose), { fileRoutes: [SHARED_ROUTE] }), [
        'no longer validates every path segment against a regex (:exchange)',
    ]);
});

test('a regex in a neighbouring shared schema does not stand in for the named one', (t) => {
    const loose = PARAMS.replace('file: z.string().regex(', 'file: z.string().min(').replace(
        'z.object({ name: z.string().min(1) })',
        'z.object({ file: z.string().regex(/^x$/) })',
    );
    assert.deepEqual(whats(sharedTree(t, loose), { fileRoutes: [SHARED_ROUTE] }), [
        'no longer validates every path segment against a regex (:file)',
    ]);
});

test('a route that no longer hands the validator the named schema is reported', (t) => {
    const unvalidated = SHARED_LOGOS.replace('params: logoParams', 'params: idParam');
    assert.deepEqual(whats(sharedTree(t, PARAMS, unvalidated), { fileRoutes: [SHARED_ROUTE] }), [
        'no longer validates every path segment against a regex (params: logoParams)',
    ]);
});

test('a named segment schema that is gone is a broken anchor', (t) => {
    const gone = PARAMS.replace('export const logoParams', 'export const logoParamz');
    assert.deepEqual(whats(sharedTree(t, gone), { fileRoutes: [SHARED_ROUTE] }), [
        'missing landmark `export const logoParams =`',
    ]);
});

// ─── Bounded reads: a rule must not be satisfied by the code BELOW its subject ─

test('a second cookie function below does not satisfy the refresh cookie flags', (t) => {
    const withClear = `${COOKIE.replace("sameSite: 'strict'", "sameSite: 'lax'")}
function clearRefreshCookie(res: Response): void {
    res.clearCookie('refresh', { httpOnly: true, secure: true, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
}
`;
    const root = tree(t, good({ 'api/src/routes/identity/auth.ts': withClear }));
    assert.match(whats(root)[0], /sameSite/);
});

test('a schema below the password schema does not supply its character classes', (t) => {
    const withOther = `${SCHEMAS.replace(
        "if (!/[A-Z]/.test(value)) ctx.addIssue({ message: 'needs an uppercase letter' });",
        '',
    )}
export const usernameSchema = z.string().regex(/^[A-Za-z0-9]+$/);
`;
    const root = tree(t, good({ 'api/src/lib/schemas.ts': withOther }));
    assert.match(whats(root)[0], /an uppercase letter/);
});

test('a function below escapeHtml does not supply its entities', (t) => {
    const withOther = `${HELPERS.replace(".replace(/</g, '&lt;')", '')}
export function escapeAttr(value: string): string {
    return value.replace(/</g, '&lt;');
}
`;
    const root = tree(t, good({ 'api/src/lib/helpers.ts': withOther }));
    assert.match(whats(root)[0], /&lt;/);
});

test('a file route that DEFINES isSameOrigin but never calls it is reported', (t) => {
    const declaredOnly = `${LOGOS.replace('if (!isSameOrigin(req)) return res.status(403).end();', '')}
function isSameOrigin(req: Request): boolean {
    return req.headers.origin === config.corsOrigin;
}
`;
    const root = tree(t, good({ 'api/src/routes/asset/logos.ts': declaredOnly }));
    assert.deepEqual(whats(root, { fileRoutes: [FILE_ROUTE] }), ['no longer checks the request origin']);
});

test('a function DECLARATION does not count as a throttle call site', (t) => {
    const declares = `export async function assertLoginAllowed(email: string): Promise<void> {
    await redis.get(email);
}
`;
    const root = tree(t, good({ 'api/src/services/auth/other-throttle.ts': declares }));
    assert.deepEqual(whats(root), []);
});

// ─── Cases the mutation sweep found nothing pinning ──────────────────────────

test('a wildcard origin elsewhere is reported even when cors() reads config', (t) => {
    const both = ENTRY.replace(
        'app.use(cors({ origin: config.corsOrigin, credentials: true }));',
        "app.use(cors({ origin: config.corsOrigin, credentials: true }));\nio.engine.opts.cors = { origin: '*' };",
    );
    const root = tree(t, good({ 'api/src/index.ts': both }));
    assert.deepEqual(whats(root), ['does not set the CORS origin from config']);
});

test('an underscored max-age that is too short is still too short', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': ENTRY.replace('maxAge: 31536000', 'maxAge: 86_400') }));
    assert.match(whats(root)[0], /max-age=86400/);
});

test('a dummy hash differing in memoryCost alone is reported', (t) => {
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': TOKENS.replace('m=65536,', 'm=131072,') }));
    assert.match(whats(root)[0], /DUMMY_HASH is m=131072/);
});

test('an expiry taken from a variable instead of the record is reported', (t) => {
    const sliding = TOKENS.replace(
        'return issueRefreshToken(record.userId, { expiresAt: record.expiresAt });',
        'const sevenDays = addDays(7);\n    return issueRefreshToken(record.userId, { expiresAt: sevenDays });',
    );
    const root = tree(t, good({ 'api/src/services/auth/auth-tokens.ts': sliding }));
    assert.match(whats(root)[0], /does not carry `record.expiresAt` forward/);
});

test('an interpolation closed by a brace but not opened by one is still user input', (t) => {
    const root = tree(t, good({ 'api/src/lib/search.ts': 'const re = new RegExp(`^${term}}$`);' }));
    assert.match(whats(root)[0], /new RegExp/);
});

test('an IngressRoute naming a different TLSOption is reported', (t) => {
    const root = tree(t, good({ 'k8s/traefik/ingress.yaml': INGRESS.replace('name: app-tls', 'name: default-tls') }));
    assert.match(whats(root)[0], /does not reference the `app-tls` TLSOption/);
});
