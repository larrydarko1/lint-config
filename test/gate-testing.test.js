import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repoFiles } from '../src/gates/lib/files.ts';
import { duplicateTitles, inspectTesting } from '../src/gates/testing.ts';

const CONFIG = [
    'export default {',
    '    test: {',
    "        environment: 'jsdom',",
    '        coverage: {',
    '            thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },',
    "            exclude: ['**/*.d.ts'],",
    '        },',
    '    },',
    '};',
].join('\n');

const SUITE = [
    "describe('thing', () => {",
    "    it('works', () => {",
    '        expect(1).toBe(1);',
    '    });',
    '});',
    '',
].join('\n');

/** A temp repo with a git index, because the gate asks git which files exist. */
const repo = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
};

/** A repo that passes everything, so a case only has to break one thing. */
const good = (overrides = {}) => ({
    'vitest.config.ts': CONFIG,
    'package.json': '{ "devDependencies": {} }',
    'tests/renderer/thing.test.ts': SUITE,
    ...overrides,
});

const MIRRORED = { kind: 'mirrored', root: 'tests', areas: ['main', 'renderer'] };

const run = (root, options = {}) =>
    inspectTesting({
        root,
        config: 'vitest.config.ts',
        layout: MIRRORED,
        excludes: { '**/*.d.ts': 'declarations, no runtime' },
        ...options,
    });

const whats = (result) => result.problems.map((p) => p.what);

// ── The file list ───────────────────────────────────────────────────────────
test('a correct repo has no problems', (t) => {
    assert.deepEqual(run(repo(t, good())).problems, []);
});

test('a file staged for deletion is not read', (t) => {
    const root = repo(t, good());
    execFileSync('git', ['add', '-A'], { cwd: root });
    fs.rmSync(path.join(root, 'tests/renderer/thing.test.ts'));
    assert.ok(!repoFiles(root).includes('tests/renderer/thing.test.ts'));
    assert.deepEqual(run(root).problems, []);
});

// ── 1. Placement ────────────────────────────────────────────────────────────
test('a mirrored project fails a co-located suite', (t) => {
    const root = repo(t, good({ 'src/renderer/__tests__/thing.test.ts': SUITE }));
    assert.deepEqual(whats(run(root)), ['a co-located `__tests__/` suite']);
});

test('a mirrored project fails a suite outside the test root', (t) => {
    const root = repo(t, good({ 'src/thing.test.ts': SUITE }));
    assert.deepEqual(whats(run(root)), ['a .test.ts outside `tests/`']);
});

test('a mirrored project fails an area that mirrors nothing', (t) => {
    const root = repo(t, good({ 'tests/widgets/thing.test.ts': SUITE }));
    assert.deepEqual(whats(run(root)), ['sits under `tests/widgets/`, which mirrors no `src/` directory']);
});

test('a mirrored project with no area list allows any area', (t) => {
    const root = repo(t, good({ 'tests/widgets/thing.test.ts': SUITE }));
    assert.deepEqual(run(root, { layout: { kind: 'mirrored', root: 'tests' } }).problems, []);
});

test('a co-located project fails a suite outside `__tests__/`', (t) => {
    const root = repo(t, {
        'vitest.config.ts': CONFIG,
        'package.json': '{}',
        'src/__tests__/a.test.ts': SUITE,
        'src/b.test.ts': SUITE,
    });
    assert.deepEqual(whats(run(root, { layout: { kind: 'colocated' } })), [
        'a .test.ts outside a `__tests__/` directory',
    ]);
});

test('the co-located message counts the suites that got it right', (t) => {
    const root = repo(t, {
        'vitest.config.ts': CONFIG,
        'package.json': '{}',
        'src/__tests__/a.test.ts': SUITE,
        'src/__tests__/b.test.ts': SUITE,
        'src/c.test.ts': SUITE,
    });
    assert.match(run(root, { layout: { kind: 'colocated' } }).problems[0].why, /all 2 other suites/);
});

// ── 2 & 3. Where E2E lives, which may be nowhere ────────────────────────────
test('a .spec file fails where there is deliberately no E2E suite', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.spec.ts': SUITE }));
    assert.deepEqual(whats(run(root)), ['a .spec file']);
});

