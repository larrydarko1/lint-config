/**
 * The repo's CHANGELOG.md, in the Keep a Changelog shape: `# Changelog`, an intro that
 * names the format and the version scheme, `## [Unreleased]` first, then one
 * `## [version] - YYYY-MM-DD` per release, newest first, each version in the project's
 * scheme. What is in each release is for a reader to judge; the shape is what lets a bump
 * move `[Unreleased]` under a new heading without anyone re-reading it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { stripMarkdownCode } from './lib/markdown.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, plural, type GateFailure } from './lib/report.ts';
import { CALVER_VERSION, SCHEMES, SEMVER_VERSION, type Versioning } from './lib/versioning.ts';

export type ChangelogOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /** How releases are numbered. `larry check` gives the family's, or the one a base project names. */
    versioning: Versioning;
};

type ChangelogInspection = {
    problems: GateFailure[];
    /** The release headings read, or null when there was no changelog to read. */
    releases: number | null;
};

type Heading = { text: string; line: number };

const FILE = 'CHANGELOG.md';

/** Other names a changelog goes by, in any casing, so one under the wrong name is told to move. */
const NEAR_NAMES = /^(?:change[-_ ]?log|changes|history|releases)(?:\.md)?$/i;

const UNRELEASED = '## [Unreleased]';

/** A version starts with a digit (`1.4.2`, `2026.10.2`, `0.1.0-beta.3`), so `v1.0.0` fails. */
const RELEASE = /^## \[(\d[0-9A-Za-z.+-]*)\] - (\d{4})-(\d{2})-(\d{2})$/;

const FORMAT_LINK = '](https://keepachangelog.com/';

