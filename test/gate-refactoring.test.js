/**
 * The refactoring gate, against real fixture repositories.
 * - It has to be a real repository: the gate's file list comes from
 * `git ls-files --cached --others --exclude-standard`, and that choice is the point
 * of one of the tests below — a marker in a file added but not yet committed must be
 * caught before the commit, not after.
 * - The case-sensitivity tests are the ones worth reading. Four of the five projects
 * matched the shouted form only and one matched case-insensitively; three of them
 * ship Spanish or Portuguese locale strings containing the ordinary word `todo`, so
 * the insensitive match is the one that cannot be satisfied without breaking a
 * translation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkRefactoring } from '../src/gates/refactoring.ts';

/** Runs `fn` with console captured and the exit code restored afterwards. */
const capture = (fn) => {
    const out = [];
    const err = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), err: err.join('\n'), failed: process.exitCode === 1 };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

/** A committed repository holding `files`; anything in `extra` is left uncommitted. */
const project = (t, files, extra = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-refactor-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const put = (rel, body) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
    };
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

    for (const [rel, body] of Object.entries(files)) put(rel, body);

    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    git('add', '-A');
    git('commit', '-qm', 'fixture');

    for (const [rel, body] of Object.entries(extra)) put(rel, body);

    return root;
};

const run = (t, files, options = {}, extra = {}) => {
    const root = project(t, files, extra);
    return capture(() => checkRefactoring({ root, ...options }));
};

// ── The baseline ─────────────────────────────────────────────────────────────

test('a repo with no markers passes and says what it covered', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n', 'deploy.yml': 'name: deploy\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /no deferral markers in 2 unlinted files/);
});

// ── 1. Markers where ESLint has no parser ────────────────────────────────────