test('an e2e directory appearing unannounced fails', (t) => {
    const root = repo(t, good({ 'e2e/login.ts': 'export {};\n' }));
    assert.deepEqual(whats(run(root)), ['an E2E suite appearing without discussion']);
});

test('a playwright dependency fails the same way, through the manifest', (t) => {
    const root = repo(t, good({ 'package.json': '{ "devDependencies": { "@playwright/test": "^1.0.0" } }' }));
    assert.deepEqual(whats(run(root)), ['`@playwright/test` is installed']);
});

test('a .spec outside the e2e directory fails when E2E does exist', (t) => {
    const root = repo(t, good({ 'src/thing.spec.ts': SUITE, 'e2e/playwright.config.ts': 'export default {};\n' }));
    assert.deepEqual(whats(run(root, { e2e: { dir: 'e2e', config: 'e2e/playwright.config.ts' } })), [
        'a .spec file outside `e2e/`',
    ]);
});

test('a spec with no playwright config fails', (t) => {
    const root = repo(t, good({ 'e2e/login.spec.ts': SUITE }));
    assert.deepEqual(whats(run(root, { e2e: { dir: 'e2e', config: 'e2e/playwright.config.ts' } })), ['missing']);
});

test('the config is demanded by the specs, not unconditionally', (t) => {
    const root = repo(t, good());
    assert.deepEqual(run(root, { e2e: { dir: 'e2e', config: 'e2e/playwright.config.ts' } }).problems, []);
});

// ── 4. The coverage config ──────────────────────────────────────────────────
test('a lowered threshold fails, naming both numbers', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace('branches: 80', 'branches: 70') }));
    assert.deepEqual(whats(run(root)), ['`branches` threshold lowered to 70 (floor is 80)']);
});

test('a raised threshold is fine', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace('branches: 80', 'branches: 95') }));
    assert.deepEqual(run(root).problems, []);
});

test('a missing metric fails', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace('functions: 80, ', '') }));
    assert.deepEqual(whats(run(root)), ['no `functions` threshold']);
});

test('a thresholds block this gate cannot read fails rather than passing', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace('thresholds:', 'limits:') }));
    assert.deepEqual(whats(run(root)), ['no `thresholds` block found in the coverage config']);
});

test('a new exclude fails', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace("'**/*.d.ts'", "'**/*.d.ts', 'src/hard.ts'") }));
    assert.deepEqual(whats(run(root)), ['new coverage exclude `src/hard.ts`']);
});

test('an exclude that is no longer in the config fails too, so the lists stay in step', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace("'**/*.d.ts'", '') }));
    assert.deepEqual(whats(run(root)), ['`**/*.d.ts` is no longer excluded from coverage']);
});

test('a missing exclude list fails', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace('exclude:', 'skip:') }));
    assert.deepEqual(whats(run(root)), ['no coverage `exclude` list found']);
});

// ── 5. Nothing at 0% ────────────────────────────────────────────────────────
const summary = (entries) => JSON.stringify({ total: { statements: { total: 1, covered: 1 } }, ...entries });

test('a file with no covered statement fails', (t) => {
    const root = repo(
        t,
        good({
            'coverage/coverage-summary.json': summary({ 'src/dead.ts': { statements: { total: 12, covered: 0 } } }),
        }),
    );
    assert.deepEqual(whats(run(root)), ['0% of 12 statement(s) covered — no test imports this file']);
});

test('a component at 0% is reported as never rendered', (t) => {
    const root = repo(
        t,
        good({
            'coverage/coverage-summary.json': summary({ 'src/IconX.vue': { statements: { total: 1, covered: 0 } } }),
        }),
    );
    assert.deepEqual(whats(run(root)), ['0% of 1 statement(s) covered — no test renders this component']);
});

test('a file with nothing to cover is not a gap', (t) => {
    const root = repo(
        t,
        good({
            'coverage/coverage-summary.json': summary({ 'src/types.ts': { statements: { total: 0, covered: 0 } } }),
        }),
    );
    assert.deepEqual(run(root).problems, []);
});

test('an absolute key is reported relative to the repo', (t) => {
    const root = repo(t, good());
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'coverage/coverage-summary.json'),
        summary({ [path.join(root, 'src/dead.ts')]: { statements: { total: 3, covered: 0 } } }),
    );
    assert.deepEqual(
        run(root).problems.map((p) => p.file),
        ['src/dead.ts'],
    );
});

