/**
 * Deferral markers (TODO, FIXME, TBD…) where ESLint's `no-warning-comments` cannot
 * see them: files with no parser (`.scss`, `.yml`, `.md`, Dockerfiles…) and SFC
 * templates, which vue-eslint-parser keeps off the comment list. For a `.vue` file in
 * `linted`, ESLint has the `<script>` half and this gate reads the `<template>` half.
 * The match is case-sensitive on purpose: `todo` is an ordinary Spanish and Portuguese
 * word in locale files. Lowercase markers in code are ESLint's job.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type RefactoringOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /**
     * Extensions ESLint already covers, so this gate skips them. Listing `.vue` means
     * only its `<template>` is read. Defaults to `['.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs']`.
     */
    linted?: string[];
    /** Extra basenames never read, on top of `package-lock.json` and the tracker. */
    skip?: string[];
    /** Paths never read. Replaces the default build-output list. */
    ignore?: RegExp;
    /** The file deferred work belongs in. Defaults to `todo.md`. */
    tracker?: string;
    /** Require every tracker bullet to carry a `[ ]` checkbox. */
    requireCheckboxes?: boolean;
};

type RefactoringInspection = {
    problems: GateFailure[];
    /** `trackerItems` is null when the tracker is not in this checkout. */
    counts: { scanned: number; templates: number; trackerItems: number | null };
};

/** Kept in step by hand with the ESLint `terms` list, which is matched case-insensitively. */
const MARKERS = /\b(TODO|FIXME|FIX ME|HACK|XXX|TBD|WIP)\b/;

const DEFAULT_TRACKER = 'todo.md';

/** Extensions ESLint parses in a default setup, so this gate leaves them alone. */
const DEFAULT_LINTED = ['.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs'];

/** Build output and vendored code, at any depth. */
const DEFAULT_IGNORE = /(^|\/)(node_modules|dist|dist-electron|out|coverage|backups)\//;

/** Binary payloads git tracks but no marker can meaningfully live in. */
const BINARY = /\.(png|jpe?g|gif|webp|svg|ico|icns|psd|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|zip|gz|jar|keystore|jks)$/i;

/** Past this, a file is generated or vendored; reading it line by line proves nothing. */
const MAX_BYTES = 512 * 1024;

export function inspectRefactoring(input: RefactoringOptions = {}): RefactoringInspection {
    const {
        root = REPO_ROOT,
        linted = DEFAULT_LINTED,
        skip = [],
        ignore = DEFAULT_IGNORE,
        tracker = DEFAULT_TRACKER,
        requireCheckboxes = false,
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const lintedExtensions = new Set(linted);
    const skipNames = new Set(['package-lock.json', tracker, ...skip]);

    /** Tracked and untracked-but-not-ignored, so a new file is checked before its first commit. */
    const repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
    })
        .split('\n')
        .filter(Boolean);

    // ── 1. Deferral markers where ESLint cannot see them ────────────────────────
    let scanned = 0;
    let templates = 0;

    for (const rel of repoFiles) {
        const ext = path.extname(rel);
        if (lintedExtensions.has(ext) && ext !== '.vue') continue;
        if (skipNames.has(path.basename(rel)) || ignore.test(rel) || BINARY.test(rel)) continue;

        const abs = path.join(root, rel);
        if (!fs.existsSync(abs) || fs.statSync(abs).size > MAX_BYTES) continue;

        const text = fs.readFileSync(abs, 'utf8');
        if (text.includes('\0')) continue;

        let lines: string[];
        let offset = 0;

        if (ext === '.vue' && lintedExtensions.has('.vue')) {
            const block = templateBlock(text);
            if (block === null) continue;
            ({ lines, offset } = block);
            templates += 1;
        } else {
            lines = (ext === '.md' ? stripMarkdownCode(text) : text).split('\n');
            scanned += 1;
        }

        lines.forEach((line, i) => {
            const hit = MARKERS.exec(line);
            if (hit === null) return;
            fail(
                `${rel}:${offset + i + 1}`,
                `\`${hit[1]}\` marker — ${line.trim().slice(0, 80)}`,
                `Deferred work does not live in the code. Move it to ${tracker} at the repo root (or a tracked issue) and delete the marker. If the line describes something that is TRUE now rather than something outstanding, say it as a statement — the marker is what turns an observation into a promise nobody is tracking.`,
            );
        });
    }

    // ── 2. The destination ──────────────────────────────────────────────────────
    const trackerPath = path.join(root, tracker);
    const hasTracker = fs.existsSync(trackerPath);
    let items = 0;

    if (hasTracker) {
        const lines = fs.readFileSync(trackerPath, 'utf8').split('\n');

        if (lines.every((line) => line.trim() === '')) {
            fail(
                tracker,
                'is empty',
                'It is the destination the marker ban points at. An empty tracker in a repo that forbids deferral markers means deferred work is being dropped, not deferred.',
            );
        }

        lines.forEach((line, i) => {
            if (!/^\s*[-*]\s/.test(line)) return;
            items += 1;
            if (requireCheckboxes && !/^\s*[-*]\s\[.\]\s/.test(line)) {
                fail(
                    `${tracker}:${i + 1}`,
                    `bullet without a checkbox — ${line.trim().slice(0, 60)}`,
                    'Write it as `- [ ] …` so the item has a state. A bare bullet cannot be marked done, which is how a tracker turns into a pile.',
                );
            }
        });
    }

    return { problems, counts: { scanned, templates, trackerItems: hasTracker ? items : null } };
}

export function checkRefactoring(options: RefactoringOptions = {}): void {
    const { tracker = DEFAULT_TRACKER, requireCheckboxes = false } = options;
    const report = createGateReport({ name: 'Refactoring' });
    const { problems, counts } = inspectRefactoring(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const covered = [
        `no deferral markers in ${plural(counts.scanned, 'unlinted file')}`,
        counts.templates > 0 ? plural(counts.templates, 'SFC <template> block') : '',
    ]
        .filter(Boolean)
        .join(' or ');

    const destination =
        counts.trackerItems === null
            ? `${tracker} is not in this checkout, so the destination check was skipped`
            : `${tracker} holds ${plural(counts.trackerItems, 'item')}${requireCheckboxes ? ', all with a checkbox' : ''}`;

    report.done({
        summary: `Refactoring OK — ${covered}; ${destination}.`,
        notMachineChecked:
            'whether a change was in scope, whether a drive-by belonged in its own commit, whether a file was split by concern or by line count, and whether something deferred should have been fixed on the spot.',
    });
}

/** Blank out fenced blocks and inline code spans (a backticked marker is named, not used), keeping line numbers. */
function stripMarkdownCode(source: string): string {
    return source
        .replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/** An SFC's outermost `<template>` block (the one at column 0), with the line it starts on. */
function templateBlock(source: string): { lines: string[]; offset: number } | null {
    const lines = source.split('\n');
    const open = lines.findIndex((line) => /^<template(\s|>)/.test(line));
    if (open === -1) return null;
    const close = lines.reduce((acc, line, i) => (line.startsWith('</template>') ? i : acc), -1);
    return close > open ? { lines: lines.slice(open, close + 1), offset: open } : null;
}
