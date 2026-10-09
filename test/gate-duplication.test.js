/**
 * The duplication gate's rules, against the JSON jscpd actually emits.
 * - Driven through `inspectDuplication` rather than by running jscpd over a fixture
 * repo: the alternative is to check a clone of a specific token count into a fixture
 * and trust jscpd's tokenizer, its `minTokens`, and nobody ever reformatting the
 * fixture. `exportedTypes` is the one part that reads the filesystem, so it gets a
 * real temporary repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { exportedTypes, iconDrawing, iconDrawings, inspectDuplication } from '../src/gates/duplication.ts';

const ROOT = '/repo';

/** One clone, as jscpd reports it: absolute paths, and `tokens` is what the rules read. */
const clone = (first, second, { tokens = 60, lines = 8, format = 'typescript' } = {}) => ({
    format,
    lines,
    tokens,
    firstFile: { name: `${ROOT}/${first}`, start: 1, end: lines },
    secondFile: { name: `${ROOT}/${second}`, start: 1, end: lines },
});

/** A jscpd report whose per-format statistics are derived from the clones given. */
const report = (duplicates, percentages = {}) => ({
    duplicates,
    statistics: {
        formats: Object.fromEntries(
            Object.entries(percentages).map(([format, percentageTokens]) => [
                format,
                { percentageTokens, clones: duplicates.filter((d) => d.format === format).length },
            ]),
        ),
        total: { clones: duplicates.length },
    },
});

const MONOREPO = ['api/src', 'frontend/src', 'packages/shared/src'];

const inspect = (input) => inspectDuplication({ root: ROOT, scan: ['src'], ceilings: {}, ...input });
const whats = (result) => result.problems.map((p) => p.what).join('\n');

// ── The baseline ─────────────────────────────────────────────────────────────

test('a report with no clones and no ceilings has nothing to say', () => {
    assert.deepEqual(inspect({ report: report([]) }).problems, []);
});

test('a clone under every ceiling and under the cap is not a problem', () => {
    const result = inspect({
        report: report([clone('src/a.ts', 'src/b.ts', { tokens: 60 })], { typescript: 2 }),
        ceilings: { typescript: 4 },
        maxCloneTokens: 140,
    });
    assert.deepEqual(result.problems, []);
});

// ── 1. Per-format ceilings ───────────────────────────────────────────────────

test('a format over its ceiling fails, and the worst clones are listed under it', () => {
    const result = inspect({
        report: report(
            [
                clone('src/a.ts', 'src/b.ts', { tokens: 60 }),
                clone('src/c.ts', 'src/d.ts', { tokens: 200 }),
                clone('src/e.ts', 'src/f.ts', { tokens: 120 }),
            ],
            { typescript: 9.5 },
        ),
        ceilings: { typescript: 4 },
    });
    assert.match(
        result.problems[0].what,
        /`typescript` duplication is 9\.50% of tokens, over the 4% ceiling \(3 clones\)/,
    );
    // Largest first, so the first thing read is the biggest thing to fix.
    assert.match(result.problems[1].what, /200 tokens/);
    assert.match(result.problems[2].what, /120 tokens/);
    assert.match(result.problems[3].what, /60 tokens/);
});

test('a format with no ceiling is not gated, however high it is', () => {
    const result = inspect({
        report: report([clone('src/a.scss', 'src/b.scss', { format: 'scss' })], { typescript: 1, scss: 40 }),
        ceilings: { typescript: 4 },
    });
    assert.deepEqual(result.problems, []);
});

test('a ceiling given as a bare number works, and carries the generic reason', () => {
    const result = inspect({
        report: report([], { typescript: 7 }),
        ceilings: { typescript: 5 },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].why, /only ever goes down/);
});

test("a ceiling's note is what the failure explains itself with", () => {
    const result = inspect({
        report: report([], { scss: 9 }),
        ceilings: { scss: { limit: 0.5, note: 'presentation — a stale copy looks wrong rather than behaves wrong.' } },
    });
    assert.match(result.problems[0].why, /This ceiling is presentation/);
});

test('a format present in the ceilings but absent from the report is skipped, not assumed zero', () => {
    const result = inspect({
        report: report([], { typescript: 1 }),
        ceilings: { typescript: 4, html: 6 },
    });
    assert.deepEqual(result.problems, []);
});

test('a percentage exactly on the ceiling passes — the ceiling is a maximum, not a target', () => {
    assert.deepEqual(inspect({ report: report([], { typescript: 4 }), ceilings: { typescript: 4 } }).problems, []);
});

// ── 1b. Per-root ceilings ────────────────────────────────────────────────────

