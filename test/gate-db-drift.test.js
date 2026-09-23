import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectDbDrift } from '../src/gates/db-drift.js';

/**
 * A temp repo holding exactly the files a case needs.
 *
 * Each tree gets its own directory rather than being reused, because rule 1 and
 * rule 9 `import()` real modules and Node caches a module URL forever — a
 * second tree at the same path would silently test the first one's contents.
 */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const MANIFEST = `type IndexSpec = {
    collection: string;
    keys: Record<string, 1 | -1>;
    options?: Record<string, unknown>;
    why: string;
};

export const COLLECTIONS = ['Users', 'RefreshTokens'] as const;

export const INDEXES: IndexSpec[] = [
    { collection: 'Users', keys: { email: 1 }, options: { unique: true }, why: 'Login looks a user up by email.' },
    { collection: 'RefreshTokens', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }, why: 'Mongo deletes an expired token for us.' },
];
`;

const TYPES = `export type UserDoc = {
    _id: ObjectId;
    email: string;
    username: string;
    createdAt: Date;
    avatarKey?: string;
};

export type RefreshTokenDoc = {
    _id: ObjectId;
    userId: ObjectId;
    expiresAt: Date;
};
`;

const BOOTSTRAP = `import { COLLECTIONS } from '../../packages/shared/src/db/indexes.ts';

export async function up(db) {
    const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
    for (const name of COLLECTIONS) if (!existing.has(name)) await db.createCollection(name);
}
`;

const ARCHITECTURE = `# Schema

The database contains **2 collections**.

## Collections

#### Users

| Field | Type |
|---|---|
| \`_id\` | ObjectId |
| \`email\` | string |
| \`username\` | string |
| \`createdAt\` | Date |
| \`avatarKey\` | string |

#### RefreshTokens

| Field | Type |
|---|---|
| \`_id\` | ObjectId |
| \`userId\` | ObjectId |
| \`expiresAt\` | Date |

## Migration history

| Migration | What |
|---|---|
| \`20260101000000-bootstrap\` | Creates the collections. |
`;

const USER_EXAMPLE = JSON.stringify(
    { _id: 'a1', email: 'x@y.z', username: 'ada', createdAt: '2026-01-01T00:00:00Z' },
    null,
    4,
);
const TOKEN_EXAMPLE = JSON.stringify({ _id: 'b2', userId: 'a1', expiresAt: '2026-02-01T00:00:00Z' }, null, 4);

const API_ENTRY = `import { INDEXES } from '@test/shared';

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    await server.close();
    await closeDb();
}
`;

const DB_TS = `import { INDEXES } from '@test/shared';

export async function connectDb() {
    const db = await client.connect();
    await ensureIndexes(db);
    return db;
}
`;

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');

/** A repo that passes every rule, with named files replaced (or removed with null). */
const good = (overrides = {}) => {
    const files = {
        'packages/shared/src/db/indexes.ts': MANIFEST,
        'packages/shared/src/db/collections.ts': TYPES,
        'db/migrations/20260101000000-bootstrap.js': BOOTSTRAP,
        'db/migrations/.checksums.json': JSON.stringify({ '20260101000000-bootstrap.js': sha(BOOTSTRAP) }, null, 4),
        'db/__tests__/bootstrap.test.ts': 'test("is idempotent", () => {});\n',
        'db/docs/architecture.md': ARCHITECTURE,
        'db/docs/examples/users.json': USER_EXAMPLE,
        'db/docs/examples/refresh-tokens.json': TOKEN_EXAMPLE,
        'api/src/index.ts': API_ENTRY,
        'api/src/lib/db.ts': DB_TS,
        'package.json': JSON.stringify({ scripts: { 'db:migrate': 'migrate-mongo up' } }, null, 4),
        ...overrides,
    };
    for (const [key, value] of Object.entries(files)) if (value === null) delete files[key];
    // The checksum has to follow the migration it records, or every case that
    // edits the migration would trip the immutability rule instead of its own.
    if (
        files['db/migrations/.checksums.json'] !== undefined &&
        overrides['db/migrations/.checksums.json'] === undefined
    ) {
        const migrations = Object.entries(files).filter(([rel]) => /^db\/migrations\/\d{14}-.*\.js$/.test(rel));
        files['db/migrations/.checksums.json'] = JSON.stringify(
            Object.fromEntries(migrations.map(([rel, body]) => [path.basename(rel), sha(body)])),
            null,
            4,
        );
    }
    return files;
};

const OPTIONS = {
    manifest: 'packages/shared/src/db/indexes.ts',
    manifestSpecifier: '../../packages/shared/src/db/indexes.ts',
    typesFile: 'packages/shared/src/db/collections.ts',
    collectionTypes: { Users: 'UserDoc', RefreshTokens: 'RefreshTokenDoc' },
    bootstrap: 'db/migrations/20260101000000-bootstrap.js',
    architecture: 'db/docs/architecture.md',
    examplesDir: 'db/docs/examples',
    migrationsDir: 'db/migrations',
    testsDir: 'db/__tests__',
    checksums: 'db/migrations/.checksums.json',
    appDirs: ['api/src'],
    services: [{ name: 'api', entry: 'api/src/index.ts' }],
    indexAppliers: [{ file: 'api/src/lib/db.ts', applies: ['INDEXES'] }],
    packageManifests: ['package.json'],
};

