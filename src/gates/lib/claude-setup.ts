/**
 * The layout of a repo's local Claude Code setup, for a project that opts in: its
 * `CLAUDE.md`, its skills, and no `CLAUDE.local.md`. The files are gitignored, so this
 * reads them from disk where they exist, which is the machine they were written on. In
 * CI there is nothing to read, and the gate says so.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { isRecord } from './json.ts';
import { stripMarkdownCode } from './markdown.ts';
import type { GateFailure } from './report.ts';

export type ClaudeSetupInspection = {
    problems: GateFailure[];
    /** Whether there was a `CLAUDE.md` to read, and how many skills. */
    read: { claudeMd: boolean; skills: number };
};

/** A standard section: its title, and the spellings close enough to mean it. */
type Standard = { title: string; exact: RegExp; nearMiss: RegExp };

type Heading = { title: string; line: number; bodyLines: string[] };

/** "Under 200 lines": past that, each line is followed less reliably. */
const MAX_LINES = 200;

/** The open-work notes are reviewed monthly; a date older than this was not. */
const MAX_OPEN_AGE_DAYS = 31;

const DAY_MS = 86_400_000;

const OPEN: Standard = {
    title: 'Open, as of YYYY-MM-DD',
    exact: /^Open, as of (.+)$/,
    nearMiss: /^open\b|\bcurrent state\b|\d{4}-\d{2}-\d{2}/i,
};

/** The sections in the order they come. `null` is the slot for the repo's own topic sections. */
const LAYOUT: (Standard | null)[] = [
    { title: 'Commands', exact: /^Commands$/, nearMiss: /\bcommands?\b/i },
    { title: 'Git', exact: /^Git$/, nearMiss: /\bgit\b/i },
    {
        title: "Things the code doesn't tell you",
        exact: /^Things the code doesn't tell you$/,
        nearMiss: /\bdoesn.t tell\b|\bcode (?:does not|won.t) tell\b/i,
    },
    null,
    {
        title: "Decided, don't reopen",
        exact: /^Decided, don't reopen$/,
        nearMiss: /\bdecided\b|\breopen\b|\bsettled\b/i,
    },
    OPEN,
];

const TOPIC_SLOT = LAYOUT.indexOf(null);