test('no coverage report means the section is skipped, and says so', (t) => {
    const result = run(repo(t, good()));
    assert.equal(result.haveCoverage, false);
    assert.deepEqual(result.problems, []);
});

test('the counts come back for the summary line', (t) => {
    const root = repo(
        t,
        good({
            'coverage/coverage-summary.json': summary({
                'src/a.ts': { statements: { total: 3, covered: 3 } },
                'src/b.ts': { statements: { total: 3, covered: 0 } },
            }),
        }),
    );
    const result = run(root);
    assert.equal(result.measured, 2);
    assert.equal(result.uncovered, 1);
});

// ── 6. Suite hygiene ────────────────────────────────────────────────────────
test('a parked `.only` fails, with its line', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': SUITE.replace('it(', 'it.only(') }));
    assert.deepEqual(
        run(root).problems.map((p) => `${p.file} ${p.what}`),
        ['tests/renderer/thing.test.ts:2 a parked `.only`'],
    );
});

test('a parked `.skip` fails', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': SUITE.replace('it(', 'it.skip(') }));
    assert.deepEqual(whats(run(root)), ['a parked `.skip`']);
});

test('a bare `test()` fails, because one vocabulary per suite', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': SUITE.replace('    it(', '    test(') }));
    assert.deepEqual(whats(run(root)), ['a bare `test()`']);
});

test('a commented-out test fails', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `${SUITE}// it('later', () => {});\n` }));
    assert.deepEqual(whats(run(root)), ['a commented-out test']);
});

test('the word test inside a sentence is not a bare test()', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `${SUITE}// this is the latest(ish) note\n` }));
    assert.deepEqual(run(root).problems, []);
});

// ── Duplicate titles ────────────────────────────────────────────────────────
test('two cases with one title in the same describe are a copy-paste', () => {
    const source = ["describe('a', () => {", "    it('works', () => {});", "    it('works', () => {});", '});'].join(
        '\n',
    );
    assert.deepEqual(duplicateTitles(source), [{ title: 'a › works', count: 2 }]);
});

test('the same title in two different describes is fine', () => {
    const source = [
        "describe('a', () => {",
        "    it('works', () => {});",
        '});',
        "describe('b', () => {",
        "    it('works', () => {});",
        '});',
    ].join('\n');
    assert.deepEqual(duplicateTitles(source), []);
});

test('a duplicate title is reported against the file', (t) => {
    const source = [
        "describe('a', () => {",
        "    it('works', () => {});",
        "    it('works', () => {});",
        '});',
        '',
    ].join('\n');
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': source }));
    assert.deepEqual(whats(run(root)), ['2 cases titled `a › works` in the same describe']);
});

// ── 7. The transport ────────────────────────────────────────────────────────
test('mocking axios directly fails', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `vi.mock('axios');\n${SUITE}` }));
    assert.deepEqual(whats(run(root)), ['patches axios or fetch directly']);
});

test('assigning globalThis.fetch fails', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `globalThis.fetch = vi.fn();\n${SUITE}` }));
    assert.deepEqual(whats(run(root)), ['patches axios or fetch directly']);
});

test('stubbing the fetch global fails', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `vi.stubGlobal('fetch', vi.fn());\n${SUITE}` }));
    assert.deepEqual(whats(run(root)), ['patches axios or fetch directly']);
});

test('mocking a module that is not the transport is fine', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `vi.mock('@/api/client.js');\n${SUITE}` }));
    assert.deepEqual(run(root).problems, []);
});

// ── 7 with apiClient. The request path the mock server checks ───────────────
const CLIENT = { apiClient: { module: '@/api/client', exports: ['call', 'api'] } };
const withMock = (mock) => good({ 'tests/renderer/thing.test.ts': `${mock}\n${SUITE}` });
const where = (result) => result.problems.map((p) => `${p.file} ${p.what}`);

test('replacing the typed caller fails, at the vi.mock', (t) => {
    const mock = "vi.mock('@/api/client', () => ({\n    call: vi.fn(),\n    isAuthenticated: () => true,\n}));";
    assert.deepEqual(where(run(repo(t, withMock(mock)), CLIENT)), [
        'tests/renderer/thing.test.ts:1 replaces `call` from @/api/client',
    ]);
});

