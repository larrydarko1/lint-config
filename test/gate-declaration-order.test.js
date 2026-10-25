/**
 * The declaration-order gate, against minimal fixture projects.
 * - Every check has a fixture that must FAIL as well as one that must pass. The two
 * halves are equally load-bearing here: the whole point of the topological sort is
 * that it does NOT report a statement the table would move but the temporal dead
 * zone pins in place, and the only way to know that exception still works is to
 * assert a module that uses it stays green.
 */
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    CATEGORIES,
    TEST_CATEGORIES,
    analyzeFile,
    checkDeclarationOrder,
    isTestPath,
} from '../src/gates/declaration-order.ts';

/** Runs `fn` with console captured and the exit code restored afterwards. */
const capture = (fn) => {
    const out = [];
    const err = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), err: err.join('\n'), failed: process.exitCode === 1 };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

/** Writes a { path: contents } map into a fresh temp repo and returns its root. */
const project = (t, files) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-do-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return root;
};

const run = (root, options = {}) => capture(() => checkDeclarationOrder({ root, sourceRoots: ['src'], ...options }));

/** A module in canonical order: imports → types → constants → exported-fns → side-effects. */
const ORDERED = `import fs from 'node:fs';

type Thing = { a: number };

const LIMIT = 10;

export function run(t: Thing): number {
    return t.a + LIMIT + fs.constants.F_OK;
}

console.log(run({ a: 1 }));
`;

// ── The baseline ─────────────────────────────────────────────────────────────

test('a module in canonical order passes and leaves the exit code alone', (t) => {
    const { out, failed } = run(project(t, { 'src/a.ts': ORDERED }));
    assert.equal(failed, false);
    assert.match(out, /✓ Declaration order check passed/);
    assert.match(out, /1 modules \+ 0 suites/);
});

// ── The table ────────────────────────────────────────────────────────────────

test('a constant below a private function is reported, naming both categories', (t) => {
    const root = project(t, {
        'src/a.ts': `function helper(): number {
    return 1;
}

const LIMIT = 10;

console.log(helper() + LIMIT);
`,
    });
    const { err, failed } = run(root);
    assert.equal(failed, true);
    assert.match(err, /src\/a\.ts — 1 statement\(s\) out of canonical order/);
    // The statement that MOVED is the one named, not everything it displaced.
    assert.match(err, /private-fns "helper" belongs after constants "LIMIT"/);
    assert.match(err, new RegExp(`Order is: ${CATEGORIES.join(' → ')}\\.`));
});

