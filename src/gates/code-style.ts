/**
 * File-shape conventions ESLint has no opinion about: filename casing, a composable
 * exporting its own name, the line softcap, public before private, headers, SFC
 * block order and attributes, comment format per block, no JSDoc type tags, and no
 * relative imports where an alias resolves.
 *
 * Conventions are per-project data (`casing`, `headers`, `lineCap`, `baseline`,
 * `aliasedRoots`); an unmatched file is deliberately unconstrained.
 *
 * The softcap is a ratchet: files already over it are listed in `baseline` at their
 * size and fail only if they grow. An entry back under the cap, or naming a missing
 * file, fails too. Size is non-blank lines excluding an SFC's `<style>` block, as the
 * standard defines it.
 *
 * Not checked: tests and ambient `.d.ts` files.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './files.ts';
import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';
import { stripComments } from './strip-comments.ts';

export type CaseStyle = 'kebab' | 'camel' | 'pascal';

export type CasingRule = {
    /** Tested against the repo-relative path. First matching rule wins; an unmatched file is unchecked. */
    files: RegExp;
    style: CaseStyle;
    /** Paths this rule does not apply to — an upstream naming convention, or a framework-fixed name. */
    exempt?: RegExp;
};

export type HeaderRule = {
    /** Tested against the repo-relative path. First matching rule wins. */
    files: RegExp;
    /** `jsdoc` a `/** ... *\/` block, `comment` any leading comment, `none` a BAN on one. */
    require: 'jsdoc' | 'comment' | 'none';
};

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
};

export type CodeStyleInput = Omit<CodeStyleOptions, 'root'> & { root: string };

export type CodeStyleProblem = { file: string; what: string; why: string };

export type CodeStyleInspection = {
    problems: CodeStyleProblem[];
    /** Source files examined — `.ts`/`.tsx`/`.vue`, excluding specs and ambient declarations. */
    files: number;
    baselined: number;
};

/** The three filename conventions, as predicates on the stem. */
const CASE_STYLE = {
    kebab: { test: (stem: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem), label: 'kebab-case' },
    camel: { test: (stem: string) => /^[a-z][A-Za-z0-9]*$/.test(stem), label: 'camelCase' },
    pascal: { test: (stem: string) => /^[A-Z][A-Za-z0-9]*$/.test(stem), label: 'PascalCase' },
};

/** What a header rule can demand. `none` is a BAN, and bans are what nothing else catches. */
const HEADER_RULE = {
    jsdoc: {
        ok: (source: string) => /^\s*\/\*\*/.test(source),
        what: 'no JSDoc file header',
        why: 'This module owns an external concern — a filesystem, a model handle, a config file, a domain — and which one, plus what it guarantees callers, is not derivable from its exports.',
    },
    comment: {
        ok: (source: string) => /^\s*(\/\*|\/\/)/.test(source),
        what: 'no file header',
        why: 'A module here states what it owns in at least one line — a JSDoc block for a domain owner, a single `//` line for a narrow sub-module. That is the thing its signature cannot say.',
    },
    none: {
        ok: (source: string) => !/^\s*(<!--|\/\*)/.test(source),
        what: 'has a file-level header comment',
        why: 'An SFC takes no file header — `defineProps`/`defineEmits` are the contract, and a prose header above them is the one part nothing checks, so it is the part that goes stale. Put the "why" next to the code it explains.',
    },
};

const MARKUP_COMMENT = /<!--([\s\S]*?)-->/g;
const STYLE_COMMENT = /\/\*([\s\S]*?)\*\//g;
const DIVIDER = /^–{2,}\s+\S[\s\S]*\S\s+–{2,}$/;
const JSDOC_TYPE_TAG = /@(param|returns?|type)\s*\{/g;
const RELATIVE_IMPORT = /(?:from|import)\s*['"](\.[^'"]*)['"]/g;

const isSpec = (rel: string): boolean => rel.includes('__tests__') || /\.(test|spec)\.(ts|tsx)$/.test(rel);
const isDeclaration = (rel: string) => rel.endsWith('.d.ts');

/** 1-based line of a byte offset, so a per-occurrence finding can point at it. */
const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;

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
    } = input;

    const problems: CodeStyleProblem[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const all = walkFiles(root, scan, { match: /\.(ts|tsx|vue|scss)$/, exclude: (rel) => isSpec(rel) });
    const ts = all.filter((rel) => /\.tsx?$/.test(rel) && !isDeclaration(rel));
    const vue = all.filter((rel) => rel.endsWith('.vue'));
    const scss = all.filter((rel) => rel.endsWith('.scss'));

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
        const { ok, what, why } = HEADER_RULE[rule.require];
        if (!ok(read(rel))) fail(rel, what, why);
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
                if (text.startsWith('stylelint-')) continue;
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

    return { problems, files: ts.length + vue.length, baselined: Object.keys(baseline).length };
}

export function checkCodeStyle(options: CodeStyleOptions): void {
    const { root = REPO_ROOT, ...rest } = options;
    const report = createGateReport({ name: 'Code style' });

    const { problems, files, baselined } = inspectCodeStyle({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const cap = rest.lineCap ?? 400;
    report.done({
        summary: `Code style OK — ${plural(files, 'source file')}: names follow the convention for where they sit, composables export their own name, public API above private helpers, headers present per file type, SFC blocks in order, template and style comments in their own formats, no JSDoc types. File length: ${plural(baselined, 'file')} over the ~${cap}-line softcap, all baselined and ratcheted — they can shrink, not grow.`,
        notMachineChecked:
            'whether a comment explains WHY rather than what, whether a header earns its place, whether a file really is one concern, whether a name means anything beyond being long enough.',
    });
}
