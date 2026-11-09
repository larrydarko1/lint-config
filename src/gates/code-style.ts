/**
 * File-shape conventions ESLint has no opinion about: filename casing, a composable
 * exporting its own name, the line softcap, public before private, headers, SFC
 * block order and attributes, comment format per block, no JSDoc type tags, and no
 * relative imports where an alias resolves. In Rust: `//!` headers, one-sentence doc
 * summaries, no section labels, no `get_` getters, and acronyms written as words.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 * - Conventions are per-project data (`casing`, `headers`, `lineCap`, `baseline`,
 * `aliasedRoots`); an unmatched file is deliberately unconstrained.
 * - The softcap is a ratchet: files already over it are listed in `baseline` at their
 * size and fail only if they grow. An entry back under the cap, or naming a missing
 * file, fails too. Size is non-blank lines excluding an SFC's `<style>` block, as the
 * standard defines it.
 * - Not checked: tests and ambient `.d.ts` files, and Rust under `target/`. Rust's
 * casing, length and public-before-private belong to rustc and the declaration-order gate.
 */
import fs from 'node:fs';
import path from 'node:path';

import { HEADER_RULE, RUST_HEADER_RULE, type HeaderRule } from './lib/file-headers.ts';
import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { lexRust, rustDocBlocks, rustItems, summarySentences } from './lib/rust.ts';
import { stripComments } from './lib/strip-comments.ts';

export type CodeStyleOptions = {
    root?: string;
    /** Source roots to walk. */
    scan: string[];
    lineCap?: number;
    /** Files already over the cap, at the size they were. Lower a number, never raise it. */
    baseline?: Record<string, number>;
    casing?: CasingRule[];
    headers?: HeaderRule[];
    /** Roots where an import alias resolves. Empty means the rule never fires. */
    aliasedRoots?: string[];
    /** SFCs that legitimately own a global style block, such as an app root. */
    globalStyles?: string[];
    /**
     * Let style blocks and stylesheets carry explanations, not only section dividers.
     * Defaults to false. Say why next to it: a project whose stylesheets are short and
     * whose comments say why a property has the value it has, which no markup can.
     */
    styleExplanations?: boolean;
};

type CaseStyle = 'kebab' | 'camel' | 'pascal';

type CasingRule = {
    /** Tested against the repo-relative path. First matching rule wins; an unmatched file is unchecked. */
    files: RegExp;
    style: CaseStyle;
    /** Paths this rule does not apply to — an upstream naming convention, or a framework-fixed name. */
    exempt?: RegExp;
};

type CodeStyleInput = Omit<CodeStyleOptions, 'root'> & { root: string };

type CodeStyleInspection = {
    problems: GateFailure[];
    /** Source files examined — `.ts`/`.tsx`/`.vue`, excluding specs and ambient declarations. */
    files: number;
    /** `.rs` files examined. */
    rustFiles: number;
    baselined: number;
};

/** The three filename conventions, as predicates on the stem. */
const CASE_STYLE = {
    kebab: { test: (stem: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem), label: 'kebab-case' },
    camel: { test: (stem: string) => /^[a-z][A-Za-z0-9]*$/.test(stem), label: 'camelCase' },
    pascal: { test: (stem: string) => /^[A-Z][A-Za-z0-9]*$/.test(stem), label: 'PascalCase' },
};

