/**
 * The changelog gate, against fixture repositories holding only a changelog. Each
 * failing case breaks one thing in an otherwise valid file, so a pass on it proves the
 * rule, not a neighbour.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkChangelog, inspectChangelog } from '../src/gates/changelog.ts';

const INTRO = [
    '# Changelog',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
    '',
];

const VALID = [
    ...INTRO,
    '## [Unreleased]',
    '',
    '## [2.0.0] - 2026-03-10',
    '',
    '### Upgrading',
    '',
    '## [2.0.0-beta.1] - 2026-02-01',
    '',
    '## [1.0.0] - 2026-01-05',
    '',
];

/** A repository root holding `files`, removed after the test. */
const project = (t, files) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-changelog-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(root, rel), body);
    return root;
};

const changelog = (t, lines) => inspectChangelog({ root: project(t, { 'CHANGELOG.md': lines.join('\n') }) });

const whats = (result) => result.problems.map((problem) => problem.what);

/** Runs `fn` with console captured and the exit code restored afterwards. */
const capture = (fn) => {
    const out = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...args) => out.push(args.join(' '));
    console.error = (...args) => out.push(args.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), failed: process.exitCode === 1 };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

test('a Keep a Changelog file passes, pre-releases included, and its releases are counted', (t) => {
    assert.deepEqual(changelog(t, VALID), { problems: [], releases: 3 });
});

test('a dated version (CalVer) is a version', (t) => {
    const result = changelog(t, [...INTRO, '## [Unreleased]', '', '## [2026.10.2] - 2026-10-20', '']);
    assert.deepEqual(result, { problems: [], releases: 1 });
});

test('an empty [Unreleased] at the top is all a new project needs', (t) => {
    assert.deepEqual(changelog(t, [...INTRO, '## [Unreleased]', '']), { problems: [], releases: 0 });
});

