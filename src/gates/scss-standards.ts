/**
 * SCSS architecture. Two modules matter: the INJECTED one, `_variables.scss`
 * (`additionalData`, compiled once per SFC), and the ENTRY one, `index.scss`
 * (imported once by `main.ts`). Anything reachable from the injected module that
 * emits CSS ships once per component.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. The entry forwards nothing.
 *   2. The entry `@use`s every emitting module.
 *   3. main.ts imports exactly one stylesheet.
 *   4. Nothing reachable from the injected module emits.
 *   5. The Vite injection is configured and guarded.
 *   6. No SFC manually `@use`s what Vite already injects.
 *   7. Theme parity, and every `var(--token)` resolves.
 *   8. No Sass colour function on a runtime `$color-*` token.
 *   9. No `@extend` inside an SFC.
 *  10. Self-hosted fonts: no CDN, no `@fontsource`, bundled `@font-face`, LICENSE
 *      beside the woff2 (silent on a system font stack).
 * `themes.source` is the only switch: where the palettes live.
 */
import fs from 'node:fs';
import path from 'node:path';

import { repoReader } from './lib/files.ts';
import { dependencyNames } from './lib/json.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, type GateFailure } from './lib/report.ts';
import { cssCustomProps, readPalettes, type ThemeSource } from './lib/theme-palettes.ts';

export type { ThemeSource } from './lib/theme-palettes.ts';

export type ScssStandardsOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /**
     * The styles directory, repo-relative. Its `index.scss` is the entry and its
     * `_variables.scss` the injected module; neither name is configurable.
     */
    styles: string;
    /** The source tree swept for SFCs and stylesheets, repo-relative. */
    src: string;
    /** The script that imports the entry point, repo-relative. */
    mainScript: string;
    /** Every Vite config that compiles these SFCs. More than one means more than one build target. */
    viteConfigs: string[];
    /** The specifier `additionalData` must inject, exactly as written there. It must resolve to `_variables.scss`. */
    injectedSpecifier: string;
    /**
     * Text the `additionalData` guard must contain, besides the injected specifier:
     * the entry's filename, or the styles folder. Defaults to `'styles'`.
     */
    injectionGuard?: string;
    /** Modules the entry point must `@use`, since nothing else can reach them. */
    emitters?: EmittingModule[];
    themes: ThemeSource;
    /** Custom properties a component sets through `:style`, absent from every palette. Mapped to the reason. */
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

type ScssStandardsInspection = {
    problems: GateFailure[];
    /** Every `.scss` and `.vue` file swept, repo-relative. */
    styleFiles: string[];
    /** The palette names found, in the project's own vocabulary. */
    palettes: string[];
    /** How many tokens the reference palette declares. */
    tokenCount: number;
};

/** A module the entry point must `@use`, with the reason its absence matters. */
type EmittingModule = {
    /** Matched against the `@use` specifier, so the partial's bare name. */
    module: string;
    why: string;
};

type ScssStandardsInput = Omit<ScssStandardsOptions, 'root'> & { root: string };

/** Sass constructs that declare something and emit nothing until it is used. */
const INERT_AT_RULES = /^@(mixin|function|use|forward|if|else|each|for|while|return|debug|warn|error)\b/;