const ORDER_WHY = `The sections come in one order in every repo, so a reader knows where to look: ${LAYOUT.map((slot) => (slot === null ? "the repo's own topic sections" : `\`## ${slot.title}\``)).join(', ')}. Each one is optional, and a standard one appears once.`;

/** A template line left unfilled: `<One paragraph: …>`, `<e.g. "…">`. An autolink has no space in it. */
const PLACEHOLDER = /<[A-Za-z][^<>]*\s[^<>]*>/g;

/** An `@` import Claude Code follows: a relative, home or absolute path, or a file name with an extension. */
const IMPORT = /(?:^|\s)@(\S+)/g;

/** @returns What is wrong with the local Claude Code setup under `root`, judged on `today`. */
export function inspectClaudeSetup(root: string, today: Date): ClaudeSetupInspection {
    const problems: GateFailure[] = [];

    if (fs.existsSync(path.join(root, 'CLAUDE.local.md'))) {
        problems.push({
            file: 'CLAUDE.local.md',
            what: 'a second file of instructions for this repo',
            why: 'Claude Code adds CLAUDE.local.md to CLAUDE.md, so a rule could live in either, and two copies of a rule drift apart. Move its lines into CLAUDE.md and delete it.',
        });
    }

    const claudeMd = path.join(root, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudeMd);
    if (hasClaudeMd) {
        problems.push(...listClaudeMdProblems(fs.readFileSync(claudeMd, 'utf8'), root, today));
    }

    const skills = listSkillFolders(root);
    for (const skill of skills) {
        problems.push(...listSkillProblems(root, skill));
    }

    return { problems, read: { claudeMd: hasClaudeMd, skills: skills.length } };
}

function listClaudeMdProblems(source: string, root: string, today: Date): GateFailure[] {
    const problems: GateFailure[] = [];
    const fail = (line: number | null, what: string, why: string): void => {
        problems.push({ file: line === null ? 'CLAUDE.md' : `CLAUDE.md:${line}`, what, why });
    };

    const lines = source.replace(/\n$/, '').split('\n');
    const prose = stripMarkdownCode(source).split('\n');

    if (lines.length >= MAX_LINES) {
        fail(
            null,
            `${lines.length} lines, at or over the ${MAX_LINES}-line budget`,
            'Claude Code loads the whole file into every session, and the longer it is, the less reliably each line is followed. Move what holds in every repo to your user-level CLAUDE.md, and delete what the code already says.',
        );
    }

    if (!/^# \S/.test(lines[0] ?? '')) {
        fail(
            1,
            'the file does not open with a `# <project name>` title',
            'The first line names the project, and the paragraph under it says what it is, its stack and its state.',
        );
    }

    const titles = prose.flatMap((line, i) => (line.startsWith('# ') && i > 0 ? [i + 1] : []));
    for (const line of titles) {
        fail(
            line,
            'a second `#` title',
            'The file has one title, the project name. A section under it is a `##` heading.',
        );
    }

    const headings = listSections(lines, prose);
    const intro = lines.slice(1, headings[0] === undefined ? lines.length : headings[0].line - 1);
    if (!intro.some((line) => line.trim() !== '' && !line.startsWith('#'))) {
        fail(
            1,
            'no paragraph under the title',
            'One paragraph under the title says what the project is, its stack and its state, so a session starts knowing what it is working on.',
        );
    }

    let reached = 0;
    let reachedTitle = '';
    const seen = new Set<string>();
    for (const heading of headings) {
        const slot = slotOf(heading.title);
        if (slot.misspelled !== null) {
            fail(
                heading.line,
                `\`## ${heading.title}\` looks like \`## ${slot.misspelled}\`, spelled differently`,
                'Each standard section has one spelling, so the same note has the same title in every repo. Rename it, or, if it is a topic of its own, give it a title that does not borrow a standard one.',
            );
        } else if (slot.standard !== null && seen.has(slot.standard)) {
            fail(heading.line, `a second \`## ${heading.title}\``, `Merge it into the first one. ${ORDER_WHY}`);
        }
        if (slot.standard !== null) {
            seen.add(slot.standard);
        }

        if (slot.index < reached) {
            fail(heading.line, `\`## ${heading.title}\` comes after \`## ${reachedTitle}\``, ORDER_WHY);
        } else {
            reached = slot.index;
            reachedTitle = heading.title;
        }

        if (heading.bodyLines.every((line) => line.trim() === '')) {
            fail(
                heading.line,
                `\`## ${heading.title}\` is empty`,
                'A heading with nothing under it costs a line in every session and says nothing. Delete it until something real goes in it.',
            );
        }

        const date = OPEN.exact.exec(heading.title)?.[1];
        if (date !== undefined) {
            const problem = openDateProblem(date, today);
            if (problem !== null) {
                fail(
                    heading.line,
                    problem,
                    `The date says when the open lines were last checked. Once a month, delete the lines that are done and set the date to that day; a date over ${MAX_OPEN_AGE_DAYS} days old means nobody has.`,
                );
            }
        }
    }

    problems.push(...listPlaceholderProblems('CLAUDE.md', prose.join('\n')));

    prose.forEach((line, i) => {
        for (const match of line.matchAll(IMPORT)) {
            const target = (match[1] ?? '').replace(/[.,;:!?)\]]+$/, '');
            if (!/^(?:\.{1,2}\/|~\/|\/)|\.[A-Za-z0-9]+$/.test(target)) continue;
            const resolved = target.startsWith('~/')
                ? path.join(os.homedir(), target.slice(2))
                : path.resolve(root, target);
            if (fs.existsSync(resolved)) continue;
            fail(
                i + 1,
                `\`@${target}\` imports a file that does not exist`,
                'Claude Code reads `@path` as an import and skips one it cannot find without saying so, so the instructions it was meant to load are missing. Fix the path, or put the text in backticks if it is not an import.',
            );
        }
    });

    return problems;
}

