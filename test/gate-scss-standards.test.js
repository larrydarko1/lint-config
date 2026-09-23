import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectScssStandards } from '../src/gates/scss-standards.js';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scss-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const VITE = `export default {
    css: {
        preprocessorOptions: {
            scss: {
                additionalData: (source, filename) =>
                    filename.includes('/styles/') ? source : \`@use '@/styles/variables' as *;\\n\${source}\`,
            },
        },
    },
};
`;

const VARIABLES = `@use 'sass:color';

$space-1: 0.25rem;

@mixin above($bp) {
    @media (min-width: $bp) {
        @content;
    }
}

$theme-default: (
    'bg': #000,
    'text': #fff,
);

$theme-snow: (
    'bg': #fff,
    'text': #000,
);

// stylelint-disable no-unknown-custom-properties
$color-bg: var(--color-bg);
$color-text: var(--color-text);
// stylelint-enable no-unknown-custom-properties
`;

const THEME = `@use '@/styles/variables' as *;

@mixin emit-theme($map, $scheme: dark) {
    color-scheme: $scheme;

    @each $key, $value in $map {
        --color-#{$key}: #{$value};
    }
}

:root,
[data-theme='default'] {
    @include emit-theme($theme-default, dark);
}

[data-theme='snow'] {
    @include emit-theme($theme-snow, light);
}
`;

const INDEX = `@forward '@/styles/variables';

@use '@/styles/theme' as *;
@use '@/styles/base' as *;
`;

/** The full-stack layout: one barrel, the token module injected. */
const good = (overrides = {}) => ({
    'src/styles/index.scss': INDEX,
    'src/styles/_variables.scss': VARIABLES,
    'src/styles/_theme.scss': THEME,
    'src/styles/_base.scss': "@use '@/styles/variables' as *;\n\nbody {\n    margin: 0;\n}\n",
    'src/main.ts': "import '@/styles/index.scss';\n",
    'vite.config.ts': VITE,
    'src/App.vue':
        '<template><div /></template>\n<style scoped lang="scss">\n.a {\n    color: $color-bg;\n}\n</style>\n',
    ...overrides,
});

const OPTIONS = {
    styles: 'src/styles',
    src: 'src',
    mainScript: 'src/main.ts',
    viteConfigs: ['vite.config.ts'],
    injectedSpecifier: '@/styles/variables',
    emitters: [
        { module: 'theme', why: 'the emission' },
        { module: 'base', why: 'the reset' },
    ],
    themes: {
        source: 'scss-maps',
        file: 'src/styles/_variables.scss',
        emitFile: 'src/styles/_theme.scss',
        mixinFile: 'src/styles/_theme.scss',
        reference: 'default',
    },
};

const run = (t, files, options = {}) => inspectScssStandards({ root: tree(t, files), ...OPTIONS, ...options });
const whats = (result) => result.problems.map((p) => `${p.file}: ${p.what}`).join(' | ');

test('a clean tree has no problems', (t) => {
    const result = run(t, good());
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.palettes, ['default', 'snow']);
    assert.equal(result.tokenCount, 2);
});

// ── 1. The barrel forwards the tokens ───────────────────────────────────────
test('a barrel that @uses its tokens instead of @forwarding them fails', (t) => {
    const result = run(t, good({ 'src/styles/index.scss': INDEX.replace('@forward', '@use') }));
    assert.match(whats(result), /index\.scss: does not `@forward` variables/);
});

