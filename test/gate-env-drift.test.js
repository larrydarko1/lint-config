import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectEnvDrift } from '../src/gates/env-drift.ts';

/**
 * A temp repo holding exactly the files a case needs. It is a real git
 * repository because rule 8 asks git, not a regex, whether a path is ignored —
 * see the gate header.
 */
const tree = (t, files, { git = true } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    if (git) execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
};

const SHARED = `import { z } from 'zod';

export const mongoEnv = {
    MONGO_URI: z.string().min(1).default('mongodb://localhost:27017'),
    MONGO_DB: z.string().min(1).default('AppDB'),
};

export const s3Env = {
    S3_ENDPOINT: z.url().default('http://localhost:3900'),
    S3_ACCESS_KEY: infraDefault('local-access-key'),
    S3_SECRET_KEY: infraDefault('local-secret-key'),
};
`;

const CONFIG = `import { z } from 'zod';

const Env = z.object({
    ...mongoEnv,
    ...s3Env,
    PORT: z.coerce.number().int().positive().default(3001),
    JWT_SECRET: requiredSecret(32),
});

export const config = {
    port: parsed.PORT,
    jwt: { secret: parsed.JWT_SECRET },
    mongo: { uri: parsed.MONGO_URI, db: parsed.MONGO_DB },
    s3: { endpoint: parsed.S3_ENDPOINT },
} as const;
`;

const EXAMPLE = `# Database
MONGO_URI=mongodb://localhost:27017
MONGO_DB=myapp

# S3
S3_ENDPOINT=http://localhost:3900
S3_ACCESS_KEY=replace-me
S3_SECRET_KEY=replace-me

# Server
PORT=3001
JWT_SECRET=replace-with-32-plus-char-random-string
`;

const ENTRY = `import 'dotenv/config';
import { config } from './lib/config.ts';

console.log(config.port);
`;

const GITIGNORE = 'node_modules\n*.env\n!*.env.example\n';

/** A repo that passes every rule, with named files replaced or removed. */
const good = (overrides = {}) => {
    const files = {
        '.gitignore': GITIGNORE,
        'packages/shared/src/config/env.ts': SHARED,
        'api/src/lib/config.ts': CONFIG,
        'api/src/index.ts': ENTRY,
        'api/.env.example': EXAMPLE,
        ...overrides,
    };
    for (const [key, value] of Object.entries(files)) if (value === null) delete files[key];
    return files;
};

const OPTIONS = {
    services: [
        {
            name: 'api',
            config: 'api/src/lib/config.ts',
            example: 'api/.env.example',
            entry: 'api/src/index.ts',
            local: 'api/.env',
        },
    ],
    sharedEnv: 'packages/shared/src/config/env.ts',
    canonicalGroups: { 'api/src/lib/config.ts': ['jwt', 'mongo', 's3'] },
    exampleFiles: ['api/.env.example'],
    businessDirs: ['api/src'],
};

const run = (t, files, extra = {}) => inspectEnvDrift({ root: tree(t, files), ...OPTIONS, ...extra });
const whats = (result) => result.problems.map((p) => p.what);

// ── The passing baseline ─────────────────────────────────────────────────────

test('a repo following every rule reports nothing', (t) => {
    const result = run(t, good());
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});

test('it counts the keys a service reads, resolving spread fragments', (t) => {
    const result = run(t, good());
    // 2 mongo + 3 s3 + PORT + JWT_SECRET
    assert.deepEqual(result.services, [{ name: 'api', keys: 7 }]);
});

// ── 1. Schema ↔ .env.example ─────────────────────────────────────────────────

test('a schema key missing from the example is reported', (t) => {
    const result = run(t, good({ 'api/.env.example': EXAMPLE.replace(/^PORT=3001\n/m, '') }));
    assert.deepEqual(whats(result), ['does not document PORT, which api/src/lib/config.ts reads']);
});