const run = (t, files, extra = {}) => inspectDbDrift({ root: tree(t, files), ...OPTIONS, ...extra });
const whats = (result) => result.problems.map((p) => p.what);

// ── The passing baseline ─────────────────────────────────────────────────────

test('a repo following every rule reports nothing', async (t) => {
    const result = await run(t, good());
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});

test('it counts what it actually checked', async (t) => {
    const result = await run(t, good());
    assert.deepEqual(result.collections, ['Users', 'RefreshTokens']);
    assert.equal(result.indexes, 2);
    assert.equal(result.migrations, 1);
});

// ── 0. Anchors ───────────────────────────────────────────────────────────────

test('a moved anchor stops the gate instead of reporting a pass', async (t) => {
    const result = await run(t, good({ 'db/docs/architecture.md': null }));
    assert.deepEqual(whats(result), ['does not exist']);
    assert.deepEqual(result.collections, []);
});

test('a missing manifest is reported once, not also as a failed import', async (t) => {
    // What the anchor stop is for: without it the gate goes on to import a
    // path that is not there and adds "does not load under plain Node" on top,
    // which reads like a syntax error in a file nobody can find.
    const result = await run(t, good({ 'packages/shared/src/db/indexes.ts': null }));
    assert.deepEqual(whats(result), ['does not exist']);
});

// ── 1. The registry loads under plain Node ───────────────────────────────────

test('a registry with a runtime import is reported, not crashed on', async (t) => {
    // The failure this rule exists for: the bootstrap migration imports this
    // module through the migrate-mongo CLI, where nothing resolves an alias.
    const result = await run(
        t,
        good({ 'packages/shared/src/db/indexes.ts': `import { thing } from '@nope/nowhere';\n${MANIFEST}` }),
    );
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].what, /does not load under plain Node/);
});

test('a renamed export is reported', async (t) => {
    const result = await run(
        t,
        good({
            'packages/shared/src/db/indexes.ts': MANIFEST.replace('export const INDEXES', 'export const ALL_INDEXES'),
        }),
    );
    assert.deepEqual(whats(result), ['no longer exports INDEXES']);
});

test('several index exports are all read', async (t) => {
    const manifest = `${MANIFEST}\nexport const EXTRA_INDEXES: IndexSpec[] = [\n    { collection: 'Users', keys: { username: 1 }, why: 'Profile pages resolve a username.' },\n];\n`;
    const result = await run(
        t,
        good({ 'packages/shared/src/db/indexes.ts': manifest, 'api/src/lib/db.ts': `${DB_TS}\n// EXTRA_INDEXES\n` }),
        {
            indexExports: ['INDEXES', 'EXTRA_INDEXES'],
            indexAppliers: [{ file: 'api/src/lib/db.ts', applies: ['INDEXES', 'EXTRA_INDEXES'] }],
        },
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.indexes, 3);
});

// ── 2. The bootstrap tracks the registry ─────────────────────────────────────

test('a bootstrap declaring its own collection list is reported', async (t) => {
    const bootstrap = `const COLLECTIONS = ['Users', 'RefreshTokens'];\nexport async function up(db) {}\n`;
    const result = await run(t, good({ 'db/migrations/20260101000000-bootstrap.js': bootstrap }));
    assert.deepEqual(whats(result), ['declares its own collection list']);
});

test('a bootstrap importing from somewhere else is reported', async (t) => {
    const bootstrap = BOOTSTRAP.replace('../../packages/shared/src/db/indexes.ts', './somewhere-else.js');
    const result = await run(
        t,
        good({
            'db/migrations/20260101000000-bootstrap.js': bootstrap,
            'db/migrations/somewhere-else.js': 'export const COLLECTIONS = [];\n',
        }),
    );
    assert.equal(result.problems.filter((p) => /does not import COLLECTIONS/.test(p.what)).length, 1);
});

// ── 3. Unindexed collections ─────────────────────────────────────────────────

test('a collection with no index is reported', async (t) => {
    const manifest = MANIFEST.replace(
        "export const COLLECTIONS = ['Users', 'RefreshTokens'] as const;",
        "export const COLLECTIONS = ['Users', 'RefreshTokens', 'Stats'] as const;",
    );
    const files = good({
        'packages/shared/src/db/indexes.ts': manifest,
        'packages/shared/src/db/collections.ts': `${TYPES}\nexport type StatsDoc = {\n    _id: string;\n    value: number;\n};\n`,
        'db/docs/examples/stats.json': JSON.stringify({ _id: 'totals', value: 1 }),
        'db/docs/architecture.md': ARCHITECTURE.replace('**2 collections**', '**3 collections**').replace(
            '## Migration history',
            '#### Stats\n\n| Field | Type |\n|---|---|\n| `_id` | string |\n| `value` | number |\n\n## Migration history',
        ),
    });
    const result = await run(t, files, { collectionTypes: { ...OPTIONS.collectionTypes, Stats: 'StatsDoc' } });
    assert.deepEqual(whats(result), ["'Stats' has no index and no recorded reason for having none"]);
});