const MARKUP_COMMENT = /<!--([\s\S]*?)-->/g;
const STYLE_COMMENT = /\/\*([\s\S]*?)\*\//g;
const DIVIDER = /^–{2,}\s+\S[\s\S]*\S\s+–{2,}$/;
const JSDOC_TYPE_TAG = /@(param|returns?|type)\s*\{/g;
/** A `//` line made of rule characters: `// ── Helpers ──`, `// ======`. */
const RUST_SECTION_LABEL = /^\s*\/\/(?![/!])[^\n]*?[─━═–—=*#~-]{3,}/gm;
/** A getter spelled `get_x(&self)`: one receiver, no other arguments. */
const RUST_GETTER = /\bfn\s+(get_\w+)\s*(?:<[^>]*>)?\s*\(\s*&\s*(?:'\w+\s+)?(?:mut\s+)?self\s*\)/g;
/** Two capitals followed by a lowercase letter: `HTTPClient`, `IOError`. */
const SHOUTED_ACRONYM = /[A-Z]{2,}[a-z]/;
const RELATIVE_IMPORT = /(?:from|import)\s*['"](\.[^'"]*)['"]/g;

/** Non-blank lines, excluding an SFC's `<style>` block. */
export function measureFile(source: string, rel: string): number {
    const body = rel.endsWith('.vue') ? source.replace(/<style[\s\S]*?<\/style>/g, '') : source;
    return body.split('\n').filter((line) => line.trim() !== '').length;
}

/** The `<script setup>` block (not necessarily the first), plus any companion block. */
export function scriptBlocks(source: string): { setup: string | null; others: string[] } {
    const attrs = [...source.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '');
    const setup = attrs.find((a) => /\bsetup\b/.test(a));
    return { setup: setup ?? null, others: attrs.filter((a) => a !== setup) };
}

/** Every problem in one source tree, without printing anything. */
export function inspectCodeStyle(input: CodeStyleInput): CodeStyleInspection {
    const {
        root,
        scan,
        lineCap = 400,
        baseline = {},
        casing = [],
        headers = [],
        aliasedRoots = [],
        globalStyles = [],
        styleExplanations = false,
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const all = walkFiles(root, scan, {
        match: /\.(ts|tsx|vue|scss|rs)$/,
        exclude: (rel) => isSpec(rel) || isCargoOutput(rel),
    });
    const ts = all.filter((rel) => /\.tsx?$/.test(rel) && !isDeclaration(rel));
    const vue = all.filter((rel) => rel.endsWith('.vue'));
    const scss = all.filter((rel) => rel.endsWith('.scss'));
    const rust = all.filter((rel) => rel.endsWith('.rs'));

    // ── 1. Filename casing ──────────────────────────────────────────────────
    for (const rel of [...ts, ...vue]) {
        const rule = casing.find((c) => c.files.test(rel));
        if (rule === undefined) continue;
        if (rule.exempt?.test(rel) === true) continue;
        const style = CASE_STYLE[rule.style];
        const stem = path.basename(rel).replace(/\.(tsx?|vue)$/, '');
        if (!style.test(stem)) {
            fail(
                rel,
                `filename \`${stem}\` is not ${style.label}`,
                `Files here are ${style.label}. Rename the file and its importers together, MODULE SPECIFIERS ONLY: rewriting the exported symbol at the same time is how \`mockDb\` once became \`mock-db\` in 47 files. Anchor the rewrite on the path separator — suites import their subject relatively.`,
            );
        }
    }

    // ── 2. A composable file exports its own name ───────────────────────────
    for (const rel of ts) {
        const stem = path.basename(rel, path.extname(rel));
        if (!/^use[A-Z]/.test(stem)) continue;
        const code = stripComments(read(rel));
        if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${stem}`).test(code)) {
            fail(
                rel,
                `exports nothing named \`${stem}…\``,
                'A composable renamed without renaming its file — or split in two with only half moved — leaves a filename that lies about its contents, and every import site still reads perfectly. A helpers module satisfies this with a prefixed export (`useDebounce.ts` → `useDebounceFn`).',
            );
        }
    }

    // ── 3. The line softcap, as a ratchet ───────────────────────────────────
    for (const rel of [...ts, ...vue].sort()) {
        const size = measureFile(read(rel), rel);
        const limit = baseline[rel];
        if (limit === undefined) {
            if (size > lineCap) {
                fail(
                    rel,
                    `${size} lines, over the ~${lineCap}-line softcap`,
                    "Split it into smaller pieces. If it genuinely cannot be split, add it to this gate's `baseline` with a reason — that is a decision worth making out loud.",
                );
            }
        } else if (size > limit) {
            fail(
                rel,
                `grew to ${size} lines (was ${limit}, already over the ~${lineCap} softcap)`,
                'This file is on the split-me list. It may shrink, not grow — lower its `baseline` number, never raise it.',
            );
        } else if (size <= lineCap) {
            fail(
                rel,
                `is down to ${size} lines and no longer needs a baseline entry`,
                'Remove it from `baseline` so the ratchet cannot quietly slip back. An entry left behind is a licence to regrow to the old number.',
            );
        }
    }
    for (const rel of Object.keys(baseline).sort()) {
        if (!fs.existsSync(path.join(root, rel))) {
            fail(
                rel,
                'is in `baseline` but does not exist',
                'The ratchet is naming a file that was deleted or moved. Drop the entry — a list that keeps names nobody can check is how the whole list stops being read.',
            );
        }
    }

    // ── 4. Public before private ────────────────────────────────────────────
    for (const rel of ts) {
        const code = stripComments(read(rel));
        const declarations = [...code.matchAll(/^(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => ({
            exported: m[1] !== undefined,
            name: m[2] ?? '',
        }));
        const firstPrivate = declarations.findIndex((d) => !d.exported);
        if (firstPrivate === -1) continue;
        const lateExport = declarations.slice(firstPrivate).find((d) => d.exported);
        if (lateExport !== undefined) {
            fail(
                rel,
                `exported \`${lateExport.name}()\` is declared after the private \`${declarations[firstPrivate]?.name ?? ''}()\``,
                'Public API first, machinery below, so a reader meets what the module offers before how it works. Comments are stripped first — a disabled handler quoted inside a block comment is not a private function stranded above the public API.',
            );
        }
    }

    // ── 5. Headers, by file type ────────────────────────────────────────────
    for (const rel of [...ts, ...vue]) {
        const rule = headers.find((h) => h.files.test(rel));
        if (rule === undefined) continue;
        const { problem, why } = HEADER_RULE[rule.require];
        const what = problem(read(rel));
        if (what !== null) fail(rel, what, why);
    }

    // ── 6/7. SFC block order and block attributes ───────────────────────────
    for (const rel of vue) {
        const source = read(rel);

        const seen = [...source.matchAll(/^<(script|template|style)\b/gm)].map((m) => m[1]);
        const ordered = seen.filter((tag, i) => seen.indexOf(tag) === i);
        const canonical = ['script', 'template', 'style'].filter((tag) => ordered.includes(tag));
        if (ordered.join(',') !== canonical.join(',')) {
            fail(
                rel,
                `blocks are ordered ${ordered.join(' → ')}`,
                'Every SFC opens `<script setup>` → `<template>` → `<style>`: logic, then markup, then presentation. Vue compiles any order, so nothing but a sweep ever notices — and the payoff is that you never hunt for the script block.',
            );
        }

        const { setup, others } = scriptBlocks(source);
        if (setup !== null && !setup.includes('lang="ts"')) {
            fail(
                rel,
                `<script${setup}> is not \`<script setup lang="ts">\``,
                'Every SFC in this codebase is script-setup TypeScript.',
            );
        }
        for (const other of others) {
            if (!other.includes('lang="ts"')) {
                fail(
                    rel,
                    `<script${other}> is not TypeScript`,
                    'A second, non-setup script block is legitimate — it is where a generic component declares the type its setup block is generic over — but it is still TypeScript.',
                );
            }
        }

        const style = /<style\b([^>]*)>/.exec(source)?.[1];
        if (style !== undefined && !globalStyles.includes(rel)) {
            if (!(style.includes('scoped') && style.includes('lang="scss"'))) {
                fail(
                    rel,
                    `<style${style}> is not \`<style scoped lang="scss">\``,
                    'Component styles are scoped SCSS. Anything that has to cross the SFC boundary is a real global class in styles/, never an unscoped block here — and an app root that genuinely owns the global sheet belongs in `globalStyles`, named.',
                );
            }
        }
    }

    // ── 8. Comment format in <template> ─────────────────────────────────────
    for (const rel of vue) {
        const source = read(rel);
        const start = source.search(/^<template\b/m);
        if (start === -1) continue;
        const after = source.slice(start + 1).search(/^<(script|style)\b/m);
        const template = source.slice(start, after === -1 ? undefined : start + 1 + after);

        for (const match of template.matchAll(MARKUP_COMMENT)) {
            if (/[–—─]{2,}/.test(match[1] ?? '')) {
                fail(
                    `${rel}:${lineAt(source, start + (match.index ?? 0))}`,
                    `decorated template comment: <!--${(match[1] ?? '').replace(/\s+/g, ' ').slice(0, 40)}… -->`,
                    'Template section labels are plain text: `<!-- Section name -->`. The dashed form is the style-block divider, and using one form for both is what turns a label into noise.',
                );
            }
        }
        for (const match of template.matchAll(/^[ \t]*(\/\/|\/\*)/gm)) {
            fail(
                `${rel}:${lineAt(source, start + (match.index ?? 0))}`,
                `JS-style comment inside <template>: \`${match[1] ?? ''}\``,
                'Markup comments are `<!-- Section -->`. A `//` in a template is not a comment at all — Vue renders it to the page as text.',
            );
        }
    }

    // ── 9. Comment format in style blocks and stylesheets ───────────────────
    for (const rel of [...vue, ...scss].sort()) {
        const source = read(rel);
        const globalSheet = rel.endsWith('.scss');
        const blocks = globalSheet
            ? [{ text: source.replace(/^\/\*[\s\S]*?\*\//, ''), offset: 0 }]
            : [...source.matchAll(/<style[\s\S]*?<\/style>/g)].map((m) => ({ text: m[0], offset: m.index ?? 0 }));

        for (const { text: block, offset } of blocks) {
            for (const match of block.matchAll(STYLE_COMMENT)) {
                const whole = match[0];
                const text = (match[1] ?? '').trim();
                // Control comments for another tool: stylelint's, and the contrast gate's opt-out.
                if (text.startsWith('stylelint-') || text.startsWith('contrast-exempt:')) continue;
                if (styleExplanations) continue;
                if (globalSheet && whole.startsWith('/**')) continue;
                if (DIVIDER.test(text)) continue;
                fail(
                    `${rel}:${lineAt(source, offset + (match.index ?? 0))}`,
                    `non-divider style comment: /* ${text.replace(/\s+/g, ' ').slice(0, 45)} */`,
                    'Style blocks carry section dividers only — `/* –––––– Section name –––––– */`, en-dashes. An explanation of a property belongs in the markup or the component docs, not the stylesheet, where the decoration is the only thing making a 700-line block scannable.',
                );
            }
        }
    }

    // ── 10. No JSDoc type tags in TypeScript ────────────────────────────────
    for (const rel of [...ts, ...vue].sort()) {
        const source = read(rel);
        for (const match of source.matchAll(JSDOC_TYPE_TAG)) {
            fail(
                `${rel}:${lineAt(source, match.index ?? 0)}`,
                `\`@${match[1] ?? ''} {…}\` carries a type`,
                'TypeScript already states the type and actually checks it; the tag is a copy that nothing verifies, so it drifts silently. Drop the braces — keep the prose if it says something the signature cannot.',
            );
        }
    }

    // ── 11. No relative imports where an alias resolves ─────────────────────
    for (const rel of [...ts, ...vue].sort()) {
        if (!aliasedRoots.some((r) => rel.startsWith(`${r}/`))) continue;
        const code = stripComments(read(rel));
        for (const match of code.matchAll(RELATIVE_IMPORT)) {
            fail(
                `${rel}:${lineAt(code, match.index ?? 0)}`,
                `relative import \`${match[1] ?? ''}\``,
                'Imports in an aliased root always use the alias. A relative specifier works right up until the file moves, and then it fails somewhere else — which is why it spreads.',
            );
        }
    }

    // ── 12. Rust headers: `lib.rs` always, the rest by rule ─────────────────
    for (const rel of rust) {
        const rule = path.basename(rel) === 'lib.rs' ? 'rustdoc' : headers.find((h) => h.files.test(rel))?.require;
        if (rule === undefined) continue;
        const { problem, why } = RUST_HEADER_RULE[rule];
        const what = problem(read(rel));
        if (what !== null) {
            fail(
                rel,
                what,
                path.basename(rel) === 'lib.rs'
                    ? 'The crate root always opens with `//!`: it is the crate’s documentation, one or two lines saying what the crate is.'
                    : why,
            );
        }
    }

    for (const rel of rust) {
        const source = read(rel);
        const lexed = lexRust(source);

        // ── 13. A doc summary is one sentence ──────────────────────────────────
        for (const block of rustDocBlocks(source, lexed)) {
            const sentences = summarySentences(block.lines);
            if (sentences <= 1) continue;
            fail(
                `${rel}:${block.line}`,
                `the first paragraph of this \`${block.kind === 'inner' ? '//!' : '///'}\` block is ${sentences} sentences`,
                'rustdoc shows the first paragraph alone, in module listings and the editor’s hover, so it is the summary and it is one sentence. End it after the first sentence with a blank `//!` or `///` line, and the rest becomes the body.',
            );
        }

        // ── 14. No section labels ─────────────────────────────────────────────
        for (const match of source.matchAll(RUST_SECTION_LABEL)) {
            const at = match.index + (match[0].length - match[0].trimStart().length);
            if (lexed.strings.some((str) => at > str.start && at < str.end)) continue;
            fail(
                `${rel}:${lineAt(source, at)}`,
                `section-label comment: \`${match[0].trim().slice(0, 40)}\``,
                'The item order already places every item, and a label goes stale the first time someone appends to the wrong block. Explain a why next to the code, or split the file.',
            );
        }

        // ── 15. No `get_` on a getter ─────────────────────────────────────────
        for (const match of lexed.code.matchAll(RUST_GETTER)) {
            fail(
                `${rel}:${lineAt(source, match.index)}`,
                `\`${match[1] ?? ''}(&self)\` is a getter named with \`get_\``,
                `A getter takes the field’s name: \`fn ${(match[1] ?? '').slice(4)}(&self)\` (Rust API Guidelines, C-GETTER). \`get\` is for a lookup that can miss, like \`HashMap::get\`.`,
            );
        }

        // ── 16. Acronyms are words ────────────────────────────────────────────
        for (const item of rustItems(source, lexed)) {
            if (!['struct', 'enum', 'union', 'trait', 'type'].includes(item.kind)) continue;
            if (!SHOUTED_ACRONYM.test(item.name)) continue;
            fail(
                `${rel}:${item.line}`,
                `\`${item.name}\` writes an acronym in capitals`,
                'Acronyms are one word in UpperCamelCase: `HttpClient`, `IoError` (RFC 430). Clippy’s `upper_case_acronyms` only flags a name in capitals throughout.',
            );
        }
    }

    return { problems, files: ts.length + vue.length, rustFiles: rust.length, baselined: Object.keys(baseline).length };
}

export function checkCodeStyle(options: CodeStyleOptions): void {
    const { root = REPO_ROOT, ...rest } = options;
    const report = createGateReport({ name: 'Code style' });

    const { problems, files, rustFiles, baselined } = inspectCodeStyle({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const cap = rest.lineCap ?? 400;
    report.done({
        summary: `Code style OK — ${plural(files, 'source file')}: names follow the convention for where they sit, composables export their own name, public API above private helpers, headers present per file type, SFC blocks in order, template and style comments in their own formats, no JSDoc types. File length: ${plural(baselined, 'file')} over the ~${cap}-line softcap, all baselined and ratcheted — they can shrink, not grow.${rustFiles === 0 ? '' : ` ${plural(rustFiles, 'Rust file')}: \`//!\` headers where they are owed, one-sentence doc summaries, no section labels, no \`get_\` getters, acronyms as words.`}`,
        notMachineChecked:
            'whether a comment explains WHY rather than what, whether a header earns its place, whether a file really is one concern, whether a name means anything beyond being long enough.',
    });
}

const isSpec = (rel: string): boolean => rel.includes('__tests__') || /\.(test|spec)\.(ts|tsx)$/.test(rel);
const isDeclaration = (rel: string) => rel.endsWith('.d.ts');
const isCargoOutput = (rel: string) => rel.endsWith('.rs') && /(^|\/)target\//.test(rel);

/** 1-based line of a byte offset, so a per-occurrence finding can point at it. */
const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;
