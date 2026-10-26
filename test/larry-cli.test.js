/**
 * The `larry` CLI, run as a child process in invented repositories, the way a project's
 * script runs it. The gates here are secrets and licences: both read only the temp repo,
 * so a whole run stays fast and offline. Every other gate is skipped with a reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { gatesFor } from '../src/gates/registry.ts';

const LARRY = path.resolve(import.meta.dirname, '../src/cli/larry.ts');
const CONFIG_MODULE = pathToFileURL(path.resolve(import.meta.dirname, '../src/config.ts')).href;
const LOCKFILE = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' } } });

/** A git repo holding `files`, with an empty lockfile unless `files` brings one. */
const repo = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const [rel, body] of Object.entries({ 'package-lock.json': LOCKFILE, ...files })) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

/** A larry.config.js that default-exports `config`. */
const configFile = (config) => ({ 'larry.config.js': `export default ${JSON.stringify(config)};\n` });

const larry = (cwd, ...args) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [LARRY, ...args], { cwd, encoding: 'utf8' });
    return { code: status, out: stdout, err: stderr };
};

/** A library config that skips every gate but secrets and licences. */
const LIBRARY = {
    family: 'library',
    gates: {
        ...Object.fromEntries(
            gatesFor('library')
                .filter((name) => name !== 'secrets' && name !== 'licenses')
                .map((name) => [name, { skip: `${name} reads tools this suite does not set up` }]),
        ),
        licenses: { distribution: 'closed' },
    },
};

// ── Usage ────────────────────────────────────────────────────────────────────

test('help and version exit 0; no command, an unknown one or an unknown option exit 2', (t) => {
    const root = repo(t, configFile(LIBRARY));
    assert.match(larry(root, '--help').out, /^Usage: larry check \[gate…\]/);
    assert.equal(larry(root, '--help').code, 0);
    const version = larry(root, '--version');
    assert.equal(version.code, 0);
    assert.match(version.out, /^\d+\.\d+\.\d+/);

    assert.equal(larry(root).code, 2);
    const unknown = larry(root, 'lint');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /unknown command "lint"/);
    const flag = larry(root, 'check', '--fast');
    assert.equal(flag.code, 2);
    assert.match(flag.err, /unknown option --fast/);
});

// ── The config ───────────────────────────────────────────────────────────────

test('no config is a usage error, not a pass', (t) => {
    const result = larry(repo(t, {}), 'check');
    assert.equal(result.code, 2);
    assert.match(result.err, /no larry\.config\.ts or larry\.config\.js in /);
});

test('every problem in the config is listed at once, and nothing runs', (t) => {
    const result = larry(
        repo(
            t,
            configFile({
                family: 'library',
                gates: {
                    secret: {},
                    i18n: {},
                    audit: { skip: '' },
                    refactoring: { skip: 'covered elsewhere', markerFiles: [] },
                    pipeline: 'off',
                },
            }),
        ),
        'check',
    );
    assert.equal(result.code, 2);
    assert.match(result.err, /"secret" is not a gate\. library projects run: audit, /);
    assert.match(result.err, /"i18n" is not a gate library projects run/);
    assert.match(result.err, /"audit" is skipped without a reason/);
    assert.match(result.err, /"refactoring" is skipped and given options/);
    assert.match(result.err, /"pipeline" must be the gate's options, or \{ skip/);
    assert.equal(result.out, '');
});

test('a family that does not exist is a usage error', (t) => {
    const result = larry(repo(t, configFile({ family: 'cli', gates: {} })), 'check');
    assert.equal(result.code, 2);
    assert.match(result.err, /family is "cli", not one of api, /);
});

test('a TypeScript config is loaded with its types stripped, from any subdirectory', (t) => {
    const root = repo(t, {
        'larry.config.ts': [
            `import { defineConfig } from '${CONFIG_MODULE}';`,
            `const distribution: 'open' | 'closed' = 'open';`,
            `export default defineConfig({ family: 'spa', gates: { licenses: { distribution } } });`,
        ].join('\n'),
        'src/app.ts': 'export {};\n',
    });
    const result = larry(path.join(root, 'src'), 'check', 'licenses');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /allowed in an open-source app/);
});

// ── Running gates ────────────────────────────────────────────────────────────

test('a whole run runs every gate of the family, prints why each skipped one is skipped, and exits 0', (t) => {
    const result = larry(repo(t, { ...configFile(LIBRARY), 'src/index.ts': 'export {};\n' }), 'check');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /── licenses\n✓ Licences clean/);
    assert.match(result.out, /── secrets\n✓ No secrets/);
    assert.match(result.out, /── audit\n– skipped: audit reads tools this suite does not set up/);
    assert.match(result.out, /✓ larry check: 2 gates passed\. 10 gates skipped: audit, /);
});

test('NEGATIVE: one failing gate fails the run, and the gates after it still run', (t) => {
    const root = repo(t, { ...configFile(LIBRARY), '.env': 'A=1\n' });
    const result = larry(root, 'check', 'secrets', 'licenses');
    assert.equal(result.code, 1);
    assert.match(result.err, /✗ Secrets check failed/);
    assert.ok(
        result.out.indexOf('── licenses') < result.out.indexOf('── secrets'),
        'named gates run in registry order',
    );
    assert.match(result.out, /✗ larry check: 1 of 2 gates failed: secrets\./);
});

test('NEGATIVE: a gate that throws is a failure, reported with its stack, and the run goes on', (t) => {
    const config = { ...LIBRARY, gates: { ...LIBRARY.gates, licenses: { distribution: 'closed', allowlist: 'x' } } };
    const result = larry(repo(t, configFile(config)), 'check', 'licenses', 'secrets');
    assert.equal(result.code, 1);
    assert.match(result.err, /✗ licenses stopped with an error before it could report:\nTypeError: /);
    assert.match(result.out, /── secrets\n✓ No secrets/);
    assert.match(result.out, /failed: licenses\./);
});

test('naming a gate the family does not run is a usage error; naming a skipped one says so', (t) => {
    const root = repo(t, configFile(LIBRARY));
    const notRun = larry(root, 'check', 'i18n', 'docker');
    assert.equal(notRun.code, 2);
    assert.match(notRun.err, /"i18n", "docker" are not gates library projects run\. They run: audit, /);

    const skipped = larry(root, 'check', 'audit');
    assert.equal(skipped.code, 0);
    assert.match(skipped.out, /– skipped: audit reads tools/);
    assert.match(skipped.out, /✓ larry check: 0 gates passed\. 1 gate skipped: audit\./);
});