test('an example key no schema reads is reported', (t) => {
    const result = run(t, good({ 'api/.env.example': `${EXAMPLE}OLD_NAME=x\n` }));
    assert.deepEqual(whats(result), ['documents OLD_NAME, which api/src/lib/config.ts does not read']);
});

test('a key from a spread fragment counts as read, not undocumented', (t) => {
    // Every mongo/s3 key comes in via `...mongoEnv` / `...s3Env`; a gate that
    // did not resolve the spread would report all five as undocumented.
    const result = run(t, good());
    assert.equal(result.problems.filter((p) => /MONGO_|S3_/.test(p.what)).length, 0);
});

test('a commented-out key in the example still documents it', (t) => {
    const example = EXAMPLE.replace('PORT=3001', '# PORT=3001');
    const result = run(t, good({ 'api/.env.example': example }));
    assert.deepEqual(result.problems, []);
});

test('NODE_ENV is ignored on both sides by default', (t) => {
    const config = CONFIG.replace('    PORT:', "    NODE_ENV: z.enum(['development']),\n    PORT:");
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(result.problems, []);
});

test('the ignore list is configurable', (t) => {
    const config = CONFIG.replace('    PORT:', '    CI_ONLY: z.string(),\n    PORT:');
    const result = run(t, good({ 'api/src/lib/config.ts': config }), { ignored: ['NODE_ENV', 'CI_ONLY'] });
    assert.deepEqual(result.problems, []);
});

// ── 2. The local .env advisory ───────────────────────────────────────────────

test('a local .env missing a documented key warns and does not fail', (t) => {
    const result = run(
        t,
        good({
            'api/.env': 'MONGO_URI=x\nMONGO_DB=y\nS3_ENDPOINT=z\nS3_ACCESS_KEY=a\nS3_SECRET_KEY=b\nJWT_SECRET=c\n',
        }),
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /missing 1 key\(s\).*PORT/s);
});

test('a local .env setting a key no schema reads warns', (t) => {
    const result = run(t, good({ 'api/.env': `${EXAMPLE}GONE=1\n` }));
    assert.deepEqual(result.problems, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /dead, usually a missed rename.*GONE/s);
});

test('a commented key in a real .env is NOT set, unlike in the example', (t) => {
    // The one asymmetry in the dotenv parser. Treating them the same reports a
    // commented-out key in a real env as configured, which is backwards.
    const result = run(t, good({ 'api/.env': EXAMPLE.replace('PORT=3001', '# PORT=3001') }));
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings[0], /missing 1 key\(s\).*PORT/s);
});

test('no local .env at all is silent', (t) => {
    const result = run(t, good());
    assert.deepEqual(result.warnings, []);
});

// ── 3. dotenv first ──────────────────────────────────────────────────────────

test('an import above dotenv/config is reported', (t) => {
    const entry = `import { config } from './lib/config.ts';\nimport 'dotenv/config';\n`;
    const result = run(t, good({ 'api/src/index.ts': entry }));
    assert.deepEqual(whats(result), [`imports './lib/config.ts' before 'dotenv/config'`]);
});

test('an entry with no imports fails rather than passing vacuously', (t) => {
    const result = run(t, good({ 'api/src/index.ts': 'console.log(1);\n' }));
    assert.deepEqual(whats(result), ['has no import statements, so this check proves nothing']);
});

// ── 4. Secrets and .default() ────────────────────────────────────────────────

test('a secret with a bare .default() is reported', (t) => {
    const config = CONFIG.replace('JWT_SECRET: requiredSecret(32),', "JWT_SECRET: z.string().default('dev-secret'),");
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(whats(result), ['JWT_SECRET is a secret with a bare .default() and no superRefine guard']);
});

