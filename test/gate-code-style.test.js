/**
 * The code style gate, against temporary source trees.
 *
 * Every test builds a real directory because the gate's whole job is the shape of
 * files on disk — what they are called, how long they are, what their first line is.
 * A fake filesystem would test the mock.
 *
 * The tests worth reading are the ones covering the four rules that only one family
 * had. They are here as much to record that the union costs nothing as to check the
 * behaviour: a composable exporting its own name, SFC block order, and the two
 * stale-baseline rules all found zero problems in the repos that never had them —
 * except the stale-baseline pair, which found four, which is the point.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { inspectCodeStyle, measureFile, scriptBlocks } from '../src/gates/code-style.ts';

/** A source tree holding `files`, cleaned up when the test ends. */
const tree = (t, files) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-style-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const run = (root, options = {}) => inspectCodeStyle({ root, scan: ['src'], ...options });
const whats = (result) => result.problems.map((p) => `${p.file}: ${p.what}`);

/** A minimal, entirely correct SFC. */
const SFC =
    '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    <div>{{ a }}</div>\n</template>\n\n<style scoped lang="scss">\n.x {\n    color: red;\n}\n</style>\n';

const CAMEL = [
    { files: /\.vue$/, style: 'pascal' },
    { files: /\.ts$/, style: 'camel' },
];
const KEBAB = [{ files: /\.ts$/, style: 'kebab' }];

// ── The walk ────────────────────────────────────────────────────────────────
test('a correct tree has no problems', (t) => {
    const root = tree(t, {
        'src/Widget.vue': SFC,
        'src/thing.ts': 'export function thing(): number {\n    return 1;\n}\n',
    });
    const result = run(root, { casing: CAMEL });
    assert.deepEqual(result.problems, []);
    assert.equal(result.files, 2);
});

test('specs and ambient declarations are out of scope', (t) => {
    const root = tree(t, {
        'src/thing.ts': 'export const a = 1;\n',
        'src/Bad-Name.test.ts': 'export const b = 1;\n',
        '__tests__/Bad-Name.ts': 'export const c = 1;\n',
        'src/__tests__/Bad-Name.ts': 'export const d = 1;\n',
        'src/bad-Name.d.ts': 'export declare const e: number;\n',
    });
    const result = run(root, { casing: CAMEL });
    assert.deepEqual(result.problems, []);
    assert.equal(result.files, 1);
});

// ── 1. Filename casing ──────────────────────────────────────────────────────
test('a camelCase rule catches a kebab filename', (t) => {
    const root = tree(t, { 'src/my-thing.ts': 'export const a = 1;\n' });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/my-thing.ts: filename `my-thing` is not camelCase']);
});

test('a kebab rule catches a camelCase filename', (t) => {
    const root = tree(t, { 'src/myThing.ts': 'export const a = 1;\n' });
    assert.deepEqual(whats(run(root, { casing: KEBAB })), ['src/myThing.ts: filename `myThing` is not kebab-case']);
});

test('an SFC is PascalCase', (t) => {
    const root = tree(t, { 'src/widget.vue': SFC });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/widget.vue: filename `widget` is not PascalCase']);
});