/** The `##` headings, each with the lines under it. Headings inside fenced code are not headings. */
function listSections(lines: string[], prose: string[]): Heading[] {
    const starts = prose.flatMap((line, i) => (/^##? /.test(line) && i > 0 ? [i] : []));
    return starts
        .filter((start) => prose[start]?.startsWith('## ') === true)
        .map((start) => {
            const next = starts.find((other) => other > start) ?? lines.length;
            return {
                title: (lines[start] ?? '').replace(/^##\s+/, '').trim(),
                line: start + 1,
                bodyLines: lines.slice(start + 1, next),
            };
        });
}

/** Where a heading sits in the layout, which standard section it is, and which one it looks like but is not. */
function slotOf(title: string): { index: number; standard: string | null; misspelled: string | null } {
    for (const [index, slot] of LAYOUT.entries()) {
        if (slot?.exact.test(title) === true) return { index, standard: slot.title, misspelled: null };
    }
    for (const [index, slot] of LAYOUT.entries()) {
        if (slot?.nearMiss.test(title) === true) return { index, standard: null, misspelled: slot.title };
    }
    return { index: TOPIC_SLOT, standard: null, misspelled: null };
}

/** @returns What is wrong with an `Open, as of` date on `today`, or null when it is fine. */
function openDateProblem(date: string, today: Date): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date} is not a date`;
    const [year, month, day] = date.split('-').map(Number);
    const at = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
    // Date.UTC rolls 2026-02-30 over to March, so a date that comes back different was not on the calendar.
    if (at.toISOString().slice(0, 10) !== date) return `${date} is not a date`;

    const days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - at.getTime()) / DAY_MS);
    if (days < 0) return `${date} is in the future`;
    if (days > MAX_OPEN_AGE_DAYS) return `the open work was last checked ${days} days ago, on ${date}`;
    return null;
}

/** The folders under `.claude/skills/`, each one a skill. */
function listSkillFolders(root: string): string[] {
    const dir = path.join(root, '.claude', 'skills');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function listSkillProblems(root: string, skill: string): GateFailure[] {
    const rel = `.claude/skills/${skill}/SKILL.md`;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
        return [
            {
                file: `.claude/skills/${skill}`,
                what: 'a skill folder with no SKILL.md',
                why: 'Claude Code loads a skill from its SKILL.md, so a folder without one is never offered. Add it, or delete the folder.',
            },
        ];
    }

    const source = fs.readFileSync(abs, 'utf8');
    // `argument-hint` shows what to type after the command, and `<…>` is how that is written.
    const prose = stripMarkdownCode(source).replace(/^argument-hint:.*$/m, (line) => ' '.repeat(line.length));
    const problems = listPlaceholderProblems(rel, prose);
    const header = frontmatter(source);
    if (header === null) {
        problems.push({
            file: rel,
            what: 'no `---` header with `name` and `description`, or one that is not valid YAML',
            why: 'Claude reads the description to decide when the skill applies, and the name is what you type after `/`.',
        });
        return problems;
    }

    if (header['name'] !== skill) {
        problems.push({
            file: rel,
            what: `\`name\` is ${typeof header['name'] === 'string' ? `\`${header['name']}\`` : 'missing'}, not the folder's name, \`${skill}\``,
            why: 'The name is what you type after `/`. When it matches the folder, the command and the file it runs have one name.',
        });
    }
    if (typeof header['description'] !== 'string' || header['description'].trim() === '') {
        problems.push({
            file: rel,
            what: 'no `description`',
            why: 'Claude reads the description to decide when the skill applies. Without one, it only runs when you type its name.',
        });
    }
    return problems;
}

/** The YAML between a file's opening `---` lines, or null when there is none or it does not parse to an object. */
function frontmatter(source: string): Record<string, unknown> | null {
    const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)?.[1];
    if (block === undefined) return null;
    try {
        const parsed: unknown = YAML.parse(block);
        return isRecord(parsed) ? parsed : null;
    } catch {
        // A header that does not parse is reported as missing, with the same fix.
        return null;
    }
}

function listPlaceholderProblems(file: string, prose: string): GateFailure[] {
    return [...prose.matchAll(PLACEHOLDER)].map((match) => {
        const line = prose.slice(0, match.index).split('\n').length;
        return {
            file: `${file}:${line}`,
            what: `an unfilled template line: ${match[0].replace(/\s+/g, ' ').slice(0, 60)}`,
            why: 'A placeholder tells Claude nothing and reads as an instruction. Write the real line, or delete it.',
        };
    });
}