test('a recorded reason exempts it', async (t) => {
    const manifest = MANIFEST.replace("['Users', 'RefreshTokens']", "['Users', 'RefreshTokens', 'Stats']");
    const files = good({
        'packages/shared/src/db/indexes.ts': manifest,
        'packages/shared/src/db/collections.ts': `${TYPES}\nexport type StatsDoc = {\n    _id: string;\n    value: number;\n};\n`,
        'db/docs/examples/stats.json': JSON.stringify({ _id: 'totals', value: 1 }),
        'db/docs/architecture.md': ARCHITECTURE.replace('**2 collections**', '**3 collections**').replace(
            '## Migration history',
            '#### Stats\n\n| Field | Type |\n|---|---|\n| `_id` | string |\n| `value` | number |\n\n## Migration history',
        ),
    });
    const result = await run(t, files, {
        collectionTypes: { ...OPTIONS.collectionTypes, Stats: 'StatsDoc' },
        noIndexByDesign: { Stats: 'Singletons addressed by a string _id, which Mongo indexes itself.' },
    });
    assert.deepEqual(result.problems, []);
});

test('an exemption that has stopped applying is reported', async (t) => {
    const result = await run(t, good(), { noIndexByDesign: { Users: 'stale' } });
    assert.deepEqual(whats(result), ["'Users' is exempted from needing an index, but now has one"]);
});

// ── 4. Index entries explain themselves and TTL indexes expire ───────────────

test('an index entry with no why is reported', async (t) => {
    const manifest = MANIFEST.replace(", why: 'Login looks a user up by email.'", '');
    const result = await run(t, good({ 'packages/shared/src/db/indexes.ts': manifest }));
    assert.deepEqual(whats(result), ['the index on Users (email) carries no `why`']);
});

test('a TTL-shaped index with no expireAfterSeconds is reported', async (t) => {
    const manifest = MANIFEST.replace('options: { expireAfterSeconds: 0 }, ', '');
    const result = await run(t, good({ 'packages/shared/src/db/indexes.ts': manifest }));
    assert.deepEqual(whats(result), [
        'the index on RefreshTokens.expiresAt looks like a TTL index but has no expireAfterSeconds',
    ]);
});

test('a compound index that merely includes a date field is not asked to expire', async (t) => {
    // Only a single-key index on an expiry field can be a TTL index; asking a
    // compound one to expire would be wrong, and Mongo rejects it anyway.
    const manifest = MANIFEST.replace(
        'keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }',
        'keys: { userId: 1, expiresAt: 1 }',
    );
    const result = await run(t, good({ 'packages/shared/src/db/indexes.ts': manifest }));
    assert.deepEqual(result.problems, []);
});

// ── 5. Examples ──────────────────────────────────────────────────────────────

test('a collection with no example document is reported', async (t) => {
    const result = await run(t, good({ 'db/docs/examples/users.json': null }));
    assert.deepEqual(whats(result), ['is missing']);
});

test('an example for a collection that does not exist is reported', async (t) => {
    const result = await run(t, good({ 'db/docs/examples/forums.json': '{}' }));
    assert.deepEqual(whats(result), ['documents a collection that is not in the registry']);
});

test('a camel-case collection maps to a kebab-case example file', async (t) => {
    const manifest = MANIFEST.replace("'RefreshTokens'", "'HashDatabase'").replace(
        /collection: 'RefreshTokens'/,
        "collection: 'HashDatabase'",
    );
    const files = good({
        'packages/shared/src/db/indexes.ts': manifest,
        'packages/shared/src/db/collections.ts': TYPES.replace('RefreshTokenDoc', 'HashDatabaseDoc'),
        'db/docs/examples/refresh-tokens.json': null,
        'db/docs/examples/hash-database.json': TOKEN_EXAMPLE,
        'db/docs/architecture.md': ARCHITECTURE.replace('#### RefreshTokens', '#### HashDatabase'),
    });
    const result = await run(t, files, { collectionTypes: { Users: 'UserDoc', HashDatabase: 'HashDatabaseDoc' } });
    assert.deepEqual(result.problems, []);
});

// ── 6. Docs and examples vs the real type ────────────────────────────────────

test('a field the type declares but the doc omits is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/docs/architecture.md': ARCHITECTURE.replace('| `username` | string |\n', '') }),
    );
    assert.deepEqual(whats(result), ["the 'Users' table is missing `username`, which is a field of UserDoc"]);
});

test('a field the doc invents is reported', async (t) => {
    const result = await run(
        t,
        good({
            'db/docs/architecture.md': ARCHITECTURE.replace(
                '| `username` | string |',
                '| `username` | string |\n| `karma` | number |',
            ),
        }),
    );
    assert.deepEqual(whats(result), ["the 'Users' table documents `karma`, which is not a field of UserDoc"]);
});

test('a field listed twice in one table is reported', async (t) => {
    const result = await run(
        t,
        good({
            'db/docs/architecture.md': ARCHITECTURE.replace(
                '| `username` | string |',
                '| `username` | string |\n| `username` | text |',
            ),
        }),
    );
    assert.deepEqual(whats(result), ["the 'Users' table lists `username` more than once"]);
});

test('an example carrying a field no type declares is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/docs/examples/users.json': JSON.stringify({ ...JSON.parse(USER_EXAMPLE), karma: 3 }) }),
    );
    assert.deepEqual(whats(result), ['has `karma`, which is not a field of UserDoc']);
});

