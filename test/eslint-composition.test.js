/**
 * The full-stack family is the SPA family's areas on its frontend, the API family's on
 * its api, and its own on the services and shared packages. Asserted through ESLint's
 * resolver against the single-package family the area came from: when the two resolve
 * different lists, one of them was given a copy, and the copies are how the full-stack
 * consumers came to hand-wire every area themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

import { larry } from '../src/eslint/index.ts';
import * as api from '../src/eslint/api/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';
import * as spa from '../src/eslint/spa/index.ts';

const ROOT = '/tmp/lint-config-composition-test';

const apiConfig = larry({ preset: 'api', rootDir: ROOT, standards: api.apiStandards() });
const spaConfig = larry({ preset: 'spa', rootDir: ROOT, standards: spa.spaStandards() });
const fullstackConfig = (workspaces) =>
    larry({ preset: 'fullstack', rootDir: ROOT, workspaces, standards: fullstack.fullstackStandards() });

const resolve = async (config, file) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    return (await eslint.calculateConfigForFile(`${ROOT}/${file}`)).rules;
};

/** What a file's restricted rules ban, by selector and module, without the messages. */
const bansOf = async (config, file) => {
    const rules = await resolve(config, file);
    const options = (rule) => (Array.isArray(rules[rule]) && rules[rule][0] !== 0 ? rules[rule].slice(1) : []);
    const imports = [...options('no-restricted-imports'), ...options('@typescript-eslint/no-restricted-imports')];
    return {
        selectors: options('no-restricted-syntax').map((entry) => entry.selector),
        paths: imports.flatMap((entry) => (entry.paths ?? []).map((path) => path.name)).sort(),
    };
};

test('the full-stack api resolves the API family’s areas, given its workspace', async () => {
    const pairs = [
        ['src/index.ts', 'api/src/index.ts'],
        ['src/routes/users.ts', 'api/src/routes/users.ts'],
        ['src/gateway/socket.ts', 'api/src/gateway/socket.ts'],
        ['src/middleware/error-handler.ts', 'api/src/middleware/error-handler.ts'],
        ['src/lib/db.ts', 'api/src/lib/db.ts'],
        ['src/lib/config.ts', 'api/src/lib/config.ts'],
        ['src/lib/cache.ts', 'api/src/lib/cache.ts'],
        ['db/migrations/001-init.js', 'db/migrations/001-init.js'],
        ['scripts/seed.ts', 'scripts/seed.ts'],
        ['e2e/login.spec.ts', 'e2e/login.spec.ts'],
    ];
    for (const [single, workspace] of pairs) {
        const expected = await bansOf(apiConfig, single);
        assert.ok(expected.selectors.length > 0, `${single} has an area`);
        assert.deepEqual(await bansOf(fullstackConfig(), workspace), expected, workspace);
    }
});

test('the full-stack frontend resolves the SPA family’s areas, plus the client of its own API', async () => {
    const client = [...fullstack.frontendSelectors, ...fullstack.wsEventNameSelectors].map((entry) => entry.selector);
    const app = await bansOf(spaConfig, 'src/views/Home.vue');
    const frontend = await bansOf(fullstackConfig(), 'frontend/src/views/Home.vue');
    assert.deepEqual(frontend.selectors, [...client, ...app.selectors]);
    assert.deepEqual(frontend.paths, [...app.paths, 'socket.io-client'].sort());

    // The one module that may open the socket, and the areas with no client rules at all.
    assert.deepEqual((await bansOf(fullstackConfig(), 'frontend/src/api/socket.ts')).paths, app.paths);
    for (const file of ['utils/format.ts', '__tests__/Home.test.ts', 'composables/__tests__/useFeed.test.ts']) {
        const single = await bansOf(spaConfig, `src/${file}`);
        const workspace = await bansOf(fullstackConfig(), `frontend/src/${file}`);
        assert.deepEqual(
            workspace.selectors,
            file.startsWith('utils') ? [...client, ...single.selectors] : single.selectors,
            file,
        );
    }
});

test('a service holds its database client in its lib/db.ts, as the api does, and applies no indexes', async () => {
    const config = fullstackConfig({ services: ['worker', 'ingestor'] });
    const client = "NewExpression[callee.name='MongoClient']";
    const createIndex = "CallExpression[callee.property.name='createIndex']";
    for (const service of ['worker', 'ingestor']) {
        const dbModule = (await bansOf(config, `${service}/src/lib/db.ts`)).selectors;
        assert.ok(!dbModule.includes(client) && dbModule.includes(createIndex), `${service}/src/lib/db.ts`);
        for (const file of ['index.ts', 'jobs/transcode.ts'])
            assert.ok(
                (await bansOf(config, `${service}/src/${file}`)).selectors.includes(client),
                `${service}/src/${file}`,
            );
        const source = await bansOf(config, `${service}/src/jobs/transcode.ts`);
        assert.ok(source.selectors.includes(fullstack.outboundCallSelectors[0].selector), 'outbound timeouts');
        assert.ok(!source.selectors.includes(fullstack.apiRoutesOnlySelectors[0].selector), 'no HTTP rules');
        assert.ok(source.paths.includes('mongoose') && source.paths.includes('lru-cache'), `${service} imports`);
    }
});

test('the full-stack selectors a project composes are the ones the family resolves', async () => {
    const routes = (await bansOf(fullstackConfig(), 'api/src/routes/users.ts')).selectors;
    const resolved = (await resolve(fullstackConfig(), 'api/src/routes/users.ts'))['no-restricted-syntax'].slice(1);
    for (const name of ['apiSourceSelectors', 'dbApiWorkerSelectors']) {
        for (const entry of fullstack[name]) {
            assert.ok(routes.includes(entry.selector), `${name}: ${entry.selector}`);
            assert.deepEqual(
                resolved.find((found) => found.selector === entry.selector),
                entry,
                `${name}: same message`,
            );
        }
    }
    const workerDb = (await resolve(fullstackConfig(), 'worker/src/lib/db.ts'))['no-restricted-syntax'].slice(1);
    for (const entry of fullstack.dbWorkerIndexSelectors)
        assert.ok(workerDb.some((found) => found.message === entry.message));
});

test('a suite keeps the naming and export selectors of the code it tests, in every family', async () => {
    const expected = [
        'VariableDeclarator[id.name=/^[a-hk-zA-Z$]$/]',
        'ExportNamedDeclaration[source=null][declaration=null]',
    ];
    const suites = [
        [spaConfig, ['src/__tests__/App.test.ts', 'src/components/__tests__/NavBar.test.ts', 'e2e/login.spec.ts']],
        [apiConfig, ['src/__tests__/app.test.ts', 'src/services/media.test.ts', 'e2e/login.spec.ts']],
        [
            fullstackConfig(),
            [
                'frontend/src/views/__tests__/Home.test.ts',
                'api/src/routes/__tests__/users.test.ts',
                'worker/src/jobs/transcode.test.ts',
                'packages/shared/src/__tests__/errors.test.ts',
                'e2e/login.spec.ts',
            ],
        ],
    ];
    for (const [config, files] of suites)
        for (const file of files) {
            const { selectors } = await bansOf(config, file);
            for (const selector of expected) assert.ok(selectors.includes(selector), `${file}: ${selector}`);
        }
});