test('requiredSecret, hexSecret, infraDefault and .optional() are all accepted', (t) => {
    const config = CONFIG.replace(
        'JWT_SECRET: requiredSecret(32),',
        [
            'JWT_SECRET: requiredSecret(32),',
            '    ENC_KEY: hexSecret(32),',
            "    S3_KEY: infraDefault('local'),",
            '    SMTP_PASS: z.string().default(undefined).optional(),',
        ].join('\n'),
    );
    const example = `${EXAMPLE}ENC_KEY=replace-me\nS3_KEY=replace-me\nSMTP_PASS=\n`;
    const result = run(t, good({ 'api/src/lib/config.ts': config, 'api/.env.example': example }));
    assert.deepEqual(result.problems, []);
});

test('a key named in the superRefine is allowed to carry a default', (t) => {
    const config = `${CONFIG.replace('JWT_SECRET: requiredSecret(32),', "JWT_SECRET: z.string().default('dev'),")}
const guarded = Env.superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['JWT_SECRET']) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key] });
    }
    });
`;
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(result.problems, []);
});

test('a non-secret key with a default is not reported', (t) => {
    // PORT carries `.default(3001)` in the baseline and must stay silent, or
    // the rule fires on every tuning knob in the schema.
    const result = run(t, good());
    assert.equal(result.problems.filter((p) => /PORT/.test(p.what)).length, 0);
});

test('the secret rule reads the shared fragment module too', (t) => {
    const shared = SHARED.replace(
        "S3_SECRET_KEY: infraDefault('local-secret-key'),",
        "S3_SECRET_KEY: z.string().default('local-secret-key'),",
    );
    const result = run(t, good({ 'packages/shared/src/config/env.ts': shared }));
    assert.deepEqual(whats(result), ['S3_SECRET_KEY is a secret with a bare .default() and no superRefine guard']);
});

// ── 5. A shared key is declared once ─────────────────────────────────────────

test('redeclaring a key the config already spreads in is reported', (t) => {
    const config = CONFIG.replace('    PORT:', "    MONGO_DB: z.string().default('other'),\n    PORT:");
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(whats(result), ['redeclares MONGO_DB, which it already gets from `...mongoEnv`']);
});

// ── 6. The canonical config tree ─────────────────────────────────────────────

test('a missing canonical group is reported', (t) => {
    const config = CONFIG.replace('    mongo: { uri: parsed.MONGO_URI, db: parsed.MONGO_DB },\n', '');
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(whats(result), ['does not export config.mongo']);
});

test('a config object with no `as const` is still found', (t) => {
    const result = run(t, good({ 'api/src/lib/config.ts': CONFIG.replace('} as const;', '};') }));
    assert.deepEqual(result.problems, []);
});

test('a renamed config export fails rather than silently checking nothing', (t) => {
    const result = run(
        t,
        good({ 'api/src/lib/config.ts': CONFIG.replace('export const config = {', 'export const settings = {') }),
    );
    assert.deepEqual(whats(result), ['has no `export const config = { … }`']);
});

test('a nested key matching a group name does not satisfy the rule', (t) => {
    // `mongo:` indented deeper is a field of another group, not a top-level one.
    const config = CONFIG.replace(
        '    mongo: { uri: parsed.MONGO_URI, db: parsed.MONGO_DB },',
        '    db: {\n        mongo: parsed.MONGO_URI,\n    },',
    );
    const result = run(t, good({ 'api/src/lib/config.ts': config }));
    assert.deepEqual(whats(result), ['does not export config.mongo']);
});

// ── 7. Real secrets in a committed example ───────────────────────────────────