test('an example missing a required field is reported', async (t) => {
    const { username, ...rest } = JSON.parse(USER_EXAMPLE);
    const result = await run(t, good({ 'db/docs/examples/users.json': JSON.stringify(rest) }));
    assert.deepEqual(whats(result), ['is missing `username`, which UserDoc declares as required']);
});

test('an optional field may be absent from an example', async (t) => {
    // avatarKey is `avatarKey?:` and the baseline example omits it.
    const result = await run(t, good());
    assert.deepEqual(result.problems, []);
});

test('a type with an index signature accepts extra example keys', async (t) => {
    // The failure the stricter copy had: a document whose nightly jobs each
    // attach their own fields is correctly described by an open type.
    const types = TYPES.replace(
        'export type UserDoc = {\n    _id: ObjectId;',
        'export type UserDoc = {\n    [key: string]: unknown;\n    _id: ObjectId;',
    );
    const result = await run(
        t,
        good({
            'packages/shared/src/db/collections.ts': types,
            'db/docs/examples/users.json': JSON.stringify({ ...JSON.parse(USER_EXAMPLE), whateverTheJobAdded: 1 }),
        }),
    );
    assert.deepEqual(result.problems, []);
});

test('nested object fields are not mistaken for top-level ones', async (t) => {
    const types = TYPES.replace(
        '    createdAt: Date;',
        '    createdAt: Date;\n    flags: {\n        banned: boolean;\n    };',
    );
    const doc = ARCHITECTURE.replace('| `createdAt` | Date |', '| `createdAt` | Date |\n| `flags` | object |');
    const example = JSON.stringify({ ...JSON.parse(USER_EXAMPLE), flags: { banned: false } });
    const result = await run(
        t,
        good({
            'packages/shared/src/db/collections.ts': types,
            'db/docs/architecture.md': doc,
            'db/docs/examples/users.json': example,
        }),
    );
    assert.deepEqual(result.problems, []);
});

test('a collection mapped to a type that does not exist is reported', async (t) => {
    const result = await run(t, good(), { collectionTypes: { Users: 'UserDoc', RefreshTokens: 'GhostDoc' } });
    assert.deepEqual(whats(result), ['has no "type GhostDoc = { … }"']);
});

test('a collection with no collectionTypes entry is reported', async (t) => {
    const result = await run(t, good(), { collectionTypes: { Users: 'UserDoc' } });
    assert.deepEqual(whats(result), ["'RefreshTokens' has no entry in collectionTypes"]);
});

test('an example that is not valid JSON is reported, not thrown', async (t) => {
    const result = await run(t, good({ 'db/docs/examples/users.json': '{ nope' }));
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].what, /is not valid JSON/);
});

// ── 7. architecture.md ↔ the registry ────────────────────────────────────────

test('an undocumented collection is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/docs/architecture.md': ARCHITECTURE.replace('#### RefreshTokens', '#### Tokens') }),
    );
    assert.deepEqual(whats(result).sort(), [
        '\'RefreshTokens\' is not documented (expected a "#### RefreshTokens" heading)',
        "documents 'Tokens', which is not in the registry",
    ]);
});

test('a stated collection count that disagrees with the registry is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/docs/architecture.md': ARCHITECTURE.replace('**2 collections**', '**7 collections**') }),
    );
    assert.deepEqual(whats(result), ['says 7 collections; the registry has 2']);
});

test('a missing overview line is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/docs/architecture.md': ARCHITECTURE.replace('The database contains **2 collections**.\n', '') }),
    );
    assert.deepEqual(whats(result), ['has no overview line of the form "contains **N collections**"']);
});

test('a migration history listing a file that does not exist is reported', async (t) => {
    const doc = ARCHITECTURE.replace(
        '| `20260101000000-bootstrap` | Creates the collections. |',
        '| `20260101000000-bootstrap` | Creates the collections. |\n| `20260202000000-backfill` | Never written. |',
    );
    const result = await run(t, good({ 'db/docs/architecture.md': doc }));
    assert.deepEqual(whats(result), [
        'the migration history lists `20260202000000-backfill`, which is not in db/migrations/',
    ]);
});

test('a migration missing from the history is reported', async (t) => {
    const extra = 'export async function up(db) {}\n';
    const result = await run(
        t,
        good({
            'db/migrations/20260202000000-backfill.js': extra,
            'db/__tests__/backfill.test.ts': 'test("x", () => {});\n',
        }),
    );
    assert.deepEqual(whats(result), [
        'migration `20260202000000-backfill` is missing from the migration history table',
    ]);
});

// ── 8-9. Migration rules ─────────────────────────────────────────────────────

test('a migration with no test is reported', async (t) => {
    // A second file keeps the tests directory in existence, or the anchor
    // check fires first and this rule is never reached.
    const result = await run(
        t,
        good({ 'db/__tests__/bootstrap.test.ts': null, 'db/__tests__/helpers.ts': 'export const mockDb = {};\n' }),
    );
    assert.deepEqual(whats(result), ['is missing']);
});

test('a migration that exports a down() is reported', async (t) => {
    const result = await run(
        t,
        good({ 'db/migrations/20260101000000-bootstrap.js': `${BOOTSTRAP}\nexport async function down(db) {}\n` }),
    );
    assert.deepEqual(whats(result), ['exports a down()']);
});