test('a marker in a file ESLint cannot parse fails, with its line and its text', (t) => {
    const result = run(t, { 'styles/_layout.scss': '// header\n// TODO: split this file\n.a { color: red; }\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /styles\/_layout\.scss:2/);
    assert.match(result.err, /`TODO` marker — \/\/ TODO: split this file/);
});

test('every marker in the list is matched', (t) => {
    for (const marker of ['TODO', 'FIXME', 'FIX ME', 'HACK', 'XXX', 'TBD', 'WIP']) {
        const result = run(t, { 'notes.yml': `# ${marker} something\n` });
        assert.equal(result.failed, true, marker);
    }
});

test('a marker inside a longer word is not a marker', (t) => {
    const result = run(t, { 'art.txt': 'XXXXXXXXXX\nHACKING is fine\nTODOS\n' });
    assert.equal(result.failed, false);
});

test('a file ESLint already lints is left alone, so one marker is not reported twice', (t) => {
    const result = run(t, { 'src/main.ts': '// TODO: later\n' });
    assert.equal(result.failed, false);
});

test('with `linted: []` — a project with no ESLint — the same file IS read', (t) => {
    const result = run(t, { 'src/main.ts': '// TODO: later\n' }, { linted: [] });
    assert.equal(result.failed, true);
});

test('a file added but not yet committed is checked, which is the point of --others', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n' }, {}, { 'new.scss': '// FIXME: unfinished\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /new\.scss:1/);
});

test('build output and vendored code are not read', (t) => {
    const result = run(t, {
        'README.md': '# Fixture\n',
        'dist/bundle.css': '/* TODO */\n',
        'out/app.yml': '# TODO\n',
        'coverage/report.html': '<!-- TODO -->\n',
        'node_modules/dep/readme.md': 'TODO\n',
    });
    assert.equal(result.failed, false);
});

test('package-lock.json is never read, whatever a dependency called itself', (t) => {
    const result = run(t, { 'package-lock.json': '{ "name": "TODO" }\n' });
    assert.equal(result.failed, false);
});

test('extra skipped basenames are honoured', (t) => {
    const files = { 'scripts/generated.yml': '# TODO: regenerate\n' };
    assert.equal(run(t, files).failed, true);
    assert.equal(run(t, files, { skip: ['generated.yml'] }).failed, false);
});

// ── Case sensitivity ─────────────────────────────────────────────────────────

test('a lowercase `todo` in a locale file is Spanish, not a marker', (t) => {
    const result = run(t, {
        'locales/es.json': '{\n    "reset": "¿Desea reiniciar todo su portafolio?",\n    "copy": "Copiar Todo"\n}\n',
    });
    assert.equal(result.failed, false);
});

test('the shouted form in that same file still fails', (t) => {
    const result = run(t, {
        'locales/es.json': '{\n    "_note": "TODO translate this",\n    "copy": "Copiar Todo"\n}\n',
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /locales\/es\.json:2/);
});

// ── Markdown ─────────────────────────────────────────────────────────────────

test('a backticked marker in prose is named, not used', (t) => {
    const result = run(t, { 'CONTRIBUTING.md': 'Commits can be messy — `WIP`, fixups. See `notes/TODO.md`.\n' });
    assert.equal(result.failed, false);
});

test('a marker in a fenced block is documentation of the rule, not a breach of it', (t) => {
    const result = run(t, { 'docs/gates.md': 'The gate bans these:\n\n```\n// TODO: later\n```\n\nThat is all.\n' });
    assert.equal(result.failed, false);
});

test('stripping a fenced block keeps the line numbers of everything after it', (t) => {
    const result = run(t, { 'docs/gates.md': '# Gates\n\n```\nTODO\nTODO\n```\n\nTBD: write the rest\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /docs\/gates\.md:8/);
});

test('a marker in ordinary markdown prose still fails', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n\nTBD: describe the worker.\n' });
    assert.equal(result.failed, true);
});

// ── SFC templates ────────────────────────────────────────────────────────────

const SFC = `<template>
    <!-- TODO: extract this row -->
    <div class="row" />
</template>

<script setup lang="ts">
const a = 1;
</script>
`;

test("an SFC template is read, because ESLint's no-warning-comments never sees it", (t) => {
    const result = run(t, { 'src/Card.vue': SFC });
    assert.equal(result.failed, true);
    assert.match(result.err, /src\/Card\.vue:2/);
});

test('the SFC script half is left to ESLint, so the two halves are covered once each', (t) => {
    const result = run(t, {
        'src/Card.vue': '<template>\n    <div />\n</template>\n\n<script setup lang="ts">\n// TODO: later\n</script>\n',
    });
    assert.equal(result.failed, false);
});

test('an SFC with no template block is skipped rather than read whole', (t) => {
    const result = run(t, { 'src/thing.vue': '<script setup lang="ts">\n// TODO: later\n</script>\n' });
    assert.equal(result.failed, false);
});

test('a nested <template> inside the block does not end it early', (t) => {
    const source = `<template>
    <Modal>
        <template #body>
            <p>hi</p>
        </template>
    </Modal>
    <!-- HACK: remove once the API returns it -->
</template>
`;
    const result = run(t, { 'src/Card.vue': source });
    assert.equal(result.failed, true);
    assert.match(result.err, /src\/Card\.vue:7/);
});

test('with `.vue` absent from `linted`, the whole SFC is read instead', (t) => {
    const result = run(t, { 'src/Card.vue': SFC }, { linted: ['.ts', '.js'] });
    assert.equal(result.failed, true);
    assert.match(result.out + result.err, /src\/Card\.vue:2/);
});

test('SFC template blocks are counted separately in the summary', (t) => {
    const result = run(t, { 'src/Card.vue': '<template>\n    <div />\n</template>\n', 'README.md': '# Fixture\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /1 unlinted file or 1 SFC <template> block/);
});

// ── No tracker file in the repo ──────────────────────────────────────────────

test('a committed todo.md fails once, as a file, not once per marker in it', (t) => {
    const result = run(t, { 'todo.md': '- [ ] TODO: finish the worker\n- [ ] FIXME the cache\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /todo\.md/);
    assert.match(result.err, /deferred-work list committed to the repo/);
    assert.doesNotMatch(result.err, /marker —/);
});

test('a todo.md fails in any casing and at any depth', (t) => {
    const result = run(t, { 'docs/TODO.md': '- finish the worker\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /docs\/TODO\.md/);
});

test('a new todo.md fails before its first commit', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n' }, {}, { 'todo.md': '- finish the worker\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /todo\.md/);
});

test('a gitignored todo.md is local, so it passes', (t) => {
    const result = run(t, { '.gitignore': 'todo.md\n' }, {}, { 'todo.md': '- [ ] TODO: finish the worker\n' });
    assert.equal(result.failed, false);
    assert.match(result.out, /no todo\.md and no Claude Code config in the repo/);
});

// ── No Claude Code config in the repo ────────────────────────────────────────

test('a committed CLAUDE.md fails, and says how to untrack it without deleting it', (t) => {
    const result = run(t, { 'CLAUDE.md': '# Fixture\n\n- TODO: note for later\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /CLAUDE\.md/);
    assert.match(result.err, /Claude Code config committed to the repo/);
    assert.match(result.err, /git rm --cached/);
    assert.doesNotMatch(result.err, /marker —/);
});

test('CLAUDE.local.md and a CLAUDE.md in a subfolder fail too', (t) => {
    const result = run(t, { 'CLAUDE.local.md': '- local\n', 'packages/api/CLAUDE.md': '# Api\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /CLAUDE\.local\.md/);
    assert.match(result.err, /packages\/api\/CLAUDE\.md/);
});

test('anything under .claude/ fails, at any depth', (t) => {
    const result = run(t, {
        '.claude/settings.json': '{}\n',
        'web/.claude/skills/deploy/SKILL.md': '# Deploy\n',
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /\.claude\/settings\.json/);
    assert.match(result.err, /web\/\.claude\/skills\/deploy\/SKILL\.md/);
});

test('a new CLAUDE.md fails before its first commit', (t) => {
    const result = run(t, { 'README.md': '# Fixture\n' }, {}, { 'CLAUDE.md': '# Fixture\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /CLAUDE\.md/);
});

test('Claude Code config kept out of git passes, by .gitignore or .git/info/exclude', (t) => {
    const ignored = run(
        t,
        { '.gitignore': 'CLAUDE.md\n.claude/\n' },
        {},
        { 'CLAUDE.md': '# Fixture\n', '.claude/settings.json': '{}\n' },
    );
    assert.equal(ignored.failed, false);

    const excluded = run(
        t,
        { 'README.md': '# Fixture\n' },
        {},
        { '.git/info/exclude': 'CLAUDE.local.md\n', 'CLAUDE.local.md': '- local\n' },
    );
    assert.equal(excluded.failed, false);
});

test('only the names Claude Code loads are refused, not files that mention Claude', (t) => {
    const result = run(t, { 'docs/claude-code.md': '# Using Claude Code\n', 'claude/notes.md': '# Notes\n' });
    assert.equal(result.failed, false);
});

// ── The local Claude Code setup, for a project that opts in ──────────────────

/** A date `days` before today, as the gate reads it. */
const daysAgo = (days) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const INTRO = '# Fixture\n\nA fixture project, for the gate tests.\n';

/** A CLAUDE.md with these `[heading, body]` sections under the title. */
const claudeMd = (sections, intro = INTRO) =>
    `${intro}${sections.map(([heading, body = '- A real line.']) => `\n## ${heading}\n\n${body}\n`).join('')}`;

const LOCAL = { '.gitignore': 'CLAUDE.md\nCLAUDE.local.md\n.claude/\n' };

/** The setup in `local` sits beside a repo that ignores it, and the gate is opted in. */
const runLocal = (t, local) => run(t, LOCAL, { claudeCode: true }, local);

const FULL_LAYOUT = [
    ['Commands'],
    ['Git'],
    ["Things the code doesn't tell you"],
    ['Charting'],
    ['Releases'],
    ["Decided, don't reopen"],
    [`Open, as of ${daysAgo(3)}`],
];

const SKILL =
    '---\nname: deploy\ndescription: Ships the site. Use when asked to deploy.\nargument-hint: <target, e.g. "staging">\n---\n\n1. Run the build.\n';

test('every section, in order, with topic sections in their slot, passes and says so', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd(FULL_LAYOUT), '.claude/skills/deploy/SKILL.md': SKILL });
    assert.equal(result.failed, false, result.err);
    assert.match(result.out, /The local CLAUDE\.md follows the layout; 1 skill checked\./);
});

test('every section is optional', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': INTRO });
    assert.equal(result.failed, false, result.err);
});

test('the layout is not checked unless the project opts in', (t) => {
    const result = run(t, LOCAL, {}, { 'CLAUDE.md': claudeMd([["Decided, don't reopen"], ['Git']]) });
    assert.equal(result.failed, false);
    assert.doesNotMatch(result.out, /layout/);
});

test('with no local CLAUDE.md, as in CI, it passes and says nothing was read', (t) => {
    const result = runLocal(t, {});
    assert.equal(result.failed, false);
    assert.match(result.out, /No local CLAUDE\.md here to check \(it never reaches CI\)\./);
});

test('a standard section out of order fails, naming the one it follows', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd([["Decided, don't reopen"], ['Git']]) });
    assert.equal(result.failed, true);
    assert.match(result.err, /`## Git` comes after `## Decided, don't reopen`/);
});

test('a topic section before "Things the code doesn\'t tell you" fails', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd([['Naming'], ["Things the code doesn't tell you"]]) });
    assert.equal(result.failed, true);
    assert.match(result.err, /`## Things the code doesn't tell you` comes after `## Naming`/);
});

test('a topic section after "Decided, don\'t reopen" fails', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd([["Decided, don't reopen"], ['Consumer gotchas']]) });
    assert.equal(result.failed, true);
    assert.match(result.err, /`## Consumer gotchas` comes after `## Decided, don't reopen`/);
});

test('a standard section spelled another way fails, naming the spelling', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([
            ["Product decisions (settled, don't reopen)"],
            [`Current state (${daysAgo(1)})`],
            ['Open'],
            ['Git hooks'],
        ]),
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /`## Product decisions \(settled, don't reopen\)` looks like `## Decided, don't reopen`/);
    assert.match(result.err, /`## Current state \([\d-]+\)` looks like `## Open, as of YYYY-MM-DD`/);
    assert.match(result.err, /`## Open` looks like `## Open, as of YYYY-MM-DD`/);
    assert.match(result.err, /`## Git hooks` looks like `## Git`/);
});

