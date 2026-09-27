/**
 * Every module exports by name. A default export is allowed only where a tool loads
 * the module by its package name and reads `default` — `"prettier":
 * "@larrydarko/lint-config/prettier"` in package.json, a commitlint or stylelint
 * `extends`, a lint-staged config that is a one-line re-export. Those four also
 * export the factory by name, so a project with options never touches `default`.
 * This package does not lint itself, so this is the check that holds the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOADED_BY_NAME = ['src/commitlint.ts', 'src/lint-staged.ts', 'src/prettier.ts', 'src/stylelint.ts'];

const sources = readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join('src', file));

const hasDefault = (file) =>
    /^export default |^export \{[^}]*\bas default\b/m.test(readFileSync(path.join(ROOT, file), 'utf8'));

test('no module has a default export unless a tool loads it by name', () => {
    const extra = sources.filter((file) => !LOADED_BY_NAME.includes(file) && hasDefault(file));
    assert.deepEqual(extra, [], 'export it by name instead');
});

test('the modules a tool loads by name still have their default, and a named export beside it', async () => {
    for (const file of LOADED_BY_NAME) {
        const mod = await import(path.join(ROOT, file));
        assert.ok(mod.default, `${file} lost its default export`);
        assert.ok(Object.keys(mod).length > 1, `${file} has only a default export`);
    }
});