test('a migration that creates an index is reported', async (t) => {
    const bootstrap = BOOTSTRAP.replace(
        'await db.createCollection(name);',
        'await db.collection(name).createIndex({ email: 1 });',
    );
    const result = await run(t, good({ 'db/migrations/20260101000000-bootstrap.js': bootstrap }));
    assert.deepEqual(whats(result), ['creates an index']);
});

test('a migration that exports no up() is reported', async (t) => {
    const result = await run(
        t,
        good({
            'db/migrations/20260101000000-bootstrap.js':
                "import { COLLECTIONS } from '../../packages/shared/src/db/indexes.ts';\nexport const noop = COLLECTIONS;\n",
        }),
    );
    assert.deepEqual(whats(result), ['does not export an up() function']);
});

test('a migration that fails to import is reported, not thrown', async (t) => {
    // migrate-mongo would fail the same way, at deploy time, which is the
    // whole reason the gate imports rather than reads these files.
    const result = await run(
        t,
        good({
            'db/migrations/20260101000000-bootstrap.js':
                "import x from './missing.js';\nexport async function up() {}\n",
        }),
    );
    assert.equal(result.problems.filter((p) => /fails to import under plain Node/.test(p.what)).length, 1);
});

test('a badly named migration is reported', async (t) => {
    const files = good({ 'db/migrations/backfill.js': 'export async function up(db) {}\n' });
    const result = await run(t, files);
    assert.equal(result.problems.filter((p) => /is not named/.test(p.what)).length, 1);
});

// ── 10. Immutability ─────────────────────────────────────────────────────────

test('an edited migration is reported', async (t) => {
    const files = good();
    files['db/migrations/20260101000000-bootstrap.js'] = `${BOOTSTRAP}// edited after it was merged\n`;
    const result = await run(t, files);
    assert.deepEqual(whats(result), ['has been modified since it was committed']);
});

test('a migration with no recorded checksum is reported', async (t) => {
    const result = await run(t, good({ 'db/migrations/.checksums.json': '{}' }));
    assert.deepEqual(whats(result), ['has no recorded checksum']);
});

test('a checksum recording a migration that was deleted is reported', async (t) => {
    const files = good();
    const recorded = JSON.parse(files['db/migrations/.checksums.json']);
    recorded['20259999000000-gone.js'] = 'deadbeef';
    files['db/migrations/.checksums.json'] = JSON.stringify(recorded, null, 4);
    const result = await run(t, files);
    assert.deepEqual(whats(result), ['records 20259999000000-gone.js, which no longer exists']);
});

test('a missing checksum file is reported', async (t) => {
    const result = await run(t, good({ 'db/migrations/.checksums.json': null }));
    assert.deepEqual(whats(result), ['is missing']);
});

// ── 11. dropIndex outside a migration ────────────────────────────────────────

for (const call of ['dropIndex', 'dropIndexes']) {
    test(`${call}() in app code is reported`, async (t) => {
        const result = await run(
            t,
            good({ 'api/src/lib/maintenance.ts': `await db.collection('Users').${call}('email_1');\n` }),
        );
        assert.deepEqual(whats(result), ['drops an index']);
    });
}

test('a drop inside the migrations directory is not swept', async (t) => {
    const files = good({
        'db/migrations/20260202000000-drop-old.js':
            "export async function up(db) { await db.collection('Users').dropIndex('old_1'); }\n",
        'db/__tests__/drop-old.test.ts': 'test("x", () => {});\n',
    });
    files['db/docs/architecture.md'] = ARCHITECTURE.replace(
        '| `20260101000000-bootstrap` | Creates the collections. |',
        '| `20260101000000-bootstrap` | Creates the collections. |\n| `20260202000000-drop-old` | Drops a replaced index. |',
    );
    const result = await run(t, files);
    assert.deepEqual(result.problems, []);
});

// ── 12-13. Draining ──────────────────────────────────────────────────────────

for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`a service with no ${signal} handler is reported`, async (t) => {
        const result = await run(
            t,
            good({
                'api/src/index.ts': API_ENTRY.replace(new RegExp(`process\\.on\\('${signal}', shutdown\\);\\n`), ''),
            }),
        );
        assert.deepEqual(whats(result), [`has no ${signal} handler`]);
    });
}

test('a signal named only in a comment does not count as a handler', async (t) => {
    // The real shape that made this necessary: an entry file that explains in
    // prose why SIGTERM matters, above the loop that registers the handlers.
    const entry = API_ENTRY.replace("process.on('SIGTERM', shutdown);", '// Kubernetes sends SIGTERM on pod eviction.');
    const result = await run(t, good({ 'api/src/index.ts': entry }));
    assert.deepEqual(whats(result), ['has no SIGTERM handler']);
});

test('a handler registered from an array of quoted signals counts', async (t) => {
    const entry = API_ENTRY.replace(
        "process.on('SIGTERM', shutdown);\nprocess.on('SIGINT', shutdown);",
        "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);",
    );
    const result = await run(t, good({ 'api/src/index.ts': entry }));
    assert.deepEqual(result.problems, []);
});

test('a shutdown that never closes the client is reported', async (t) => {
    const result = await run(t, good({ 'api/src/index.ts': API_ENTRY.replace('    await closeDb();\n', '') }));
    assert.deepEqual(whats(result), ['does not call closeDb() on shutdown']);
});

