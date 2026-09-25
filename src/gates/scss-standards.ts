/**
 * SCSS architecture gate.
 *
 * Stylesheets fail quietly. Nothing throws when a token is missing from one
 * theme, when a rule is emitted forty-seven times, or when a `var()` names
 * something nothing declares — the build is green, the page just looks wrong,
 * and only for whoever picked that theme.
 *
 * WHY THIS ONE WAS THE HARDEST. Five copies, 191 to 436 lines, and unlike every
 * gate before it the copies did not agree on WHAT they were checking. They
 * agreed on the principles and disagreed on the spelling, because the projects
 * themselves genuinely differ — one ships themes as JSON files users hand-edit,
 * which is a product feature, not a style preference.
 *
 * THE FINDING THAT MADE IT TRACTABLE. Two roles hide behind the word "barrel",
 * and every repo has both:
 *   • the INJECTED module — what `additionalData` prepends to every SFC style
 *     block. It is compiled once PER COMPONENT, so anything it can reach that
 *     emits a rule ships once per component.
 *   • the ENTRY module — what `main.ts` imports, exactly once. This is the only
 *     path by which a global rule should reach the bundle.
 * Three repos inject the token module and let `index.scss` be both barrel and
 * entry. Two inject the barrel, which forces the entry into a second file
 * (`global.scss`). That is not two architectures needing a switch — it is one
 * rule, "whatever is injected must emit nothing, transitively", reading two
 * different starting points. The one-file check in the desktop copy is the
 * degenerate case of the graph walk in the newest copy.
 *
 * AND IT CAUGHT A REAL BUG. One project injected `_variables.scss`, and
 * `_variables.scss` held the five `[data-theme='…'] { @include emit-theme(…) }`
 * blocks. Measured on the real build: every palette appeared 47 times in the
 * production CSS — once per SFC plus once for the barrel — and moving the
 * emission into a partial only the entry reaches took the stylesheet from
 * 286,849 bytes to 110,002. Four of the five repos already had a rule for this;
 * the fifth did not, and it was the one with the bug.
 *
 * WHAT THE STANDARD SETTLED, where the copies disagreed:
 *   • NO SASS COLOUR FUNCTION ON A `$color-*` TOKEN. One copy had it; the
 *     standard states it outright with a worked example. It is in, for all.
 *   • NO `@extend` INSIDE AN SFC. One copy had it; the standard's architecture
 *     section says SFCs cannot `@extend` across the compilation boundary. In.
 *   • FONTS — no CDN, no `@fontsource` dependency, `@font-face` in the base
 *     partial resolving to a bundled asset, and the upstream LICENSE shipped
 *     beside the woff2. The standard lists all four; one copy checked the last
 *     two, two copies checked the first two. All four are in, and the ones that
 *     only apply to a repo that vendors fonts stay silent in a repo that does
 *     not — a system font stack is not a violation.
 *
 * WHAT IS STILL AN OPTION, because it is a real difference and not drift: where
 * the palettes live. `themes.source` is the only switch in the gate, and the
 * comparison it feeds is identical in all three cases.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport } from './report.ts';

export type ScssProblem = {
    /** The file the finding belongs to. */
    file: string;
    what: string;
    why: string;
};

export type ScssStandardsInspection = {
    problems: ScssProblem[];
    /** Every `.scss` and `.vue` file swept, repo-relative. */
    styleFiles: string[];
    /** The palette names found, in the project's own vocabulary. */
    palettes: string[];
    /** How many tokens the reference palette declares. */
    tokenCount: number;
};

/** A module the entry point must `@use`, with the reason its absence matters. */
export type EmittingModule = {
    /** Matched against the `@use` specifier, so the partial's bare name. */
    module: string;
    why: string;
};

/**
 * Where the palettes live. This is the gate's only switch, and it is a switch
 * because the difference is a real architectural choice rather than drift:
 *
 *   • `scss-maps`  — palettes are Sass maps run through an `emit-theme` mixin.
 *                    This is what the standard specifies.
 *   • `css-blocks` — palettes are written out as literal custom-property blocks,
 *                    so stylelint's `no-unknown-custom-properties` can see them.
 *                    A Sass map is opaque to it, and to this gate.
 *   • `json-presets` — palettes are JSON files on disk, seeded into the user's
 *                    profile for hand-editing. A product feature, not a style.
 */
export type ThemeSource = ScssMapThemes | CssBlockThemes | JsonPresetThemes;