test('a missing barrel is named as the barrel', (t) => {
    const files = good();
    delete files['src/styles/index.scss'];
    assert.match(whats(run(t, files)), /index\.scss: does not exist, but is this project's barrel/);
});

test('a missing injected module is named as the injected module', (t) => {
    const files = good();
    delete files['src/styles/_variables.scss'];
    assert.match(whats(run(t, files)), /_variables\.scss: does not exist, but is this project's injected module/);
});

// ── 2. The entry @uses every emitting module ────────────────────────────────
test('an entry that does not @use an emitting module fails, with that module’s reason', (t) => {
    const result = run(t, good({ 'src/styles/index.scss': INDEX.replace("@use '@/styles/base' as *;\n", '') }));
    assert.match(whats(result), /index\.scss: does not `@use` base/);
    assert.equal(result.problems.find((p) => p.what.includes('base'))?.why, 'the reset');
});

test('the entry is a second file when the barrel itself is injected', (t) => {
    const result = run(
        t,
        good({
            'src/styles/index.scss': "@forward '@/styles/variables';\n",
            'src/styles/global.scss': "@use '@/styles/theme' as *;\n@use '@/styles/base' as *;\n",
            'src/main.ts': "import '@/styles/global.scss';\n",
            'vite.barrel.ts': VITE.replace('@/styles/variables', '@/styles'),
        }),
        {
            entry: 'global.scss',
            injected: 'index.scss',
            injectedSpecifier: '@/styles',
            viteConfigs: ['vite.barrel.ts'],
        },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 3. main.ts imports exactly one stylesheet ───────────────────────────────
test('importing the stylesheet twice fails', (t) => {
    const result = run(t, good({ 'src/main.ts': "import '@/styles/index.scss';\nimport '@/styles/extra.scss';\n" }));
    assert.match(whats(result), /main\.ts: imports 2 stylesheets/);
});

test('importing no stylesheet fails', (t) => {
    const result = run(t, good({ 'src/main.ts': "import { createApp } from 'vue';\n" }));
    assert.match(whats(result), /main\.ts: imports no stylesheet/);
});

// ── 4. Nothing reachable from the injected module emits ─────────────────────
test('a rule in the injected module fails', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `${VARIABLES}\n.card {\n    color: red;\n}\n` }));
    assert.match(whats(result), /_variables\.scss: is reachable from the injected module but emits CSS \(`\.card…`/);
});

test('the theme emission left in the injected module fails — the bug this gate was built for', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': VARIABLES + THEME.replace(/^@use[^\n]*\n\n/, '') }));
    assert.match(whats(result), /_variables\.scss: is reachable from the injected module but emits CSS/);
    assert.match(whats(result), /:root, \[data-theme='default'\]/);
});

test('an emitting rule reached TRANSITIVELY through a @forward still fails', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': `@forward '@/styles/sneaky';\n${VARIABLES}`,
            'src/styles/_sneaky.scss': 'a {\n    color: red;\n}\n',
        }),
    );
    assert.match(whats(result), /_sneaky\.scss: is reachable from the injected module but emits CSS/);
});

test('a mixin in the injected module emits nothing, however much it contains', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': `${VARIABLES}\n@mixin card {\n    .inner {\n        @media screen {\n            color: red;\n        }\n    }\n}\n`,
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a %placeholder in the injected module emits nothing', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `${VARIABLES}\n%row {\n    display: flex;\n}\n` }));
    assert.equal(result.problems.length, 0, whats(result));
});

test('a top-level @media in the injected module DOES emit', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': `${VARIABLES}\n@media print {\n    body {\n        color: #000;\n    }\n}\n`,
        }),
    );
    assert.match(
        whats(result),
        /_variables\.scss: is reachable from the injected module but emits CSS \(`@media print…`/,
    );
});

test('a rule named only in a comment does not count as a rule', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `${VARIABLES}\n// .card { color: red; }\n` }));
    assert.equal(result.problems.length, 0, whats(result));
});

test('a top-level declaration built with interpolation is not a rule', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `${VARIABLES}\n$name: #{$space-1}-wide;\n` }));
    assert.equal(result.problems.length, 0, whats(result));
});

test('a %placeholder in the injected module emits nothing even when it holds rules', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': `${VARIABLES}\n%row {\n    display: flex;\n\n    &:hover {\n        color: red;\n    }\n}\n`,
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a brace inside a quoted string does not open a block', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `${VARIABLES}\n$brace: '{ not a rule }';\n` }));
    assert.equal(result.problems.length, 0, whats(result));
});