test('replacing the HTTP instance under it fails too', (t) => {
    const mock =
        "vi.mock('@/api/client', async (importOriginal) => ({\n    ...(await importOriginal()),\n    api: { post: h.post },\n}));";
    assert.deepEqual(whats(run(repo(t, withMock(mock)), CLIENT)), ['replaces `api` from @/api/client']);
});

test('a shorthand property replaces it as surely as a keyed one', (t) => {
    const mock = "const call = vi.fn();\nvi.mock('@/api/client', () => ({ isAuthenticated, call }));";
    assert.deepEqual(whats(run(repo(t, withMock(mock)), CLIENT)), ['replaces `call` from @/api/client']);
});

test('an automock with no factory replaces every export', (t) => {
    assert.deepEqual(whats(run(repo(t, withMock("vi.mock('@/api/client');")), CLIENT)), [
        'replaces `call` from @/api/client',
        'replaces `api` from @/api/client',
    ]);
});

test('vi.doMock and vi.spyOn replace it too', (t) => {
    const doMock = "vi.doMock('@/api/client', () => ({ call: vi.fn() }));";
    const spy = "vi.spyOn(client, 'call').mockResolvedValue({ data: {} });";
    assert.deepEqual(whats(run(repo(t, withMock(doMock)), CLIENT)), ['replaces `call` from @/api/client']);
    assert.deepEqual(whats(run(repo(t, withMock(spy)), CLIENT)), ['replaces `call` from @/api/client']);
});

test("replacing the client module's other exports, around the real caller, is fine", (t) => {
    const mock =
        "vi.mock('@/api/client', async (importOriginal) => ({\n    ...(await importOriginal()),\n    setAccessToken: h.setAccessToken,\n    recall: vi.fn(),\n    apiErrorMessage: (e, fallback) => fallback,\n}));";
    assert.deepEqual(run(repo(t, withMock(mock)), CLIENT).problems, []);
});

test('a property merely reading the caller, or a mock of another module, is fine', (t) => {
    const mock =
        "vi.mock('@/api/account', () => ({ call: vi.fn() }));\nvi.mock('@/api/client', () => ({ wrapped: h.call }));";
    assert.deepEqual(run(repo(t, withMock(mock)), CLIENT).problems, []);
});

test('a replacement left in a comment is not one', (t) => {
    const mock = "// vi.mock('@/api/client', () => ({ call: vi.fn() }));";
    assert.deepEqual(run(repo(t, withMock(mock)), CLIENT).problems, []);
});

test('a repo that names no API client is not graded on it', (t) => {
    assert.deepEqual(run(repo(t, withMock("vi.mock('@/api/client', () => ({ call: vi.fn() }));"))).problems, []);
});

// ── 8. Component internals ──────────────────────────────────────────────────
test('reading wrapper.vm fails while the baseline is zero', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `${SUITE}// wrapper.vm.count\n` }));
    assert.deepEqual(whats(run(root)), ["reads a component's internals through `wrapper.vm`"]);
});

test('a baseline licenses exactly as many sites as it names', (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `${SUITE}const a = wrapper.vm.count;\n` }));
    assert.deepEqual(run(root, { vmBaseline: 1 }).problems, []);
});

test('a baseline above the real count fails, so the ratchet cannot slip back', (t) => {
    const root = repo(t, good());
    assert.deepEqual(whats(run(root, { vmBaseline: 2 })), ['`vmBaseline` is 2 but only 0 sites remain']);
});

test("Vue's public instance API is not an internal", (t) => {
    const root = repo(t, good({ 'tests/renderer/thing.test.ts': `${SUITE}await wrapper.vm.$nextTick();\n` }));
    assert.deepEqual(run(root).problems, []);
});

// ── 9. The DOM environment ──────────────────────────────────────────────────
const DOM = { name: 'jsdom', config: 'vitest.config.ts' };

test('the configured environment must be the one the standard names', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace("'jsdom'", "'happy-dom'") }));
    assert.deepEqual(whats(run(root, { domEnvironment: DOM })), [
        'tests run on `happy-dom`, but the standard names `jsdom`',
    ]);
});

test('an environment this gate cannot read fails rather than passing', (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace("environment: 'jsdom',", '') }));
    assert.deepEqual(whats(run(root, { domEnvironment: DOM })), ['could not read the tests `environment`']);
});

