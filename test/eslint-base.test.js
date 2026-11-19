/**
 * The base preset: for a project no family describes, so nothing about its layout is
 * assumed. What is worth testing is that it cannot be used without naming where the code
 * is, that what it names reaches the rules, and that a glob pointing at nothing fails
 * loudly instead of linting less.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';

import { larry } from '../src/eslint/index.ts';
import { resolvePaths } from '../src/eslint/presets.ts';
import { baseStandards } from '../src/eslint/base/index.ts';
import { libraryStandards } from '../src/eslint/library/index.ts';

/** No package.json here, so the guard has nothing to hold the paths to and stays out of the way. */
const ROOT = '/tmp/lint-config-base-test';

/** A Node project with its code in `lib/` and its suites in `spec/`, like none of the families. */
const PATHS = {
    source: ['lib/**/*.ts'],
    tests: ['spec/**/*.ts'],
    browser: [],
    node: ['lib/**/*.ts', 'spec/**/*.ts'],
};

const calculate = async (configBlocks, file) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: configBlocks, cwd: ROOT });
    return eslint.calculateConfigForFile(`${ROOT}/${file}`);
};

const severityOf = async (configBlocks, file, rule) => {
    const entry = (await calculate(configBlocks, file))?.rules[rule] ?? 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

// ── Paths ───────────────────────────────────────────────────────────────────

test('the base preset has no layout to fall back on, so it names every path it is missing', () => {
    assert.throws(
        () => larry({ preset: 'base', rootDir: ROOT }),
        /must name source, tests, browser, node\. Missing: source, tests, browser, node\. An area with no files takes \[\]/,
    );
    assert.throws(
        () => larry({ preset: 'base', rootDir: ROOT, paths: { source: ['lib/**/*.ts'], tests: [] } }),
        /Missing: browser, node\./,
    );
});

test('what the project names is its paths, and the type-aware rules reach its source and its tests', () => {
    const paths = resolvePaths('base', PATHS);
    assert.deepEqual(paths.typedSource, ['lib/**/*.ts', 'spec/**/*.ts']);
    assert.deepEqual(paths.vue, []);
    assert.ok(paths.ignores.includes('**/node_modules/'));
    assert.deepEqual(resolvePaths('base', { ...PATHS, typedSource: ['lib/**/*.ts'] }).typedSource, ['lib/**/*.ts']);
});

test('the base preset has no roles: layout, workspaces and roles passed to resolvePaths are refused', () => {
    assert.throws(
        () => larry({ preset: 'base', rootDir: ROOT, paths: PATHS, layout: { src: 'lib' } }),
        /the base preset has none, so name its globs in `paths`/,
    );
    assert.throws(
        () => larry({ preset: 'base', rootDir: ROOT, paths: PATHS, workspaces: { api: 'server' } }),
        /'base' has no workspaces/,
    );
    assert.throws(() => resolvePaths('base', PATHS, { src: 'lib' }), /no roles to move/);
});

test('a project with no Node code, or none in a browser, gets a config ESLint accepts', async () => {
    const browserOnly = larry({ preset: 'base', rootDir: ROOT, paths: { ...PATHS, browser: PATHS.source, node: [] } });
    const config = await calculate(browserOnly, 'lib/index.ts');
    assert.equal(config.languageOptions.globals.window, false);
    assert.equal(config.languageOptions.globals.process, undefined);

    const nodeOnly = await calculate(larry({ preset: 'base', rootDir: ROOT, paths: PATHS }), 'lib/index.ts');
    assert.equal(nodeOnly.languageOptions.globals.window, undefined);
    assert.ok('process' in nodeOnly.languageOptions.globals);
});

test('the base preset assumes no components, and a project with some turns Vue on', async () => {
    assert.equal(
        await severityOf(larry({ preset: 'base', rootDir: ROOT, paths: PATHS }), 'lib/a.vue', 'vue/require-v-for-key'),
        'absent',
    );
    const withVue = larry({ preset: 'base', rootDir: ROOT, vue: true, paths: { ...PATHS, vue: ['lib/**/*.vue'] } });
    assert.equal(await severityOf(withVue, 'lib/a.vue', 'vue/require-v-for-key'), 2);
});

// ── Standards ───────────────────────────────────────────────────────────────

test("baseStandards() follows the project's paths, and stays out of what it does not name", async () => {
    const config = larry({ preset: 'base', rootDir: ROOT, paths: PATHS, standards: baseStandards() });
    assert.equal(await severityOf(config, 'lib/index.ts', 'no-restricted-exports'), 2);
    assert.deepEqual((await calculate(config, 'lib/index.ts')).rules['max-depth'], [2, 3]);
    assert.deepEqual((await calculate(config, 'spec/index.ts')).rules['max-depth'], [2, 4]);
    assert.equal(await severityOf(config, 'spec/index.ts', 'no-eval'), 2);
    assert.equal(await severityOf(config, 'src/index.ts', 'no-restricted-exports'), 'absent');
});

test('baseStandards() assumes nothing about logging, the environment or the test runner', async () => {
    const config = larry({ preset: 'base', rootDir: ROOT, paths: PATHS, standards: baseStandards() });
    for (const rule of ['no-console', 'no-process-env', 'no-restricted-properties']) {
        assert.equal(await severityOf(config, 'lib/index.ts', rule), 'absent', rule);
    }
});

test("the base preset's standards are its own, and its own belong to it", () => {
    assert.throws(
        () => larry({ preset: 'library', rootDir: ROOT, standards: baseStandards() }),
        /baseStandards\(\) needs preset: 'base', not 'library'/,
    );
    assert.throws(
        () => larry({ preset: 'base', rootDir: ROOT, paths: PATHS, standards: libraryStandards() }),
        /libraryStandards\(\) needs preset: 'library', not 'base'/,
    );
});

// ── The guard ───────────────────────────────────────────────────────────────

/** A throwaway project: a package.json, and each of `dirs` as a folder. */
const project = (t, dirs) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-base-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'package.json'), '{}');
    for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
    return root;
};

test('GUARD: a folder a glob starts in must exist, and each is named once with the areas that use it', (t) => {
    const root = project(t, ['lib']);
    assert.throws(
        () => larry({ preset: 'base', rootDir: root, paths: PATHS }),
        (error) => {
            assert.match(error.message, /^Paths out of date:/);
            assert.match(error.message, /names 'spec' in tests, node, which does not exist/);
            assert.doesNotMatch(error.message, /'lib'/);
            return true;
        },
    );
    assert.doesNotThrow(() => larry({ preset: 'base', rootDir: project(t, ['lib', 'spec']), paths: PATHS }));
});

test('GUARD: a glob that could match anywhere is not held, and a file it names is', (t) => {
    const root = project(t, ['lib']);
    const paths = { ...PATHS, tests: ['**/*.test.ts'], node: ['lib/**/*.ts', 'vitest.setup.ts', '*.config.ts'] };
    assert.throws(() => larry({ preset: 'base', rootDir: root, paths }), /names 'vitest.setup.ts' in node/);
    writeFileSync(path.join(root, 'vitest.setup.ts'), '');
    assert.doesNotThrow(() => larry({ preset: 'base', rootDir: root, paths }));
});

test('GUARD: `./` before a folder is the same folder', (t) => {
    const root = project(t, ['lib', 'spec']);
    assert.doesNotThrow(() => larry({ preset: 'base', rootDir: root, paths: { ...PATHS, source: ['./lib/**/*.ts'] } }));
});