test('a service that closes its client another way can opt out', async (t) => {
    const result = await run(
        t,
        good({ 'api/src/index.ts': API_ENTRY.replace('    await closeDb();\n', '    await client.close();\n') }),
        {
            services: [{ name: 'api', entry: 'api/src/index.ts', closes: false }],
        },
    );
    assert.deepEqual(result.problems, []);
});

test('a drain that runs out of order is reported', async (t) => {
    const worker = `${API_ENTRY}\nawait client.close();\nawait queues.close();\nawait workers.close();\n`;
    const result = await run(t, good({ 'worker/src/index.ts': worker }), {
        services: [{ name: 'api', entry: 'api/src/index.ts' }],
        drainOrder: {
            file: 'worker/src/index.ts',
            stages: [
                { what: 'stopping the consumers', pattern: /workers\.close\(\)/ },
                { what: 'closing the queues', pattern: /queues\.close\(\)/ },
                { what: 'closing the client', pattern: /client\.close\(\)/ },
            ],
        },
    });
    assert.equal(result.problems.length, 2);
    assert.match(result.problems[0].what, /closing the queues happens before stopping the consumers/);
});

test('a drain missing a stage is reported once, naming what is gone', async (t) => {
    const worker = `${API_ENTRY}\nawait workers.close();\nawait client.close();\n`;
    const result = await run(t, good({ 'worker/src/index.ts': worker }), {
        drainOrder: {
            file: 'worker/src/index.ts',
            stages: [
                { what: 'stopping the consumers', pattern: /workers\.close\(\)/ },
                { what: 'closing the queues', pattern: /queues\.close\(\)/ },
                { what: 'closing the client', pattern: /client\.close\(\)/ },
            ],
        },
    });
    assert.deepEqual(whats(result), ['the shutdown is missing closing the queues']);
});

test('a drain in the right order is silent', async (t) => {
    const worker = `${API_ENTRY}\nawait workers.close();\nawait queues.close();\nawait client.close();\n`;
    const result = await run(t, good({ 'worker/src/index.ts': worker }), {
        drainOrder: {
            file: 'worker/src/index.ts',
            stages: [
                { what: 'stopping the consumers', pattern: /workers\.close\(\)/ },
                { what: 'closing the queues', pattern: /queues\.close\(\)/ },
                { what: 'closing the client', pattern: /client\.close\(\)/ },
            ],
        },
    });
    assert.deepEqual(result.problems, []);
});

// ── 14. The manifest is applied ──────────────────────────────────────────────

test('an applier that never calls its function is reported', async (t) => {
    const result = await run(t, good({ 'api/src/lib/db.ts': DB_TS.replace('    await ensureIndexes(db);\n', '') }));
    assert.deepEqual(whats(result), ['never calls ensureIndexes()']);
});

test('an applier reached through .then() counts as calling it', async (t) => {
    // The worker spelling in one of the repos. What matters is that the
    // function is reached, not which syntax reaches it.
    const result = await run(
        t,
        good({
            'api/src/lib/db.ts': DB_TS.replace('    await ensureIndexes(db);\n', '').replace(
                'export async function connectDb() {',
                'connect().then(ensureIndexes);\nexport async function connectDb() {',
            ),
        }),
    );
    assert.deepEqual(result.problems, []);
});

test('declaring the applier function without ever calling it is reported', async (t) => {
    // The failure this catches: a file that defines ensureIndexes() and never
    // runs it. Every environment boots with no indexes, and nothing says so.
    const db =
        DB_TS.replace('    await ensureIndexes(db);\n', '') +
        '\nasync function ensureIndexes(target) {\n    await target.createIndex();\n}\n';
    const result = await run(t, good({ 'api/src/lib/db.ts': db }));
    assert.deepEqual(whats(result), ['never calls ensureIndexes()']);
});

test('an index export nobody applies is reported', async (t) => {
    const manifest = `${MANIFEST}\nexport const ORPHAN_INDEXES: IndexSpec[] = [\n    { collection: 'Users', keys: { createdAt: 1 }, why: 'Admin listing sorts by signup date.' },\n];\n`;
    const result = await run(t, good({ 'packages/shared/src/db/indexes.ts': manifest }), {
        indexExports: ['INDEXES', 'ORPHAN_INDEXES'],
    });
    assert.deepEqual(whats(result), ['exports ORPHAN_INDEXES, which no process applies']);
});

test('an applier that does not reference its manifest export is reported', async (t) => {
    const result = await run(
        t,
        good({
            'api/src/lib/db.ts': DB_TS.replace(
                "import { INDEXES } from '@test/shared';",
                "import { SPECS } from './elsewhere.js';",
            ).replace('INDEXES', 'SPECS'),
        }),
    );
    assert.deepEqual(whats(result), ['does not reference INDEXES from packages/shared/src/db/indexes.ts']);
});

// ── 15. Migration surface ────────────────────────────────────────────────────

test('a migrate-down script is reported', async (t) => {
    const result = await run(
        t,
        good({
            'package.json': JSON.stringify(
                { scripts: { 'db:migrate': 'migrate-mongo up', 'db:migrate:down': 'migrate-mongo down' } },
                null,
                4,
            ),
        }),
    );
    assert.deepEqual(whats(result), ['exposes `db:migrate:down`']);
});

