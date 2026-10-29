/**
 * `larry({ workspaces })`: the full-stack rules follow a workspace's role, not its folder
 * name, and the roles are held to package.json. What is worth testing is that a workspace
 * added to a role gets every rule the role has — the gap this closed was a fifth backend
 * that got the shared rules and none of the service ones — and that forgetting to add it
 * fails loudly instead of linting less.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';

import { larry } from '../src/eslint/index.ts';
import { fullstackStandards } from '../src/eslint/fullstack/index.ts';
import { electronStandards } from '../src/eslint/electron/index.ts';

/** No package.json here, so the guard has nothing to hold the roles to and stays out of the way. */
const ROOT = '/tmp/lint-config-workspaces-test';

const config = (workspaces, rootDir = ROOT) =>
    larry({ preset: 'fullstack', rootDir, workspaces, standards: fullstackStandards() });

const severityOf = async (configBlocks, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: configBlocks, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved?.rules[rule] ?? 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

/** One rule from each place a service's rules come from: logging, security, typescript, refactoring, db, the preset. */
const SERVICE_RULES = [
    'no-console',
    'no-eval',
    'no-restricted-exports',
    'max-depth',
    'no-restricted-syntax',
    '@typescript-eslint/explicit-function-return-type',
];

test('a service added to the role gets every rule the role has', async () => {
    const withIngestor = config({ services: ['worker', 'ingestor'] });
    for (const rule of SERVICE_RULES) {
        assert.equal(await severityOf(withIngestor, 'ingestor/src/feed.ts', rule), 2, rule);
        assert.equal(await severityOf(withIngestor, 'worker/src/jobs.ts', rule), 2, `${rule} (worker keeps it)`);
    }
});

test('a workspace in no role gets none of them', async () => {
    for (const rule of SERVICE_RULES) {
        assert.notEqual(await severityOf(config(), 'ingestor/src/feed.ts', rule), 2, rule);
    }
});

test('a service is a Node process: Node globals, not browser ones', async () => {
    const eslint = new ESLint({
        overrideConfigFile: true,
        baseConfig: config({ services: ['worker', 'ingestor'] }),
        cwd: ROOT,
    });
    const { languageOptions } = await eslint.calculateConfigForFile(`${ROOT}/ingestor/src/feed.ts`);
    assert.ok('process' in languageOptions.globals);
    assert.ok(!('window' in languageOptions.globals));
});

test('the frontend role moves every frontend rule with it, locale files included', async () => {
    const web = config({ frontend: 'web' });
    assert.equal(await severityOf(web, 'web/src/App.vue', 'vue/no-v-html'), 2);
    assert.equal(await severityOf(web, 'web/src/App.vue', 'no-console'), 2);
    assert.equal(
        await severityOf(web, 'web/src/i18n/locales/en.json', '@intlify/vue-i18n/no-duplicate-keys-in-locale'),
        2,
    );
    // The Vue preset still warns there; the error is the frontend role's.
    assert.equal(await severityOf(web, 'frontend/src/App.vue', 'vue/no-v-html'), 1);
});

test('the default roles are the four the family started with', async () => {
    for (const file of ['api/src/app.ts', 'worker/src/index.ts', 'packages/shared/src/index.ts']) {
        assert.equal(await severityOf(config(), file, 'no-eval'), 2, file);
    }
});

test('workspaces belong to the full-stack preset only', () => {
    assert.throws(
        () => larry({ preset: 'electron', rootDir: ROOT, workspaces: { services: ['worker'] } }),
        /is for the full-stack preset/,
    );
    assert.throws(
        () => larry({ preset: 'electron', rootDir: ROOT, standards: fullstackStandards() }),
        /needs preset: 'fullstack'/,
    );
    assert.doesNotThrow(() => larry({ preset: 'electron', rootDir: ROOT, standards: electronStandards() }));
});

// ── The guard ───────────────────────────────────────────────────────────────

/** A throwaway repo: package.json `workspaces`, and a `src/` in each folder listed in `withSource`. */
const repo = (t, workspaces, withSource) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-workspaces-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces }));
    for (const dir of withSource) mkdirSync(path.join(root, dir, 'src'), { recursive: true });
    return root;
};

const FAMILY = ['frontend', 'api', 'worker', 'packages/shared'];

test('GUARD: a workspace with a src/ and no role fails the config', (t) => {
    const root = repo(t, [...FAMILY, 'ingestor'], [...FAMILY, 'ingestor']);
    assert.throws(() => config({}, root), /'ingestor' is a workspace with a src\/ but has no role/);
    assert.doesNotThrow(() => config({ services: ['worker', 'ingestor'] }, root));
});

test('GUARD: a role naming a folder with no src/ fails the config', (t) => {
    const root = repo(t, FAMILY, FAMILY);
    assert.throws(() => config({ services: ['worker', 'ingestr'] }, root), /names 'ingestr', which has no src\//);
});

test('a workspace without a src/ needs no role — migrations are not source', (t) => {
    const root = repo(t, [...FAMILY, 'db'], FAMILY);
    assert.doesNotThrow(() => config({}, root));
});

test('GUARD: a trailing /* in package.json is expanded before the roles are checked', (t) => {
    const root = repo(t, ['frontend', 'api', 'worker', 'packages/*'], [...FAMILY, 'packages/billing']);
    assert.throws(() => config({}, root), /'packages\/billing' is a workspace/);
    assert.doesNotThrow(() => config({ shared: ['packages/shared', 'packages/billing'] }, root));
});

test('every problem is reported at once, not the first alone', (t) => {
    const root = repo(t, [...FAMILY, 'ingestor', 'mailer'], [...FAMILY, 'ingestor', 'mailer']);
    assert.throws(
        () => config({}, root),
        (error) => /'ingestor'/.test(error.message) && /'mailer'/.test(error.message),
    );
});