test('the first matching casing rule wins', (t) => {
    const root = tree(t, { 'src/services/my-thing.ts': 'export const a = 1;\n' });
    const casing = [
        { files: /\/services\//, style: 'kebab' },
        { files: /\.ts$/, style: 'camel' },
    ];
    assert.deepEqual(run(root, { casing }).problems, []);
});

test('a file no casing rule matches is unchecked', (t) => {
    const root = tree(t, { 'src/My_Thing.vue': SFC });
    assert.deepEqual(run(root, { casing: KEBAB }).problems, []);
});

test('an exempt path skips the casing rule', (t) => {
    const root = tree(t, { 'src/editor/cm-theme.ts': 'export const a = 1;\n' });
    const exempt = { casing: [{ files: /\.ts$/, style: 'camel', exempt: /^src\/editor\/cm-[a-z-]+\.ts$/ }] };
    assert.deepEqual(run(root, exempt).problems, []);
    assert.equal(run(root, { casing: CAMEL }).problems.length, 1);
});

test('the exemption is matched against the path, not the name', (t) => {
    const root = tree(t, { 'src/elsewhere/cm-theme.ts': 'export const a = 1;\n' });
    const exempt = { casing: [{ files: /\.ts$/, style: 'camel', exempt: /^src\/editor\/cm-[a-z-]+\.ts$/ }] };
    assert.equal(run(root, exempt).problems.length, 1);
});

// ── 2. A composable file exports its own name ───────────────────────────────
test('a composable that exports its own name passes', (t) => {
    const root = tree(t, { 'src/useThing.ts': 'export function useThing(): number {\n    return 1;\n}\n' });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a composable that exports something else fails', (t) => {
    const root = tree(t, { 'src/useThing.ts': 'export function useOther(): number {\n    return 1;\n}\n' });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/useThing.ts: exports nothing named `useThing…`']);
});

test('a prefixed export satisfies the composable rule', (t) => {
    const root = tree(t, { 'src/useDebounce.ts': 'export const useDebounceFn = (): number => 1;\n' });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a commented-out export does not satisfy the composable rule', (t) => {
    const root = tree(t, { 'src/useThing.ts': '// export function useThing() {}\nexport const other = 1;\n' });
    assert.equal(run(root, { casing: CAMEL }).problems.length, 1);
});

test('a file that is not a composable is not asked to export its name', (t) => {
    const root = tree(t, { 'src/user.ts': 'export const a = 1;\n' });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

// ── 3. The softcap, as a ratchet ────────────────────────────────────────────
const long = (n) => `${'export const a = 1;\n'.repeat(n)}`;

test('a file over the cap with no baseline fails', (t) => {
    const root = tree(t, { 'src/big.ts': long(12) });
    assert.deepEqual(whats(run(root, { casing: CAMEL, lineCap: 10 })), [
        'src/big.ts: 12 lines, over the ~10-line softcap',
    ]);
});

test('a baselined file at its baseline passes', (t) => {
    const root = tree(t, { 'src/big.ts': long(12) });
    assert.deepEqual(run(root, { casing: CAMEL, lineCap: 10, baseline: { 'src/big.ts': 12 } }).problems, []);
});

test('a baselined file that grew fails', (t) => {
    const root = tree(t, { 'src/big.ts': long(13) });
    const result = run(root, { casing: CAMEL, lineCap: 10, baseline: { 'src/big.ts': 12 } });
    assert.deepEqual(whats(result), ['src/big.ts: grew to 13 lines (was 12, already over the ~10 softcap)']);
});

test('a baselined file that shrank but is still over the cap passes', (t) => {
    const root = tree(t, { 'src/big.ts': long(11) });
    assert.deepEqual(run(root, { casing: CAMEL, lineCap: 10, baseline: { 'src/big.ts': 12 } }).problems, []);
});

test('a baselined file back under the cap must lose its entry', (t) => {
    const root = tree(t, { 'src/big.ts': long(9) });
    const result = run(root, { casing: CAMEL, lineCap: 10, baseline: { 'src/big.ts': 12 } });
    assert.deepEqual(whats(result), ['src/big.ts: is down to 9 lines and no longer needs a baseline entry']);
});

test('a file exactly on the cap is not over it', (t) => {
    const root = tree(t, { 'src/big.ts': long(10) });
    assert.deepEqual(run(root, { casing: CAMEL, lineCap: 10 }).problems, []);
});

test('a baseline entry naming a file that does not exist fails', (t) => {
    const root = tree(t, { 'src/thing.ts': 'export const a = 1;\n' });
    const result = run(root, { casing: CAMEL, baseline: { 'src/gone.ts': 900 } });
    assert.deepEqual(whats(result), ['src/gone.ts: is in `baseline` but does not exist']);
});

test('the reported baseline count is the size of the list', (t) => {
    const root = tree(t, { 'src/big.ts': long(12) });
    assert.equal(run(root, { casing: CAMEL, lineCap: 10, baseline: { 'src/big.ts': 12 } }).baselined, 1);
});

// ── measure ─────────────────────────────────────────────────────────────────
test("blank lines do not count towards a file's length", () => {
    assert.equal(measureFile('a\n\n\nb\n', 'x.ts'), 2);
});

test("an SFC style block does not count towards the file's length", () => {
    assert.equal(measureFile(SFC, 'X.vue'), 6);
});

test('a style block is dropped from an SFC only, not from a .ts file', () => {
    const source = 'const css = `\n<style>\na\nb\nc\n</style>\n`;\n';
    assert.equal(measureFile(source, 'x.ts'), 7);
});

test('the blank lines a file is padded with cannot push it over the cap', (t) => {
    const root = tree(t, { 'src/thing.ts': 'export const a = 1;\n\n\n\n\n\n\n\n\n\n\n\n' });
    assert.deepEqual(run(root, { casing: CAMEL, lineCap: 5 }).problems, []);
});

test('a long style block cannot push an SFC over the cap', (t) => {
    const rule = '.x {\n    color: red;\n}\n';
    const root = tree(t, { 'src/Thing.vue': SFC.replace(rule, rule.repeat(6)) });
    assert.deepEqual(run(root, { casing: CAMEL, lineCap: 10 }).problems, []);
});

// ── 4. Public before private ────────────────────────────────────────────────
test('an export after a private function fails, naming both', (t) => {
    const body =
        'function helper(): number {\n    return 1;\n}\nexport function api(): number {\n    return helper();\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), [
        'src/thing.ts: exported `api()` is declared after the private `helper()`',
    ]);
});

test('public above private passes', (t) => {
    const body =
        'export function api(): number {\n    return helper();\n}\nfunction helper(): number {\n    return 1;\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a private function quoted in a comment is not read as code', (t) => {
    const body = '/**\n * function helper() {}\n */\nexport function api(): number {\n    return 1;\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('an indented function is a nested one and is not a declaration', (t) => {
    const body =
        'export function api(): number {\n    function inner(): number {\n        return 1;\n    }\n    return inner();\n}\nexport function other(): number {\n    return 2;\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('an async export after a private one still fails', (t) => {
    const body =
        'function helper(): number {\n    return 1;\n}\nexport async function api(): Promise<number> {\n    return helper();\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.equal(run(root, { casing: CAMEL }).problems.length, 1);
});

// ── 5. Headers ──────────────────────────────────────────────────────────────
const headers = [
    { files: /^src\/lib\/.*\.ts$/, require: 'jsdoc' },
    { files: /^src\/services\/.*\.ts$/, require: 'comment' },
    { files: /\.vue$/, require: 'none' },
];

test('a lib module without a JSDoc block fails', (t) => {
    const root = tree(t, { 'src/lib/thing.ts': '// a line comment\nexport const a = 1;\n' });
    assert.deepEqual(whats(run(root, { casing: CAMEL, headers })), ['src/lib/thing.ts: no JSDoc file header']);
});

test('a lib module with a JSDoc block passes', (t) => {
    const root = tree(t, { 'src/lib/thing.ts': '/** What it owns. */\nexport const a = 1;\n' });
    assert.deepEqual(run(root, { casing: CAMEL, headers }).problems, []);
});

test('a service accepts either comment form', (t) => {
    const root = tree(t, {
        'src/services/one.ts': '// owns one\nexport const a = 1;\n',
        'src/services/two.ts': '/** owns two */\nexport const b = 1;\n',
    });
    assert.deepEqual(run(root, { casing: CAMEL, headers }).problems, []);
});

test('a service with no header at all fails', (t) => {
    const root = tree(t, { 'src/services/one.ts': 'export const a = 1;\n' });
    assert.deepEqual(whats(run(root, { casing: CAMEL, headers })), ['src/services/one.ts: no file header']);
});

test('an SFC with a markup header is banned', (t) => {
    const root = tree(t, { 'src/Widget.vue': `<!-- The widget -->\n${SFC}` });
    assert.deepEqual(whats(run(root, { casing: CAMEL, headers })), ['src/Widget.vue: has a file-level header comment']);
});

test('an SFC with a JSDoc header is banned', (t) => {
    const root = tree(t, { 'src/Widget.vue': `/** The widget */\n${SFC}` });
    assert.equal(run(root, { casing: CAMEL, headers }).problems.length, 1);
});

test('a file no header rule matches is unchecked', (t) => {
    const root = tree(t, { 'src/other/thing.ts': 'export const a = 1;\n' });
    assert.deepEqual(run(root, { casing: CAMEL, headers }).problems, []);
});

// ── 6/7. SFC blocks ─────────────────────────────────────────────────────────
test('template before script fails', (t) => {
    const root = tree(t, {
        'src/Widget.vue': '<template>\n    <div />\n</template>\n\n<script setup lang="ts">\nconst a = 1;\n</script>\n',
    });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/Widget.vue: blocks are ordered template → script']);
});

test('style before template fails', (t) => {
    const root = tree(t, {
        'src/Widget.vue':
            '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<style scoped lang="scss">\n.x {\n    color: red;\n}\n</style>\n\n<template>\n    <div />\n</template>\n',
    });
    assert.equal(run(root, { casing: CAMEL }).problems.length, 1);
});

test('a missing block does not break the order', (t) => {
    const root = tree(t, {
        'src/Widget.vue': '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n',
    });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a second, non-setup script block is legitimate', (t) => {
    const source =
        '<script lang="ts">\nexport type Item = { id: string };\n</script>\n\n<script setup lang="ts" generic="T extends Item">\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a companion script block still has to be TypeScript', (t) => {
    const source =
        '<script>\nexport default {};\n</script>\n\n<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/Widget.vue: <script> is not TypeScript']);
});

test('a setup block without lang="ts" fails', (t) => {
    const root = tree(t, {
        'src/Widget.vue': '<script setup>\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n',
    });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), [
        'src/Widget.vue: <script setup> is not `<script setup lang="ts">`',
    ]);
});

