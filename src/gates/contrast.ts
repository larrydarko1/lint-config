/**
 * Text contrast, proven over the palettes rather than sampled from a screen:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Every text token clears the minimum ratio (WCAG AA, 4.5:1) on every background
 *      token, in every palette. The palettes are the whole set of colours, so this is the
 *      whole set proven, theme by theme.
 *   2. Every palette carries every token a pair names, as a colour the gate can measure.
 *   3. No dimmed text (with `scan`): a rule that colours text with a text token does not
 *      also lower its `opacity`. Opacity blends the text toward whatever is behind it,
 *      which voids the ratio proven in 1, and it compounds: a dimmed span in a dimmed
 *      paragraph is dimmed twice. Pseudo-elements and keyframes are exempt, and so is a
 *      rule under a `contrast-exempt: <reason>` comment.
 * Not checked: text over images or gradients, focus rings and borders (WCAG 1.4.11),
 * and whether a pairing looks good.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import type { ThemeSource } from './scss-standards.ts';

export type ContrastOptions = {
    root?: string;
    /** Where the palettes live: the same object the scss-standards gate takes. */
    themes: ThemeSource;
    /** Palette keys painted as text. Each is measured on every one of `backgrounds`. */
    text: string[];
    /** Palette keys text sits on. */
    backgrounds: string[];
    /** The ratio every pair must reach. Defaults to 4.5, WCAG AA for body text. */
    minRatio?: number;
    /** Style roots swept for text dimmed with `opacity` (rule 3). Without it, rule 3 is skipped. */
    scan?: string[];
    /** How a rule names a text colour, for rule 3. Defaults to `$color-<key>` for each of `text`. */
    textAliases?: string[];
};

type ContrastInput = Omit<ContrastOptions, 'root'> & { root: string };

/** One measured text-on-background pair. */
type Pair = { palette: string; text: string; background: string; ratio: number };

type ContrastInspection = {
    problems: GateFailure[];
    pairs: Pair[];
    palettes: string[];
    /** Style files swept for dimmed text; 0 without `scan`. */
    swept: number;
};

/** A palette's colours, by key. */
type Palette = Map<string, string>;

/** Generated punctuation and animation frames: no information for a reader, so WCAG does not price them. */
const DECORATIVE = /::(?:before|after|marker|placeholder)|@keyframes|^\s*(?:from|to|\d+%)\s*$/;

/** The opt-out, which must say why: a bare `contrast-exempt` does not match. */
const EXEMPT = /\/\*[\s\S]*?contrast-exempt:[ \t]*\S[\s\S]*?\*\//;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Inspect the palettes and the style tree without printing. */
export function inspectContrast(input: ContrastInput): ContrastInspection {
    const {
        root,
        themes,
        text,
        backgrounds,
        minRatio = 4.5,
        scan,
        textAliases = text.map((key) => `$color-${key}`),
    } = input;
    const themeFile = themes.source === 'json-presets' ? themes.dir : themes.file;
    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string): void => {
        problems.push({ file, what, why });
    };

    // ── 1–2. Every pair, in every palette ───────────────────────────────────
    const palettes = readPaletteColours(root, themes);
    if (palettes.size === 0) {
        fail(
            themeFile,
            'no palettes found',
            'The gate proves contrast by reading the palettes. Finding none must not read as a pass: the themes moved, or `themes` points at the wrong place.',
        );
    }
    const pairs: Pair[] = [];
    for (const [palette, colours] of palettes) {
        for (const key of [...text, ...backgrounds]) {
            const value = colours.get(key);
            if (value === undefined) {
                fail(
                    themeFile,
                    `the \`${palette}\` palette has no \`${key}\``,
                    'Every pair is measured in every palette, and a missing token cannot be.',
                );
            } else if (!HEX.test(value)) {
                fail(
                    themeFile,
                    `\`${palette}\`.\`${key}\` is \`${value}\`, which the gate cannot measure`,
                    'Write a palette colour as `#rgb` or `#rrggbb`. A computed or translucent colour has no fixed ratio: it depends on what it is computed from or drawn over.',
                );
            }
        }
        for (const fg of text) {
            for (const bg of backgrounds) {
                const [fgValue, bgValue] = [colours.get(fg), colours.get(bg)];
                if (fgValue === undefined || bgValue === undefined || !HEX.test(fgValue) || !HEX.test(bgValue))
                    continue;
                const ratio = contrastRatio(fgValue, bgValue);
                pairs.push({ palette, text: fg, background: bg, ratio });
                if (ratio < minRatio) {
                    fail(
                        themeFile,
                        `\`${palette}\`: ${fg} (${fgValue}) on ${bg} (${bgValue}) is ${ratio.toFixed(2)}:1, under ${minRatio}:1`,
                        'Text a reader cannot make out. Darken the text token or lighten the background, in this palette only.',
                    );
                }
            }
        }
    }

    // ── 3. No text dimmed with opacity ──────────────────────────────────────
    const files = scan === undefined ? [] : walkFiles(root, scan, { match: /\.(?:s?css|vue)$/ });
    const colour = new RegExp(String.raw`(?:^|[\s;])color:\s*(${textAliases.map(escape).join('|')})\s*;`);
    for (const file of files) {
        const source = styleSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
        for (const { selector, body, index } of styleRules(source)) {
            if (DECORATIVE.test(selector) || EXEMPT.test(selector)) continue;
            const textColour = colour.exec(body)?.[1];
            const opacity = /(?:^|[\s;])opacity:\s*([^;]+);/.exec(body)?.[1]?.trim();
            if (textColour === undefined || opacity === undefined || ['1', '100%'].includes(opacity)) continue;
            const line = source.slice(0, index + selector.search(/\S/)).split('\n').length;
            fail(
                `${file}:${line}`,
                `\`${selector.replace(/\/\*[\s\S]*?\*\//g, '').trim()}\` sets color: ${textColour} and opacity: ${opacity}`,
                'Opacity blends the text toward what is behind it and compounds through descendants, so the proven ratio no longer holds. Use the next text token down instead, or mark an aria-hidden ornament with `/* contrast-exempt: <reason> */`.',
            );
        }
    }

    return { problems, pairs, palettes: [...palettes.keys()], swept: files.length };
}

