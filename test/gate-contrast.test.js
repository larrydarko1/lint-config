import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contrastRatio, inspectContrast } from '../src/gates/contrast.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contrast-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const MAPS = [
    '$theme-light: (',
    "    'text': #1c1a15,",
    "    'text-muted': #55504a,",
    "    'bg': #f4f1ea,",
    "    'surface': #d5cfc0,",
    ');',
    '',
    '$theme-dark: (',
    "    'text': #fff,",
    "    'text-muted': #b0b0b0,",
    "    'bg': #121212,",
    "    'surface': #282828,",
    ');',
].join('\n');

const THEMES = { source: 'scss-maps', file: 'src/styles/variables.scss', reference: 'light' };

const run = (root, options = {}) =>
    inspectContrast({ root, themes: THEMES, text: ['text', 'text-muted'], backgrounds: ['bg', 'surface'], ...options });

const whats = (result) => result.problems.map((p) => p.what);

// ── The maths ───────────────────────────────────────────────────────────────
test('the ratio runs from 1 for one colour to 21 for black on white, either way round', () => {
    assert.equal(contrastRatio('#000', '#fff'), 21);
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#abc', '#aabbcc'), 1);
    // #777 on white is the classic near miss: 4.48:1, just under AA.
    assert.equal(contrastRatio('#777777', '#fff').toFixed(2), '4.48');
});

// ── 1–2. The palettes ───────────────────────────────────────────────────────
test('palettes that clear AA pass, with every pair in every palette measured', (t) => {
    const result = run(tree(t, { 'src/styles/variables.scss': MAPS }));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.palettes, ['light', 'dark']);
    assert.equal(result.pairs.length, 8);
});

test('a pair under the ratio fails, naming the palette, both colours and the ratio', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS.replace("'text-muted': #b0b0b0", "'text-muted': #555555"),
    });
    const [what] = whats(run(root));
    assert.match(what, /`dark`: text-muted \(#555555\) on bg \(#121212\) is 2\.\d\d:1, under 4\.5:1/);
});

test('minRatio raises the bar', (t) => {
    const root = tree(t, { 'src/styles/variables.scss': MAPS });
    assert.ok(run(root, { minRatio: 7 }).problems.length > 0);
});

test('a token missing from a palette, or not a measurable colour, fails rather than being skipped', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS.replace("    'surface': #282828,\n", '').replace(
            "'bg': #f4f1ea",
            "'bg': rgba(0, 0, 0, 0.5)",
        ),
    });
    const found = whats(run(root));
    assert.ok(found.some((what) => /`dark` palette has no `surface`/.test(what)));
    assert.ok(found.some((what) => /`light`\.`bg` is `rgba\(0, 0, 0, 0\.5\)`/.test(what)));
});

test('finding no palettes fails, so a moved theme file cannot read as a pass', (t) => {
    const root = tree(t, { 'src/styles/variables.scss': '$space-1: 0.5em;\n' });
    assert.deepEqual(whats(run(root)), ['no palettes found']);
});

test('css-blocks and json-presets palettes are read too', (t) => {
    const root = tree(t, {
        'src/themes.css': [
            ":root[data-theme='light'] {",
            '    --text: #000;',
            '    --bg: #fff;',
            '}',
            "[data-theme='dark'] {",
            '    --text: #fff;',
            '    --bg: #000;',
            '}',
        ].join('\n'),
        'presets/paper.json': JSON.stringify({ name: 'Paper', colors: { text: '#111', bg: '#eee' } }),
    });
    const blocks = inspectContrast({
        root,
        themes: { source: 'css-blocks', file: 'src/themes.css', reference: 'light', selector: 'data-theme' },
        text: ['text'],
        backgrounds: ['bg'],
    });
    assert.deepEqual(blocks.problems, []);
    assert.deepEqual(blocks.palettes, ['light', 'dark']);

    const presets = inspectContrast({
        root,
        themes: { source: 'json-presets', dir: 'presets', reference: 'paper', fallbackFile: 'src/themes.css' },
        text: ['text'],
        backgrounds: ['bg'],
    });
    assert.deepEqual(presets.problems, []);
    assert.deepEqual(presets.palettes, ['paper']);
});

// ── 3. Dimmed text ──────────────────────────────────────────────────────────
test('a rule that colours text and lowers its opacity fails, at the line of its selector', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS,
        'src/styles/base.scss': [
            '.fine {',
            '    color: $color-text;',
            '}',
            '',
            '.dim {',
            '    color: $color-text-muted;',
            '    opacity: 0.6;',
            '}',
        ].join('\n'),
    });
    const { problems, swept } = run(root, { scan: ['src'] });
    assert.equal(swept, 2);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].file, 'src/styles/base.scss:5');
    assert.match(problems[0].what, /`\.dim` sets color: \$color-text-muted and opacity: 0\.6/);
});

test('decoration, full opacity and a reasoned exemption pass; a bare exemption does not', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS,
        'src/styles/base.scss': [
            '.rule::before {',
            '    color: $color-text;',
            '    opacity: 0.4;',
            '}',
            '.solid {',
            '    color: $color-text;',
            '    opacity: 1;',
            '}',
            '/* contrast-exempt: aria-hidden ornament, carries no information */',
            '.ornament {',
            '    color: $color-text;',
            '    opacity: 0.3;',
            '}',
            '/* contrast-exempt */',
            '.lazy {',
            '    color: $color-text;',
            '    opacity: 0.3;',
            '}',
        ].join('\n'),
    });
    const found = whats(run(root, { scan: ['src'] }));
    assert.equal(found.length, 1);
    assert.match(found[0], /`\.lazy`/);
});

test('in a component only the <style> blocks are read, and lines count from the top of the file', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS,
        'src/components/note.vue': [
            '<script setup lang="ts"></script>',
            '<template>',
            '    <p class="note">{{ "color: $color-text; opacity: 0.5;" }}</p>',
            '</template>',
            '<style scoped>',
            '.note {',
            '    color: $color-text;',
            '    opacity: 0.5;',
            '}',
            '</style>',
        ].join('\n'),
    });
    const { problems } = run(root, { scan: ['src'] });
    assert.deepEqual(
        problems.map((p) => p.file),
        ['src/components/note.vue:6'],
    );
});

test('textAliases says how this project names a text colour', (t) => {
    const root = tree(t, {
        'src/styles/variables.scss': MAPS,
        'src/styles/base.scss': ['.link {', '    color: $color-accent;', '    opacity: 0.7;', '}'].join('\n'),
    });
    assert.equal(run(root, { scan: ['src'] }).problems.length, 0);
    assert.equal(run(root, { scan: ['src'], textAliases: ['$color-accent'] }).problems.length, 1);
});