/** Sass colour functions, which cannot compute on a runtime `var(--color-…)`. */
const COLOUR_FN =
    /\b(?:lighten|darken|saturate|desaturate|transparentize|opacify|fade-in|fade-out|rgba|color\.(?:adjust|scale|change|mix|invert|complement))\(\s*\$color-[a-z0-9-]+/g;

/** Hosts that serve fonts or stylesheets over the network. */
const REMOTE_ASSET =
    /@import\s+url\(\s*['"]?https?:|fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|cdn\.jsdelivr\.net|unpkg\.com/gi;

/** Inspect the SCSS architecture without printing. */
export function inspectScssStandards({
    root,
    styles,
    src,
    mainScript,
    viteConfigs,
    injectedSpecifier,
    injectionGuard = 'styles',
    emitters = [],
    themes,
    componentLocalVars = {},
    html = [],
    fontDir,
    fontFaceFile,
    packageJson,
}: ScssStandardsInput): ScssStandardsInspection {
    const { problems, fail } = collectFailures();
    const { abs, exists, read } = repoReader(root);

    const entryPath = `${styles}/index.scss`;
    const injectedPath = `${styles}/_variables.scss`;

    for (const [role, rel, why] of [
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

    const entrySrc = exists(entryPath) ? read(entryPath) : '';

    // ── 1. The entry forwards nothing ───────────────────────────────────────
    // A `@forward` only reaches a file that `@use`s this one, and nothing does:
    // the SFCs get their tokens from the injection, and main.ts imports the entry
    // as plain CSS.
    for (const [, spec = ''] of stripComments(entrySrc).matchAll(/@forward\s+['"]([^'"]+)['"]/g)) {
        fail(
            entryPath,
            `\`@forward\`s \`${spec}\`, but nothing \`@use\`s this file`,
            'Vite injects _variables.scss into every SFC directly, and main.ts imports this file as plain CSS, where a `@forward` does nothing. It reads like the thing keeping the tokens in scope, so removing it looks dangerous when it is dead code.',
        );
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
            "The entry point has exactly one importer, and it is this file: `import '…/index.scss'`.",
        );
    } else if (styleImports.length > 1) {
        fail(
            mainScript,
            `imports ${styleImports.length} stylesheets`,
            'The entry point is the single way global rules reach the bundle. A second import emits every one of them twice.',
        );
    }

    // ── 4. Nothing reachable from the injected module emits ─────────────────
    const walked = new Set();
    const walkInjected = (rel: string): void => {
        if (walked.has(rel)) return;
        walked.add(rel);
        const source = read(rel);

        // Loud (slash-star) comments survive compilation, so they emit too.
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
    const resolveSpecifier = (spec: string): string | undefined => {
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
        if (!configSrc.includes('additionalData:')) {
            fail(
                viteConfig,
                'has no `css.preprocessorOptions.scss.additionalData`',
                'It is what prepends the token `@use` to every SFC style block. Without it every `$`-variable in every component is an undefined-variable error.',
            );
            continue;
        }
        if (resolveSpecifier(injectedSpecifier) !== injectedPath) {
            fail(
                viteConfig,
                `injects \`${injectedSpecifier}\`, which is not ${injectedPath}`,
                'Only _variables.scss is safe to prepend to every SFC, because it only declares. Inject the folder and Sass loads index.scss, which emits every global rule once per component.',
            );
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
    // A map-driven project's names are reconstructed from the map keys and the mixin prefix.
    // A property a component declares in its own styles resolves too: custom properties
    // inherit, so whatever sets `--x` on an element reaches every `var(--x)` below it.
    const declared = new Set([
        ...(fallback ?? []),
        ...(reference ?? []),
        ...[...(reference ?? [])].map((key) => `${emitPrefix}${key}`),
        ...invariant,
        ...Object.keys(componentLocalVars),
        ...styleFiles.flatMap((rel) => cssCustomProps(stripComments(read(rel)))),
    ]);
    const unresolved = new Map<string, string>();
    for (const rel of declared.size > 0 ? styleFiles : []) {
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
    for (const rel of [...new Set([...styleFiles, ...html, entryPath])].filter((r) => exists(r))) {
        for (const [hit] of read(rel).matchAll(REMOTE_ASSET)) {
            fail(
                rel,
                `pulls a remote stylesheet or font (\`${hit.slice(0, 40)}…\`)`,
                'Fonts are self-hosted: zero third-party requests, deterministic builds, offline-safe. Download the woff2 into the assets tree instead.',
            );
        }
    }

    if (packageJson !== undefined && exists(packageJson)) {
        const fontPkgs = dependencyNames(JSON.parse(read(packageJson))).filter((d) => d.startsWith('@fontsource'));
        if (fontPkgs.length > 0) {
            fail(
                packageJson,
                `depends on ${fontPkgs.join(', ')}`,
                'The standard is explicit: do not depend on font packages to ship glyphs. Vendor the woff2 files instead, so the build fingerprints them and the version cannot move under you.',
            );
        }
    }

    // Silent on a system font stack.
    const fontFaceSrc = fontFaceFile !== undefined && exists(fontFaceFile) ? read(fontFaceFile) : '';
    if (fontFaceFile !== undefined && fontFaceSrc.includes('@font-face')) {
        for (const [, url = ''] of fontFaceSrc.matchAll(/src:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
            if (/^https?:\/\//.test(url)) {
                fail(
                    fontFaceFile,
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

    function walk(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
        if (!exists(dir)) return out;
        for (const item of fs.readdirSync(abs(dir), { withFileTypes: true })) {
            const rel = `${dir}/${item.name}`;
            if (item.isDirectory()) walk(rel, test, out);
            else if (test(item.name)) out.push(rel);
        }
        return out;
    }
}

/** Run the gate and print. */
export function checkScssStandards({ root = REPO_ROOT, ...rest }: ScssStandardsOptions): void {
    const report = createGateReport({ name: 'SCSS architecture' });
    const { problems, styleFiles, palettes, tokenCount } = inspectScssStandards({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `entry and injection intact with nothing emitting from the injected module, ${palettes.length} palettes agreeing on ${tokenCount} tokens, ${styleFiles.length} style files with no Sass maths on a token, no @extend in an SFC and no remote font.`,
        notMachineChecked:
            'Whether a token is the RIGHT token, whether a palette is legible, whether a pattern had earned promotion to a partial, grid-vs-flex, line-height judgement. stylelint owns BEM, unit allow-lists and declaration-strict-value.',
    });
}

/**
 * The selector heads in `source` that put CSS in the output: a head counts only
 * when no enclosing block is a declare-don't-emit construct (`@mixin`, …).
 */
function emittingHeads(source: string): string[] {
    const heads: string[] = [];
    /** One entry per open block: does it, or anything above it, suppress output? */
    const stack: boolean[] = [];
    // Blank interpolation and quoted strings, so their braces are not blocks.
    const text = source
        .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, (quoted) => quoted.replace(/[{};]/g, ' '))
        .replace(/#\{[^}]*\}/g, 'x');

    let head = '';
    for (const ch of text) {
        if (ch === '{') {
            const trimmed = head.trim();
            const suppressed = stack.includes(true);
            const declaresOnly = INERT_AT_RULES.test(trimmed) || trimmed.startsWith('%');
            // A declaration never reaches a `{`: `head` resets at every `;`.
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

/** Source with its comments removed. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** How to name a palette in a message, in this project's own vocabulary. */
function describe(themes: ThemeSource, name: string): string {
    if (themes.source === 'json-presets') return `\`${name}.json\``;
    if (themes.source === 'css-blocks') {
        return themes.selector === 'data-theme' ? `\`[data-theme='${name}']\`` : `\`#app.${name}\``;
    }
    return `\`$${name}\``;
}

function escapeRe(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
