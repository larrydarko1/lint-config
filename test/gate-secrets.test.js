/**
 * The secrets gate, against invented files in a temp repo.
 * - Every token here is assembled at runtime from a prefix and filler, so this file holds
 * no string the gate, or a host's push protection, would read as a credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectSecrets } from '../src/gates/secrets.ts';

/** A temp repo holding exactly `files`. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

/** Every file in the tree is read, so no case needs git. */
const run = (t, files, options = {}) => inspectSecrets({ root: tree(t, files), files: Object.keys(files), ...options });
const whats = (result) => result.problems.map((p) => `${p.file ?? '-'}: ${p.what}`).join('\n');

const filler = (n) => 'Q7x2Kp9mZ4wB3n8RtY5vL1cH6jD0sF'.repeat(4).slice(0, n);
const TOKENS = {
    'aws-access-key': `AKIA${'Q7X2KP9MZ4WB3N8R'}`,
    'github-token': `ghp_${filler(36)}`,
    'gitlab-token': `glpat-${filler(20)}`,
    'slack-token': `xoxb-${filler(24)}`,
    'stripe-key': `sk_live_${filler(24)}`,
    'google-api-key': `AIza${filler(35)}`,
    'npm-token': `npm_${filler(36)}`,
    'anthropic-key': `sk-ant-${filler(40)}`,
    'openai-key': `sk-proj-${filler(40)}`,
    'sendgrid-key': `SG.${filler(22)}.${filler(43)}`,
};
const PRIVATE_KEY = `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\n${filler(64)}\n-----END OPENSSH PRIVATE KEY-----\n`;

// ── The baseline ─────────────────────────────────────────────────────────────