for (const [label, line] of [
    ['a 64-char hex key', `ENC_KEY=${'a1b2c3d4'.repeat(8)}`],
    ['a live Stripe key', 'STRIPE_SECRET_KEY=sk_live_abc123def456'],
    ['a Stripe webhook secret', 'STRIPE_WEBHOOK_SECRET=whsec_abcdefghij0123456789'],
    ['an AWS access key id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['a private key block', 'KEY="-----BEGIN RSA PRIVATE KEY-----"'],
]) {
    test(`${label} in a committed example is reported`, (t) => {
        const result = run(t, good({ 'api/.env.example': `${EXAMPLE}${line}\n` }));
        assert.equal(result.problems.filter((p) => /looks like/.test(p.what)).length, 1);
    });
}

test('an obvious placeholder is not mistaken for a real secret', (t) => {
    const result = run(t, good({ 'api/.env.example': `${EXAMPLE}OTHER_TOKEN=replace-with-64-hex-chars\n` }));
    assert.equal(result.problems.filter((p) => /looks like/.test(p.what)).length, 0);
});

test('a VITE_ key named like a secret is reported', (t) => {
    const result = run(t, good({ 'frontend/.env.example': 'VITE_API_URL=http://x\nVITE_STRIPE_SECRET=abc\n' }), {
        exampleFiles: ['api/.env.example', 'frontend/.env.example'],
    });
    assert.deepEqual(whats(result), ['declares VITE_STRIPE_SECRET']);
});

test('a commented-out VITE_ secret is still reported', (t) => {
    // Uncommenting it is one keystroke, and the name is the whole problem.
    const result = run(t, good({ 'frontend/.env.example': '# VITE_API_KEY=abc\n' }), {
        exampleFiles: ['frontend/.env.example'],
    });
    assert.deepEqual(whats(result), ['declares VITE_API_KEY']);
});

test('a harmless VITE_ var is not reported', (t) => {
    const result = run(t, good({ 'frontend/.env.example': 'VITE_API_URL=http://x\nVITE_APP_ENV=development\n' }), {
        exampleFiles: ['api/.env.example', 'frontend/.env.example'],
    });
    assert.deepEqual(result.problems, []);
});

test('an example file that does not exist is skipped, not crashed on', (t) => {
    const result = run(t, good(), { exampleFiles: ['api/.env.example', 'nowhere/.env.example'] });
    assert.deepEqual(result.problems, []);
});

// ── 8. The gitignore rule ────────────────────────────────────────────────────

test('a .env git does not ignore is reported', (t) => {
    const result = run(t, good({ '.gitignore': 'node_modules\n' }));
    assert.deepEqual(whats(result), ['does not ignore `api/.env`']);
});

test('a .gitignore that swallows the example is reported', (t) => {
    // `.env*` is the common spelling that really does take the example with it.
    // Note `*.env` does NOT — it matches names ENDING in `.env`, so the
    // `!*.env.example` negation written to undo it never did anything.
    const result = run(t, good({ '.gitignore': '.env*\n' }));
    assert.deepEqual(whats(result), ['ignores `api/.env.example`']);
});

test('a negation in a nested .gitignore is honoured', (t) => {
    // The reason this rule asks git instead of reading the top-level file: the
    // answer depends on a file the regex version never opened.
    const result = run(t, good({ '.gitignore': '.env*\n', 'api/.gitignore': '!.env.example\n' }));
    assert.deepEqual(result.problems, []);
});

test('outside a git repository the rule warns instead of failing', (t) => {
    const result = inspectEnvDrift({ root: tree(t, good({ '.gitignore': null }), { git: false }), ...OPTIONS });
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings.join('\n'), /Could not ask git/);
});