export type ScssMapThemes = {
    source: 'scss-maps';
    /** The partial holding the `$theme-*` maps. */
    file: string;
    /** The palette every other one is compared against, without any `theme-` prefix. */
    reference: string;
    /**
     * The map that registers which palettes get emitted, without its `$`. Absent
     * means the project emits one literal `[data-theme='…']` block per palette
     * instead, which is what the standard shows.
     */
    registryName?: string;
    /** Where `emit-theme` and `color-scheme` live, if not alongside the maps. */
    mixinFile?: string;
    /**
     * Where the maps are actually turned into CSS — the `[data-theme='…']` blocks
     * or the loop over the registry. Defaults to `file`. It is a separate option
     * because a map is a declaration and emitting it is an effect: the moment a
     * project moves its emission out of the injected module, which is what this
     * gate pushes for, the two part company.
     */
    emitFile?: string;
};

export type CssBlockThemes = {
    source: 'css-blocks';
    /** The partial holding one custom-property block per palette. */
    file: string;
    reference: string;
    /** How a palette is selected. `data-theme` is what the standard specifies. */
    selector: 'data-theme' | 'app-class';
    /**
     * A partial holding colours that are the same in every palette, declared on
     * `:root`. They take no part in the parity comparison — there is nothing for
     * them to disagree with — but a `var()` naming one resolves perfectly well,
     * so the sweep has to know about them.
     */
    invariantFile?: string;
};

export type JsonPresetThemes = {
    source: 'json-presets';
    /** The directory of bundled `<id>.json` presets. */
    dir: string;
    /** The preset id every other one is compared against. */
    reference: string;
    /** The partial whose `:root` block is the compiled-in fallback layer. */
    fallbackFile: string;
};

export type ScssStandardsOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
    /** The styles directory, repo-relative. Every file option below is relative to it. */
    styles: string;
    /** The source tree swept for SFCs and stylesheets, repo-relative. */
    src: string;
    /** The file holding the `@forward`s. Defaults to `index.scss`. */
    barrel?: string;
    /**
     * The file `main.ts` imports, which `@use`s the emitting modules. Defaults to
     * the barrel. It is a second file only when the barrel itself is injected.
     */
    entry?: string;
    /** The module Vite prepends to every SFC. Defaults to `_variables.scss`. */
    injected?: string;
    /** The script that imports the entry point, repo-relative. */
    mainScript: string;
    /** Every Vite config that compiles these SFCs. More than one means more than one build target. */
    viteConfigs: string[];
    /** The specifier `additionalData` must inject, exactly as written there. */
    injectedSpecifier: string;
    /**
     * Text the `additionalData` guard must contain, once the injected specifier
     * itself is discounted — because that specifier always mentions the styles
     * folder, and matching on it made the check pass unconditionally.
     *
     * Vite only hands the preprocessor the entry stylesheet and each SFC style
     * block; partials are resolved inside Sass and never reach it. So a project
     * whose entry is the only styles-tree file Vite sees can guard on just that
     * filename, while one that injects the barrel must exempt the whole folder.
     * Defaults to `'styles'`.
     */
    injectionGuard?: string;
    /** Modules the barrel must `@forward`. Defaults to `['variables']`. */
    forwarded?: string[];
    /** Modules the entry point must `@use`, since nothing else can reach them. */
    emitters?: EmittingModule[];
    themes: ThemeSource;
    /**
     * Custom properties a component sets on itself through a `:style` binding, so
     * they are deliberately absent from every palette. Mapped to the reason, kept
     * with the name so the exemption has to justify itself.
     */
    componentLocalVars?: Record<string, string>;
    /** Extra files swept for remote fonts, e.g. `index.html`. */
    html?: string[];
    /** Where vendored fonts live. Only consulted if the project declares `@font-face`. */
    fontDir?: string;
    /** The partial that declares `@font-face`. Absent or empty means a system font stack. */
    fontFaceFile?: string;
    /** The manifest checked for `@fontsource*` dependencies. */
    packageJson?: string;
};

export type ScssStandardsInput = Omit<ScssStandardsOptions, 'standard' | 'root'> & { root: string };

/** Sass constructs that declare something and emit nothing until it is used. */
const INERT_AT_RULES = /^@(mixin|function|use|forward|if|else|each|for|while|return|debug|warn|error)\b/;

/**
 * Sass colour functions. A `$color-*` alias is a `var(--color-…)` at runtime, so
 * Sass never sees the value it is being asked to compute on.
 */
