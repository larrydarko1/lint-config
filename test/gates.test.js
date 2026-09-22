/**
 * The gate helpers, asserted against the behaviour the projects' own copies had.
 * These three were the only files every gate imported, and the two families had
 * genuinely different versions of each — so what matters here is that the shared
 * one still answers the way each family's copy did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stripComments } from '../src/gates/strip-comments.js';
import { createImportOrder } from '../src/gates/import-order.js';
import { findRepoRoot } from '../src/gates/repo-root.js';

test('stripComments blanks comments and keeps every offset', () => {
    const src = 'const a = 1; // note\n/* block */ const b = 2;\n';
    const out = stripComments(src);
    assert.equal(out.length, src.length, 'byte offsets must survive so a gate can report a position');
    assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers must survive');
    assert.ok(!out.includes('note'));
    assert.ok(!out.includes('block'));
    assert.ok(out.includes('const a = 1;'));
    assert.ok(out.includes('const b = 2;'));
});

test('stripComments leaves a // inside a string alone', () => {
    // The false positive this exists to prevent: blanking the rest of a URL.
    const src = `const url = 'https://example.com//path';\n`;
    assert.equal(stripComments(src), src);
});

test('stripComments keeps the newlines inside a block comment', () => {
    const src = '/*\n *\n */\nconst after = 1;\n';
    const out = stripComments(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.match(out, /^\s+\n\s+\n\s+\nconst after = 1;\n$/);
});

test('stripComments handles an unterminated block comment without hanging', () => {
    const out = stripComments('const a = 1;\n/* never closed\n');
    assert.equal(out.length, 'const a = 1;\n/* never closed\n'.length);
    assert.ok(!out.includes('never'));
});

test('import groups: three without a workspace scope, four with one', () => {
    assert.deepEqual(createImportOrder().IMPORT_GROUPS, ['builtin', 'external', 'local']);
    assert.deepEqual(createImportOrder({ workspaceScope: '@orchid/' }).IMPORT_GROUPS, [
        'builtin',
        'external',
        'workspace',
        'local',
    ]);
});

/** Runs `checkImportsInFile` over `code` written to a scratch file, and returns its problems. */
const problemsFor = (mod, code) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lint-config-gates-'));
    writeFileSync(path.join(dir, 'file.ts'), code);
    try {
        return mod.checkImportsInFile('file.ts', dir).problems.map((p) => p.message);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

test('a workspace package sorts between external and local where the scope is declared', () => {
    const mod = createImportOrder({ workspaceScope: '@orchid/' });

    // Correct order: builtin, external, workspace, local — one blank line between each.
    assert.deepEqual(
        problemsFor(
            mod,
            "import fs from 'node:fs';\n\nimport vue from 'vue';\n\nimport { x } from '@orchid/shared';\n\nimport { y } from './y';\n",
        ),
        [],
    );

    // The workspace import placed after the local one is out of order.
    const wrong = problemsFor(
        mod,
        "import fs from 'node:fs';\n\nimport vue from 'vue';\n\nimport { y } from './y';\n\nimport { x } from '@orchid/shared';\n",
    );
    assert.ok(wrong.length > 0, 'a misplaced workspace import should be reported');
    assert.ok(wrong.some((m) => m.includes('@orchid/shared') && m.includes('workspace')));
});

test('without a workspace scope the same specifier is just another npm package', () => {
    const mod = createImportOrder();
    // `@orchid/shared` now belongs in the external group, so it sorts with `vue`, before local.
    assert.deepEqual(
        problemsFor(
            mod,
            "import fs from 'node:fs';\n\nimport { x } from '@orchid/shared';\nimport vue from 'vue';\n\nimport { y } from './y';\n",
        ),
        [],
    );
});

test('localAliases make a package-looking specifier sort as local', () => {
    const mod = createImportOrder({ localAliases: ['@test-utils'] });

    // Inside the local group the order is alphabetical by specifier, and '.' sorts before '@' —
    // so `./y` comes first even though `@test-utils` looks like a package.
    assert.deepEqual(
        problemsFor(mod, "import vue from 'vue';\n\nimport { y } from './y';\nimport { h } from '@test-utils';\n"),
        [],
    );

    // Without the alias it would be external, and belong up with `vue` instead.
    const asPackage = problemsFor(
        createImportOrder(),
        "import vue from 'vue';\n\nimport { y } from './y';\nimport { h } from '@test-utils';\n",
    );
    assert.ok(asPackage.some((m) => m.includes('@test-utils')));
});

test('a side-effect import never moves, and splits the run around itself', () => {
    const mod = createImportOrder();
    // `dotenv/config` must run before anything that reads process.env at import time,
    // so it stays put even though `vue` would sort before it alphabetically.
    assert.deepEqual(problemsFor(mod, "import 'dotenv/config';\n\nimport vue from 'vue';\n"), []);
});

test('findRepoRoot walks up to a workspaces manifest, and to .git without one', () => {
    // This package has no `workspaces`, so the .git fallback is what answers here.
    const root = findRepoRoot(import.meta.dirname);
    assert.equal(typeof root, 'string');
    assert.ok(root.length > 1);
});

test('findRepoRoot fails loudly rather than returning the filesystem root', () => {
    assert.throws(() => findRepoRoot('/'), /Could not locate the repository root/);
});