test('a curly apostrophe is a different spelling', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd([['Decided, don’t reopen']]) });
    assert.equal(result.failed, true);
    assert.match(result.err, /looks like `## Decided, don't reopen`/);
});

test('a standard section twice fails', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([[`Open, as of ${daysAgo(9)}`], [`Open, as of ${daysAgo(1)}`]]),
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /a second `## Open, as of/);
});

test('open work dated over 31 days ago fails; 31 days passes', (t) => {
    const stale = runLocal(t, { 'CLAUDE.md': claudeMd([[`Open, as of ${daysAgo(32)}`]]) });
    assert.equal(stale.failed, true);
    assert.match(stale.err, /last checked 32 days ago/);

    const monthly = runLocal(t, { 'CLAUDE.md': claudeMd([[`Open, as of ${daysAgo(31)}`]]) });
    assert.equal(monthly.failed, false, monthly.err);
});

test('an open-work date in the future or not on the calendar fails', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([["Decided, don't reopen"], [`Open, as of ${daysAgo(-2)}`]]),
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /is in the future/);

    const impossible = runLocal(t, { 'CLAUDE.md': claudeMd([['Open, as of 2026-02-30']]) });
    assert.equal(impossible.failed, true);
    assert.match(impossible.err, /2026-02-30 is not a date/);

    const unfilled = runLocal(t, { 'CLAUDE.md': claudeMd([['Open, as of YYYY-MM-DD']]) });
    assert.equal(unfilled.failed, true);
    assert.match(unfilled.err, /YYYY-MM-DD is not a date/);
    assert.doesNotMatch(unfilled.err, /looks like/);
});

test('an empty section fails', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': claudeMd([['Commands', ''], ['Git']]) });
    assert.equal(result.failed, true);
    assert.match(result.err, /`## Commands` is empty/);
    assert.doesNotMatch(result.err, /`## Git` is empty/);
});