test('a type below a constant is reported', (t) => {
    const { err, failed } = run(
        project(t, {
            'src/a.ts': `const LIMIT = 10;

type Thing = { a: number };

export const size = (t: Thing): number => t.a + LIMIT;
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /constants "LIMIT" belongs after types "Thing"/);
});

test('one statement out of place is one problem, not every statement after it', (t) => {
    // Six statements, one moved. A naive positional diff would call five of them
    // misplaced; the longest-common-subsequence does not.
    const { err } = run(
        project(t, {
            'src/a.ts': `export function one(): number {
    return 1;
}
export function two(): number {
    return 2;
}
export function three(): number {
    return 3;
}
export function four(): number {
    return 4;
}
const LIMIT = 10;
console.log(one() + two() + three() + four() + LIMIT);
`,
        }),
    );
    assert.match(err, /1 file\(s\), 1 statement\(s\)/);
});

// ── Classification ───────────────────────────────────────────────────────────

test('SCREAMING_SNAKE is config even when its initializer is a call', (t) => {
    // `const HOME = path.join(...)` is configuration, not state: were it binned as
    // state it would sort below the class and this module would fail.
    const { out, failed } = run(
        project(t, {
            'src/a.ts': `import path from 'node:path';

const HOME = path.join('a', 'b');

export class Store {
    root = HOME;
}
`,
        }),
    );
    assert.equal(failed, false, out);
});

test('a reactive container is state even though it is a const', (t) => {
    // `ref()` after a class is correct (state is layer 6, classes layer 5). If the
    // classifier called it a constant it would have to sit above the class.
    const { failed } = run(
        project(t, {
            'src/a.ts': `import { ref } from 'vue';

export class Store {}

const count = ref(0);

console.log(count.value, Store.name);
`,
        }),
    );
    assert.equal(failed, false);
});

test('a Zod schema is vocabulary, so it may sit above the constants', (t) => {
    const { failed } = run(
        project(t, {
            'src/a.ts': `import { z } from 'zod';

const ThingSchema = z.object({ a: z.number() });

const LIMIT = 10;

export const parse = (v: unknown): number => ThingSchema.parse(v).a + LIMIT;
`,
        }),
    );
    assert.equal(failed, false);
});

test('an arrow assigned to a const is a function, and export decides which layer', (t) => {
    // Private functions come after exported ones. Flipping them must fail.
    const { err, failed } = run(
        project(t, {
            'src/a.ts': `const helper = (): number => 1;

export const run = (): number => helper();
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /exported-fns "run"/);
});

// ── The computed exception ───────────────────────────────────────────────────

test('a contract statement that reads state stays put: the dead zone outranks the table', (t) => {
    // defineExpose is contract (#3) and `el` is state (#6). Hoisting the contract
    // to layer 3 would put it above the `ref()` it exposes — a ReferenceError at
    // import time — so the sort must leave it alone.
    const { out, failed } = run(
        project(t, {
            'src/A.vue': `<template><div ref="el" /></template>

<script setup lang="ts">
import { ref } from 'vue';

const el = ref<HTMLElement>();

defineExpose({ el });
</script>
`,
        }),
    );
    assert.equal(failed, false, out);
});

test('the same contract statement IS reported once it stops reading the state', (t) => {
    // Identical shape, one binding changed: with no edge to hold it, the table wins.
    // Without this negative the test above would pass even if the gate checked nothing.
    const { err, failed } = run(
        project(t, {
            'src/A.vue': `<template><div ref="el" /></template>

<script setup lang="ts">
import { ref } from 'vue';

const el = ref<HTMLElement>();

defineExpose({ other: 1 });
</script>
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /contract "defineExpose/);
});

test('an SFC violation is reported at its line in the file, not in the script block', (t) => {
    const root = project(t, {
        'src/A.vue': `<template>
    <div />
    <div />
    <div />
</template>

<script setup lang="ts">
const helper = (): number => 1;

const LIMIT = 10;

console.log(helper() + LIMIT);
</script>
`,
    });
    const result = analyzeFile('src/A.vue', root);
    assert.equal(result.misplaced.length, 1);
    // `helper` is line 8 of the file and line 2 of the script block. Without the
    // offset the report would point at the <template>.
    assert.equal(result.misplaced[0].line, 8);
});

test('an SFC with no script block is skipped rather than crashing', (t) => {
    const root = project(t, { 'src/A.vue': '<template><div /></template>\n' });
    assert.equal(analyzeFile('src/A.vue', root), null);
});

test('a hoisted function declaration creates no edge, so it is free to move', (t) => {
    // `run` is called by the side-effect above its own declaration. That is legal —
    // function declarations hoist — so the gate must not invent a dependency and
    // must still insist the side-effect goes last.
    const { err, failed } = run(
        project(t, {
            'src/a.ts': `console.log(run());

export function run(): number {
    return 1;
}
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /side-effects "console\.log\(run\(\)\);" belongs after exported-fns "run"/);
});

test('a function called at load time reads its body at load time, so what that reads stays above the call', (t) => {
    // `ROOT` is a constant and `walk` a private function, so the table alone would put
    // `ROOT` first — where `find()` runs before `walk` is initialised, a TDZ error at
    // import. Hoisting `find` does not hoist the arrow it calls.
    const root = project(t, {
        'src/a.ts': `const walk = (dir: string): string => dir;

export function find(dir: string): string {
    return walk(dir);
}

export const ROOT = find('.');
`,
    });
    const { misplaced, order } = analyzeFile('src/a.ts', root);
    // Statements 0, 1, 2 are walk, find, ROOT: ROOT may move, but never above walk.
    assert.ok(order.indexOf(2) > order.indexOf(0), `order ${order}`);
    assert.ok(!misplaced.some((m) => m.name === 'ROOT'));
});

test('a load-time cycle is reported as a cycle, not as a pile of misplaced statements', (t) => {
    const { err, failed } = run(
        project(t, {
            'src/a.ts': `const a = [b];
const b = [a];
console.log(a, b);
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /circular load-time dependency/);
});

// ── The test table ───────────────────────────────────────────────────────────

test('isTestPath covers colocated suites, a tests/ tree, and .spec files', () => {
    assert.equal(isTestPath('src/__tests__/a.ts'), true);
    assert.equal(isTestPath('tests/unit/a.ts'), true);
    assert.equal(isTestPath('src/a.test.ts'), true);
    assert.equal(isTestPath('src/a.spec.ts'), true);
    assert.equal(isTestPath('src/a.ts'), false);
    // A directory that merely starts with the word is not a tests tree.
    assert.equal(isTestPath('src/testing/a.ts'), false);
});

test('a suite is read against the test table, where mocks come before the fixtures', (t) => {
    const { out, failed } = run(
        project(t, {
            'src/a.test.ts': `import { describe, it, vi } from 'vitest';

vi.mock('./dep.js', () => ({ go: vi.fn() }));

const FIXTURE = { a: 1 };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('x', () => {
    it('works', () => {
        void FIXTURE;
    });
});
`,
        }),
    );
    assert.equal(failed, false, out);
    assert.match(out, /0 modules \+ 1 suites/);
});

test('a fixture above the mock block is reported, with the test table quoted', (t) => {
    const { err, failed } = run(
        project(t, {
            'src/a.test.ts': `import { describe, it, vi } from 'vitest';

const FIXTURE = { a: 1 };

vi.mock('./dep.js', () => ({ go: vi.fn() }));

describe('x', () => {
    it('works', () => {
        void FIXTURE;
    });
});
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, new RegExp(`Order is: ${TEST_CATEGORIES.join(' → ')}\\.`));
});

test('the production table gets a suite backwards — which is why there are two', (t) => {
    // Byte-identical content to the passing suite above, named as a module. The
    // production classifier bins `vi.mock` as a side-effect and sorts it LAST, so
    // the correctly-ordered file now fails. This is the whole case for TEST_CATEGORIES.
    const { failed } = run(
        project(t, {
            'src/a.ts': `import { describe, it, vi } from 'vitest';

vi.mock('./dep.js', () => ({ go: vi.fn() }));

const FIXTURE = { a: 1 };

describe('x', () => {
    it('works', () => {
        void FIXTURE;
    });
});
`,
        }),
    );
    assert.equal(failed, true);
});

test('a mock factory body counts as load time, so what it closes over cannot be moved below it', (t) => {
    // The factory is an arrow, but Vitest runs it while resolving imports. If the
    // analysis skipped its body like any other arrow, `FakeProc` would look
    // unreferenced and the sort would move it below the mock — a TDZ error at import.
    const { out, failed } = run(
        project(t, {
            'src/a.test.ts': `import { vi, describe, it } from 'vitest';

class FakeProc {}

vi.mock('./dep.js', () => ({ Proc: FakeProc }));

describe('x', () => {
    it('works', () => {});
});
`,
        }),
    );
    assert.equal(failed, false, out);
});

// ── Scope ────────────────────────────────────────────────────────────────────

test('.d.ts files are not walked', (t) => {
    const { out } = run(project(t, { 'src/a.ts': ORDERED, 'src/b.d.ts': 'export declare const x: number;\n' }));
    assert.match(out, /1 modules \+ 0 suites/);
});

test('a source root that does not exist is skipped rather than throwing', (t) => {
    const { out, failed } = run(project(t, { 'src/a.ts': ORDERED }), { sourceRoots: ['src', 'worker/src'] });
    assert.equal(failed, false);
    assert.match(out, /1 modules/);
});

test('an empty sourceRoots fails rather than passing on nothing', (t) => {
    // `[]` reads like "no restriction" and means "no folders": the gate once printed a
    // pass over 0 modules for a whole monorepo this way.
    const { err, failed } = run(project(t, { 'src/a.ts': ORDERED }), { sourceRoots: [] });
    assert.equal(failed, true);
    assert.match(err, /`sourceRoots: \[\]` names no folders/);
});

test('roots that hold no .ts or .vue file fail too', (t) => {
    const { err, failed } = run(project(t, { 'src/a.js': 'export const a = 1;\n' }));
    assert.equal(failed, true);
    assert.match(err, /read no files/);
});

/** A module whose type sits below a constant: one misplaced statement. */
const MISPLACED = 'const LIMIT = 1;\n\ntype Thing = { a: number };\n\nexport const t: Thing = { a: LIMIT };\n';

/** `project`, made a git repo, so the default scope has something to list. */
const gitProject = (t, files) => {
    const root = project(t, files);
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
};

test('without sourceRoots every file git knows about is checked, so a new folder needs no listing', (t) => {
    // The Orchid miss: scripts/ turned TypeScript after the roots were listed, and nothing checked it.
    const root = gitProject(t, { 'src/a.ts': ORDERED, 'scripts/lib/env.ts': MISPLACED });
    const { err, failed } = run(root, { sourceRoots: undefined });
    assert.equal(failed, true);
    assert.match(err, /scripts\/lib\/env\.ts/);
    assert.match(err, /constants "LIMIT" belongs after types "Thing"/);
});

test('without sourceRoots a gitignored file is not checked', (t) => {
    const root = gitProject(t, { '.gitignore': 'dist/\n', 'src/a.ts': ORDERED, 'dist/a.ts': MISPLACED });
    const { out, failed } = run(root, { sourceRoots: undefined });
    assert.equal(failed, false, out);
    assert.match(out, /1 modules/);
});

test('exclude drops a directory and everything under it', (t) => {
    const root = gitProject(t, { 'src/a.ts': ORDERED, 'db/migrations/001.ts': MISPLACED });
    const { out, failed } = run(root, { sourceRoots: undefined, exclude: ['db/migrations'] });
    assert.equal(failed, false, out);
    assert.match(out, /1 modules/);
});

test('exclude matches whole path segments, not a name that merely starts the same', (t) => {
    const root = gitProject(t, { 'db/migrations/001.ts': ORDERED, 'db/migrations-old/001.ts': MISPLACED });
    const { err, failed } = run(root, { sourceRoots: undefined, exclude: ['db/migrations/'] });
    assert.equal(failed, true);
    assert.match(err, /db\/migrations-old\/001\.ts/);
});

test('exclude drops a single file, and applies alongside sourceRoots too', (t) => {
    const root = project(t, { 'src/a.ts': ORDERED, 'src/legacy.ts': MISPLACED });
    const { out, failed } = run(root, { exclude: ['src/legacy.ts'] });
    assert.equal(failed, false, out);
    assert.match(out, /1 modules/);
});

// ── The import pass ──────────────────────────────────────────────────────────

test('imports out of group order are reported against the three-group table', (t) => {
    const { err, failed } = run(
        project(t, {
            'src/a.ts': `import { thing } from './dep.js';
import fs from 'node:fs';

console.log(thing, fs);
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /Imports go builtin → external → local/);
});

test('a workspace scope adds a fourth group between external and local', (t) => {
    const { err } = run(
        project(t, {
            'src/a.ts': `import { thing } from '@acme/shared';
import fs from 'node:fs';

console.log(thing, fs);
`,
        }),
        { importOrder: { workspaceScope: '@acme/' } },
    );
    assert.match(err, /Imports go builtin → external → workspace → local/);
});

test('a `#` specifier is local: Node resolves it through this package own imports field', (t) => {
    // Mosaic is the only project using the idiom, and it is the only one whose own
    // gate had the rule. Treating `#db/x.js` as an npm package sorts it above `pino`,
    // which is how the omission stayed invisible in the four repos that never use it.
    const { out, failed } = run(
        project(t, {
            'src/a.ts': `import pino from 'pino';

import { REDACT } from '#config/redact.js';

console.log(pino, REDACT);
`,
        }),
    );
    assert.equal(failed, false, out);
});

test('a tsconfig alias that looks like a package sorts as local once declared', (t) => {
    const files = {
        'src/a.ts': `import { it } from 'vitest';

import { mount } from '@test-utils';

console.log(it, mount);
`,
    };
    assert.equal(run(project(t, files), { importOrder: { localAliases: ['@test-utils'] } }).failed, false);
    // Without the option it is an npm package, and `@test-utils` sorts above `vitest`.
    assert.equal(run(project(t, files)).failed, true);
});

test('--fix rewrites the import block and nothing else', (t) => {
    const root = project(t, {
        'src/a.ts': `import { thing } from './dep.js';
import fs from 'node:fs';

const LIMIT = 10;

console.log(thing, fs, LIMIT);
`,
    });
    const argv = process.argv;
    process.argv = [...argv, '--fix'];
    try {
        assert.equal(run(root).failed, false);
    } finally {
        process.argv = argv;
    }
    const fixed = readFileSync(path.join(root, 'src/a.ts'), 'utf8');
    assert.match(fixed, /^import fs from 'node:fs';\n\nimport \{ thing \} from '\.\/dep\.js';$/m);
    assert.match(fixed, /^const LIMIT = 10;$/m);
    // And the file now passes on its own.
    assert.equal(run(root).failed, false);
});

// ── Rust ────────────────────────────────────────────────────────────────────

/** A crate root in Rust's order, with its use groups apart. */
const RUST_LIB = `//! The app.

mod commands;
mod error;

use std::path::Path;

use tauri::{App, Manager};

use crate::commands::file::FILE_OPENED;

const LIMIT: u32 = 3;

pub struct Pending(pub Vec<String>);

impl Pending {
    pub fn new() -> Self {
        Self(Vec::new())
    }
}

impl Default for Pending {
    fn default() -> Self {
        Self::new()
    }
}

pub fn run() {}

struct Fields(String);

impl Fields {}

fn helper(_: &Path, _: &App) {}

#[cfg(test)]
mod tests {
    use super::*;
}
`;

const rust = (t, source, rel = 'src-tauri/src/lib.rs') =>
    run(project(t, { [rel]: source }), { sourceRoots: ['src-tauri/src'] });

test('a Rust file in the table’s order passes, and the summary counts it', (t) => {
    const result = rust(t, RUST_LIB);
    assert.equal(result.failed, false, result.err);
    assert.match(result.out, /1 Rust files, 14 items in Rust's order; 3 uses grouped/);
});

test('a public fn above a public type is reported against the Rust table', (t) => {
    const result = rust(
        t,
        RUST_LIB.replace('pub fn run() {}\n\n', '').replace('const LIMIT', 'pub fn run() {}\n\nconst LIMIT'),
    );
    assert.equal(result.failed, true);
    assert.match(result.err, /public fns "fn run" belongs after/);
    assert.match(result.err, /mod → use → pub use → const/);
});

test('an impl stranded below another item is one problem, not every item after it', (t) => {
    const moved = RUST_LIB.replace(
        'impl Default for Pending {\n    fn default() -> Self {\n        Self::new()\n    }\n}\n\n',
        '',
    ).replace(
        'fn helper',
        'impl Default for Pending {\n    fn default() -> Self {\n        Self::new()\n    }\n}\n\nfn helper',
    );
    const result = rust(t, moved);
    assert.equal(result.failed, true);
    assert.match(result.err, /1 item\(s\) out of canonical order/);
    assert.match(result.err, /"impl Default for Pending" belongs after public types "impl Pending"/);
});

test('a trait impl above the inherent impl is out of order', (t) => {
    const source =
        'pub struct A;\n\nimpl Clone for A {\n    fn clone(&self) -> Self {\n        Self\n    }\n}\n\nimpl A {}\n';
    const result = rust(t, source);
    assert.equal(result.failed, true);
    assert.match(result.err, /"impl Clone for A" belongs after public types "impl A"/);
});

test('an impl of a type the file does not declare sits with the private types', (t) => {
    assert.equal(
        rust(t, 'use serde::Serialize;\n\npub fn a() {}\n\nimpl Serialize for crate::Error {}\n').failed,
        false,
    );
    assert.equal(
        rust(t, 'use serde::Serialize;\n\nimpl Serialize for crate::Error {}\n\npub fn a() {}\n').failed,
        true,
    );
});

test('macro_rules! is left where it is: it only exists below its definition', (t) => {
    const source =
        'macro_rules! twice {\n    ($x:expr) => {\n        $x * 2\n    };\n}\n\nconst A: u8 = twice!(2);\n\npub fn b() {}\n';
    assert.equal(rust(t, source).failed, false);
});

test('the tests module goes last', (t) => {
    const result = rust(t, '#[cfg(test)]\nmod tests {}\n\nfn a() {}\n');
    assert.equal(result.failed, true);
    assert.match(result.err, /tests "mod tests" belongs after private fns "fn a"/);
});

test('use groups out of order are reported, std first', (t) => {
    const result = rust(t, 'use tauri::App;\n\nuse std::path::Path;\n\nfn a(_: &App, _: &Path) {}\n');
    assert.equal(result.failed, true);
    assert.match(result.err, /`use std::path::Path` \(std\) belongs above `use tauri::App` \(external crates\)/);
});

test('a blank line inside a group, and none between two, are both reported', (t) => {
    const split = rust(t, 'use tauri::App;\n\nuse tauri_plugin_fs::FsExt;\n');
    assert.match(split.err, /a blank line splits the external crates group/);
    const joined = rust(t, 'use std::path::Path;\nuse tauri::App;\n');
    assert.match(joined.err, /no blank line between the std group and `use tauri::App`/);
});

test('a comment between two uses is not a blank line', (t) => {
    assert.equal(
        rust(t, 'use tauri::App;\n// The fs scope, for files the OS opens.\nuse tauri_plugin_fs::FsExt;\n').failed,
        false,
    );
});

test('this crate’s module imported without `crate::` is reported', (t) => {
    const result = rust(t, 'mod commands;\n\nuse commands::file::FILE_OPENED;\n');
    assert.equal(result.failed, true);
    assert.match(
        result.err,
        /names this crate's `commands` module without `crate::` — write `use crate::commands::file::FILE_OPENED`/,
    );
});

test('Rust under target/ is never read', (t) => {
    const root = project(t, {
        'src-tauri/src/lib.rs': RUST_LIB,
        'src-tauri/target/debug/build/out/generated.rs': 'fn a() {}\npub fn b() {}\n',
    });
    const result = run(root, { sourceRoots: ['src-tauri'] });
    assert.equal(result.failed, false, result.err);
    assert.match(result.out, /1 Rust files/);
});

test('a file named as a source root is read on its own', (t) => {
    const root = project(t, { 'src-tauri/build.rs': 'fn main() {}\n\nconst COMMANDS: &[&str] = &[];\n' });
    const result = run(root, { sourceRoots: ['src-tauri/build.rs'] });
    assert.equal(result.failed, true);
    assert.match(result.err, /src-tauri\/build\.rs/);
});