test('a root over the ceiling fails even when the whole scan is under it', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([], { typescript: 3.3 }),
        perRootReports: { 'api/src': report([], { typescript: 4.6 }) },
        ceilings: { typescript: 4 },
    });
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].file, 'api/src');
    assert.match(result.problems[0].what, /4\.60% of tokens, over the 4% ceiling/);
});

test('the whole-scan figure is checked too — a small clean root cannot dilute it away', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([], { typescript: 6 }),
        perRootReports: {
            'api/src': report([], { typescript: 1 }),
            'frontend/src': report([], { typescript: 1 }),
            'packages/shared/src': report([], { typescript: 1 }),
        },
        ceilings: { typescript: 4 },
    });
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].file, null);
});

test('no per-root reports means no per-root checks', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([], { typescript: 1 }),
        ceilings: { typescript: 4 },
    });
    assert.deepEqual(result.problems, []);
});

// ── 2. The cap on any single clone ───────────────────────────────────────────

test('a clone over the cap fails although every percentage is fine', () => {
    const result = inspect({
        report: report([clone('src/a.ts', 'src/b.ts', { tokens: 141 })], { typescript: 0.4 }),
        ceilings: { typescript: 4 },
        maxCloneTokens: 140,
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].what, /141 tokens duplicated at src\/b\.ts:1-8/);
    assert.match(result.problems[0].why, /the ratio can fall while this lands/);
});

test('a clone exactly on the cap passes', () => {
    const result = inspect({
        report: report([clone('src/a.ts', 'src/b.ts', { tokens: 140 })]),
        maxCloneTokens: 140,
    });
    assert.deepEqual(result.problems, []);
});

test('no cap means the rule says nothing, whatever the clone size', () => {
    const result = inspect({ report: report([clone('src/a.ts', 'src/b.ts', { tokens: 5000 })]) });
    assert.deepEqual(result.problems, []);
});

test('the cap applies to every format, not just logic', () => {
    const result = inspect({
        report: report([clone('src/a.scss', 'src/b.scss', { tokens: 300, format: 'scss' })]),
        maxCloneTokens: 140,
    });
    assert.equal(result.problems.length, 1);
});

// ── 3. Clones copied between scan roots ──────────────────────────────────────

test('a clone crossing two scan roots fails at any size', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([clone('api/src/lib/db.ts', 'frontend/src/lib/db.ts', { tokens: 50 })], { typescript: 0.1 }),
        ceilings: { typescript: 5 },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].why, /a fix lands in only one of them/);
});

test('a clone inside one root is not a cross-root clone', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([clone('api/src/a.ts', 'api/src/b.ts')]),
    });
    assert.deepEqual(result.problems, []);
});

test('with one scan root the cross-root rule says nothing — there is nothing to cross', () => {
    // Both sides are inside the only root, and `vendor/` is inside none of them, so
    // without the single-root guard the second clone would be reported as crossing
    // from `src` to nowhere.
    const result = inspect({
        scan: ['src'],
        report: report([clone('src/main/a.ts', 'src/renderer/b.ts'), clone('src/a.ts', 'vendor/b.ts')]),
    });
    assert.deepEqual(result.problems, []);
});

test('an allowed pair is excused in either order', () => {
    const allowed = [{ files: ['api/src/lib/db.ts', 'frontend/src/lib/db.ts'], why: 'composition, not logic' }];
    for (const pair of [
        ['api/src/lib/db.ts', 'frontend/src/lib/db.ts'],
        ['frontend/src/lib/db.ts', 'api/src/lib/db.ts'],
    ]) {
        const result = inspect({
            scan: MONOREPO,
            report: report([clone(pair[0], pair[1])]),
            crossCloneAllowed: allowed,
        });
        assert.deepEqual(result.problems, [], pair.join(' ↔ '));
    }
});

test('an allowance excuses only its own pair, not every clone between those roots', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([
            clone('api/src/lib/db.ts', 'frontend/src/lib/db.ts'),
            clone('api/src/lib/redis.ts', 'frontend/src/lib/redis.ts'),
        ]),
        crossCloneAllowed: [{ files: ['api/src/lib/db.ts', 'frontend/src/lib/db.ts'], why: 'composition' }],
    });
    assert.equal(result.problems.length, 1);
    assert.match(whats(result), /redis\.ts/);
});

test('an allowance whose clone no longer exists fails, so the list only ever shrinks', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([]),
        crossCloneAllowed: [{ files: ['api/src/lib/db.ts', 'frontend/src/lib/db.ts'], why: 'composition' }],
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].what, /no longer exists/);
    assert.equal(result.problems[0].file, 'api/src/lib/db.ts');
});