test('a named project is read out of a multi-project config', (t) => {
    const multi = [
        'export default {',
        '    test: {',
        '        projects: [',
        "            { test: { name: 'api', environment: 'node' } },",
        "            { test: { name: 'frontend', environment: 'happy-dom' } },",
        '        ],',
        '        coverage: {',
        '            thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },',
        "            exclude: ['**/*.d.ts'],",
        '        },',
        '    },',
        '};',
    ].join('\n');
    const root = repo(t, good({ 'vitest.config.ts': multi }));
    assert.deepEqual(whats(run(root, { domEnvironment: { ...DOM, project: 'frontend' } })), [
        'frontend tests run on `happy-dom`, but the standard names `jsdom`',
    ]);
});

test('an @vitest-environment pragma that disagrees with the config fails', (t) => {
    const root = repo(
        t,
        good({
            'tests/renderer/thing.test.ts': `// @vitest-environment node\n${SUITE}`,
        }),
    );
    assert.deepEqual(whats(run(root, { domEnvironment: DOM })), [
        'pins itself to `node` with an @vitest-environment pragma',
    ]);
});

test('a pragma that agrees with the config is fine', (t) => {
    const root = repo(
        t,
        good({
            'tests/renderer/thing.test.ts': `// @vitest-environment jsdom\n${SUITE}`,
        }),
    );
    assert.deepEqual(run(root, { domEnvironment: DOM }).problems, []);
});

test("no domEnvironment means the environment is not this gate's business", (t) => {
    const root = repo(t, good({ 'vitest.config.ts': CONFIG.replace("'jsdom'", "'happy-dom'") }));
    assert.deepEqual(run(root).problems, []);
});

// ── 10. A server error fails the E2E run ─────────────────────────────────────
const E2E = { dir: 'e2e', config: 'e2e/playwright.config.ts' };
const WIRING = { fixtures: 'e2e/support/fixtures.ts', teardown: 'e2e/support/global-teardown.ts' };

const PLAYWRIGHT_CONFIG = [
    'export default defineConfig({',
    "    globalTeardown: './support/global-teardown.ts',",
    '    webServer: [{ command: "npm run dev", env: { LOG_FILE: API_LOG } }],',
    '});',
    '',
].join('\n');

const FIXTURES = [
    "import { createServerErrorRecorder } from '@larrydarko/lint-config/server-errors';",
    "import { test as base, expect } from '@playwright/test';",
    '',
    'export const test = base.extend({',
    "    serverErrors: [async ({}, use) => use(createServerErrorRecorder({ logFile: API_LOG })), { scope: 'worker' }],",
    '    noServerErrors: [',
    '        async ({ serverErrors }, use) => {',
    '            await use();',
    '            expect(await serverErrors.drain()).toEqual([]);',
    '        },',
    '        { auto: true },',
    '    ],',
    '    context: async ({ context, serverErrors }, use) => {',
    '        serverErrors.watch(context);',
    '        await use(context);',
    '    },',
    '});',
    '',
].join('\n');

const TEARDOWN = [
    "import { logErrors } from '@larrydarko/lint-config/server-errors';",
    '',
    'export default function globalTeardown() {',
    '    if (logErrors(API_LOG).length > 0) throw new Error("the API logged errors");',
    '}',
    '',
].join('\n');

const SPEC = [
    "import { test, expect } from '../support/fixtures';",
    '',
    "test('logs in', async ({ page }) => {",
    "    await page.goto('/');",
    '});',
    '',
].join('\n');

const tripwired = (overrides = {}) =>
    good({
        'e2e/playwright.config.ts': PLAYWRIGHT_CONFIG,
        'e2e/support/fixtures.ts': FIXTURES,
        'e2e/support/global-teardown.ts': TEARDOWN,
        'e2e/tests/login.spec.ts': SPEC,
        ...overrides,
    });

const runTripwire = (root) => run(root, { e2e: E2E, serverErrors: WIRING });

test('a suite wired to the server-error tripwire has no problems', (t) => {
    assert.deepEqual(runTripwire(repo(t, tripwired())).problems, []);
});

test('fixtures without the recorder fail', (t) => {
    const root = repo(t, tripwired({ 'e2e/support/fixtures.ts': "export { test } from '@playwright/test';\n" }));
    assert.deepEqual(whats(runTripwire(root)), ['never creates a server-error recorder']);
});