export function inspectChangelog(options: ChangelogOptions): ChangelogInspection {
    const { root = REPO_ROOT, versioning } = options;
    const scheme = SCHEMES[versioning];
    const { problems, fail } = collectFailures();

    const names = fs.readdirSync(root);
    if (!names.includes(FILE)) {
        const near = names.find((name) => NEAR_NAMES.test(name));
        fail(
            near ?? FILE,
            near === undefined ? 'no changelog at the repo root' : `the changelog is named ${near}`,
            near === undefined
                ? 'Someone upgrading needs to know what changed and what to do about it, and the commit log answers neither. Add a CHANGELOG.md: `# Changelog`, an intro linking https://keepachangelog.com/en/1.1.0/, then `## [Unreleased]`, where each change is written down as it lands.'
                : `Tools and readers look for ${FILE}, in capitals, at the root. Rename it with \`git mv\`.`,
        );
        return { problems, releases: null };
    }

    const lines = stripMarkdownCode(fs.readFileSync(path.join(root, FILE), 'utf8')).split('\n');
    const at = (line: number): string => `${FILE}:${line}`;

    const titleIndex = lines.findIndex((line) => line.trim() !== '');
    if (titleIndex === -1 || lines[titleIndex]?.trim() !== '# Changelog') {
        fail(
            at(titleIndex + 1),
            'does not open with `# Changelog`',
            'The title says what the file is in every repo, so the first line is `# Changelog`, on its own.',
        );
    }

    const headings: Heading[] = lines.flatMap((text, i) =>
        text.startsWith('## ') ? [{ text: text.trimEnd(), line: i + 1 }] : [],
    );
    const introEnd = headings[0] === undefined ? lines.length : headings[0].line - 1;
    const intro = lines.slice(0, introEnd);
    if (!intro.some((line) => line.includes(FORMAT_LINK))) {
        fail(
            FILE,
            'the intro does not name the format',
            'A reader meets `[Unreleased]` and Added/Changed/Fixed without being told what they mean. Say above the first section that the format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
        );
    }
    if (!intro.some((line) => line.includes(scheme.link))) {
        const other = Object.values(SCHEMES).find((s) => s !== scheme && intro.some((line) => line.includes(s.link)));
        fail(
            FILE,
            other === undefined
                ? 'the intro does not name the version scheme'
                : `the intro names ${other.name}, but this project's releases are numbered by ${scheme.name}`,
            `A reader needs to know what a number promises before they upgrade to it. Say beside the format that versions follow [${scheme.name}](${scheme.url}).`,
        );
    }

    const [first, ...rest] = headings;
    if (first?.text !== UNRELEASED) {
        fail(
            at(first?.line ?? lines.length),
            `the first section is ${first === undefined ? 'missing' : `\`${first.text}\``}, not \`${UNRELEASED}\``,
            'Changes are written down under `[Unreleased]` as they land, and a bump moves them under the new version. Without it at the top, an entry has nowhere to go until release day, when nobody remembers it.',
        );
    }

    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set<string>();
    let newer: string | null = null;
    let releases = 0;

    for (const heading of first?.text === UNRELEASED ? rest : headings) {
        if (heading.text === UNRELEASED) {
            fail(
                at(heading.line),
                `a second \`${UNRELEASED}\``,
                'There is one list of what has not shipped yet, at the top. Merge the two.',
            );
            continue;
        }
        const match = RELEASE.exec(heading.text);
        if (match === null) {
            fail(
                at(heading.line),
                `\`${heading.text}\` is not \`## [version] - YYYY-MM-DD\``,
                'Every section after `[Unreleased]` is one release: its version in brackets, without a `v`, then ` - ` and the day it shipped. A heading of another shape reads as a release to a person and as nothing to a tool.',
            );
            continue;
        }
        releases += 1;
        const [, version = '', year = '', month = '', day = ''] = match;
        const date = `${year}-${month}-${day}`;

        if (!isCalendarDate(Number(year), Number(month), Number(day))) {
            fail(at(heading.line), `${date} is not a real date`, 'Write the day the release shipped.');
        } else if (date > today) {
            fail(
                at(heading.line),
                `${version} is dated ${date}, after today`,
                'A heading is written when the release ships, so its date is the day it did, never one ahead.',
            );
        }
        const misnumbered = numberingProblem(versioning, version, { year, month, date });
        if (misnumbered !== null) fail(at(heading.line), ...misnumbered);
        if (seen.has(version)) {
            fail(
                at(heading.line),
                `${version} has a second heading`,
                'One release, one section. Merge the entries into the first one.',
            );
        }
        seen.add(version);
        if (newer !== null && date > newer) {
            fail(
                at(heading.line),
                `${version} (${date}) comes after a release dated ${newer}`,
                'Releases are listed newest first, so the top of the file is what changed most recently. Move this section up.',
            );
        }
        newer = date;
    }

    return { problems, releases };
}

export function checkChangelog(options: ChangelogOptions): void {
    const report = createGateReport({ name: 'Changelog' });
    const { problems, releases } = inspectChangelog(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `Changelog OK — ${FILE} opens with [Unreleased], then ${plural(releases ?? 0, 'release')}, newest first, each with its date and numbered by ${SCHEMES[options.versioning].name}.`,
        notMachineChecked:
            'whether every notable change has an entry, whether an entry says what changed for the reader rather than what the commit did, and whether a release that breaks something says how to upgrade.',
    });
}

/**
 * What is wrong with a release's number under the project's scheme, as `[what, why]`, or null.
 * A calendar version names the month it shipped, so it has to agree with the heading's date.
 */
function numberingProblem(
    versioning: Versioning,
    version: string,
    shipped: { year: string; month: string; date: string },
): [string, string] | null {
    const { name, shape } = SCHEMES[versioning];
    if (versioning === 'semver') {
        if (SEMVER_VERSION.test(version)) return null;
        return [`${version} is not a semantic version`, `This project's releases are numbered by ${name}: ${shape}.`];
    }
    const match = CALVER_VERSION.exec(version);
    if (match === null) {
        return [`${version} is not a calendar version`, `This project's releases are numbered by ${name}: ${shape}.`];
    }
    const { year, month, date } = shipped;
    if (match[1] === year && Number(match[2]) === Number(month)) return null;
    return [
        `${version} is dated ${date}`,
        `A calendar version is the year and month its release shipped, so one dated ${date} is ${year}.${Number(month)}.PATCH. Correct whichever of the two is wrong.`,
    ];
}

function isCalendarDate(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
