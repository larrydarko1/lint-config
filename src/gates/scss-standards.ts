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

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, type GateFailure } from './lib/report.ts';

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

/**
 * Where the palettes live:
 *
 *   • `scss-maps`    — Sass maps run through an `emit-theme` mixin (the standard).
 *   • `css-blocks`   — literal custom-property blocks, visible to stylelint.
 *   • `json-presets` — JSON files on disk, for users to hand-edit.
 */
export type ThemeSource = ScssMapThemes | CssBlockThemes | JsonPresetThemes;

type ScssMapThemes = {
    source: 'scss-maps';
    /** The partial holding the `$theme-*` maps. */
    file: string;
    /** The palette every other one is compared against, without any `theme-` prefix. */
    reference: string;
    /** The map registering which palettes get emitted, without its `$`. Absent: one `[data-theme='…']` block per palette. */
    registryName?: string;
    /** Where `emit-theme` and `color-scheme` live, if not alongside the maps. */
    mixinFile?: string;
    /** Where the maps are turned into CSS, if not in `file`. Defaults to `file`. */
    emitFile?: string;
};

type CssBlockThemes = {
    source: 'css-blocks';
    /** The partial holding one custom-property block per palette. */
    file: string;
    reference: string;
    /** How a palette is selected. `data-theme` is what the standard specifies. */
    selector: 'data-theme' | 'app-class';
    /** A partial of palette-independent colours on `:root`: not compared, but they resolve `var()`s. */
    invariantFile?: string;
};

type JsonPresetThemes = {
    source: 'json-presets';
    /** The directory of bundled `<id>.json` presets. */
    dir: string;
    /** The preset id every other one is compared against. */
    reference: string;
    /** The partial whose `:root` block is the compiled-in fallback layer. */
    fallbackFile: string;
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
    const problems: GateFailure[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };
    const abs = (rel: string) => path.join(root, rel);
    const exists = (rel: string) => fs.existsSync(abs(rel));
    const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');

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
    const walkInjected = (rel: string) => {
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

    // Silent on a system font stack.
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

/** Read the palettes, whichever way this project spells them, into one shape. */
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
    /** A missing palette file is a finding, not a crash. */
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
    /** The prefix the `emit-theme` mixin puts before a map key, read from the mixin. */
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
        // 'scss-maps': a map is only a palette once the registry emits it.
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

/** Source with its comments removed. */
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