test('200 lines fails; 199 passes', (t) => {
    const body = (lines) => Array.from({ length: lines }, (_, i) => `- Line ${i}.`).join('\n');
    // The title, a blank, the intro, a blank, the heading, a blank: six lines before the body.
    const over = runLocal(t, { 'CLAUDE.md': claudeMd([['Commands', body(194)]]) });
    assert.equal(over.failed, true);
    assert.match(over.err, /200 lines, at or over the 200-line budget/);

    const under = runLocal(t, { 'CLAUDE.md': claudeMd([['Commands', body(193)]]) });
    assert.equal(under.failed, false, under.err);
});

test('a missing title, a missing paragraph and a second title each fail', (t) => {
    const untitled = runLocal(t, { 'CLAUDE.md': claudeMd([['Git']], 'A fixture project.\n') });
    assert.equal(untitled.failed, true);
    assert.match(untitled.err, /does not open with a `# <project name>` title/);

    const bare = runLocal(t, { 'CLAUDE.md': claudeMd([['Git']], '# Fixture\n') });
    assert.equal(bare.failed, true);
    assert.match(bare.err, /no paragraph under the title/);

    const twice = runLocal(t, { 'CLAUDE.md': `${INTRO}\n# Another\n\nText.\n` });
    assert.equal(twice.failed, true);
    assert.match(twice.err, /CLAUDE\.md:5[\s\S]*a second `#` title/);
});

