/**
 * A project's colour palettes, read whichever way it spells them (SCSS maps, CSS blocks,
 * JSON presets) into one shape the scss-standards gate compares.
 */
import fs from 'node:fs';
import path from 'node:path';

import { toRecord } from './json.ts';

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

/** The palettes, whichever way the project spells them, in one shape. */
type Palettes = {
    palettes: Map<string, Set<string>>;
    reference: Set<string> | undefined;
    fallback: Set<string> | undefined;
    invariant: Set<string>;
    emitPrefix: string;
    themeFile: string;
};

/** Read the palettes, whichever way this project spells them, into one shape. */
export function readPalettes({
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
}): Palettes {
    /** A missing palette file is a finding, not a crash. */
    const readOrFail = (rel: string, role: string): string => {
        if (exists(rel)) return read(rel);
        fail(
            rel,
            `does not exist, but is where this project's ${role} live`,
            'If it was renamed or split, this gate is pointed at the wrong file and is checking nothing at all.',
        );
        return '';
    };

    const palettes = new Map<string, Set<string>>();
    let invariant = new Set<string>();
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
            let parsed: Record<string, unknown>;
            try {
                parsed = toRecord(JSON.parse(read(`${dir}/${file}`)));
            } catch (err) {
                fail(
                    `${dir}/${file}`,
                    `is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
                    'It is copied verbatim into the user profile, so a malformed preset ships broken.',
                );
                continue;
            }
            if (typeof parsed['name'] !== 'string' || parsed['name'] === '') {
                fail(
                    `${dir}/${file}`,
                    'has no `name`',
                    'The theme picker lists presets by `name`; without one the entry renders blank.',
                );
            }
            if (typeof parsed['colors'] !== 'object' || parsed['colors'] === null) {
                fail(
                    `${dir}/${file}`,
                    'has no `colors` map',
                    'The theme is applied by writing `colors` out as `--<key>` custom properties — a preset without it changes nothing when selected.',
                );
                continue;
            }
            palettes.set(file.replace(/\.json$/, ''), new Set(Object.keys(parsed['colors'])));
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
        if (!mixinSrc.includes('color-scheme:')) {
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

/** Names of the `--custom-properties` declared in a block of CSS. */
export function cssCustomProps(body: string): string[] {
    return [...body.matchAll(/^\s*--([a-z0-9-]+)\s*:/gim)].map((m) => m[1] ?? '');
}

function readBlock(source: string, re: RegExp): string {
    return re.exec(source)?.[1] ?? '';
}
