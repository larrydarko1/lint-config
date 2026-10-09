/**
 * The two icon rules, run on real SFCs through ESLint's RuleTester, plus where each is
 * switched on. The valid cases are the SVGs that are NOT icons — the charts, the
 * spinner-shaped slot, the icon component itself — because a rule that cannot tell a
 * drawing from a chart gets turned off.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, RuleTester } from 'eslint';
import vueParser from 'vue-eslint-parser';

import { larry } from '../src/eslint/index.ts';
import { iconRules } from '../src/eslint/rules/icons.ts';
import * as electron from '../src/eslint/electron/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: vueParser, ecmaVersion: 2022, sourceType: 'module' } });
const sfc = (template) => ({ code: `<template>${template}</template>`, filename: 'Thing.vue' });
const invalid = (template, ...messageIds) => ({
    ...sfc(template),
    errors: messageIds.map((messageId) => ({ messageId })),
});

const CROSS = '<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />';

tester.run('no-inline-svg', iconRules['no-inline-svg'], {
    valid: [
        // The icon, used.
        sfc('<button aria-label="Close"><IconClose /></button>'),
        // Drawn from data: a bound attribute, a loop, an interpolation.
        sfc('<svg viewBox="0 0 100 40"><path :d="linePath" /></svg>'),
        sfc('<svg viewBox="0 0 100 40"><rect v-for="b in bars" :key="b.x" :x="b.x" :height="b.h" /></svg>'),
        sfc('<svg viewBox="0 0 100 40"><text x="0" y="10">{{ label }}</text></svg>'),
        sfc('<svg viewBox="0 0 100 40"><circle cx="5" cy="5" r="2" @click="pick" /></svg>'),
        // Content from outside: a slot, or injected markup.
        sfc('<svg viewBox="0 0 24 24"><slot /></svg>'),
        sfc('<svg viewBox="0 0 24 24" v-html="markup" />'),
        // Data only on a nested element still makes the whole drawing data.
        sfc('<svg viewBox="0 0 24 24"><g><circle :r="radius" /></g></svg>'),
        // Not an svg at all.
        sfc('<div><span>no drawing here</span></div>'),
        // Not an SFC: the rule has nothing to read.
        { code: 'const svg = "<svg><path d=\\"M0 0\\" /></svg>";', languageOptions: { parser: undefined } },
    ],
    invalid: [
        // The shape this rule exists for: a fixed drawing pasted inline.
        invalid(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${CROSS}</svg>`, 'inlineIcon'),
        // Placing it — v-if, class, :class — does not make it data.
        invalid(`<svg v-if="open" class="x" :class="{ big }" viewBox="0 0 24 24">${CROSS}</svg>`, 'inlineIcon'),
        invalid(`<svg :width="size" viewBox="0 0 24 24">${CROSS}</svg>`, 'inlineIcon'),
        // Choosing between two fixed drawings inside one <svg> is still two icons.
        invalid(
            '<svg viewBox="0 0 24 24"><template v-if="ok"><path d="M20 6L9 17l-5-5" /></template><template v-else>' +
                `${CROSS}</template></svg>`,
            'inlineIcon',
        ),
        invalid('<svg viewBox="0 0 24 24"><path v-show="on" d="M8 5v14l11-7z" /></svg>', 'inlineIcon'),
        // Reported once, at the outermost <svg>, not again for one nested inside it.
        invalid('<svg viewBox="0 0 24 24"><svg x="2"><path d="M0 0h4" /></svg></svg>', 'inlineIcon'),
        // Two icons, two reports.
        invalid(
            `<div><svg viewBox="0 0 24 24">${CROSS}</svg><svg viewBox="0 0 24 24">${CROSS}</svg></div>`,
            'inlineIcon',
            'inlineIcon',
        ),
    ],
});

const ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">${CROSS}</svg>`;

tester.run('icon-component', iconRules['icon-component'], {
    valid: [
        sfc(ICON),
        // A gradient that needs an id binds one, so two copies on a page do not collide.
        sfc(
            '<svg aria-hidden="true" viewBox="0 0 24 24"><defs><linearGradient :id="uid" /></defs>' +
                '<path :fill="`url(#${uid})`" d="M0 0h24v24H0z" /></svg>',
        ),
        // Comments around the root are not a second root.
        sfc(`<!-- close cross -->${ICON}`),
        // A <template> inside the drawing is not the file's template.
        sfc(
            '<svg aria-hidden="true" viewBox="0 0 24 24"><template v-if="on"><path d="M8 5v14l11-7z" /></template></svg>',
        ),
    ],
    invalid: [
        // Not hidden from screen readers — the 11 Orchid icons that were missing it.
        invalid(`<svg viewBox="0 0 24 24">${CROSS}</svg>`, 'ariaHidden'),
        invalid(`<svg aria-hidden="false" viewBox="0 0 24 24">${CROSS}</svg>`, 'ariaHidden'),
        invalid(`<svg :aria-hidden="hidden" viewBox="0 0 24 24">${CROSS}</svg>`, 'ariaHidden'),
        // An editor's leftover ids, which repeat every time the icon renders twice.
        invalid(
            '<svg aria-hidden="true" viewBox="0 0 32 32"><g id="SVGRepo_iconCarrier"><path id="diamond" d="M0 0h4" /></g></svg>',
            'fixedId',
            'fixedId',
        ),
        // Anything but exactly one <svg> at the root.
        invalid(`<span>${ICON}</span>`, 'oneSvg'),
        invalid(`${ICON}${ICON}`, 'oneSvg'),
        invalid('<p>not an icon</p>', 'oneSvg'),
    ],
});

// ── Where they are on ────────────────────────────────────────────────────────

const ROOT = '/tmp/lint-config-eslint-test';

const severityOf = async (config, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved?.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

const electronConfig = larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards() });
const fullstackConfig = larry({ preset: 'fullstack', rootDir: ROOT, standards: fullstack.fullstackStandards() });

const FAMILIES = [
    ['electron', electronConfig, 'src/renderer'],
    ['fullstack', fullstackConfig, 'frontend/src'],
];

test('every component outside the icons folder is held to no-inline-svg, in both families', async () => {
    for (const [family, config, src] of FAMILIES) {
        for (const file of [`${src}/App.vue`, `${src}/components/Home/HomePage.vue`, `${src}/views/charts/Bar.vue`]) {
            assert.equal(await severityOf(config, file, 'larry/no-inline-svg'), 2, `${family}: ${file}`);
            assert.equal(await severityOf(config, file, 'larry/icon-component'), 'absent', `${family}: ${file}`);
        }
    }
});

test('a file in components/icons/ is an icon component, and is the one place an <svg> may be fixed', async () => {
    for (const [family, config, src] of FAMILIES) {
        const file = `${src}/components/icons/IconClose.vue`;
        assert.equal(await severityOf(config, file, 'larry/icon-component'), 2, family);
        assert.equal(await severityOf(config, file, 'larry/no-inline-svg'), 'absent', family);
    }
});

test('a folder that only shares the name, deeper down, is not the icons folder', async () => {
    const file = 'frontend/src/components/Admin/components/icons/IconX.vue';
    assert.equal(await severityOf(fullstackConfig, file, 'larry/no-inline-svg'), 2);
    assert.equal(await severityOf(fullstackConfig, file, 'larry/icon-component'), 'absent');
});