const COLOUR_FN =
    /\b(?:lighten|darken|saturate|desaturate|transparentize|opacify|fade-in|fade-out|rgba|color\.(?:adjust|scale|change|mix|invert|complement))\(\s*\$color-[a-z0-9-]+/g;

/** Hosts that serve fonts or stylesheets over the network. */
const REMOTE_ASSET =
    /@import\s+url\(\s*['"]?https?:|fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|cdn\.jsdelivr\.net|unpkg\.com/gi;

/**
 * Inspect the SCSS architecture.
 */
export function inspectScssStandards({
    root,
    styles,
    src,
    barrel = 'index.scss',
    entry = barrel,
    injected = '_variables.scss',
    mainScript,
    viteConfigs,
    injectedSpecifier,
    injectionGuard = 'styles',
    forwarded = ['variables'],
    emitters = [],
    themes,
    componentLocalVars = {},
    html = [],
    fontDir,
    fontFaceFile,
    packageJson,
}: ScssStandardsInput): ScssStandardsInspection {
    const problems: ScssProblem[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };
    const abs = (rel: string) => path.join(root, rel);
    const exists = (rel: string) => fs.existsSync(abs(rel));
    const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');

    const barrelPath = `${styles}/${barrel}`;
    const entryPath = `${styles}/${entry}`;
    const injectedPath = `${styles}/${injected}`;

    for (const [role, rel, why] of [
        [
            'barrel',
            barrelPath,
            'It is the file that `@forward`s the design system; SFCs resolve `@use` of the styles folder through it.',
        ],
        [
            'entry point',
            entryPath,
            'It is the file `main.ts` imports; without it no global rule reaches the bundle at all.',
        ],
        [
            'injected module',
            injectedPath,
            'It is what Vite prepends to every SFC style block; without it every `$`-token reference in the app is an undefined-variable error.',
        ],
    ] as const) {
        if (!exists(rel)) fail(rel, `does not exist, but is this project's ${role}`, why);
    }

    const barrelSrc = exists(barrelPath) ? read(barrelPath) : '';
    const entrySrc = exists(entryPath) ? read(entryPath) : '';

    // ── 1. The barrel forwards the tokens ────────────────────────────────
    // `@forward` re-exports a module's members to whoever `@use`s this file.
    // `@use` would load it and keep it private — which is the whole difference,
    // and the reason a barrel that `@use`s its tokens looks fine and resolves
    // nothing.
    for (const module of forwarded) {
        if (!new RegExp(String.raw`@forward\s+['"][^'"]*${module}['"]`).test(barrelSrc)) {
            fail(
                barrelPath,
                `does not \`@forward\` ${module}`,
                `Every SFC reaches the design system through this file and nothing else. Un-forwarded, each \`$\`-name in _${module}.scss is an undefined-variable error in every component at once.`,
            );
        }
    }

    // ── 2. The entry @uses every emitting module ────────────────────────────
    for (const { module, why } of emitters) {
        if (!new RegExp(String.raw`@use\s+['"][^'"]*${module}['"]`).test(entrySrc)) {
            fail(entryPath, `does not \`@use\` ${module}`, why);
        }
    }

    // ── 3. main.ts imports exactly one stylesheet ───────────────────────────
    const mainSrc = exists(mainScript) ? read(mainScript) : '';
    const styleImports = [...mainSrc.matchAll(/import\s+['"][^'"]*\.scss['"]/g)];
    if (styleImports.length === 0) {
        fail(
            mainScript,
            'imports no stylesheet',
            `The entry point has exactly one importer, and it is this file: \`import '…/${entry}'\`.`,
        );
    } else if (styleImports.length > 1) {
        fail(
            mainScript,
            `imports ${styleImports.length} stylesheets`,
            'The entry point is the single way global rules reach the bundle. A second import emits every one of them twice.',
        );
    }

    // ── 4. Nothing reachable from the injected module emits ─────────────────
    // This is the rule the whole gate is built around. Each SFC style block is
    // its own Sass compilation, so a rule reachable from the injected module is
    // emitted once per component — silently, with a green build.
    const walked = new Set();
    const walkInjected = (rel: string) => {
        if (walked.has(rel)) return;
        walked.add(rel);
        const source = read(rel);

        // Loud (slash-star) comments survive compilation, so one in a file the
        // injection can reach is copied into every component's stylesheet.
        const loud = [...source.matchAll(/\/\*[\s\S]*?\*\//g)];
        if (loud.length > 0) {
            fail(
                rel,
                `is reachable from the injected module and holds ${loud.length} loud comment(s) (${loud.reduce((n, m) => n + m[0].length, 0)} bytes)`,
                'Sass preserves slash-star comments and this file is compiled once per SFC, so each one ships as many times as there are components. Use `//`, which Sass strips.',
            );
        }

        const stripped = stripComments(source);
        const emitted = emittingHeads(stripped);
        if (emitted.length > 0) {
            fail(
                rel,
                `is reachable from the injected module but emits CSS (\`${(emitted[0] ?? '').slice(0, 44)}…\`)`,
                'Every SFC compiles this file in its own pass, so these rules ship once per component instead of once per app. Move them into a partial that only the entry point reaches.',
            );
        }

        for (const [, spec = ''] of stripped.matchAll(/@(?:use|forward)\s+['"]([^'"]+)['"]/g)) {
            if (spec.startsWith('sass:')) continue;
            const resolved = resolveSpecifier(spec);
            if (resolved === undefined) {
                fail(
                    rel,
                    `loads \`${spec}\`, which resolves to no file`,
                    'Sass cannot find the module, so every SFC fails to compile. If it moved, the specifier has to move with it.',
                );
                continue;
            }
            walkInjected(resolved);
        }
    };

    /** Resolve a Sass specifier to a repo-relative path, trying each partial spelling. */
    const resolveSpecifier = (spec: string) => {
        const name = spec.replace(/^.*styles\//, '').replace(/^\.\//, '');
        const dir = path.dirname(name) === '.' ? '' : `${path.dirname(name)}/`;
        const base = path.basename(name);
        for (const candidate of [
            `${styles}/${dir}_${base}.scss`,
            `${styles}/${dir}${base}.scss`,
            `${styles}/${dir}${base}/_index.scss`,
            `${styles}/${dir}${base}/index.scss`,
        ]) {
            if (exists(candidate)) return candidate;
        }
        return undefined;
    };

    if (exists(injectedPath)) walkInjected(injectedPath);

    // ── 5. The Vite injection ───────────────────────────────────────────────
    for (const viteConfig of viteConfigs) {
        if (!exists(viteConfig)) {
            fail(
                viteConfig,
                'does not exist',
                'It carries the injection that puts the tokens in scope inside every SFC.',
            );
            continue;
        }
        const configSrc = read(viteConfig);
        const additionalData = /additionalData:\s*([\s\S]{0,400}?)\n\s*\},/.exec(configSrc);
        if (!/additionalData:/.test(configSrc)) {
            fail(
                viteConfig,
                'has no `css.preprocessorOptions.scss.additionalData`',
                'It is what prepends the token `@use` to every SFC style block. Without it every `$`-variable in every component is an undefined-variable error.',
            );
            continue;
        }
        if (!new RegExp(String.raw`@use\s+['"]${escapeRe(injectedSpecifier)}['"]\s+as\s+\*`).test(configSrc)) {
            fail(
                viteConfig,
                `additionalData does not inject \`@use '${injectedSpecifier}' as *\``,
                'The `as *` is what puts the tokens in the SFC’s own namespace; without it every reference needs a prefix. And it must name the module this gate walked for purity — inject anything else and the emit-once-per-component rule above is checking the wrong file.',
            );
        }
        const guard = (additionalData?.[1] ?? '').replaceAll(injectedSpecifier, '');
        if (additionalData !== null && !guard.includes(injectionGuard)) {
            fail(
                viteConfig,
                'additionalData does not exempt the styles directory',
                `Vite hands the preprocessor the entry stylesheet as well as every SFC, so without a \`${injectionGuard}\` test the entry is given a \`@use\` of the module it already loads. Sass fails the whole build on the circular load, and the message points at the wrong file.`,
            );
        }
    }

    // ── 6. No SFC manually @uses what Vite already injects ──────────────────
    const styleFiles = walk(src, (name) => name.endsWith('.scss') || name.endsWith('.vue'));
    const sfcs = styleFiles.filter((rel) => rel.endsWith('.vue'));

    const stray = sfcs.filter((rel) =>
        new RegExp(String.raw`@use\s+['"]${escapeRe(injectedSpecifier)}`).test(read(rel)),
    );
    if (stray.length > 0) {
        for (const rel of stray) {
            fail(
                rel,
                'manually `@use`s the module Vite already injects',
                'The injection puts it in scope in every SFC. A manual `@use` is redundant at best, and the day the file it names starts emitting, this component ships a second copy of it.',
            );
        }
    }

    // ── 7. Theme parity ─────────────────────────────────────────────────────
    const { palettes, reference, fallback, invariant, themeFile, emitPrefix } = readPalettes({
        themes,
        root,
        read,
        exists,
        fail,
    });

    if (reference !== undefined) {
        for (const [name, keys] of palettes) {
            if (name === themes.reference) continue;
            const missing = [...reference].filter((k) => !keys.has(k));
            const extra = [...keys].filter((k) => !reference.has(k));
            if (missing.length > 0) {
                fail(
                    themeFile,
                    `${describe(themes, name)} is missing ${missing.length} token(s): ${missing.join(', ')}`,
                    `Each one falls back to the layer underneath, so those elements are off-palette in this theme only — visible solely to whoever selected it.`,
                );
            }
            if (extra.length > 0) {
                fail(
                    themeFile,
                    `${describe(themes, name)} defines ${extra.length} token(s) no other theme has: ${extra.join(', ')}`,
                    'Either every palette needs the token, or nothing reads it and it is dead weight somebody will try to edit.',
                );
            }
        }

        if (fallback !== undefined) {
            const missingFallback = [...reference].filter((k) => !fallback.has(k));
            const orphanFallback = [...fallback].filter((k) => !reference.has(k));
            if (missingFallback.length > 0) {
                fail(
                    themeFile,
                    `the fallback layer has no value for ${missingFallback.join(', ')}`,
                    'It is what paints before a theme is applied, and what a theme that fails to load falls back to. A token missing here renders as nothing.',
                );
            }
            if (orphanFallback.length > 0) {
                fail(
                    themeFile,
                    `the fallback layer defines ${orphanFallback.join(', ')}, which no palette overrides`,
                    'The token is permanently stuck at its fallback — a theme switch cannot change it, which is exactly the bug that is hardest to see.',
                );
            }
        }
    }

    // 7b. Every `var(--token)` resolves to something.
    // A map-driven project never writes its custom properties down: the mixin
    // interpolates them, `--#{$prefix}#{$key}`, so the NAMES only exist after
    // Sass runs. Reconstructing them from the map keys is what lets this sweep
    // work at all there — without it every alias in the token layer looks
    // undeclared, which is the loudest possible false positive.
    const declared = new Set([
        ...(fallback ?? []),
        ...(reference ?? []),
        ...[...(reference ?? [])].map((key) => `${emitPrefix}${key}`),
        ...invariant,
        ...Object.keys(componentLocalVars),
    ]);
    if (declared.size > 0) {
        const unresolved: Map<string, string> = new Map();
        for (const rel of styleFiles) {
            for (const [, token = ''] of stripComments(read(rel)).matchAll(/var\(\s*--([a-z0-9-]+)/gi)) {
                if (!declared.has(token) && !unresolved.has(token)) unresolved.set(token, rel);
            }
        }
        for (const [token, rel] of unresolved) {
            fail(
                rel,
                `uses \`var(--${token})\`, which nothing declares`,
                'Not in the fallback layer, not in any palette, and not listed as component-local in this gate. It resolves to nothing — the property is simply dropped.',
            );
        }
    }

    // ── 8. No Sass colour maths on a runtime token ──────────────────────────
    for (const rel of styleFiles) {
        for (const [hit] of read(rel).matchAll(COLOUR_FN)) {
            fail(
                rel,
                `\`${hit}…\` computes on a token`,
                'A `$color-*` token is a `var(--color-…)` at runtime — themes are one stylesheet precisely because Sass never sees the value. Use `color-mix(in srgb, …)`, which the browser evaluates against whichever palette is live.',
            );
        }
    }

    // ── 9. No @extend inside an SFC ─────────────────────────────────────────
    for (const rel of sfcs) {
        for (const [, target = ''] of read(rel).matchAll(/@extend\s+([^;]+);/g)) {
            fail(
                rel,
                `\`@extend ${target.trim()}\` inside a component`,
                '@extend cannot cross the SFC boundary — each component compiles alone, so a %placeholder either fails to resolve or is duplicated into every component that extends it. Promote it to a real global class and put the class in the markup.',
            );
        }
    }

    // ── 10. Self-hosted fonts ───────────────────────────────────────────────
    for (const rel of [...new Set([...styleFiles, ...html, barrelPath, entryPath])].filter((r) => exists(r))) {
        for (const [hit] of read(rel).matchAll(REMOTE_ASSET)) {
            fail(
                rel,
                `pulls a remote stylesheet or font (\`${hit.slice(0, 40)}…\`)`,
                'Fonts are self-hosted: zero third-party requests, deterministic builds, offline-safe. Download the woff2 into the assets tree instead.',
            );
        }
    }

    if (packageJson !== undefined && exists(packageJson)) {
        const pkg = JSON.parse(read(packageJson)) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const fontPkgs = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
            d.startsWith('@fontsource'),
        );
        if (fontPkgs.length > 0) {
            fail(
                packageJson,
                `depends on ${fontPkgs.join(', ')}`,
                'The standard is explicit: do not depend on font packages to ship glyphs. Vendor the woff2 files instead, so the build fingerprints them and the version cannot move under you.',
            );
        }
    }

    // A repo on a system font stack declares no `@font-face` and vendors
    // nothing. There is nothing to license and nothing to bundle, so these two
    // stay silent rather than demanding a fonts directory that has no reason to
    // exist.
    const fontFaceSrc = fontFaceFile !== undefined && exists(fontFaceFile) ? read(fontFaceFile) : '';
    if (/@font-face/.test(fontFaceSrc)) {
        for (const [, url = ''] of fontFaceSrc.matchAll(/src:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
            if (/^https?:\/\//.test(url)) {
                fail(
                    fontFaceFile as string,
                    `@font-face loads a remote URL (${url})`,
                    'A font must resolve to a bundled asset so the build fingerprints it and no request leaves the origin.',
                );
            }
        }
        if (fontDir !== undefined && !exists(`${fontDir}/LICENSE`)) {
            fail(
                fontDir,
                'no LICENSE alongside the vendored fonts',
                'Self-hosting a font means shipping its licence with it — the upstream terms travel with the files.',
            );
        }
    }

    return { problems, styleFiles, palettes: [...palettes.keys()], tokenCount: reference?.size ?? 0 };

    /** @param dir @param {(name: string) => boolean} test @param {string[]} out */
    function walk(dir: string, test: (name: string) => boolean, out: string[] = []) {
        if (!exists(dir)) return out;
        for (const item of fs.readdirSync(abs(dir), { withFileTypes: true })) {
            const rel = `${dir}/${item.name}`;
            if (item.isDirectory()) walk(rel, test, out);
            else if (test(item.name)) out.push(rel);
        }
        return out;
    }
}

/**
 * The selector heads in `source` that actually put CSS in the output.
 *
 * NESTING IS THE WHOLE DIFFICULTY. `@media (min-width: 900px) { … }` at the top
 * level emits; the same line inside `@mixin above($bp) { … }` emits nothing at
 * all until something `@include`s it. A line-by-line scan cannot tell those
 * apart, and gets the second one wrong — which is the expensive direction,
 * because it fails a file that is correct. So this tracks the block stack: a
 * head counts only when no enclosing block is one of Sass's declare-don't-emit
 * constructs.
 */
function emittingHeads(source: string): string[] {
    const heads: string[] = [];
    /** One entry per open block: does it, or anything above it, suppress output? */
    const stack: boolean[] = [];
    // Interpolation is not a block, and a brace inside a quoted string is not a
    // block either. Blanking both first is what keeps `--color-#{$key}: …` from
    // reading as a selector named `--color-#`.
    const text = source
        .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, (quoted) => quoted.replace(/[{};]/g, ' '))
        .replace(/#\{[^}]*\}/g, 'x');

    let head = '';
    for (const ch of text) {
        if (ch === '{') {
            const trimmed = head.trim();
            const suppressed = stack.includes(true);
            const declaresOnly = INERT_AT_RULES.test(trimmed) || trimmed.startsWith('%');
            // No test for "is this really a declaration?" is needed, and an
            // earlier one here was actively wrong: it treated `:root` as a
            // declaration because of the leading colon, and so stayed silent on
            // the very block this gate exists to find. A declaration cannot
            // reach a `{` at all — `head` resets at every `;`, and the only two
            // ways a brace hides inside a value, interpolation and a quoted
            // string, are both neutralised above.
            if (!suppressed && !declaresOnly && trimmed !== '') heads.push(trimmed.replace(/\s+/g, ' '));
            stack.push(suppressed || declaresOnly);
            head = '';
        } else if (ch === '}') {
            stack.pop();
            head = '';
        } else if (ch === ';') {
            head = '';
        } else {
            head += ch;
        }
    }
    return heads;
}

/**
 * Read the palettes, whichever way this project spells them.
 *
 * This is the gate's one switch, and it exists because the difference is real:
 * a project whose users hand-edit theme files keeps them as JSON on disk, and a
 * project that wants stylelint to see its custom properties writes them out as
 * literal declarations rather than generating them from a Sass map. What comes
 * back is the same shape in all three cases, and every rule above it is shared.
 */
function readPalettes({
    themes,
    root,
    read,
    exists,
    fail,
}: {
    themes: ThemeSource;
    root: string;
    read: (rel: string) => string;
    exists: (rel: string) => boolean;
    fail: (file: string, what: string, why: string) => void;
}) {
    /**
     * A gate reports; it does not crash. A palette file that has been renamed or
     * deleted is a finding — and a far more likely one than it sounds, since the
     * whole point of this gate is to push emission out of one file into another.
     */
    const readOrFail = (rel: string, role: string) => {
        if (exists(rel)) return read(rel);
        fail(
            rel,
            `does not exist, but is where this project's ${role} live`,
            'If it was renamed or split, this gate is pointed at the wrong file and is checking nothing at all.',
        );
        return '';
    };

    const palettes: Map<string, Set<string>> = new Map();
    let invariant: Set<string> = new Set();
    let fallback: Set<string> | undefined;
    /**
     * What the `emit-theme` mixin puts in front of a map key to make the custom
     * property name. Read out of the mixin rather than assumed, because it is the
     * one place the map keys and the `var()` names are connected.
     */
    let emitPrefix = '';

    if (themes.source === 'json-presets') {
        const dir = themes.dir;
        const files = exists(dir)
            ? fs
                  .readdirSync(path.join(root, dir))
                  .filter((f) => f.endsWith('.json'))
                  .sort()
            : [];
        if (files.length === 0) {
            fail(
                dir,
                'contains no theme presets',
                'These are the bundled defaults the app seeds into the user profile on first launch.',
            );
        }
        for (const file of files) {
            let parsed: { name?: unknown; colors?: unknown };
            try {
                parsed = JSON.parse(read(`${dir}/${file}`));
            } catch (err) {
                fail(
                    `${dir}/${file}`,
                    `is not valid JSON — ${(err as Error).message}`,
                    'It is copied verbatim into the user profile, so a malformed preset ships broken.',
                );
                continue;
            }
            if (typeof parsed.name !== 'string' || parsed.name === '') {
                fail(
                    `${dir}/${file}`,
                    'has no `name`',
                    'The theme picker lists presets by `name`; without one the entry renders blank.',
                );
            }
            if (typeof parsed.colors !== 'object' || parsed.colors === null) {
                fail(
                    `${dir}/${file}`,
                    'has no `colors` map',
                    'The theme is applied by writing `colors` out as `--<key>` custom properties — a preset without it changes nothing when selected.',
                );
                continue;
            }
            palettes.set(file.replace(/\.json$/, ''), new Set(Object.keys(parsed.colors)));
        }
        const fallbackSrc = readOrFail(themes.fallbackFile, 'fallback layer');
        fallback = new Set(cssCustomProps(readBlock(fallbackSrc, /:root\s*\{([\s\S]*?)\n\}/)));
        if (fallbackSrc !== '' && !/:root\s*\{/.test(fallbackSrc)) {
            fail(
                themes.fallbackFile,
                'has no `:root` block',
                'It is the compiled-in layer every `var(--token)` resolves against before a theme is applied.',
            );
        }
    } else if (themes.source === 'css-blocks') {
        const source = readOrFail(themes.file, 'palettes');
        const selector =
            themes.selector === 'data-theme'
                ? String.raw`\[data-theme=['"][a-z0-9-]+['"]\]`
                : String.raw`#app\.[a-z0-9-]+`;
        const head = String.raw`(?::root|${selector})`;
        for (const [, selectors = '', body = ''] of source.matchAll(
            new RegExp(String.raw`^(${head}(?:,\s*\n${head})*)\s*\{([\s\S]*?)\n\}`, 'gim'),
        )) {
            const tokens = new Set(cssCustomProps(body));
            if (tokens.size === 0) continue;
            for (const sel of selectors.split(',').map((s) => s.trim())) {
                const named = /\[data-theme=['"]([a-z0-9-]+)['"]\]|#app\.([a-z0-9-]+)/.exec(sel);
                if (named === null) fallback = tokens;
                else palettes.set(named[1] ?? named[2] ?? '', tokens);
            }
        }
        if (fallback === undefined) {
            fail(
                themes.file,
                'has no `:root` block declaring custom properties',
                'It is the layer that paints before the theme selector lands — without it the first frame has no palette at all.',
            );
        }
        if (palettes.size < 2) {
            fail(
                themes.file,
                `declares ${palettes.size} theme block(s), expected at least two`,
                'The theme toggle offers both; a missing block means selecting that theme changes nothing.',
            );
        }
        if (themes.invariantFile !== undefined) {
            invariant = new Set(cssCustomProps(readOrFail(themes.invariantFile, 'invariant colours')));
            if (invariant.size === 0) {
                fail(
                    themes.invariantFile,
                    'declares no custom properties',
                    'It is the home for colours that do not fork. Empty, it is a file that only looks like it is doing something.',
                );
            }
            for (const token of invariant) {
                if (fallback?.has(token) === true) {
                    fail(
                        themes.invariantFile,
                        `declares \`--${token}\`, which the palette file also declares`,
                        'Two declarations, and the palette file loads last — so the invariant one silently never applies. Only one file can own a token; whichever is wrong, this is not a merge.',
                    );
                }
            }
        }
    } else {
        // 'scss-maps': the palettes are Sass maps. A map is only a palette once
        // something emits it, which is the `registry` half below.
        const source = readOrFail(themes.file, 'theme maps');
        for (const [, name = '', body = ''] of source.matchAll(/^\$([a-z0-9-]+):\s*\(\n?([\s\S]*?)^\);/gm)) {
            if (name === themes.registryName) continue;
            const keys = new Set([...body.matchAll(/'([a-z0-9-]+)'\s*:/g)].map((m) => m[1] ?? ''));
            if (keys.size === 0) continue;
            palettes.set(name.replace(/^theme-/, ''), keys);
        }
        if (palettes.size === 0 && source !== '') {
            fail(
                themes.file,
                'no theme maps found',
                'The theming mechanism is built on them — if they moved, this gate is blind and must be repointed.',
            );
        }

        // Where the maps ARE and where they are EMITTED are two files as often as
        // one: moving the emission out of the injected module is exactly the fix
        // this gate pushes projects towards, and it leaves the maps behind.
        const emitSrc = themes.emitFile === undefined ? source : readOrFail(themes.emitFile, 'theme emission');
        const emitted =
            themes.registryName === undefined
                ? new Set([...emitSrc.matchAll(/\[data-theme=['"]([a-z0-9-]+)['"]\]/g)].map((m) => m[1] ?? ''))
                : new Set(
                      [
                          ...(
                              new RegExp(String.raw`^\$${themes.registryName}:\s*\(([\s\S]*?)^\);`, 'm').exec(
                                  emitSrc,
                              )?.[1] ?? ''
                          ).matchAll(/\$([a-z0-9-]+)\s*,/g),
                      ].map((m) => (m[1] ?? '').replace(/^theme-/, '')),
                  );
        const orphans = [...palettes.keys()].filter((name) => name !== themes.reference && !emitted.has(name));
        if (orphans.length > 0) {
            fail(
                themes.file,
                `theme map(s) defined but never emitted: ${orphans.join(', ')}`,
                themes.registryName === undefined
                    ? 'A map with no `[data-theme="…"] { @include emit-theme(…) }` block produces no CSS. It is either dead weight or a theme users cannot select.'
                    : `A map absent from \`$${themes.registryName}\` is never reached by the loop that emits the blocks. It produces no CSS — dead weight, or a theme users cannot select.`,
            );
        }

        const mixinSrc = themes.mixinFile === undefined ? source : readOrFail(themes.mixinFile, '`emit-theme` mixin');
        emitPrefix = /--([a-z0-9-]*)#\{\s*\$/.exec(mixinSrc)?.[1] ?? '';

        if (!/@mixin\s+emit-theme/.test(mixinSrc)) {
            fail(
                themes.mixinFile ?? themes.file,
                'missing the `emit-theme` mixin',
                'It is the single place that turns a theme map into custom properties and sets `color-scheme` — without it the maps are inert.',
            );
        }
        if (!/color-scheme:/.test(mixinSrc)) {
            fail(
                themes.mixinFile ?? themes.file,
                'no `color-scheme` declaration',
                'Native controls, scrollbars and form widgets keep the UA default and clash with a dark theme.',
            );
        }
    }

    const reference = palettes.get(themes.reference);
    if (reference === undefined && palettes.size > 0) {
        fail(
            themes.source === 'json-presets' ? themes.dir : themes.file,
            `has no \`${themes.reference}\` palette`,
            `It is the reference shape every other palette is checked against. If it was renamed, this gate is blind and must be repointed.`,
        );
    }

    return {
        palettes,
        reference,
        fallback,
        invariant,
        emitPrefix,
        themeFile: themes.source === 'json-presets' ? themes.dir : themes.file,
    };
}

/**
 * Source with its comments removed. A `var()` named only in a comment is not a
 * reference, and a rule named only in a comment is not a rule.
 */
function stripComments(source: string) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Names of the `--custom-properties` declared in a block of CSS. */
function cssCustomProps(body: string) {
    return [...body.matchAll(/^\s*--([a-z0-9-]+)\s*:/gim)].map((m) => m[1] ?? '');
}

function readBlock(source: string, re: RegExp) {
    return re.exec(source)?.[1] ?? '';
}

/** How to name a palette in a message, in this project's own vocabulary. */
function describe(themes: ThemeSource, name: string) {
    if (themes.source === 'json-presets') return `\`${name}.json\``;
    if (themes.source === 'css-blocks') {
        return themes.selector === 'data-theme' ? `\`[data-theme='${name}']\`` : `\`#app.${name}\``;
    }
    return `\`$${name}\``;
}

function escapeRe(literal: string) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Run the gate and print.
 */
export function checkScssStandards({ root = REPO_ROOT, standard, ...rest }: ScssStandardsOptions): void {
    const report = createGateReport({ name: 'SCSS architecture', ...(standard === undefined ? {} : { standard }) });
    const { problems, styleFiles, palettes, tokenCount } = inspectScssStandards({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `barrel and injection intact with nothing emitting from the injected module, ${palettes.length} palettes agreeing on ${tokenCount} tokens, ${styleFiles.length} style files with no Sass maths on a token, no @extend in an SFC and no remote font.`,
        notMachineChecked:
            'Whether a token is the RIGHT token, whether a palette is legible, whether a pattern had earned promotion to a partial, grid-vs-flex, line-height judgement. stylelint owns BEM, unit allow-lists and declaration-strict-value.',
    });
}
