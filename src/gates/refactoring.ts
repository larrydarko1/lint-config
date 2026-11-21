/**
 * Deferral markers (TODO, FIXME, TBD…) where ESLint's `no-warning-comments` cannot
 * see them: files with no parser (`.scss`, `.yml`, `.md`, Dockerfiles…) and SFC
 * templates, which vue-eslint-parser keeps off the comment list. For a `.vue` file in
 * `linted`, ESLint has the `<script>` half and this gate reads the `<template>` half.
 * The match is case-sensitive on purpose: `todo` is an ordinary Spanish and Portuguese
 * word in locale files. Lowercase markers in code are ESLint's job.
 * Deferred work lives outside the repo, so a committed `todo.md` fails too. So does
 * Claude Code's local config: `CLAUDE.md`, `CLAUDE.local.md` and anything in `.claude/`.
 * A project that opts in with `claudeCode` also has the local copies held to one layout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { inspectClaudeSetup, type ClaudeSetupInspection } from './lib/claude-setup.ts';
import { stripMarkdownCode } from './lib/markdown.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, plural, type GateFailure } from './lib/report.ts';

export type RefactoringOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /**
     * Extensions ESLint already covers, so this gate skips them. Listing `.vue` means
     * only its `<template>` is read. Defaults to `['.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs']`.
     */
    linted?: string[];
    /** Extra basenames never read, on top of `package-lock.json`. */
    skipFiles?: string[];
    /** Paths never read. Replaces the default build-output list. */
    ignore?: RegExp;
    /**
     * Hold the gitignored Claude Code setup to one layout where it exists: `CLAUDE.md`'s
     * sections and their order, its size and dated notes, each skill's header, and no
     * `CLAUDE.local.md`. Off by default: it suits a project whose maintainer works this way.
     */
    claudeCode?: boolean;
};

type RefactoringInspection = {
    problems: GateFailure[];
    counts: { scanned: number; templates: number };
    /** What the opted-in Claude Code check read, or null when the project did not opt in. */
    claudeSetup: ClaudeSetupInspection['read'] | null;
};

/** Kept in step by hand with the ESLint `terms` list, which is matched case-insensitively. */
const MARKERS = /\b(TODO|FIXME|FIX ME|HACK|XXX|TBD|WIP)\b/;

/** Any casing: `TODO.md` goes stale exactly like `todo.md`. */
const TRACKER = /^todo\.md$/i;

/** Exact names: Claude Code loads `CLAUDE.md`, not a doc that happens to mention Claude. */
const CLAUDE_CONFIG = /(^|\/)(CLAUDE(\.local)?\.md$|\.claude\/)/;

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
        skipFiles = [],
        ignore = DEFAULT_IGNORE,
        claudeCode = false,
    } = input;

    const { problems, fail } = collectFailures();

    const lintedExtensions = new Set(linted);
    const skipNames = new Set(['package-lock.json', ...skipFiles]);

    /** Tracked and untracked-but-not-ignored, so a new file is checked before its first commit. */
    const repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
    })
        .split('\n')
        .filter(Boolean);

    let scanned = 0;
    let templates = 0;

    for (const rel of repoFiles) {
        // ── 1. No tracker file or Claude Code config in the repo ───────────────
        if (TRACKER.test(path.basename(rel)) && !ignore.test(rel)) {
            fail(
                rel,
                'a deferred-work list committed to the repo',
                'A list kept next to the code goes stale the first time an item is fixed without editing it, and nothing tells the reader which lines are still true. Move the items to your planner (or a GitHub issue on a team) and delete the file. A gitignored copy is local and not checked.',
            );
            continue;
        }
        if (CLAUDE_CONFIG.test(rel) && !ignore.test(rel)) {
            fail(
                rel,
                'Claude Code config committed to the repo',
                'Instructions, permissions and notes for Claude are local configuration for one machine, and a reader of the repo cannot tell which lines are still true. Keep the file out of git: add it to `.git/info/exclude` or `.gitignore`. If it is already committed, `git rm --cached <path>` untracks it without deleting it; older commits keep their copy.',
            );
            continue;
        }

        // ── 2. Deferral markers where ESLint cannot see them ────────────────────
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
                'Deferred work does not live in the repo. Move it to your planner (or a GitHub issue on a team) and delete the marker. If the line describes something that is TRUE now rather than something outstanding, say it as a statement — the marker is what turns an observation into a promise nobody is tracking.',
            );
        });
    }

    // ── 3. The local Claude Code setup, for a project that opted in ────────────
    let claudeSetup: ClaudeSetupInspection['read'] | null = null;
    if (claudeCode) {
        const setup = inspectClaudeSetup(root, new Date());
        problems.push(...setup.problems);
        claudeSetup = setup.read;
    }

    return { problems, counts: { scanned, templates }, claudeSetup };
}

export function checkRefactoring(options: RefactoringOptions = {}): void {
    const report = createGateReport({ name: 'Refactoring' });
    const { problems, counts, claudeSetup } = inspectRefactoring(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const covered = [
        `no deferral markers in ${plural(counts.scanned, 'unlinted file')}`,
        counts.templates > 0 ? plural(counts.templates, 'SFC <template> block') : '',
    ]
        .filter(Boolean)
        .join(' or ');

    report.done({
        summary: `Refactoring OK — ${covered}; no todo.md and no Claude Code config in the repo.${claudeSetupSummary(claudeSetup)}`,
        notMachineChecked:
            'whether a change was in scope, whether a drive-by belonged in its own commit, whether a file was split by concern or by line count, and whether something deferred should have been fixed on the spot.',
    });
}

function claudeSetupSummary(read: ClaudeSetupInspection['read'] | null): string {
    if (read === null) return '';
    const skills = read.skills > 0 ? `; ${plural(read.skills, 'skill')} checked` : '';
    return read.claudeMd
        ? ` The local CLAUDE.md follows the layout${skills}.`
        : ` No local CLAUDE.md here to check (it never reaches CI)${skills}.`;
}

/** An SFC's outermost `<template>` block (the one at column 0), with the line it starts on. */
function templateBlock(source: string): { lines: string[]; offset: number } | null {
    const lines = source.split('\n');
    const open = lines.findIndex((line) => /^<template(\s|>)/.test(line));
    if (open === -1) return null;
    const close = lines.reduce((acc, line, i) => (line.startsWith('</template>') ? i : acc), -1);
    return close > open ? { lines: lines.slice(open, close + 1), offset: open } : null;
}