test('migrating at startup is reported', async (t) => {
    const result = await run(t, good({ 'api/src/index.ts': `${API_ENTRY}\nawait runMigrations('migrate-mongo');\n` }));
    assert.deepEqual(whats(result), ['runs migrations at startup']);
});

// ── 16. Ops script safety ────────────────────────────────────────────────────

const WIPE = `import { cfg } from './lib/env.ts';

if (process.env['NODE_ENV'] === 'production') throw new Error('refusing');
if (!process.stdin.isTTY) throw new Error('refusing without a TTY');

const answer = await confirm(\`Type \${cfg.mongoDb} to wipe it: \`);
if (answer !== cfg.mongoDb) process.exit(1);
`;

const OPS = {
    productionRefusals: ['scripts/wipe.ts'],
    wipe: { file: 'scripts/wipe.ts', dbNameExpression: 'cfg.mongoDb' },
    envLoaderConsumers: ['scripts/wipe.ts'],
    envLoader: 'lib/env.ts',
};

test('a compliant wipe script is silent', async (t) => {
    const result = await run(t, good({ 'scripts/wipe.ts': WIPE }), { ops: OPS });
    assert.deepEqual(result.problems, []);
});

test('a wipe script with no production refusal is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace(/if \(process\.env\['NODE_ENV'\][^\n]*\n/, '') }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['has no NODE_ENV=production refusal']);
});

test('a wipe script with no TTY check is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace(/if \(!process\.stdin\.isTTY\)[^\n]*\n/, '') }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['has no TTY check']);
});

test('a renamed TTY property does not satisfy the rule', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace('process.stdin.isTTY', 'process.stdin.isTTYish') }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['has no TTY check']);
});

test('a confirmation prompt that no longer names the database is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace('`Type ${cfg.mongoDb} to wipe it: `', '`Are you sure? `') }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['no longer names the database in its confirmation prompt']);
});

test('an answer no longer compared to the database name is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace('if (answer !== cfg.mongoDb)', "if (answer !== 'yes')") }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['no longer compares the typed answer to the database name']);
});

test('a script not using the shared env loader is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/wipe.ts': WIPE.replace("from './lib/env.ts'", "from 'dotenv/config'") }),
        { ops: OPS },
    );
    assert.deepEqual(whats(result), ['does not load env through lib/env.ts']);
});

const BACKUP = `const totalDocs = await countAll();
fs.writeFileSync('backups/latest.json', JSON.stringify(manifest));
fs.writeFileSync(dir + '/manifest.json', JSON.stringify(manifest));
if (totalDocs === 0) process.exit(1);
console.log(\`Backup complete: \${totalDocs}\`);
`;

test('a compliant backup script is silent', async (t) => {
    const result = await run(t, good({ 'scripts/backup.ts': BACKUP }), {
        ops: { backup: { file: 'scripts/backup.ts' } },
    });
    assert.deepEqual(result.problems, []);
});

test('a backup with no zero-document check is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/backup.ts': BACKUP.replace('if (totalDocs === 0) process.exit(1);\n', '') }),
        { ops: { backup: { file: 'scripts/backup.ts' } } },
    );
    assert.deepEqual(whats(result), ['has no zero-document check']);
});

test('a backup that checks for zero before writing the manifest is reported', async (t) => {
    const backup = `const totalDocs = await countAll();\nif (totalDocs === 0) process.exit(1);\nfs.writeFileSync('backups/latest.json', x);\nfs.writeFileSync('manifest.json', x);\n`;
    const result = await run(t, good({ 'scripts/backup.ts': backup }), {
        ops: { backup: { file: 'scripts/backup.ts' } },
    });
    assert.deepEqual(whats(result), ['checks for zero documents before writing the manifest']);
});

test('a backup that reports success before checking is reported', async (t) => {
    const backup = `const totalDocs = await countAll();\nfs.writeFileSync('backups/latest.json', x);\nfs.writeFileSync('manifest.json', x);\nconsole.log(\`Backup complete\`);\nif (totalDocs === 0) process.exit(1);\n`;
    const result = await run(t, good({ 'scripts/backup.ts': backup }), {
        ops: { backup: { file: 'scripts/backup.ts' } },
    });
    assert.deepEqual(whats(result), ['prints "Backup complete" before the zero-document check']);
});

test('a backup that writes no manifest at all is reported', async (t) => {
    const result = await run(
        t,
        good({ 'scripts/backup.ts': 'const totalDocs = 1;\nif (totalDocs === 0) process.exit(1);\n' }),
        { ops: { backup: { file: 'scripts/backup.ts' } } },
    );
    assert.deepEqual(whats(result), ['no longer writes manifest.json and latest.json']);
});

test('a restore that flushes after queueing is reported', async (t) => {
    const restore = 'await queue.add("transcode", job);\nawait redis.flushdb();\n';
    const result = await run(t, good({ 'scripts/restore.ts': restore }), {
        ops: { restore: { file: 'scripts/restore.ts' } },
    });
    assert.deepEqual(whats(result), ['flushes Redis after queueing jobs']);
});

test('a restore that flushes first is silent', async (t) => {
    const restore = 'await redis.flushdb();\nawait queue.add("transcode", job);\n';
    const result = await run(t, good({ 'scripts/restore.ts': restore }), {
        ops: { restore: { file: 'scripts/restore.ts' } },
    });
    assert.deepEqual(result.problems, []);
});