test('a recorder without the API log fails, since its failures could not say why', (t) => {
    const root = repo(t, tripwired({ 'e2e/support/fixtures.ts': FIXTURES.replace('{ logFile: API_LOG }', '') }));
    assert.deepEqual(whats(runTripwire(root)), ["creates the server-error recorder without the API's `logFile`"]);
});

test('a recorder that is never drained fails', (t) => {
    const root = repo(
        t,
        tripwired({ 'e2e/support/fixtures.ts': FIXTURES.replace('await serverErrors.drain()', '[]') }),
    );
    assert.deepEqual(whats(runTripwire(root)), ['never drains the recorder for server errors']);
});

test('a recorder that watches no context fails', (t) => {
    const root = repo(
        t,
        tripwired({ 'e2e/support/fixtures.ts': FIXTURES.replace('        serverErrors.watch(context);\n', '') }),
    );
    assert.deepEqual(whats(runTripwire(root)), ['never watches a browser context for server errors']);
});

test("another recorder's watch does not answer for this one", (t) => {
    const fixtures = FIXTURES.replace('        serverErrors.watch(context);\n', '        leaks.watch(context);\n');
    const root = repo(t, tripwired({ 'e2e/support/fixtures.ts': fixtures }));
    assert.deepEqual(whats(runTripwire(root)), ['never watches a browser context for server errors']);
});

test('a recorder held in a variable is found by that name', (t) => {
    const fixtures = [
        "import { createServerErrorRecorder } from '@larrydarko/lint-config/server-errors';",
        '',
        'const recorder = createServerErrorRecorder({ logFile: API_LOG });',
        'export const test = base.extend({',
        '    noServerErrors: [async ({ context }, use) => { recorder.watch(context); await use(); await recorder.drain(); }, { auto: true }],',
        '});',
        '',
    ].join('\n');
    assert.deepEqual(runTripwire(repo(t, tripwired({ 'e2e/support/fixtures.ts': fixtures }))).problems, []);
});

test('a teardown that never reads the log fails', (t) => {
    const root = repo(t, tripwired({ 'e2e/support/global-teardown.ts': 'export default function teardown() {}\n' }));
    assert.deepEqual(whats(runTripwire(root)), ['never reads the API log with `logErrors`']);
});

test('a config that never registers the teardown fails', (t) => {
    const config = PLAYWRIGHT_CONFIG.replace("    globalTeardown: './support/global-teardown.ts',\n", '');
    const root = repo(t, tripwired({ 'e2e/playwright.config.ts': config }));
    assert.deepEqual(whats(runTripwire(root)), ['does not run `e2e/support/global-teardown.ts` as its globalTeardown']);
});

test('a config that boots the API without a log file fails', (t) => {
    const config = PLAYWRIGHT_CONFIG.replace('LOG_FILE: API_LOG', 'NODE_ENV: "test"');
    const root = repo(t, tripwired({ 'e2e/playwright.config.ts': config }));
    assert.deepEqual(whats(runTripwire(root)), ['does not hand the API a `LOG_FILE`']);
});

test('a spec taking test from Playwright itself fails at its line; one taking only expect is fine', (t) => {
    const root = repo(
        t,
        tripwired({
            'e2e/tests/bare.spec.ts': SPEC.replace("from '../support/fixtures'", "from '@playwright/test'"),
            'e2e/tests/expect.spec.ts': `import { expect } from '@playwright/test';\n\n${SPEC}`,
        }),
    );
    const problems = runTripwire(root).problems.map((p) => `${p.file} ${p.what}`);
    assert.deepEqual(problems, [
        'e2e/tests/bare.spec.ts:1 imports `test` from @playwright/test, not from the fixtures',
    ]);
});

test('the tripwire stated without an E2E suite fails', (t) => {
    const root = repo(t, good());
    assert.deepEqual(whats(run(root, { serverErrors: WIRING })), [
        '`serverErrors` is stated but there is no E2E suite',
    ]);
});

test('a missing fixtures module and teardown are each reported', (t) => {
    const root = repo(t, good({ 'e2e/playwright.config.ts': PLAYWRIGHT_CONFIG, 'e2e/tests/login.spec.ts': SPEC }));
    assert.deepEqual(whats(runTripwire(root)), ['missing', 'missing']);
});
