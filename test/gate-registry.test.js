/**
 * The gate registry is the one list a runner reads, so it must not drift from what it
 * lists: every gate module is in it and loads its own `check*`, every gate has a
 * package export and an `inspect*`, and the README's gate table names the same families.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { GATES, gatesFor } from '../src/gates/registry.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATES_DIR = path.join(ROOT, 'src/gates');
/** Modules under gates/ that are building blocks for other gates, not gates themselves. */
const HELPERS = ['import-order', 'registry', 'rust-order'];
const ALL = ['api', 'electron', 'fullstack', 'library', 'spa', 'tauri'];
/** How the README's Family column spells a set of families. */
const FAMILY_LABELS = {
    'all': ALL,
    'all but library': ALL.filter((f) => f !== 'library'),
    'all with a UI': ['electron', 'fullstack', 'spa', 'tauri'],
};

const gateModules = readdirSync(GATES_DIR, { recursive: true })
    .filter((file) => file.endsWith('.ts') && !file.startsWith('lib'))
    .map((file) => file.replace(/\.ts$/, '').split(path.sep).join('/'))
    .filter((name) => !HELPERS.includes(name))
    .sort();

const source = (name) => readFileSync(path.join(GATES_DIR, `${name}.ts`), 'utf8');

test('every gate module is in the registry, and nothing else is', () => {
    assert.deepEqual(Object.keys(GATES).sort(), gateModules);
});

test("each entry loads its own module's check function", async () => {
    for (const [name, { load }] of Object.entries(GATES)) {
        const check = await load();
        assert.equal(typeof check, 'function', name);
        assert.match(check.name, /^check[A-Z]/, name);
        assert.match(source(name), new RegExp(`export (async )?function ${check.name}\\b`), name);
    }
});

test('every gate exports an inspect function beside its check', () => {
    for (const name of gateModules) {
        assert.match(source(name), /^export (async )?function inspect[A-Z]/m, `${name} has no inspect*`);
    }
});

test('every gate has a package export', () => {
    const { exports } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const name of gateModules) assert.ok(exports[`./gates/${name}`], `./gates/${name} is not exported`);
});

test('every family runs at least the gates every family runs', () => {
    const shared = Object.keys(GATES).filter((name) => GATES[name].families.length === ALL.length);
    for (const family of ALL) {
        const runs = gatesFor(family);
        for (const name of shared) assert.ok(runs.includes(name), `${family} does not run ${name}`);
    }
});

test("the README's gate table names the registry's families", () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const rows = [...readme.matchAll(/^\| `([a-z0-9/-]+)`\s*\|([^|]+)\|/gm)]
        .filter(([, name]) => name in GATES)
        .map(([, name, label]) => [name, label.trim()]);
    assert.deepEqual(rows.map(([name]) => name).sort(), Object.keys(GATES).sort(), 'the table lists every gate once');
    for (const [name, label] of rows) {
        const families = FAMILY_LABELS[label] ?? label.split(/,\s*/);
        assert.deepEqual([...GATES[name].families].sort(), [...families].sort(), `${name}: README says "${label}"`);
    }
});
