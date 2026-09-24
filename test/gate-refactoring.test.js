/**
 * The refactoring gate, against real fixture repositories.
 *
 * It has to be a real repository: the gate's file list comes from
 * `git ls-files --cached --others --exclude-standard`, and that choice is the point
 * of one of the tests below — a marker in a file added but not yet committed must be
 * caught before the commit, not after.
 *
 * The case-sensitivity tests are the ones worth reading. Four of the five projects
 * matched the shouted form only and one matched case-insensitively; three of them
 * ship Spanish or Portuguese locale strings containing the ordinary word `todo`, so
 * the insensitive match is the one that cannot be satisfied without breaking a
 * translation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkRefactoring } from '../src/gates/refactoring.ts';

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

/** A committed repository holding `files`; anything in `extra` is left uncommitted. */
const project = (t, files, extra = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-refactor-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const put = (rel, body) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
    };
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

    for (const [rel, body] of Object.entries(files)) put(rel, body);

    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    git('add', '-A');
    git('commit', '-qm', 'fixture');

    for (const [rel, body] of Object.entries(extra)) put(rel, body);

    return root;
};

const run = (t, files, options = {}, extra = {}) => {
    const root = project(t, files, extra);
    return capture(() => checkRefactoring({ root, ...options }));
};

// ── The baseline ─────────────────────────────────────────────────────────────

test('a repo with no markers passes and says what it covered', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n', 'deploy.yml': 'name: deploy\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /no deferral markers in 2 unlinted files/);
});

// ── 1. Markers where ESLint has no parser ────────────────────────────────────

