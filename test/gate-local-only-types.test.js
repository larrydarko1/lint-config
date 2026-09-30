/**
 * The dead-code gate's third pass: exported types that no other file names.
 * - These run the real TypeScript checker over throwaway projects, because the rule IS
 * the resolution: a barrel, an alias, a `.vue` script block and a second tsconfig are
 * each a way for a use to reach a declaration, and each one is a way to miss it.
 * - The first test is the reason the pass exists: knip counts a type used in a used
 * export's signature as alive, and it is not — nothing else ever writes its name.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findLocalOnlyTypes, findProjects } from '../src/gates/lib/local-only-types.ts';

const TSCONFIG = {
    compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true },
    include: ['src'],
};

/** A throwaway repo from `{ relPath: body }`; objects are written as JSON. */
function repo(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-only-types-'));
    for (const [rel, body] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
}

const names = (root) => findLocalOnlyTypes(root).map((h) => `${h.file}:${h.line} ${h.name}`);

/** `src/a.ts` exports `useA(): Shape`; `src/b.ts` calls it. The knip gap, unless a test says otherwise. */
const SIGNATURE_ONLY = {
    'src/a.ts': 'export type Shape = { n: number };\nexport function useA(): Shape {\n    return { n: 1 };\n}\n',
    'src/b.ts': "import { useA } from './a';\nexport const n = useA().n;\n",
};

// ── The case knip misses ────────────────────────────────────────────────────
test('a type named only in a used export’s signature is reported', () => {
    assert.deepEqual(names(repo(SIGNATURE_ONLY)), ['src/a.ts:1 Shape']);
});

test('an interface is reported the same way', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/a.ts': 'export interface Shape { n: number }\nexport function useA(): Shape {\n    return { n: 1 };\n}\n',
    });
    assert.deepEqual(names(root), ['src/a.ts:1 Shape']);
});

test('a type used only inside its own file is reported too', () => {
    const root = repo({ 'src/a.ts': 'export type Local = string;\nconst x: Local = "";\nexport default x;\n' });
    assert.deepEqual(names(root), ['src/a.ts:1 Local']);
});

// ── What counts as another file naming it ───────────────────────────────────
test('an import of the type by name is a use', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/b.ts': "import { useA, type Shape } from './a';\nexport const s: Shape = useA();\n",
    });
    assert.deepEqual(names(root), []);
});

test('an `import type` is a use', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/c.ts': "import type { Shape } from './a';\nexport const s = {} as Shape;\n",
    });
    assert.deepEqual(names(root), []);
});

test('an import renamed on the way in is still a use of the original', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/c.ts': "import type { Shape as S } from './a';\nexport const s = {} as S;\n",
    });
    assert.deepEqual(names(root), []);
});

test('a use through a namespace import counts', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/c.ts': "import type * as a from './a';\nexport const s = {} as a.Shape;\n",
    });
    assert.deepEqual(names(root), []);
});

test('a use through an `import()` type counts', () => {
    const root = repo({ ...SIGNATURE_ONLY, 'src/c.ts': "export const s = {} as import('./a').Shape;\n" });
    assert.deepEqual(names(root), []);
});

test('a use through a barrel counts as a use of the original', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/index.ts': "export * from './a';\n",
        'src/c.ts': "import type { Shape } from './index';\nexport const s = {} as Shape;\n",
    });
    assert.deepEqual(names(root), []);
});

test('a barrel re-exporting the type is not by itself a use', () => {
    const root = repo({ ...SIGNATURE_ONLY, 'src/index.ts': "export type { Shape } from './a';\n" });
    assert.deepEqual(names(root), ['src/a.ts:1 Shape']);
});

test('a same-named type in another file is not a use of this one', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/c.ts': 'type Shape = { other: true };\nexport const s: Shape = { other: true };\n',
    });
    assert.deepEqual(names(root), ['src/a.ts:1 Shape']);
});

test('`ReturnType<typeof useA>` receives the shape without naming it, so it is not a use', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/c.ts':
            "import { useA } from './a';\nexport type Got = ReturnType<typeof useA>;\nexport const g: Got = useA();\n",
    });
    assert.deepEqual(names(root), ['src/a.ts:1 Shape', 'src/c.ts:2 Got']);
});

// ── What is a candidate ─────────────────────────────────────────────────────
test('`export { X }` of a local type is a candidate, reported under the exported name', () => {
    const root = repo({
        'src/a.ts': 'type Inner = string;\nconst v: Inner = "";\nexport { v, type Inner as Outer };\n',
    });
    assert.deepEqual(names(root), ['src/a.ts:3 Outer']);
});

test('a type tagged @public is left alone', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/a.ts':
            '/** @public */\nexport type Shape = { n: number };\nexport function useA(): Shape {\n    return { n: 1 };\n}\n',
    });
    assert.deepEqual(names(root), []);
});