test('a loud comment in the injected module fails, with its byte cost', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `/* a loud header */\n${VARIABLES}` }));
    assert.match(
        whats(result),
        /_variables\.scss: is reachable from the injected module and holds 1 loud comment\(s\) \(19 bytes\)/,
    );
});

test('a loud comment outside the injection is nobody’s business', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_base.scss': `/* a loud header */\n@use '@/styles/variables' as *;\n\nbody {\n    margin: 0;\n}\n`,
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('the injected module naming a module that does not exist fails', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': `@use '@/styles/ghost';\n${VARIABLES}` }));
    assert.match(whats(result), /_variables\.scss: loads `@\/styles\/ghost`, which resolves to no file/);
});

test('a folder module resolves through its sub-barrel rather than looking missing', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': `@forward '@/styles/tokens';\n${VARIABLES}`,
            'src/styles/tokens/_index.scss': '$brand: #f00;\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a sass: built-in is not chased as a missing file', (t) => {
    const result = run(t, good());
    assert.doesNotMatch(whats(result), /sass:color/);
});

// ── 5. The Vite injection ───────────────────────────────────────────────────
test('a vite config with no additionalData fails', (t) => {
    const result = run(t, good({ 'vite.config.ts': 'export default {};\n' }));
    assert.match(whats(result), /vite\.config\.ts: has no `css\.preprocessorOptions\.scss\.additionalData`/);
});

test('injecting without `as *` fails', (t) => {
    const result = run(t, good({ 'vite.config.ts': VITE.replace('as *', '') }));
    assert.match(whats(result), /additionalData does not inject `@use '@\/styles\/variables' as \*`/);
});

test('injecting a module other than the one walked for purity fails', (t) => {
    const result = run(t, good({ 'vite.config.ts': VITE.replace('@/styles/variables', '@/styles/other') }));
    assert.match(whats(result), /additionalData does not inject `@use '@\/styles\/variables' as \*`/);
});

test('an injection that does not exempt the styles directory fails', (t) => {
    const result = run(t, good({ 'vite.config.ts': VITE.replace("filename.includes('/styles/')", 'false') }));
    assert.match(whats(result), /additionalData does not exempt the styles directory/);
});