export function checkContrast(options: ContrastOptions): void {
    const { root = REPO_ROOT, ...rest } = options;

    const report = createGateReport({ name: 'Contrast' });
    const { problems, pairs, palettes, swept } = inspectContrast({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const worst = pairs.reduce<Pair | undefined>(
        (low, pair) => (low === undefined || pair.ratio < low.ratio ? pair : low),
        undefined,
    );
    report.done({
        summary:
            `Contrast OK — ${plural(pairs.length, 'text/background pair')} across ${plural(palettes.length, 'palette')} ` +
            `(${palettes.join(', ')}) clear ${rest.minRatio ?? 4.5}:1${
                worst === undefined
                    ? ''
                    : `; the tightest is ${worst.text} on ${worst.background} in ${worst.palette} at ${worst.ratio.toFixed(2)}:1`
            }${rest.scan === undefined ? '.' : `. No text dimmed by opacity in ${plural(swept, 'style file')}.`}`,
        notMachineChecked:
            'text over images or gradients, focus rings and borders (WCAG 1.4.11), and whether a pairing looks good.',
    });
}

/** WCAG 2.x relative luminance of a `#rgb` or `#rrggbb` colour. */
function luminance(hex: string): number {
    const digits = hex.slice(1);
    const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits;
    const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((at) => {
        const channel = Number.parseInt(full.slice(at, at + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Every palette's colours, whichever way the project spells them. */
function readPaletteColours(root: string, themes: ThemeSource): Map<string, Palette> {
    const read = (rel: string): string | null => {
        const absolute = path.join(root, rel);
        return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    };
    const palettes = new Map<string, Palette>();

    if (themes.source === 'json-presets') {
        const dir = path.join(root, themes.dir);
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
        for (const file of files.sort()) {
            const parsed: unknown = JSON.parse(read(`${themes.dir}/${file}`) ?? '{}');
            const colours = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'colors') : undefined;
            if (typeof colours !== 'object' || colours === null) continue;
            const entries = Object.entries(colours).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
            );
            palettes.set(file.replace(/\.json$/, ''), new Map(entries));
        }
    } else if (themes.source === 'css-blocks') {
        const source = read(themes.file) ?? '';
        const selector =
            themes.selector === 'data-theme'
                ? String.raw`\[data-theme=['"]([a-z0-9-]+)['"]\]`
                : String.raw`#app\.([a-z0-9-]+)`;
        for (const [, name = '', body = ''] of source.matchAll(
            new RegExp(String.raw`${selector}\s*\{([\s\S]*?)\n\}`, 'gi'),
        )) {
            palettes.set(
                name,
                new Map(
                    [...body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
                ),
            );
        }
    } else {
        const source = read(themes.file) ?? '';
        for (const [, name = '', body = ''] of source.matchAll(/^\$([a-z0-9-]+):\s*\(\n?([\s\S]*?)^\);/gm)) {
            if (name === themes.registryName) continue;
            const colours = new Map(
                [...body.matchAll(/'([a-z0-9-]+)'\s*:\s*(.+?),?[ \t]*$/gm)].map((m) => [
                    m[1] ?? '',
                    (m[2] ?? '').trim(),
                ]),
            );
            if (colours.size > 0) palettes.set(name.replace(/^theme-/, ''), colours);
        }
    }
    return palettes;
}

/** `selector { declarations }` pairs, with whatever precedes the selector (its comment) kept on it. */
function* styleRules(source: string): Generator<{ selector: string; body: string; index: number }> {
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        yield { selector: match[1] ?? '', body: match[2] ?? '', index: match.index };
    }
}

/** A `.vue` file's `<style>` blocks, kept at their offsets so line numbers stay true; a stylesheet whole. */
function styleSource(file: string, source: string): string {
    if (!file.endsWith('.vue')) return source;
    let kept = source.replace(/[^\n]/g, ' ');
    for (const match of source.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/g)) {
        const start = match.index + (match[1] ?? '').length;
        const body = match[2] ?? '';
        kept = kept.slice(0, start) + body + kept.slice(start + body.length);
    }
    return kept;
}

const escape = (text: string): string => text.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