test('an unscoped style block fails', (t) => {
    const root = tree(t, { 'src/Widget.vue': SFC.replace('<style scoped lang="scss">', '<style lang="scss">') });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), [
        'src/Widget.vue: <style lang="scss"> is not `<style scoped lang="scss">`',
    ]);
});

test('an SFC named in globalStyles may own a global block', (t) => {
    const root = tree(t, { 'src/App.vue': SFC.replace('<style scoped lang="scss">', '<style lang="scss">') });
    assert.deepEqual(run(root, { casing: CAMEL, globalStyles: ['src/App.vue'] }).problems, []);
});

test('globalStyles excuses only the file it names', (t) => {
    const unscoped = SFC.replace('<style scoped lang="scss">', '<style lang="scss">');
    const root = tree(t, { 'src/App.vue': unscoped, 'src/Widget.vue': unscoped });
    assert.deepEqual(whats(run(root, { casing: CAMEL, globalStyles: ['src/App.vue'] })), [
        'src/Widget.vue: <style lang="scss"> is not `<style scoped lang="scss">`',
    ]);
});

test('scriptBlocks finds the setup block wherever it sits', () => {
    const source = '<script lang="ts">\n</script>\n<script setup lang="ts">\n</script>\n';
    assert.deepEqual(scriptBlocks(source), { setup: ' setup lang="ts"', others: [' lang="ts"'] });
});