test('every vite config is checked, not just the first', (t) => {
    const result = run(t, good({ 'vite.capacitor.ts': 'export default {};\n' }), {
        viteConfigs: ['vite.config.ts', 'vite.capacitor.ts'],
    });
    assert.match(whats(result), /vite\.capacitor\.ts: has no `css\.preprocessorOptions/);
});

test('a named vite config that does not exist fails rather than being skipped', (t) => {
    const result = run(t, good(), { viteConfigs: ['vite.config.ts', 'missing.config.ts'] });
    assert.match(whats(result), /missing\.config\.ts: does not exist/);
});

// ── 6. No SFC manually @uses what Vite injects ──────────────────────────────
test('an SFC that manually @uses the injected module fails', (t) => {
    const result = run(
        t,
        good({
            'src/App.vue':
                '<style scoped lang="scss">\n@use \'@/styles/variables\' as *;\n\n.a {\n    color: red;\n}\n</style>\n',
        }),
    );
    assert.match(whats(result), /App\.vue: manually `@use`s the module Vite already injects/);
});

test('a partial that @uses the injected module is correct, not a violation', (t) => {
    const result = run(t, good());
    assert.doesNotMatch(whats(result), /_base\.scss: manually/);
});

// ── 7. Theme parity ─────────────────────────────────────────────────────────
test('a palette missing a token fails, naming the token', (t) => {
    const result = run(t, good({ 'src/styles/_variables.scss': VARIABLES.replace("    'text': #000,\n", '') }));
    assert.match(whats(result), /`\$snow` is missing 1 token\(s\): text/);
});

test('a palette with a token no other palette has fails', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_variables.scss': VARIABLES.replace(
                "    'text': #000,\n",
                "    'text': #000,\n    'extra': #123,\n",
            ),
        }),
    );
    assert.match(whats(result), /`\$snow` defines 1 token\(s\) no other theme has: extra/);
});

test('a map that is never emitted fails', (t) => {
    const result = run(t, good({ 'src/styles/_theme.scss': THEME.replace(/\[data-theme='snow'\][\s\S]*$/, '') }));
    assert.match(whats(result), /theme map\(s\) defined but never emitted: snow/);
});

test('a renamed reference palette fails loudly rather than passing blind', (t) => {
    const result = run(t, good(), { themes: { ...OPTIONS.themes, reference: 'midnight' } });
    assert.match(whats(result), /has no `midnight` palette/);
});

test('a missing emit-theme mixin fails', (t) => {
    const result = run(t, good({ 'src/styles/_theme.scss': THEME.replace('@mixin emit-theme', '@mixin paint') }));
    assert.match(whats(result), /missing the `emit-theme` mixin/);
});

test('a missing color-scheme fails', (t) => {
    const result = run(t, good({ 'src/styles/_theme.scss': THEME.replace('color-scheme: $scheme;', '') }));
    assert.match(whats(result), /no `color-scheme` declaration/);
});

test('a registry-driven project reads its palettes out of the registry', (t) => {
    const themesFile = `$default: (\n    'bg': #000,\n);\n\n$snow: (\n    'bg': #fff,\n);\n\n$themes: (\n    'snow': ($snow, light),\n);\n\n@each $name, $pair in $themes {\n    [data-theme='#{$name}'] {\n        @include emit-theme(nth($pair, 1), nth($pair, 2));\n    }\n}\n`;
    const result = run(
        t,
        good({ 'src/styles/_variables.scss': aliasing('color-bg'), 'src/styles/_themes.scss': themesFile }),
        {
            themes: {
                source: 'scss-maps',
                file: 'src/styles/_themes.scss',
                registryName: 'themes',
                emitFile: 'src/styles/_themes.scss',
                mixinFile: 'src/styles/_theme.scss',
                reference: 'default',
            },
        },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a registry-driven project fails a map left out of the registry', (t) => {
    const themesFile = `$default: (\n    'bg': #000,\n);\n\n$snow: (\n    'bg': #fff,\n);\n\n$themes: (\n);\n`;
    const result = run(t, good({ 'src/styles/_themes.scss': themesFile }), {
        themes: {
            source: 'scss-maps',
            file: 'src/styles/_themes.scss',
            registryName: 'themes',
            mixinFile: 'src/styles/_theme.scss',
            reference: 'default',
        },
    });
    assert.match(whats(result), /theme map\(s\) defined but never emitted: snow/);
});

// ── 7b. Every var(--token) resolves ─────────────────────────────────────────
test('a var() nothing declares fails', (t) => {
    const result = run(
        t,
        good({ 'src/App.vue': '<style lang="scss">\n.a {\n    color: var(--ghost);\n}\n</style>\n' }),
    );
    assert.match(whats(result), /App\.vue: uses `var\(--ghost\)`, which nothing declares/);
});

test('a var() naming a token the mixin interpolates into existence resolves', (t) => {
    const result = run(
        t,
        good({ 'src/App.vue': '<style lang="scss">\n.a {\n    color: var(--color-bg);\n}\n</style>\n' }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a var() named only in a comment is not a reference', (t) => {
    const result = run(
        t,
        good({ 'src/App.vue': '<style lang="scss">\n// see var(--ghost)\n.a {\n    color: red;\n}\n</style>\n' }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a component-local var is allowed, and the allowance carries a reason', (t) => {
    const files = good({ 'src/App.vue': '<style lang="scss">\n.a {\n    width: var(--fill);\n}\n</style>\n' });
    assert.match(whats(run(t, files)), /uses `var\(--fill\)`/);
    const result = run(t, files, { componentLocalVars: { fill: 'App.vue — set by a :style binding' } });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 8. No Sass colour maths on a runtime token ──────────────────────────────
for (const fn of ['rgba', 'darken', 'lighten', 'color.adjust']) {
    test(`\`${fn}()\` on a $color-* token fails`, (t) => {
        const result = run(
            t,
            good({ 'src/App.vue': `<style lang="scss">\n.a {\n    background: ${fn}($color-bg, 0.1);\n}\n</style>\n` }),
        );
        assert.match(whats(result), /computes on a token/);
    });
}

test('color-mix() on a token is the correct answer and passes', (t) => {
    const result = run(
        t,
        good({
            'src/App.vue':
                '<style lang="scss">\n.a {\n    background: color-mix(in srgb, $color-bg 12%, transparent);\n}\n</style>\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('rgba() on a literal colour is not a token and passes', (t) => {
    const result = run(
        t,
        good({ 'src/App.vue': '<style lang="scss">\n.a {\n    background: rgba(0, 0, 0, 0.1);\n}\n</style>\n' }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('rgba() on a non-colour variable passes', (t) => {
    const result = run(
        t,
        good({ 'src/App.vue': '<style lang="scss">\n.a {\n    background: rgba($brand-ink, 0.1);\n}\n</style>\n' }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 9. No @extend inside an SFC ─────────────────────────────────────────────
test('@extend inside an SFC fails', (t) => {
    const result = run(t, good({ 'src/App.vue': '<style lang="scss">\n.a {\n    @extend %row;\n}\n</style>\n' }));
    assert.match(whats(result), /App\.vue: `@extend %row` inside a component/);
});

test('@extend in a global partial is fine', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_base.scss':
                "@use '@/styles/variables' as *;\n\n%row {\n    display: flex;\n}\n\n.a {\n    @extend %row;\n}\n",
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 10. Self-hosted fonts ───────────────────────────────────────────────────
test('a Google Fonts URL in a stylesheet fails', (t) => {
    const result = run(
        t,
        good({
            'src/styles/_base.scss':
                "@use '@/styles/variables' as *;\n\n@import url(https://fonts.googleapis.com/css2?family=Inter);\n",
        }),
    );
    assert.match(whats(result), /pulls a remote stylesheet or font/);
});

test('a font CDN in the html shell fails', (t) => {
    const result = run(t, good({ 'index.html': '<link href="https://fonts.gstatic.com/x.woff2" />\n' }), {
        html: ['index.html'],
    });
    assert.match(whats(result), /index\.html: pulls a remote stylesheet or font/);
});

test('an @fontsource dependency fails', (t) => {
    const result = run(t, good({ 'package.json': '{ "dependencies": { "@fontsource/inter": "^5.0.0" } }' }), {
        packageJson: 'package.json',
    });
    assert.match(whats(result), /depends on @fontsource\/inter/);
});

test('a remote @font-face src fails', (t) => {
    const base =
        "@use '@/styles/variables' as *;\n\n@font-face {\n    font-family: Inter;\n    src: url(https://cdn.example.com/inter.woff2);\n}\n";
    const result = run(t, good({ 'src/styles/_base.scss': base }), { fontFaceFile: 'src/styles/_base.scss' });
    assert.match(whats(result), /@font-face loads a remote URL/);
});

test('vendored fonts without a LICENSE fail', (t) => {
    const base =
        "@use '@/styles/variables' as *;\n\n@font-face {\n    font-family: Inter;\n    src: url('@/assets/fonts/Inter.woff2');\n}\n";
    const result = run(t, good({ 'src/styles/_base.scss': base, 'src/assets/fonts/Inter.woff2': 'x' }), {
        fontFaceFile: 'src/styles/_base.scss',
        fontDir: 'src/assets/fonts',
    });
    assert.match(whats(result), /no LICENSE alongside the vendored fonts/);
});

test('vendored fonts with a LICENSE pass', (t) => {
    const base =
        "@use '@/styles/variables' as *;\n\n@font-face {\n    font-family: Inter;\n    src: url('@/assets/fonts/Inter.woff2');\n}\n";
    const result = run(
        t,
        good({ 'src/styles/_base.scss': base, 'src/assets/fonts/Inter.woff2': 'x', 'src/assets/fonts/LICENSE': 'OFL' }),
        { fontFaceFile: 'src/styles/_base.scss', fontDir: 'src/assets/fonts' },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a project on a system font stack is not asked for a fonts directory', (t) => {
    const result = run(t, good(), { fontFaceFile: 'src/styles/_base.scss', fontDir: 'src/assets/fonts' });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── The css-blocks source ───────────────────────────────────────────────────
const BLOCKS = `:root {
    --bg: #000;
    --text: #fff;
}

[data-theme='dark'] {
    --bg: #000;
    --text: #fff;
}

[data-theme='light'] {
    --bg: #fff;
    --text: #000;
}
`;

/** The alias layer, repointed at whatever names the palettes under test declare. */
const aliasing = (...names) =>
    VARIABLES.replace(
        /\$color-bg: var\(--color-bg\);\n\$color-text: var\(--color-text\);/,
        names.map((n) => `$color-${n}: var(--${n});`).join('\n'),
    );

const blockTree = (overrides = {}) =>
    good({ 'src/styles/_variables.scss': aliasing('bg', 'text'), 'src/styles/_themes.scss': BLOCKS, ...overrides });

const blockOptions = {
    themes: { source: 'css-blocks', file: 'src/styles/_themes.scss', reference: 'dark', selector: 'data-theme' },
    emitters: [
        { module: 'theme', why: 'the emission' },
        { module: 'base', why: 'the reset' },
    ],
};

test('css-blocks: matching palettes pass', (t) => {
    const result = run(t, blockTree(), blockOptions);
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.palettes, ['dark', 'light']);
});

test('css-blocks: a palette missing a token fails', (t) => {
    const result = run(
        t,
        blockTree({ 'src/styles/_themes.scss': BLOCKS.replace('    --text: #000;\n', '') }),
        blockOptions,
    );
    assert.match(whats(result), /`\[data-theme='light'\]` is missing 1 token\(s\): text/);
});

test('css-blocks: a :root fallback missing a token fails', (t) => {
    const result = run(
        t,
        blockTree({ 'src/styles/_themes.scss': BLOCKS.replace('    --text: #fff;\n}', '}') }),
        blockOptions,
    );
    assert.match(whats(result), /the fallback layer has no value for text/);
});

test('css-blocks: a :root token no palette overrides fails', (t) => {
    const result = run(
        t,
        blockTree({
            'src/styles/_themes.scss': BLOCKS.replace(
                ':root {\n    --bg: #000;',
                ':root {\n    --stuck: #123;\n    --bg: #000;',
            ),
        }),
        blockOptions,
    );
    assert.match(whats(result), /the fallback layer defines stuck, which no palette overrides/);
});

test('css-blocks: no :root block fails', (t) => {
    const result = run(
        t,
        blockTree({ 'src/styles/_themes.scss': BLOCKS.replace(/^:root \{[\s\S]*?\n\}\n\n/, '') }),
        blockOptions,
    );
    assert.match(whats(result), /has no `:root` block declaring custom properties/);
});

test('css-blocks: a single palette is not a theme system', (t) => {
    const result = run(
        t,
        blockTree({ 'src/styles/_themes.scss': BLOCKS.replace(/\[data-theme='light'\][\s\S]*$/, '') }),
        blockOptions,
    );
    assert.match(whats(result), /declares 1 theme block\(s\), expected at least two/);
});

test('css-blocks: the app-class selector is read too', (t) => {
    const result = run(
        t,
        blockTree({ 'src/styles/_themes.scss': BLOCKS.replace(/\[data-theme='([a-z]+)'\]/g, '#app.$1') }),
        {
            ...blockOptions,
            themes: { ...blockOptions.themes, selector: 'app-class' },
        },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('css-blocks: an invariant token duplicated in the palette file fails', (t) => {
    const result = run(t, blockTree({ 'src/styles/_tokens.scss': ':root {\n    --bg: #111;\n}\n' }), {
        ...blockOptions,
        themes: { ...blockOptions.themes, invariantFile: 'src/styles/_tokens.scss' },
    });
    assert.match(whats(result), /declares `--bg`, which the palette file also declares/);
});

test('css-blocks: an invariant token resolves a var() without joining the parity check', (t) => {
    const result = run(
        t,
        blockTree({
            'src/styles/_tokens.scss': ':root {\n    --brand: #f00;\n}\n',
            'src/App.vue': '<style lang="scss">\n.a {\n    color: var(--brand);\n}\n</style>\n',
        }),
        { ...blockOptions, themes: { ...blockOptions.themes, invariantFile: 'src/styles/_tokens.scss' } },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('css-blocks: an empty invariant file fails', (t) => {
    const result = run(t, blockTree({ 'src/styles/_tokens.scss': '// nothing yet\n' }), {
        ...blockOptions,
        themes: { ...blockOptions.themes, invariantFile: 'src/styles/_tokens.scss' },
    });
    assert.match(whats(result), /declares no custom properties/);
});

// ── The json-presets source ─────────────────────────────────────────────────
const presetOptions = {
    themes: {
        source: 'json-presets',
        dir: 'assets/themes',
        reference: 'dark',
        fallbackFile: 'src/styles/_theme.scss',
    },
};
const FALLBACK = ':root {\n    --bg: #000;\n    --text: #fff;\n}\n';
const presetTree = (overrides = {}) =>
    good({
        'src/styles/_variables.scss': aliasing('bg', 'text'),
        'src/styles/_theme.scss': FALLBACK,
        'assets/themes/dark.json': JSON.stringify({ name: 'Dark', colors: { bg: '#000', text: '#fff' } }),
        'assets/themes/light.json': JSON.stringify({ name: 'Light', colors: { bg: '#fff', text: '#000' } }),
        ...overrides,
    });

test('json-presets: matching presets pass', (t) => {
    const result = run(t, presetTree(), presetOptions);
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.palettes, ['dark', 'light']);
});

test('json-presets: a preset missing a colour fails', (t) => {
    const result = run(
        t,
        presetTree({ 'assets/themes/light.json': JSON.stringify({ name: 'Light', colors: { bg: '#fff' } }) }),
        presetOptions,
    );
    assert.match(whats(result), /`light\.json` is missing 1 token\(s\): text/);
});

test('json-presets: malformed JSON fails as malformed, not as missing keys', (t) => {
    const result = run(t, presetTree({ 'assets/themes/light.json': '{ oops' }), presetOptions);
    assert.match(whats(result), /light\.json: is not valid JSON/);
});

test('json-presets: a preset with no name fails', (t) => {
    const result = run(
        t,
        presetTree({ 'assets/themes/light.json': JSON.stringify({ colors: { bg: '#fff', text: '#000' } }) }),
        presetOptions,
    );
    assert.match(whats(result), /light\.json: has no `name`/);
});

test('json-presets: a preset with no colors map fails', (t) => {
    const result = run(t, presetTree({ 'assets/themes/light.json': JSON.stringify({ name: 'Light' }) }), presetOptions);
    assert.match(whats(result), /light\.json: has no `colors` map/);
});

test('json-presets: an empty preset directory fails', (t) => {
    const files = presetTree();
    delete files['assets/themes/dark.json'];
    delete files['assets/themes/light.json'];
    const result = run(t, { ...files, 'assets/themes/.keep': '' }, presetOptions);
    assert.match(whats(result), /contains no theme presets/);
});

test('json-presets: a :root fallback out of step with the presets fails', (t) => {
    const result = run(t, presetTree({ 'src/styles/_theme.scss': ':root {\n    --bg: #000;\n}\n' }), presetOptions);
    assert.match(whats(result), /the fallback layer has no value for text/);
});