test('an unexported type is never a candidate', () => {
    const root = repo({ 'src/a.ts': 'type Local = string;\nexport const x: Local = "";\n' });
    assert.deepEqual(names(root), []);
});

test('an exported value is not this pass’s business', () => {
    const root = repo({ 'src/a.ts': 'export const helper = 1;\nexport const x = helper + 1;\n' });
    assert.deepEqual(names(root), []);
});

test('a declaration file is never a candidate', () => {
    const root = repo({ 'src/env.d.ts': 'export type Ambient = string;\n', 'src/a.ts': 'export const x = 1;\n' });
    assert.deepEqual(names(root), []);
});

// ── .vue files ──────────────────────────────────────────────────────────────
test('a type imported into a .vue script block is a use', () => {
    const root = repo({
        ...SIGNATURE_ONLY,
        'src/C.vue':
            '<template><p /></template>\n<script setup lang="ts">\nimport type { Shape } from \'./a\';\nconst s = {} as Shape;\n</script>\n',
    });
    assert.deepEqual(names(root), []);
});

test('a type exported from a .vue file is reported at its line in that file', () => {
    const root = repo({
        'src/C.vue':
            '<template>\n    <p />\n</template>\n\n<script lang="ts">\nexport type Row = { id: string };\n</script>\n\n<script setup lang="ts">\nconst r: Row = { id: "" };\n</script>\n',
    });
    assert.deepEqual(names(root), ['src/C.vue:6 Row']);
});

test('template text is not read as TypeScript, so a stray backtick cannot swallow the script', () => {
    const root = repo({
        'src/C.vue':
            '<template>\n    <p>Wrap it in a ` like this</p>\n</template>\n<script lang="ts">\nexport type Row = { id: string };\n</script>\n',
    });
    assert.deepEqual(names(root), ['src/C.vue:5 Row']);
});

test('a type a .vue file exports and a .ts file imports is a use', () => {
    const root = repo({
        'src/C.vue': '<script lang="ts">\nexport type Row = { id: string };\n</script>\n<template><p /></template>\n',
        'src/b.ts': "import type { Row } from './C.vue';\nexport const r = {} as Row;\n",
    });
    assert.deepEqual(names(root), []);
});

// ── Several tsconfigs ───────────────────────────────────────────────────────
test('a use from another project, through its own path alias, counts', () => {
    const root = repo({
        'tsconfig.json': { files: [], references: [{ path: './pkg' }, { path: './app' }] },
        'pkg/tsconfig.json': TSCONFIG,
        'pkg/src/a.ts':
            'export type Shape = { n: number };\nexport function useA(): Shape {\n    return { n: 1 };\n}\n',
        'app/tsconfig.json': {
            compilerOptions: { ...TSCONFIG.compilerOptions, paths: { '@pkg/*': ['../pkg/src/*'] } },
            include: ['src'],
        },
        'app/src/b.ts': "import type { Shape } from '@pkg/a';\nexport const s = {} as Shape;\n",
    });
    assert.deepEqual(names(root), []);
});

test('the same type found by two projects is reported once', () => {
    const root = repo({
        'tsconfig.json': { files: [], references: [] },
        'a/tsconfig.json': { ...TSCONFIG, include: ['../shared'] },
        'b/tsconfig.json': { ...TSCONFIG, include: ['../shared'] },
        'shared/x.ts': 'export type Solo = string;\nexport const x: Solo = "";\n',
    });
    assert.deepEqual(names(root), ['shared/x.ts:1 Solo']);
});

// ── findProjects ────────────────────────────────────────────────────────────
test('a solution file and an extended base are not projects', () => {
    const root = repo({
        'tsconfig.json': { files: [], references: [{ path: './app' }] },
        'tsconfig.base.json': { compilerOptions: { strict: true } },
        'app/tsconfig.json': { extends: '../tsconfig.base.json', include: ['src'] },
        'app/tsconfig.node.json': { extends: '../tsconfig.base.json', include: ['vite.config.ts'] },
    });
    assert.deepEqual(findProjects(root), ['app/tsconfig.json', 'app/tsconfig.node.json']);
});

test('a preset extended from a package does not hide a project', () => {
    const root = repo({ 'tsconfig.json': { extends: '@vue/tsconfig/tsconfig.dom.json', include: ['src'] } });
    assert.deepEqual(findProjects(root), ['tsconfig.json']);
});

test('tsconfigs under node_modules, build output and dot-directories are skipped', () => {
    const root = repo({
        'node_modules/x/tsconfig.json': TSCONFIG,
        'dist/tsconfig.json': TSCONFIG,
        '.cache/tsconfig.json': TSCONFIG,
    });
    assert.deepEqual(findProjects(root), ['tsconfig.json']);
});

test('a tsconfig with comments and a trailing comma is still read', () => {
    const root = repo({ 'tsconfig.json': '{\n    // a comment\n    "files": [],\n}\n' });
    assert.deepEqual(findProjects(root), []);
});
