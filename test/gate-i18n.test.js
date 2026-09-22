/**
 * The i18n gate. Every check gets a negative test — a fixture that must FAIL —
 * as well as the positive one, because a gate that has quietly stopped firing
 * looks exactly like a gate that is passing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectI18n } from '../src/gates/i18n.js';

/** A valid createI18n file, so the option checks pass unless a test says otherwise. */
const GOOD_CONFIG = `
export const i18n = createI18n({
    legacy: false,
    escapeParameter: true,
    fallbackLocale: 'en',
});
`;

/**
 * Builds a throwaway repo with the given locale files and runs the gate over it.
 *
 * @param {Record<string, unknown | string>} locales Locale name → JSON value, or a raw
 *   string to write verbatim (for the unparseable-JSON case).
 * @param {object} [opts]
 * @param {string | null} [opts.config] createI18n source, or null to omit the file.
 * @param {Record<string, string>} [opts.configNotes]
 * @returns {import('../src/gates/i18n.js').I18nGateResult}
 */
const run = (locales, opts = {}) => {
    const { config = GOOD_CONFIG, configNotes } = opts;
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-i18n-'));
    try {
        mkdirSync(path.join(root, 'locales'));
        for (const [name, value] of Object.entries(locales)) {
            const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            writeFileSync(path.join(root, 'locales', `${name}.json`), body);
        }
        if (config !== null) writeFileSync(path.join(root, 'i18n.ts'), config);
        return inspectI18n({ root, localeDir: 'locales', configFile: 'i18n.ts', configNotes });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test('locales that agree produce no errors', () => {
    const res = run({
        en: { greeting: 'Hello {name}', items: 'one item | {count} items', reasons: ['spam', 'abuse'] },
        it: { greeting: 'Ciao {name}', items: 'un elemento | {count} elementi', reasons: ['spam', 'abuso'] },
    });
    assert.equal(res.fatal, null);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.locales.sort(), ['en', 'it']);
    // `reasons[]` is bookkeeping, not a translatable key, so it must not be counted.
    assert.equal(res.keyCount, 4);
});

test('NEGATIVE: a missing plural segment is reported', () => {
    const res = run({
        en: { items: 'one item | {count} items' },
        it: { items: '{count} elementi' },
    });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /\[it\] items: 1 plural segment\(s\) ≠ en 2/);
});

test('NEGATIVE: a dropped placeholder is reported', () => {
    const res = run({
        en: { greeting: 'Hello {name}, you have {count} messages' },
        it: { greeting: 'Ciao {name}, hai dei messaggi' },
    });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /placeholders \[\{name\}\] ≠ en \[\{count\},\{name\}\]/);
});

test("placeholders in a different order are NOT reported — word order is the translator's", () => {
    const res = run({
        en: { line: '{count} from {name}' },
        it: { line: 'da {name}: {count}' },
    });
    assert.deepEqual(res.errors, []);
});

test("the {'@'} literal is not treated as a placeholder", () => {
    const res = run({
        en: { email: "name{'@'}example.com" },
        it: { email: "nome{'@'}esempio.com" },
    });
    assert.deepEqual(res.errors, []);
});

test('NEGATIVE: an array of a different length is reported', () => {
    const res = run({
        en: { reasons: ['spam', 'abuse', 'other'] },
        it: { reasons: ['spam', 'abuso'] },
    });
    assert.ok(res.errors.some((e) => /\[it\] reasons: array length 2 ≠ en 3/.test(e)));
});

test('NEGATIVE: a string where the reference has an array is reported', () => {
    // v-for over a string iterates its characters, so this renders one <li> per letter.
    const res = run({
        en: { reasons: ['spam', 'abuse'] },
        it: { reasons: 'spam' },
    });
    assert.deepEqual(res.errors, ['[it] reasons: string where en has an array of 2']);
});

test('NEGATIVE: an array where the reference has a string is reported', () => {
    const res = run({
        en: { reason: 'spam' },
        it: { reason: ['spam', 'abuso'] },
    });
    assert.deepEqual(res.errors, ['[it] reason: array where en has a string']);
});

test('a key missing from another locale is left to the ESLint rule that owns it', () => {
    const res = run({
        en: { a: 'A', b: 'B' },
        it: { a: 'A' },
    });
    assert.deepEqual(res.errors, []);
});

test('NEGATIVE: each required createI18n option is reported when absent', () => {
    for (const [option, config] of [
        ['escapeParameter: true', `createI18n({ legacy: false, fallbackLocale: 'en' })`],
        ['legacy: false', `createI18n({ escapeParameter: true, fallbackLocale: 'en' })`],
        ['fallbackLocale', `createI18n({ legacy: false, escapeParameter: true })`],
    ]) {
        const res = run({ en: { a: 'A' } }, { config });
        assert.equal(res.errors.length, 1, `expected exactly one error for a missing ${option}`);
        assert.ok(res.errors[0].includes(option), `expected the error to name ${option}`);
    }
});

test('NEGATIVE: `legacy: true` does not satisfy the legacy check', () => {
    // The regex must match the VALUE, not just the key — matching `legacy:` would
    // pass a project that had explicitly opted into the mode the gate forbids.
    const res = run(
        { en: { a: 'A' } },
        { config: `createI18n({ legacy: true, escapeParameter: true, fallbackLocale: 'en' })` },
    );
    assert.ok(res.errors.some((e) => e.includes('legacy: false')));
});

test('configNotes are appended to the shared reason, not instead of it', () => {
    const res = run(
        { en: { a: 'A' } },
        {
            config: `createI18n({ legacy: false, fallbackLocale: 'en' })`,
            configNotes: { escapeParameter: 'The legal pages render messages with v-html.' },
        },
    );
    assert.match(res.errors[0], /SECURITY\./);
    assert.match(res.errors[0], /The legal pages render messages with v-html\.$/);
});

test('FATAL: unparseable JSON stops the gate rather than being counted as agreement', () => {
    const res = run({ en: { a: 'A' }, it: '{ "a": "A", }' });
    assert.match(res.fatal ?? '', /it\.json could not be read as JSON/);
    assert.deepEqual(res.errors, []);
});

test('FATAL: a missing reference locale stops the gate', () => {
    const res = run({ it: { a: 'A' } });
    assert.match(res.fatal ?? '', /Reference locale "en\.json" not found/);
});

test('FATAL: a moved createI18n file is reported, not silently skipped', () => {
    // Without this the option checks would vanish the day someone renames the file,
    // and the gate would keep printing ✓.
    const res = run({ en: { a: 'A' } }, { config: null });
    assert.match(res.fatal ?? '', /createI18n config not found at i18n\.ts/);
});

test('FATAL: a missing locale directory is reported', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-i18n-'));
    try {
        const res = inspectI18n({ root, localeDir: 'nope', configFile: 'i18n.ts' });
        assert.match(res.fatal ?? '', /Locale directory not found at nope/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the reference locale is configurable and the messages follow it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-i18n-'));
    try {
        mkdirSync(path.join(root, 'locales'));
        writeFileSync(path.join(root, 'locales', 'it.json'), JSON.stringify({ items: 'uno | {count} due' }));
        writeFileSync(path.join(root, 'locales', 'en.json'), JSON.stringify({ items: '{count} items' }));
        writeFileSync(path.join(root, 'i18n.ts'), GOOD_CONFIG);
        const res = inspectI18n({ root, localeDir: 'locales', configFile: 'i18n.ts', reference: 'it' });
        assert.equal(res.errors.length, 1);
        assert.match(res.errors[0], /\[en\] items: 1 plural segment\(s\) ≠ it 2/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