test('ordinary source has nothing to report', (t) => {
    const result = run(t, {
        'src/app.ts': "export const greeting = 'hello';\nconst apiKey = process.env.API_KEY;\n",
        '.env.example': 'API_KEY=\nDATABASE_URL=postgres://user:password@db:5432/app\n',
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.files, 2);
});

// ── Files that only hold secrets ─────────────────────────────────────────────

test('an env file, a keystore and an SSH key fail by name; an example does not', (t) => {
    const result = run(t, {
        '.env': 'A=1\n',
        'api/.env.production': 'A=1\n',
        '.env.local': 'A=1\n',
        '.env.example': 'A=\n',
        'api/.env.sample': 'A=\n',
        'android/release.keystore': 'binary',
        'src-tauri/updater.key': 'not a pem',
        'deploy/id_ed25519': 'key',
        'deploy/id_ed25519.pub': 'ssh-ed25519 AAAA',
        '.netrc': 'machine example.com',
    });
    const files = result.problems.map((p) => p.file);
    assert.deepEqual(files, [
        '.env',
        '.env.local',
        '.netrc',
        'android/release.keystore',
        'api/.env.production',
        'deploy/id_ed25519',
        'src-tauri/updater.key',
    ]);
});

// ── Tokens by shape ──────────────────────────────────────────────────────────

test('each issuer’s token shape is found, at its line', (t) => {
    const lines = Object.values(TOKENS).map((token) => `const value = '${token}';`);
    const result = run(t, { 'src/config.ts': `// config\n${lines.join('\n')}\n` });
    assert.equal(result.problems.length, Object.keys(TOKENS).length, whats(result));
    assert.equal(result.problems[0].file, 'src/config.ts:2');
});

test('a finding never prints the secret itself', (t) => {
    const result = run(t, { 'src/config.ts': `const k = '${TOKENS['stripe-key']}';\n` });
    assert.equal(result.problems.length, 1);
    assert.ok(!result.problems[0].what.includes(TOKENS['stripe-key']), result.problems[0].what);
    assert.match(result.problems[0].what, /a live Stripe key: sk_l…/);
});

test('a private key block is found, inside JSON too', (t) => {
    const result = run(t, {
        'certs/server.pem': PRIVATE_KEY,
        'service-account.json': JSON.stringify({ private_key: PRIVATE_KEY }),
        'certs/public.pem': `-----BEGIN ${'CERTIFICATE'}-----\nMIIB\n`,
    });
    assert.deepEqual(
        result.problems.map((p) => p.file),
        ['certs/server.pem:1', 'service-account.json:1'],
    );
});

test('AWS’s documented example id is not a finding', (t) => {
    const result = run(t, { 'README.md': `AWS_ACCESS_KEY_ID=AKIA${'IOSFODNN7'}EXAMPLE\n` });
    assert.deepEqual(result.problems, []);
});

// ── Passwords in URLs and registry tokens ────────────────────────────────────

test('a password in a URL fails unless it is a placeholder or the host is local', (t) => {
    const result = run(t, {
        'docker-compose.yml': [
            `MONGO_URL: mongodb://app:${filler(12)}@mongo.internal:27017/app`,
            'DEV_URL: postgres://postgres:postgres@db:5432/app',
            `LOCAL_URL: redis://default:${filler(12)}@localhost:6379`,
            'TEMPLATE: amqp://${RABBIT_USER}:${RABBIT_PASS}@queue:5672',
        ].join('\n'),
    });
    assert.equal(whats(result), 'docker-compose.yml:1: a password in a URL: mongodb://app:…@mongo.internal');
});

test('a literal registry token in .npmrc fails; one read from the environment does not', (t) => {
    const result = run(t, {
        '.npmrc': `//registry.npmjs.org/:_authToken=${filler(36)}\n`,
        'packages/ui/.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    });
    assert.equal(whats(result), '.npmrc:1: a registry token: _authToken=…');
});

// ── Credentials assigned in code ─────────────────────────────────────────────

test('a random-looking value assigned to a credential name fails', (t) => {
    const result = run(t, {
        'src/client.ts': `const clientSecret = '${filler(24)}';\n`,
        'config/app.yml': `api_key: "${filler(32)}"\n`,
    });
    assert.equal(result.problems.length, 2, whats(result));
});

test('placeholders, env var names, words and password hashes are not credentials', (t) => {
    const result = run(t, {
        'src/fixtures.ts': [
            "const password = 'correct-horse-battery-staple';",
            "const apiKey = 'your-api-key-goes-here-1234';",
            "const secretName = 'STRIPE_SECRET_KEY_PRODUCTION';",
            "const password = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA';",
            "const accessToken = '${ACCESS_TOKEN_FROM_THE_ENV}';",
            "const password = 'short1';",
        ].join('\n'),
    });
    assert.deepEqual(result.problems, [], whats(result));
});

// ── What is read ─────────────────────────────────────────────────────────────

test('lockfiles, binaries and oversized files are not read', (t) => {
    const big = `const k = '${TOKENS['npm-token']}';\n${'x'.repeat(1024 * 1024)}`;
    const result = run(t, {
        'package-lock.json': `{"integrity": "${TOKENS['npm-token']}"}`,
        'assets/logo.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(TOKENS['npm-token'])]),
        'dist/bundle.js': big,
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.skipped, 2);
});

test('by default it reads what git would commit, so an ignored .env is fine', (t) => {
    const root = tree(t, {
        '.gitignore': '.env\n',
        '.env': `STRIPE_KEY=${TOKENS['stripe-key']}\n`,
        'src/leak.ts': `const k = '${TOKENS['github-token']}';\n`,
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const result = inspectSecrets({ root });
    assert.equal(whats(result), 'src/leak.ts:1: a GitHub token: ghp_…');
});

// ── Waivers ──────────────────────────────────────────────────────────────────

test('a waiver passes its rule in the files it names, and only that rule', (t) => {
    const result = run(
        t,
        {
            'test/fixtures/keys.ts': `const fake = '${TOKENS['github-token']}';\nconst also = '${TOKENS['npm-token']}';\n`,
            'test/fixtures/more.ts': `const fake = '${TOKENS['github-token']}';\n`,
        },
        { allowlist: [{ file: 'test/fixtures/**', rule: 'github-token', reason: 'fakes for the parser tests' }] },
    );
    assert.equal(whats(result), 'test/fixtures/keys.ts:2: an npm token: npm_…');
    assert.equal(result.waived, 2);
});

test('a waiver that matches nothing, lacks a field or names no rule fails', (t) => {
    const result = run(
        t,
        { 'src/app.ts': 'export {};\n' },
        {
            allowlist: [
                { file: 'src/app.ts', rule: 'github-token', reason: 'was a fake once' },
                { file: 'src/app.ts', rule: 'github-token' },
                { file: 'src/app.ts', rule: 'github', reason: 'typo' },
            ],
        },
    );
    assert.match(whats(result), /waiver for github-token in src\/app.ts matches nothing/);
    assert.match(whats(result), /entry 2 \(src\/app.ts\) is missing: reason/);
    assert.match(whats(result), /entry 3 \(src\/app.ts\) names the rule "github", which does not exist/);
});