test('a marker in a file ESLint cannot parse fails, with its line and its text', (t) => {
    const result = run(t, { 'styles/_layout.scss': '// header\n// TODO: split this file\n.a { color: red; }\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /styles\/_layout\.scss:2/);
    assert.match(result.err, /`TODO` marker — \/\/ TODO: split this file/);
});

test('every marker in the list is matched', (t) => {
    for (const marker of ['TODO', 'FIXME', 'FIX ME', 'HACK', 'XXX', 'TBD', 'WIP']) {
        const result = run(t, { 'notes.yml': `# ${marker} something\n` });
        assert.equal(result.failed, true, marker);
    }
});

test('a marker inside a longer word is not a marker', (t) => {
    const result = run(t, { 'art.txt': 'XXXXXXXXXX\nHACKING is fine\nTODOS\n' });
    assert.equal(result.failed, false);
});

test('a file ESLint already lints is left alone, so one marker is not reported twice', (t) => {
    const result = run(t, { 'src/main.ts': '// TODO: later\n' });
    assert.equal(result.failed, false);
});

test('with `linted: []` — a project with no ESLint — the same file IS read', (t) => {
    const result = run(t, { 'src/main.ts': '// TODO: later\n' }, { linted: [] });
    assert.equal(result.failed, true);
});

test('a file added but not yet committed is checked, which is the point of --others', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n' }, {}, { 'new.scss': '// FIXME: unfinished\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /new\.scss:1/);
});

test('build output and vendored code are not read', (t) => {
    const result = run(t, {
        'README.md': '# Fixture\n',
        'dist/bundle.css': '/* TODO */\n',
        'out/app.yml': '# TODO\n',
        'coverage/report.html': '<!-- TODO -->\n',
        'node_modules/dep/readme.md': 'TODO\n',
    });
    assert.equal(result.failed, false);
});

test('package-lock.json is never read, whatever a dependency called itself', (t) => {
    const result = run(t, { 'package-lock.json': '{ "name": "TODO" }\n' });
    assert.equal(result.failed, false);
});

test('extra skipped basenames are honoured', (t) => {
    const files = { 'scripts/generated.yml': '# TODO: regenerate\n' };
    assert.equal(run(t, files).failed, true);
    assert.equal(run(t, files, { skip: ['generated.yml'] }).failed, false);
});

// ── Case sensitivity ─────────────────────────────────────────────────────────

test('a lowercase `todo` in a locale file is Spanish, not a marker', (t) => {
    const result = run(t, {
        'locales/es.json': '{\n    "reset": "¿Desea reiniciar todo su portafolio?",\n    "copy": "Copiar Todo"\n}\n',
    });
    assert.equal(result.failed, false);
});

test('the shouted form in that same file still fails', (t) => {
    const result = run(t, {
        'locales/es.json': '{\n    "_note": "TODO translate this",\n    "copy": "Copiar Todo"\n}\n',
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /locales\/es\.json:2/);
});

// ── Markdown ─────────────────────────────────────────────────────────────────

test('a backticked marker in prose is named, not used', (t) => {
    const result = run(t, { 'CONTRIBUTING.md': 'Commits can be messy — `WIP`, fixups. See `notes/TODO.md`.\n' });
    assert.equal(result.failed, false);
});

test('a marker in a fenced block is documentation of the rule, not a breach of it', (t) => {
    const result = run(t, { 'docs/gates.md': 'The gate bans these:\n\n```\n// TODO: later\n```\n\nThat is all.\n' });
    assert.equal(result.failed, false);
});

test('stripping a fenced block keeps the line numbers of everything after it', (t) => {
    const result = run(t, { 'docs/gates.md': '# Gates\n\n```\nTODO\nTODO\n```\n\nTBD: write the rest\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /docs\/gates\.md:8/);
});

test('a marker in ordinary markdown prose still fails', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n\nTBD: describe the worker.\n' });
    assert.equal(result.failed, true);
});

// ── SFC templates ────────────────────────────────────────────────────────────

const SFC = `<template>
    <!-- TODO: extract this row -->
    <div class="row" />
</template>

<script setup lang="ts">
const a = 1;
</script>
`;

test("an SFC template is read, because ESLint's no-warning-comments never sees it", (t) => {
    const result = run(t, { 'src/Card.vue': SFC });
    assert.equal(result.failed, true);
    assert.match(result.err, /src\/Card\.vue:2/);
});

test('the SFC script half is left to ESLint, so the two halves are covered once each', (t) => {
    const result = run(t, {
        'src/Card.vue': '<template>\n    <div />\n</template>\n\n<script setup lang="ts">\n// TODO: later\n</script>\n',
    });
    assert.equal(result.failed, false);
});

test('an SFC with no template block is skipped rather than read whole', (t) => {
    const result = run(t, { 'src/thing.vue': '<script setup lang="ts">\n// TODO: later\n</script>\n' });
    assert.equal(result.failed, false);
});

test('a nested <template> inside the block does not end it early', (t) => {
    const source = `<template>
    <Modal>
        <template #body>
            <p>hi</p>
        </template>
    </Modal>
    <!-- HACK: remove once the API returns it -->
</template>
`;
    const result = run(t, { 'src/Card.vue': source });
    assert.equal(result.failed, true);
    assert.match(result.err, /src\/Card\.vue:7/);
});

test('with `.vue` absent from `linted`, the whole SFC is read instead', (t) => {
    const result = run(t, { 'src/Card.vue': SFC }, { linted: ['.ts', '.js'] });
    assert.equal(result.failed, true);
    assert.match(result.out + result.err, /src\/Card\.vue:2/);
});

test('SFC template blocks are counted separately in the summary', (t) => {
    const result = run(t, { 'src/Card.vue': '<template>\n    <div />\n</template>\n', 'README.md': '# Fixture\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /1 unlinted file or 1 SFC <template> block/);
});

// ── 2. The destination ───────────────────────────────────────────────────────

test('the tracker itself is never flagged for containing the word', (t) => {
    const result = run(t, { 'todo.md': '- [ ] TODO: finish the worker\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /todo\.md holds 1 item/);
});

test('an empty tracker fails — deferred work is being dropped, not deferred', (t) => {
    const result = run(t, { 'todo.md': '\n\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /is empty/);
});

test('a missing tracker is not a failure, because it is often gitignored', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /todo\.md is not in this checkout/);
});

test('requireCheckboxes fails a bare bullet, and is off by default', (t) => {
    const files = { 'todo.md': '- [ ] done properly\n- a bare bullet\n' };
    assert.equal(run(t, files).failed, false);

    const strict = run(t, files, { requireCheckboxes: true });
    assert.equal(strict.failed, true);
    assert.match(strict.err, /todo\.md:2/);
    assert.match(strict.err, /bullet without a checkbox/);
});

test('a differently named tracker is honoured everywhere at once', (t) => {
    const result = run(t, { 'BACKLOG.md': '- [ ] TODO: finish the worker\n' }, { tracker: 'BACKLOG.md' });
    assert.equal(result.failed, false);
    assert.match(result.out, /BACKLOG\.md holds 1 item/);
});

// ── Files that are not text ──────────────────────────────────────────────────

test('a binary file is not read as text', (t) => {
    const result = run(t, { 'assets/icon.png': 'TODO\n', 'assets/blob.bin': 'TODO\0TODO\n' });
    assert.equal(result.failed, false);
});