test('a stale allowance is matched against every clone, not only the cross-root ones', () => {
    // The two files moved into one root. The clone is still there, so the entry is not stale.
    const result = inspect({
        scan: MONOREPO,
        report: report([clone('api/src/lib/db.ts', 'api/src/lib/db-old.ts')]),
        crossCloneAllowed: [{ files: ['api/src/lib/db.ts', 'api/src/lib/db-old.ts'], why: 'composition' }],
    });
    assert.deepEqual(result.problems, []);
});

test("an SFC's script block is matched by file, not by jscpd's `:typescript` suffix", () => {
    const withSuffix = {
        ...clone('frontend/src/Card.vue', 'api/src/card.ts'),
        firstFile: { name: `${ROOT}/frontend/src/Card.vue:typescript`, start: 1, end: 8 },
    };
    const result = inspect({
        scan: MONOREPO,
        report: report([withSuffix]),
        crossCloneAllowed: [{ files: ['frontend/src/Card.vue', 'api/src/card.ts'], why: 'composition' }],
    });
    assert.deepEqual(result.problems, []);
});

// ── 4. One exported type name in two roots ───────────────────────────────────

test('a type name declared in two roots fails, once per declaration', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([]),
        declarations: new Map([
            [
                'VideoMeta',
                [
                    { root: 'api/src', where: 'api/src/types.ts:4' },
                    { root: 'frontend/src', where: 'frontend/src/types.ts:9' },
                ],
            ],
        ]),
    });
    assert.equal(result.problems.length, 2);
    assert.equal(result.problems[0].file, 'api/src/types.ts:4');
    assert.match(result.problems[0].what, /also declared in frontend\/src\/types\.ts:9/);
    assert.match(result.problems[1].what, /also declared in api\/src\/types\.ts:4/);
});

test("the same name twice inside one root is that root's business", () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([]),
        declarations: new Map([
            [
                'Options',
                [
                    { root: 'api/src', where: 'api/src/a.ts:1' },
                    { root: 'api/src', where: 'api/src/b.ts:1' },
                ],
            ],
        ]),
    });
    assert.deepEqual(result.problems, []);
});

test('with one scan root the type rule says nothing', () => {
    const result = inspect({
        scan: ['src'],
        report: report([]),
        declarations: new Map([
            [
                'Options',
                [
                    { root: 'src', where: 'src/a.ts:1' },
                    { root: 'other', where: 'other/b.ts:1' },
                ],
            ],
        ]),
    });
    assert.deepEqual(result.problems, []);
});

test('the count of distinct names is reported, for the passing summary', () => {
    const result = inspect({
        scan: MONOREPO,
        report: report([]),
        declarations: new Map([
            ['A', [{ root: 'api/src', where: 'api/src/a.ts:1' }]],
            ['B', [{ root: 'api/src', where: 'api/src/b.ts:1' }]],
        ]),
    });
    assert.equal(result.types, 2);
});

// ── exportedTypes, against a real tree ───────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-gate-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (rel, source) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
};

test('exportedTypes finds exported types and interfaces, with their line numbers', () => {
    write(
        'api/src/types.ts',
        '// header\n\nexport type VideoMeta = { id: string };\nexport interface User {\n    id: string;\n}\n',
    );
    write('frontend/src/types.ts', 'export type VideoMeta = { id: string; title: string };\n');

    const found = exportedTypes(tmp, ['api/src', 'frontend/src']);
    assert.deepEqual(found.get('VideoMeta'), [
        { root: 'api/src', where: 'api/src/types.ts:3' },
        { root: 'frontend/src', where: 'frontend/src/types.ts:1' },
    ]);
    assert.deepEqual(found.get('User'), [{ root: 'api/src', where: 'api/src/types.ts:4' }]);
});

test('exportedTypes ignores a type that is not exported, and one that is only re-exported', () => {
    write('api/src/local.ts', 'type Hidden = string;\nexport type { Hidden };\nexport * from "./types.js";\n');
    const found = exportedTypes(tmp, ['api/src']);
    assert.equal(found.has('Hidden'), false);
});

test('exportedTypes skips tests, declaration files and build output', () => {
    write('api/src/__tests__/helpers.ts', 'export type Fixture = { id: string };\n');
    write('api/src/thing.test.ts', 'export type Mocked = { id: string };\n');
    write('api/src/globals.d.ts', 'export type Ambient = { id: string };\n');
    write('api/src/dist/bundle.ts', 'export type Built = { id: string };\n');

    const found = exportedTypes(tmp, ['api/src']);
    for (const name of ['Fixture', 'Mocked', 'Ambient', 'Built']) {
        assert.equal(found.has(name), false, name);
    }
});

test('exportedTypes reads an SFC, where a type in <script setup> is just as exported', () => {
    write('frontend/src/Card.vue', '<script setup lang="ts">\nexport type CardProps = { id: string };\n</script>\n');
    const found = exportedTypes(tmp, ['frontend/src']);
    assert.deepEqual(found.get('CardProps'), [{ root: 'frontend/src', where: 'frontend/src/Card.vue:2' }]);
});