test('the gitignore rule can be turned off entirely', (t) => {
    const result = inspectEnvDrift({
        root: tree(t, good({ '.gitignore': null }), { git: false }),
        ...OPTIONS,
        gitignore: false,
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});

// ── 9. process.env outside the schema ────────────────────────────────────────

test('process.env read in a service file is reported', (t) => {
    const files = good({ 'api/src/routes/auth.ts': "const secret = process.env['JWT_SECRET'];\n" });
    const result = run(t, files);
    assert.deepEqual(whats(result), ['reads process.env directly']);
    assert.equal(result.problems[0].file, 'api/src/routes/auth.ts:1');
});

test('the config module and the entry file are exempt', (t) => {
    const files = good({
        'api/src/lib/config.ts': CONFIG.replace('const Env =', 'const raw = process.env;\nconst Env ='),
        'api/src/index.ts': `${ENTRY}console.log(process.env.PORT);\n`,
    });
    const result = run(t, files);
    assert.deepEqual(result.problems, []);
});

test('tests are exempt, because setting env is how you test a config module', (t) => {
    const files = good({
        'api/src/lib/__tests__/config.test.ts': "process.env['PORT'] = '4000';\n",
        'api/src/routes/auth.spec.ts': 'delete process.env.X;\n',
    });
    const result = run(t, files);
    assert.deepEqual(result.problems, []);
});

test('process.env named only in a comment is not reported', (t) => {
    const files = good({ 'api/src/routes/auth.ts': '// never read process.env here\nexport const x = 1;\n' });
    const result = run(t, files);
    assert.deepEqual(result.problems, []);
});

test('the sweep is skipped when no directories are given', (t) => {
    const files = good({ 'api/src/routes/auth.ts': 'const s = process.env.X;\n' });
    const result = inspectEnvDrift({ root: tree(t, files), ...OPTIONS, businessDirs: undefined });
    assert.deepEqual(result.problems, []);
});

test('a directory that does not exist is skipped, not crashed on', (t) => {
    const result = run(t, good(), { businessDirs: ['api/src', 'nowhere/src'] });
    assert.deepEqual(result.problems, []);
});

// ── Anchors ──────────────────────────────────────────────────────────────────

test('a missing anchor stops the gate instead of reporting a pass', (t) => {
    const result = run(t, good({ 'api/src/lib/config.ts': null }));
    assert.deepEqual(whats(result), ['does not exist']);
    assert.deepEqual(result.services, []);
});

test('a missing shared env module is reported as a missing anchor', (t) => {
    const result = run(t, good({ 'packages/shared/src/config/env.ts': null }));
    assert.deepEqual(whats(result), ['does not exist']);
});

test('a repo with no shared fragments needs no sharedEnv', (t) => {
    const config = CONFIG.replace('    ...mongoEnv,\n    ...s3Env,\n', '');
    const example = 'PORT=3001\nJWT_SECRET=replace-me\n';
    const result = inspectEnvDrift({
        root: tree(
            t,
            good({
                'api/src/lib/config.ts': config,
                'api/.env.example': example,
                'packages/shared/src/config/env.ts': null,
            }),
        ),
        ...OPTIONS,
        sharedEnv: undefined,
        canonicalGroups: { 'api/src/lib/config.ts': ['jwt', 'mongo'] },
    });
    assert.deepEqual(result.problems, []);
});

// ── Several services ─────────────────────────────────────────────────────────

test('each service is checked separately', (t) => {
    const files = good({
        'worker/src/lib/config.ts': CONFIG,
        'worker/src/index.ts': ENTRY,
        'worker/.env.example': EXAMPLE.replace(/^PORT=3001\n/m, ''),
    });
    const result = inspectEnvDrift({
        root: tree(t, files),
        ...OPTIONS,
        services: [
            ...OPTIONS.services,
            {
                name: 'worker',
                config: 'worker/src/lib/config.ts',
                example: 'worker/.env.example',
                entry: 'worker/src/index.ts',
            },
        ],
    });
    assert.deepEqual(whats(result), ['does not document PORT, which worker/src/lib/config.ts reads']);
    assert.deepEqual(
        result.services.map((s) => s.name),
        ['api', 'worker'],
    );
});

test('a service with no local .env produces no advisory for it', (t) => {
    const files = good({
        'worker/src/lib/config.ts': CONFIG,
        'worker/src/index.ts': ENTRY,
        'worker/.env.example': EXAMPLE,
    });
    const result = inspectEnvDrift({
        root: tree(t, files),
        ...OPTIONS,
        services: [
            ...OPTIONS.services,
            {
                name: 'worker',
                config: 'worker/src/lib/config.ts',
                example: 'worker/.env.example',
                entry: 'worker/src/index.ts',
            },
        ],
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});
