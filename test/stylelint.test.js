/**
 * Each test states a toggle's promise as a real lint run: same source, different
 * option, different verdict. A toggle that silently stops working fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import stylelintApi from 'stylelint';

import { stylelint } from '../src/stylelint.js';

const CONFIG_BASEDIR = path.resolve(import.meta.dirname, '..');

/** Rules reported for `code`, deduped — the plugin names are what the tests assert on. */
const rulesFor = async (code, options) => {
    const result = await stylelintApi.lint({
        code,
        codeFilename: 'test.scss',
        config: stylelint(options),
        configBasedir: CONFIG_BASEDIR,
    });
    return [...new Set(result.results[0].warnings.map((w) => w.rule))];
};

test('spacingUnit: em is the default, rem is opt-in', async () => {
    const em = '.a { padding: 1em; }';
    const rem = '.a { padding: 1rem; }';

    assert.ok(!(await rulesFor(em, {})).includes('declaration-property-unit-allowed-list'));
    assert.ok((await rulesFor(rem, {})).includes('declaration-property-unit-allowed-list'));

    assert.ok((await rulesFor(em, { spacingUnit: 'rem' })).includes('declaration-property-unit-allowed-list'));
    assert.ok(!(await rulesFor(rem, { spacingUnit: 'rem' })).includes('declaration-property-unit-allowed-list'));
});

test('noScssImport bans @import only when asked', async () => {
    const code = "@import 'other';";

    assert.ok(!(await rulesFor(code, {})).includes('at-rule-disallowed-list'));
    assert.ok((await rulesFor(code, { noScssImport: true })).includes('at-rule-disallowed-list'));
});

test('mobileFirst bans max-width media features only when asked', async () => {
    const code = '@media (max-width: 600px) { .a { color: $color-x; } }';

    assert.ok(!(await rulesFor(code, {})).includes('media-feature-name-disallowed-list'));
    assert.ok((await rulesFor(code, { mobileFirst: true })).includes('media-feature-name-disallowed-list'));
});

test('noScssColorFunctions catches rgba() on a runtime token', async () => {
    const code = '.a { background: rgba($color-accent, 0.12); }';

    assert.ok(!(await rulesFor(code, {})).includes('declaration-property-value-disallowed-list'));
    assert.ok((await rulesFor(code, { noScssColorFunctions: true })).includes('declaration-property-value-disallowed-list'));
});

test('tokenProperties widens which properties must use a token', async () => {
    const code = '.a { font-size: 0.875rem; }';
    const strict = { tokenProperties: ['/color$/', 'fill', 'stroke', 'font-size'] };

    assert.ok(!(await rulesFor(code, {})).includes('scale-unlimited/declaration-strict-value'));
    assert.ok((await rulesFor(code, strict)).includes('scale-unlimited/declaration-strict-value'));
});

test('ignoreZero decides whether `0` counts as an untokenised value', async () => {
    const code = '.a { border-radius: 0; }';
    const strict = ['/color$/', 'fill', 'stroke', 'border-radius'];

    assert.ok((await rulesFor(code, { tokenProperties: strict })).includes('scale-unlimited/declaration-strict-value'));
    assert.ok(
        !(await rulesFor(code, { tokenProperties: strict, ignoreZero: true })).includes(
            'scale-unlimited/declaration-strict-value',
        ),
    );
});

test('unknownCustomProperties can be switched off for generated tokens', async () => {
    const code = '.a { color: var(--not-declared-anywhere); }';

    assert.ok((await rulesFor(code, {})).includes('no-unknown-custom-properties'));
    assert.ok(!(await rulesFor(code, { unknownCustomProperties: false })).includes('no-unknown-custom-properties'));
});

test('bem allows block__element--modifier class names', async () => {
    const code = '.card__title--large { color: $color-x; }';

    assert.ok((await rulesFor(code, {})).includes('selector-class-pattern'));
    assert.ok(!(await rulesFor(code, { bem: true })).includes('selector-class-pattern'));
});

test('duplicateFallbacks allows the CSS fallback idiom', async () => {
    const code = '.a { min-height: 100vh; min-height: 100dvh; }';

    assert.ok((await rulesFor(code, {})).includes('declaration-block-no-duplicate-properties'));
    assert.ok(
        !(await rulesFor(code, { duplicateFallbacks: true })).includes('declaration-block-no-duplicate-properties'),
    );
});

test('rules and overrides stay available as an escape hatch', async () => {
    const config = stylelint({ rules: { 'declaration-no-important': null }, overrides: [{ files: ['x.scss'] }] });

    assert.equal(config.rules['declaration-no-important'], null);
    assert.ok(config.overrides.some((o) => o.files.includes('x.scss')));
});