test('exportedTypes skips a scan root that does not exist, so one options object fits a family', () => {
    assert.doesNotThrow(() => exportedTypes(tmp, ['api/src', 'ingestor/src']));
});

// ── 5. Icons drawn twice ─────────────────────────────────────────────────────

const icon = (svgAttrs, body) =>
    `<template>\n    <svg aria-hidden="true" ${svgAttrs}>\n        ${body}\n    </svg>\n</template>\n`;
const STROKED = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"';
const CROSS = '<line x1="18" y1="6" x2="6" y2="18" />\n        <line x1="6" y1="6" x2="18" y2="18" />';

test('two icon files with the same drawing fail, once, under the first', () => {
    const icons = new Map([['k', ['src/components/icons/IconClose.vue', 'src/components/icons/IconX.vue']]]);
    const result = inspect({ report: report([]), icons });
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].file, 'src/components/icons/IconClose.vue');
    assert.match(result.problems[0].what, /same icon as src\/components\/icons\/IconX\.vue/);
});

test('an icon drawn once is fine, and the count of icons is reported for the summary', () => {
    const icons = new Map([
        ['a', ['src/components/icons/IconA.vue']],
        ['b', ['src/components/icons/IconB.vue']],
    ]);
    const result = inspect({ report: report([]), icons });
    assert.deepEqual(result.problems, []);
    assert.equal(result.icons, 2);
});

test('iconDrawing: spelling is not a difference — attribute order, whitespace, self-closing, comments', () => {
    const a = icon(STROKED, CROSS);
    const b = icon(
        'stroke="currentColor" fill="none" viewBox="0 0 24 24"',
        '<!-- x --><line y2="18" x2="6" y1="6" x1="18"></line><line x1="6"   y1="6" x2="18" y2="18"/>',
    );
    assert.equal(iconDrawing(a), iconDrawing(b));
});

test('iconDrawing: a stroke weight or cap is not a different icon — callers override those', () => {
    assert.equal(iconDrawing(icon(STROKED, CROSS)), iconDrawing(icon(STROKED.replace('"2"', '"1.5"'), CROSS)));
    assert.equal(
        iconDrawing(icon(STROKED, CROSS)),
        iconDrawing(icon(STROKED.replace(' stroke-linecap="round"', ''), CROSS)),
    );
});

test('iconDrawing: the viewBox, fill and stroke ARE the picture', () => {
    const base = iconDrawing(icon(STROKED, CROSS));
    assert.notEqual(base, iconDrawing(icon(STROKED.replace('0 0 24 24', '0 0 16 16'), CROSS)));
    assert.notEqual(base, iconDrawing(icon(STROKED.replace('fill="none"', 'fill="currentColor"'), CROSS)));
    assert.notEqual(base, iconDrawing(icon(STROKED.replace('stroke="currentColor"', 'stroke="red"'), CROSS)));
});

test('iconDrawing: a different shape is a different icon, however small the change', () => {
    assert.notEqual(iconDrawing(icon(STROKED, CROSS)), iconDrawing(icon(STROKED, CROSS.replace('x1="18"', 'x1="19"'))));
});

test('iconDrawing: a file with no <svg> draws nothing', () => {
    assert.equal(iconDrawing('<template><span /></template>'), null);
});

test('iconDrawings groups the icons folder of every scan root, and nothing outside it', () => {
    write('frontend/src/components/icons/IconClose.vue', icon(STROKED, CROSS));
    write('frontend/src/components/icons/IconCross.vue', icon(STROKED.replace('"2"', '"3"'), CROSS));
    write(
        'frontend/src/components/icons/IconPlay.vue',
        icon('viewBox="0 0 24 24" fill="currentColor"', '<path d="M8 5v14l11-7z" />'),
    );
    write('frontend/src/components/icons/Broken.vue', '<template><span /></template>\n');
    // An inline <svg> elsewhere is ESLint's business (larry/no-inline-svg), not this rule's.
    write('frontend/src/components/Card.vue', icon(STROKED, CROSS));

    const groups = [...iconDrawings(tmp, ['frontend/src']).values()];
    assert.deepEqual(
        groups.sort((a, b) => b.length - a.length),
        [
            ['frontend/src/components/icons/IconClose.vue', 'frontend/src/components/icons/IconCross.vue'],
            ['frontend/src/components/icons/IconPlay.vue'],
        ],
    );
});

test('iconDrawings in a repo with no icons folder finds nothing, so the rule is silent', () => {
    assert.equal(iconDrawings(tmp, ['api/src', 'ingestor/src']).size, 0);
});