test('an unfilled template line fails, also when it spans two lines', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([
            ['Commands', '- `npm run dev`: <what it starts>'],
            ["Things the code doesn't tell you", '<Only what Claude cannot learn,\none bullet each.>'],
        ]),
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /unfilled template line: <what it starts>/);
    assert.match(result.err, /unfilled template line: <Only what Claude cannot learn, one bullet each\.>/);
});

test('angle brackets in code, an autolink and a comparison are not placeholders', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([
            [
                'Commands',
                '- `git rm --cached <a path>` untracks it.\n- Docs: <https://example.test/docs>.\n- Pin below 6.1 (a < b, b > a).\n\n```sh\ncp <the template> ./CLAUDE.md\n```',
            ],
        ]),
    });
    assert.equal(result.failed, false, result.err);
});

test('a heading inside fenced code is not a section', (t) => {
    // Read as a section, this `## Git` would come after `## Decided, don't reopen`.
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([["Decided, don't reopen", '- A real line.\n\n```md\n## Git\n```']]),
    });
    assert.equal(result.failed, false, result.err);
});

test('an @ import of a missing file fails; an existing one, a package name and an email do not', (t) => {
    const result = runLocal(t, {
        'CLAUDE.md': claudeMd([
            [
                'Commands',
                '- See @docs/setup.md and @./docs/gone.md.\n- Uses @larrydarko/lint-config and @types/node.\n- Mail fixture@example.test.',
            ],
        ]),
        'docs/setup.md': '# Setup\n',
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /`@\.\/docs\/gone\.md` imports a file that does not exist/);
    assert.doesNotMatch(result.err, /setup\.md|lint-config|types\/node|example\.test/);
});

test('a CLAUDE.local.md fails when opted in', (t) => {
    const result = runLocal(t, { 'CLAUDE.md': INTRO, 'CLAUDE.local.md': '- local\n' });
    assert.equal(result.failed, true);
    assert.match(result.err, /CLAUDE\.local\.md[\s\S]*a second file of instructions/);
});

test('a skill needs a SKILL.md whose header names its folder and describes it', (t) => {
    const result = runLocal(t, {
        '.claude/skills/empty/notes.md': '# Notes\n',
        '.claude/skills/renamed/SKILL.md': SKILL,
        '.claude/skills/vague/SKILL.md': '---\nname: vague\n---\n\n1. Do it.\n',
        '.claude/skills/bare/SKILL.md': '1. Do it.\n',
        '.claude/skills/template/SKILL.md': '---\nname: template\ndescription: <What it does, in one sentence.>\n---\n',
    });
    assert.equal(result.failed, true);
    assert.match(result.err, /\.claude\/skills\/empty[\s\S]*a skill folder with no SKILL\.md/);
    assert.match(result.err, /`name` is `deploy`, not the folder's name, `renamed`/);
    assert.match(result.err, /\.claude\/skills\/vague\/SKILL\.md[\s\S]*no `description`/);
    assert.match(result.err, /\.claude\/skills\/bare\/SKILL\.md[\s\S]*no `---` header/);
    assert.match(result.err, /\.claude\/skills\/template\/SKILL\.md:3[\s\S]*unfilled template line/);
});

// ── Files that are not text ──────────────────────────────────────────────────

test('a binary file is not read as text', (t) => {
    const result = run(t, { 'assets/icon.png': 'TODO\n', 'assets/blob.bin': 'TODO\0TODO\n' });
    assert.equal(result.failed, false);
});