test('a type declaring flushdb() is not mistaken for a flush', async (t) => {
    // One repo types its Redis client inline. The declaration sits near the top
    // of the file, so counting it would both satisfy this rule and pass the
    // ordering check every time, whatever the code below actually did.
    const restore =
        'const redis = (await queue.client) as unknown as { flushdb(): Promise<unknown> };\nawait queue.add("transcode", job);\n';
    const result = await run(t, good({ 'scripts/restore.ts': restore }), {
        ops: { restore: { file: 'scripts/restore.ts' } },
    });
    assert.deepEqual(whats(result), ['does not flush Redis']);
});

test('a restore with no flush at all is reported', async (t) => {
    const result = await run(t, good({ 'scripts/restore.ts': 'await queue.add("transcode", job);\n' }), {
        ops: { restore: { file: 'scripts/restore.ts' } },
    });
    assert.deepEqual(whats(result), ['does not flush Redis']);
});

// ── 17. Backup health ────────────────────────────────────────────────────────

const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

test('a fresh drill and a fresh backup are silent', async (t) => {
    const files = good({
        'docs/ops/restore-drills.md': `# Drills\n\n| Date | Result |\n|---|---|\n| ${day(3)} | Passed. |\n`,
        'backups/latest.json': JSON.stringify({ completedAt: new Date().toISOString(), totalDocuments: 1200 }),
    });
    const result = await run(t, files, {
        backups: { drills: 'docs/ops/restore-drills.md', latest: 'backups/latest.json' },
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});

test('a stale drill warns and does not fail', async (t) => {
    const files = good({ 'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(200)} | Passed. |\n` });
    const result = await run(t, files, { backups: { drills: 'docs/ops/restore-drills.md' } });
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings[0], /200 days ago/);
});

test('a drill log with no entries warns', async (t) => {
    const result = await run(t, good({ 'docs/ops/restore-drills.md': '# Drills\n\nNone yet.\n' }), {
        backups: { drills: 'docs/ops/restore-drills.md' },
    });
    assert.match(result.warnings[0], /no drill has ever been logged/);
});

test('a commented-out example row does not count as a drill', async (t) => {
    const doc = `# Drills\n\n<!--\n| ${day(1)} | Example row |\n-->\n`;
    const result = await run(t, good({ 'docs/ops/restore-drills.md': doc }), {
        backups: { drills: 'docs/ops/restore-drills.md' },
    });
    assert.match(result.warnings[0], /no drill has ever been logged/);
});

test('a missing drill log fails', async (t) => {
    const result = await run(t, good(), { backups: { drills: 'docs/ops/restore-drills.md' } });
    assert.deepEqual(whats(result), ['is missing — there is no restore-drill log']);
});

test('a backup of zero documents fails rather than warns', async (t) => {
    const files = good({
        'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(1)} | Passed. |\n`,
        'backups/latest.json': JSON.stringify({ completedAt: new Date().toISOString(), totalDocuments: 0 }),
    });
    const result = await run(t, files, {
        backups: { drills: 'docs/ops/restore-drills.md', latest: 'backups/latest.json' },
    });
    assert.deepEqual(whats(result), ['records a backup that contained zero documents']);
});

test('a backups directory git does not ignore is reported', async (t) => {
    const files = good({
        'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(1)} | Passed. |\n`,
        '.gitignore': 'node_modules\n',
    });
    const root = tree(t, files);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const result = await inspectDbDrift({
        root,
        ...OPTIONS,
        backups: { drills: 'docs/ops/restore-drills.md', dir: 'backups/' },
    });
    assert.deepEqual(whats(result), ['does not ignore `backups/`']);
});

test('an ignored backups directory is silent', async (t) => {
    const files = good({
        'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(1)} | Passed. |\n`,
        '.gitignore': 'backups/\n',
    });
    const root = tree(t, files);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const result = await inspectDbDrift({
        root,
        ...OPTIONS,
        backups: { drills: 'docs/ops/restore-drills.md', dir: 'backups/' },
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
});

test('a stale backup warns', async (t) => {
    const files = good({
        'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(1)} | Passed. |\n`,
        'backups/latest.json': JSON.stringify({
            completedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            totalDocuments: 10,
        }),
    });
    const result = await run(t, files, {
        backups: { drills: 'docs/ops/restore-drills.md', latest: 'backups/latest.json' },
    });
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings[0], /completed 5 days ago/);
});

test('the drill window is configurable', async (t) => {
    const files = good({ 'docs/ops/restore-drills.md': `| Date | Result |\n|---|---|\n| ${day(100)} | Passed. |\n` });
    const result = await run(t, files, { backups: { drills: 'docs/ops/restore-drills.md', maxAgeDays: 365 } });
    assert.deepEqual(result.warnings, []);
});

// ── Optional groups ──────────────────────────────────────────────────────────

test('a repo with no backup pipeline runs every other rule', async (t) => {
    // The absence is a recorded decision in the shim, not a silent gap: with
    // `backups` omitted the drill rules do not run and nothing else changes.
    const result = await run(t, good());
    assert.deepEqual(result.problems, []);
    assert.equal(result.migrations, 1);
});