test('scriptBlocks reports no setup block when there is none', () => {
    assert.deepEqual(scriptBlocks('<template>\n</template>\n'), { setup: null, others: [] });
});

// ── 8. Comment format in <template> ─────────────────────────────────────────
test('a decorated template comment fails', (t) => {
    const source =
        '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    <!-- –––––– Header –––––– -->\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.equal(run(root, { casing: CAMEL }).problems[0]?.file, 'src/Widget.vue:6');
});

test('a plain template comment passes', (t) => {
    const source =
        '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    <!-- Header -->\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a JS comment inside the template fails', (t) => {
    const source =
        '<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n    // the header\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), [
        'src/Widget.vue:6: JS-style comment inside <template>: `//`',
    ]);
});

test('a JS comment in the script block is not a template comment', (t) => {
    const source =
        '<script setup lang="ts">\n// a real comment\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a decorated comment in the style block is not a template comment', (t) => {
    const root = tree(t, { 'src/Widget.vue': SFC.replace('.x {', '/* –––––– Layout –––––– */\n.x {') });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

// ── 9. Comment format in style blocks and stylesheets ───────────────────────
test('a prose comment in a style block fails', (t) => {
    const root = tree(t, { 'src/Widget.vue': SFC.replace('.x {', '/* red because the design says so */\n.x {') });
    const result = run(root, { casing: CAMEL });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]?.what ?? '', /^non-divider style comment/);
});

test('a divider comment in a style block passes', (t) => {
    const root = tree(t, { 'src/Widget.vue': SFC.replace('.x {', '/* ––– Layout ––– */\n.x {') });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a stylelint control comment is left alone', (t) => {
    const root = tree(t, {
        'src/Widget.vue': SFC.replace('.x {', '/* stylelint-disable declaration-no-important */\n.x {'),
    });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a standalone stylesheet is checked too', (t) => {
    const root = tree(t, {
        'src/styles/_base.scss':
            '.x {\n    color: red;\n}\n\n/* a note about the reset */\n.y {\n    color: blue;\n}\n',
    });
    assert.equal(run(root, { casing: CAMEL }).problems.length, 1);
});

test('a stylesheet may open with a block comment, which is its file header', (t) => {
    const root = tree(t, { 'src/styles/_base.scss': '/* The reset. */\n.x {\n    color: red;\n}\n' });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a JSDoc block anywhere in a stylesheet is a header, not a section label', (t) => {
    const root = tree(t, {
        'src/styles/_base.scss':
            '.x {\n    color: red;\n}\n\n/** Why the next block exists. */\n.y {\n    color: blue;\n}\n',
    });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a stylesheet written with // comments has nothing to check', (t) => {
    const root = tree(t, { 'src/styles/_base.scss': '// –– Text utilities ––\n.x {\n    color: red;\n}\n' });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a comment outside the style block is not a style comment', (t) => {
    const source =
        '<script setup lang="ts">\n/* a note */\nconst a = 1;\n</script>\n\n<template>\n    <div />\n</template>\n';
    const root = tree(t, { 'src/Widget.vue': source });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

// ── 10. JSDoc type tags ─────────────────────────────────────────────────────
test('a JSDoc type tag fails, with its line', (t) => {
    const body =
        '/**\n * Does a thing.\n *\n * @param {string} name The name.\n */\nexport function thing(name: string): string {\n    return name;\n}\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(whats(run(root, { casing: CAMEL })), ['src/thing.ts:4: `@param {…}` carries a type']);
});

test('every type tag form is caught', (t) => {
    const body =
        '/**\n * @param {string} a\n * @returns {number}\n * @return {number}\n * @type {string}\n */\nexport const a = 1;\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.equal(run(root, { casing: CAMEL }).problems.length, 4);
});

test('a JSDoc tag without braces is prose and is fine', (t) => {
    const body =
        '/**\n * @param name The name, which must already be trimmed.\n * @returns the greeting.\n */\nexport const a = 1;\n';
    const root = tree(t, { 'src/thing.ts': body });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

// ── 11. Relative imports ────────────────────────────────────────────────────
test('with no aliased roots the relative-import rule never fires', (t) => {
    const root = tree(t, { 'src/thing.ts': "import { a } from './other.js';\n\nexport const b = a;\n" });
    assert.deepEqual(run(root, { casing: CAMEL }).problems, []);
});

test('a relative import inside an aliased root fails, with its line', (t) => {
    const root = tree(t, { 'src/thing.ts': "import { a } from './other.js';\n\nexport const b = a;\n" });
    const result = run(root, { casing: CAMEL, aliasedRoots: ['src'] });
    assert.deepEqual(whats(result), ['src/thing.ts:1: relative import `./other.js`']);
});

test('an aliased import passes', (t) => {
    const root = tree(t, { 'src/thing.ts': "import { a } from '@/other.js';\n\nexport const b = a;\n" });
    assert.deepEqual(run(root, { casing: CAMEL, aliasedRoots: ['src'] }).problems, []);
});

test('a root that is not aliased is left alone', (t) => {
    const root = tree(t, { 'src/thing.ts': "import { a } from './other.js';\n\nexport const b = a;\n" });
    const result = inspectCodeStyle({ root, scan: ['src'], casing: CAMEL, aliasedRoots: ['packages/shared/src'] });
    assert.deepEqual(result.problems, []);
});

test('a relative specifier inside a comment is not an import', (t) => {
    const root = tree(t, { 'src/thing.ts': "// was: import { a } from './other.js';\nexport const b = 1;\n" });
    assert.deepEqual(run(root, { casing: CAMEL, aliasedRoots: ['src'] }).problems, []);
});

test('a bare package import is not relative', (t) => {
    const root = tree(t, { 'src/thing.ts': "import path from 'node:path';\n\nexport const b = path;\n" });
    assert.deepEqual(run(root, { casing: CAMEL, aliasedRoots: ['src'] }).problems, []);
});

// ── Scope ───────────────────────────────────────────────────────────────────
test('a missing scan root is skipped, not an error', (t) => {
    const root = tree(t, { 'src/thing.ts': 'export const a = 1;\n' });
    const result = inspectCodeStyle({ root, scan: ['src', 'packages/shared/src'], casing: CAMEL });
    assert.deepEqual(result.problems, []);
    assert.equal(result.files, 1);
});

test('every scan root is walked', (t) => {
    const root = tree(t, {
        'api/src/my-thing.ts': 'export const a = 1;\n',
        'worker/src/otherThing.ts': 'export const b = 1;\n',
    });
    const result = inspectCodeStyle({ root, scan: ['api/src', 'worker/src'], casing: KEBAB });
    assert.deepEqual(whats(result), ['worker/src/otherThing.ts: filename `otherThing` is not kebab-case']);
});