test('no changelog fails, and says what to write', (t) => {
    const result = inspectChangelog({ root: project(t, { 'README.md': '# A project\n' }) });
    assert.equal(result.releases, null);
    assert.deepEqual(
        result.problems.map(({ file, what }) => [file, what]),
        [['CHANGELOG.md', 'no changelog at the repo root']],
    );
    assert.match(result.problems[0].why, /## \[Unreleased\]/);
});

test('a changelog under another name is told to move, not that there is none', (t) => {
    for (const name of ['changelog.md', 'CHANGES.md', 'HISTORY.md']) {
        const result = inspectChangelog({ root: project(t, { [name]: VALID.join('\n') }) });
        assert.deepEqual(whats(result), [`the changelog is named ${name}`], name);
        assert.equal(result.problems[0].file, name);
    }
});

test('the title is `# Changelog`', (t) => {
    const result = changelog(t, ['# Release notes', ...VALID.slice(1)]);
    assert.deepEqual(whats(result), ['does not open with `# Changelog`']);
    assert.equal(result.problems[0].file, 'CHANGELOG.md:1');
});

test('the intro names the format with a link to keepachangelog.com', (t) => {
    const unnamed = changelog(t, ['# Changelog', '', 'Everything that changed.', '', ...VALID.slice(INTRO.length)]);
    assert.deepEqual(whats(unnamed), ['the intro does not name the format']);

    // Below the first section, the link no longer tells a reader what they are reading.
    const late = changelog(t, ['# Changelog', '', '## [Unreleased]', '', INTRO[2], '']);
    assert.deepEqual(whats(late), ['the intro does not name the format']);
});

test('[Unreleased] comes first, and only once', (t) => {
    const missing = changelog(t, [...INTRO, '## [1.0.0] - 2026-01-05', '']);
    assert.deepEqual(whats(missing), ['the first section is `## [1.0.0] - 2026-01-05`, not `## [Unreleased]`']);
    assert.equal(missing.releases, 1, 'the release under it is still read');

    const below = changelog(t, [...INTRO, '## [1.0.0] - 2026-01-05', '', '## [Unreleased]', '']);
    assert.deepEqual(whats(below), [
        'the first section is `## [1.0.0] - 2026-01-05`, not `## [Unreleased]`',
        'a second `## [Unreleased]`',
    ]);

    const twice = changelog(t, [...VALID, '## [Unreleased]', '']);
    assert.deepEqual(whats(twice), ['a second `## [Unreleased]`']);
    assert.equal(twice.problems[0].file, `CHANGELOG.md:${VALID.length + 1}`);

    assert.deepEqual(whats(changelog(t, INTRO)), ['the first section is missing, not `## [Unreleased]`']);
});

test('every later section is `## [version] - YYYY-MM-DD`', (t) => {
    for (const heading of [
        '## [v1.0.0] - 2026-01-05',
        '## 1.0.0 - 2026-01-05',
        '## [1.0.0]',
        '## [1.0.0] 2026-01-05',
        '## [1.0.0] - 5 January 2026',
        '## Older releases',
    ]) {
        const result = changelog(t, [...INTRO, '## [Unreleased]', '', heading, '']);
        assert.deepEqual(whats(result), [`\`${heading}\` is not \`## [version] - YYYY-MM-DD\``], heading);
        assert.equal(result.releases, 0, heading);
    }
});

test('a release date is a real day, not after today', (t) => {
    const impossible = changelog(t, [...INTRO, '## [Unreleased]', '', '## [1.0.0] - 2026-02-30', '']);
    assert.deepEqual(whats(impossible), ['2026-02-30 is not a real date']);

    const ahead = changelog(t, [...INTRO, '## [Unreleased]', '', '## [1.0.0] - 2999-01-01', '']);
    assert.deepEqual(whats(ahead), ['1.0.0 is dated 2999-01-01, after today']);

    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(whats(changelog(t, [...INTRO, '## [Unreleased]', '', `## [1.0.0] - ${today}`, ''])), []);
});

test('one heading per version', (t) => {
    const result = changelog(t, [...VALID, '## [1.0.0] - 2026-01-05', '']);
    assert.deepEqual(whats(result), ['1.0.0 has a second heading']);
});

test('releases are newest first; two on one day keep their order', (t) => {
    const result = changelog(t, [
        ...INTRO,
        '## [Unreleased]',
        '',
        '## [1.0.0] - 2026-01-05',
        '',
        '## [1.1.0] - 2026-02-01',
        '',
    ]);
    assert.deepEqual(whats(result), ['1.1.0 (2026-02-01) comes after a release dated 2026-01-05']);

    const sameDay = changelog(t, [
        ...INTRO,
        '## [Unreleased]',
        '',
        '## [1.0.1] - 2026-01-05',
        '',
        '## [1.0.0] - 2026-01-05',
        '',
    ]);
    assert.deepEqual(whats(sameDay), []);
});

test('a heading inside a fenced code block is quoted, not a section', (t) => {
    const result = changelog(t, [
        ...INTRO,
        '## [Unreleased]',
        '',
        '```md',
        '## Not a release',
        '```',
        '',
        '## [1.0.0] - 2026-01-05',
        '',
    ]);
    assert.deepEqual(result, { problems: [], releases: 1 });
});

test('checkChangelog reports each problem and fails the run', (t) => {
    const root = project(t, { 'CHANGELOG.md': [...INTRO, '## [1.0.0]', ''].join('\n') });
    const failed = capture(() => checkChangelog({ root }));
    assert.equal(failed.failed, true);
    assert.match(failed.out, /not `## \[Unreleased\]`/);
    assert.match(failed.out, /is not `## \[version\] - YYYY-MM-DD`/);

    const passed = capture(() => checkChangelog({ root: project(t, { 'CHANGELOG.md': VALID.join('\n') }) }));
    assert.equal(passed.failed, false);
    assert.match(passed.out, /Changelog OK — CHANGELOG\.md opens with \[Unreleased\], then 3 releases, newest first/);
});
