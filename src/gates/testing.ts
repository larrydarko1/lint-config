/**
 * Testing standards gate — the mechanically checkable half of the testing standard.
 *
 * WHY ONE GATE. The two families look further apart here than anywhere else: one
 * keeps suites co-located in `__tests__/` and runs Playwright out of `e2e/`, the
 * other mirrors `src/` under `tests/` and has deliberately NO E2E suite at all. But
 * read the rules rather than the values and they are the same three sentences:
 * "every suite is where this project said suites go", "a `.spec` file belongs to the
 * E2E runner, so it lives where E2E lives — which may be nowhere", and "the numbers
 * that define failure only move one way". The pattern is DATA. `layout` says which
 * pattern was picked, `e2e` says where E2E lives or that it does not exist, and the
 * rule underneath is one rule in both.
 *
 * THE TWO ONE-FAMILY RULE SETS ARE BOTH FREE. Suite hygiene (`.only`, `.skip`, bare
 * `test()`, a commented-out case, two cases with the same title in one `describe`)
 * came from the desktop copies and finds nothing in either full-stack repo — 464
 * suites between them, clean. The transport-patching rule came from the full-stack
 * copies and finds nothing in the desktop three. Neither needed a switch, and each
 * now covers a family that had never checked for it.
 *
 * THE `vm` RATCHET IS SCOPED TO NOTHING IN PARTICULAR ON PURPOSE. The full-stack
 * copies only scanned `frontend/`, which was an assumption about where components
 * live rather than a rule. Scanning every suite gives the same answer in all five
 * repos today (zero) and keeps giving the right one if a component test ever lands
 * somewhere else.
 *
 * TWO IMPROVEMENTS TAKEN FROM ONE COPY EACH, because they are fixes rather than
 * preferences: a Playwright config is demanded only once a spec exists (Mosaic) —
 * a gate that fails for something nobody has written teaches people to switch gates
 * off; and `git ls-files` output is filtered through `existsSync` (Quartz), because
 * `--cached` still lists a file whose deletion has not been committed, and reading
 * one crashes the gate on a tree that is merely mid-refactor.
 *
 * WHAT IS DELIBERATELY NOT CHECKED:
 *   - Whether a test is any good. The 0% rule catches a file with no test at all;
 *     nothing here tells a thorough suite from one that executes every line and
 *     asserts almost nothing.
 *   - Whether a test has an assertion. A call that feeds a value into an `expect`
 *     built three lines earlier is indistinguishable from one that does nothing
 *     without running the suite.
 *   - The priority order (security → utilities → services → composables →
 *     components). It describes what to write NEXT, which is a property of a
 *     backlog, not of the tree.
 *
 * ONE SECTION IS CONDITIONAL and says so in the output rather than passing quietly:
 * the 0% rule needs `coverage/coverage-summary.json`, which only exists after a
 * `--coverage` run. CI orders this gate after one; locally the summary names what it
 * skipped, so a green tick never overstates itself.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';

/** Where this project put its suites. The pattern is data; the rule is the same either way. */
export type TestLayout =
    | { kind: 'colocated' }
    | {
          kind: 'mirrored';
          /** The tree the suites live in, e.g. `tests`. */
          root: string;
          /** The `src/` directories it mirrors one-for-one. Omit to allow any. */
          areas?: string[];
      };

/** Where the E2E suite lives, or `false` where there deliberately is none. */
export type E2eLayout = false | { dir: string; config: string };

export type CoverageThresholds = {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
};

export type DomEnvironment = {
    /** The environment the standard names, e.g. `jsdom`. */
    name: string;
    /** The config that sets it. */
    config: string;
    /** A named Vitest project inside that config, where the config has more than one. */
    project?: string;
};

export type TestingOptions = {
    root?: string;
    /** The config holding the coverage thresholds and excludes. */
    config: string;
    layout: TestLayout;
    e2e?: E2eLayout;
    /** The floors as they stand. They may rise, never fall. */
    thresholds?: CoverageThresholds;
    /** Every path the coverage config may exclude, mapped to why it is not a coverage gap. */
    excludes?: Record<string, string>;
    coverageSummary?: string;
    domEnvironment?: DomEnvironment;
    /** Sites reading a component through `wrapper.vm`, as a ratchet. Raise it with a reason. */
    vmBaseline?: number;
    /** The document to point at on failure. */
    standard?: string;
};

export type TestingInput = Omit<TestingOptions, 'standard'> & { root: string };

export type TestingProblem = {
    file: string;
    what: string;
    why: string;
};

export type TestingInspection = {
    problems: TestingProblem[];
    /** `.test.ts` files found. */
    suites: number;
    /** `.spec.ts` / `.spec.js` files found. */
    specs: number;
    /** Files in the coverage report, when one was present. */
    measured: number;
    /** Files in it with no covered statement at all. */
    uncovered: number;
    haveCoverage: boolean;
};

export type HygieneRule = {
    re: RegExp;
    what: string;
    why: string;
};

/** The ways a suite goes wrong while every run stays green, so none of them announce themselves. */
export const HYGIENE: HygieneRule[] = [
    {
        re: /^\s*(?:describe|it|test)\.only\b/,
        what: 'a parked `.only`',
        why: 'A stray `.only` silently disables every other test in its file. The run stays green and the count drops by an amount nobody investigates.',
    },
    {
        re: /^\s*(?:describe|it|test)\.skip\b/,
        what: 'a parked `.skip`',
        why: 'A skipped test is a deferred fix living in the code. Fix it or delete it — parking it keeps the suite green about something that is not.',
    },
    {
        re: /^\s*test(?:\.\w+)?\s*\(/,
        what: 'a bare `test()`',
        why: '`describe` for grouping, `it` for cases. One vocabulary per suite, so a reader scanning for cases finds all of them.',
    },
    {
        re: /^\s*\/\/\s*(?:describe|it|test)(?:\.\w+)?\s*\(/,
        what: 'a commented-out test',
        why: 'Deleting a test is fine; leaving it as a comment is a deletion without the honesty. Git remembers it either way.',
    },
];

const PATCHED_TRANSPORT =
    /vi\.mock\(\s*['"](?:axios|node-fetch|cross-fetch)['"]|(?:global|globalThis)\.fetch\s*=|stubGlobal\(\s*['"]fetch['"]/;

const VM_ACCESS = /\.vm\.[a-zA-Z_][a-zA-Z0-9_]*/;

/** Every tracked or untracked-but-not-ignored file that still exists on disk. */
export function repoFiles(root: string): string[] {
    return (
        execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: root,
            encoding: 'utf8',
        })
            .split('\n')
            .filter(Boolean)
            // `--cached` still lists a file whose deletion has not been committed yet.
            // Reading one would crash this gate on a tree that is merely mid-refactor.
            .filter((rel) => fs.existsSync(path.join(root, rel)))
    );
}

/**
 * Duplicate case titles, scoped to the enclosing `describe` — the same title in two
 * different blocks reads fine and is everywhere in these suites; the same title
 * twice in ONE block is a copy-paste that lost its edit. `it.each` titles are
 * skipped: their `%s` placeholders expand per case at run time.
 */
export function duplicateTitles(source: string): { title: string; count: number }[] {
    const stack = [];
    const seen = new Map();
    let depth = 0;

    for (const line of source.split('\n')) {
        const opened = /^\s*describe(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);
        const cased = /^\s*it\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);

        if (opened !== null) {
            stack.push({ title: opened[2] ?? '', depth });
        } else if (cased !== null) {
            const key = [...stack.map((s) => s.title), cased[2] ?? ''].join(' › ');
            seen.set(key, (seen.get(key) ?? 0) + 1);
        }

        for (const ch of line) {
            if (ch === '{' || ch === '(') depth++;
            else if (ch === '}' || ch === ')') depth--;
        }
        while (stack.length > 0 && depth <= (stack.at(-1)?.depth ?? -Infinity)) stack.pop();
    }

    return [...seen].filter(([, count]) => count > 1).map(([title, count]) => ({ title, count }));
}

/**
 * Every problem in one repository's suites, without printing anything.
 */
export function inspectTesting(input: TestingInput): TestingInspection {
    const {
        root,
        config,
        layout,
        e2e = false,
        thresholds = { statements: 80, branches: 80, functions: 80, lines: 80 },
        excludes = {},
        coverageSummary = 'coverage/coverage-summary.json',
        domEnvironment,
        vmBaseline = 0,
    } = input;

    const problems: TestingProblem[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));

    const files = repoFiles(root);
    const unitTests = files.filter((rel) => /\.test\.ts$/.test(rel));
    const specs = files.filter((rel) => /\.spec\.[tj]s$/.test(rel));

    // ── 1. Placement: whichever pattern this project picked ─────────────────
    const half =
        'The standard allows either pattern but not both: half a convention is worse than either half, because now nobody knows where to look for a file that might not exist.';

    for (const rel of unitTests) {
        const colocated = rel.includes('/__tests__/') || rel.startsWith('__tests__/');
        if (layout.kind === 'colocated') {
            if (!colocated) {
                fail(
                    rel,
                    'a .test.ts outside a `__tests__/` directory',
                    `This project uses the co-located \`__tests__/\` pattern — all ${unitTests.length - 1} other suites are in one. ${half}`,
                );
            }
            continue;
        }
        if (colocated) {
            fail(
                rel,
                'a co-located `__tests__/` suite',
                `This project mirrors \`src/\` under \`${layout.root}/\` instead. ${half}`,
            );
            continue;
        }
        if (!rel.startsWith(`${layout.root}/`)) {
            fail(
                rel,
                `a .test.ts outside \`${layout.root}/\``,
                `Vitest is configured with \`include: ['${layout.root}/**/*.test.ts']\` — a suite anywhere else is discovered by no runner. It stops running while still looking like a test, which is the worst of both.`,
            );
            continue;
        }
        const area = rel.split('/')[1] ?? '';
        if (layout.areas !== undefined && !layout.areas.includes(area)) {
            fail(
                rel,
                `sits under \`${layout.root}/${area}/\`, which mirrors no \`src/\` directory`,
                `\`${layout.root}/\` mirrors \`src/\` one-for-one (${layout.areas.join(', ')}). A tree that only half-mirrors is one you have to search rather than navigate — if this really is a new area, add it to \`layout.areas\` in this gate along with the \`src/\` directory it mirrors.`,
            );
        }
    }

    // ── 2. A `.spec` file belongs to the E2E runner ─────────────────────────
    for (const rel of specs) {
        if (e2e === false) {
            fail(
                rel,
                'a .spec file',
                'Every test file ends in `.test.ts`. Vitest matches that suffix and nothing else, so a `.spec` file is run by nothing at all while still reading as a test — rename it.',
            );
        } else if (!rel.startsWith(`${e2e.dir}/`)) {
            fail(
                rel,
                `a .spec file outside \`${e2e.dir}/\``,
                `Playwright specs live in \`${e2e.dir}/\`. Anywhere else, no runner picks the file up: Vitest matches \`*.test.ts\`, Playwright only looks under its own testDir — so the suite silently stops running while still looking like a test.`,
            );
        }
    }

    // ── 3. E2E lives where this project said, which may be nowhere ──────────
    if (e2e === false) {
        for (const rel of files.filter((f) => /^e2e\//.test(f) || /^playwright\.config\./.test(f))) {
            fail(
                rel,
                'an E2E suite appearing without discussion',
                'There is deliberately no E2E suite here. The standard asks that adding one back be raised first — so raise it, then turn `e2e` on in this gate along with the paragraph in the contributing guide.',
            );
        }
        const manifest = JSON.parse(read('package.json'));
        for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
            if (/^(@playwright\/|playwright)/.test(dep)) {
                fail(
                    'package.json',
                    `\`${dep}\` is installed`,
                    'The same decision arriving through the manifest instead of a config file. An E2E dependency nothing runs is a CI install cost and an unread intent.',
                );
            }
        }
        // Demanded by the specs, not unconditionally: a config demanded for tests nobody
        // has written is noise, and noise is what teaches people to switch a gate off.
    } else if (specs.length > 0 && !exists(e2e.config)) {
        fail(
            e2e.config,
            'missing',
            'E2E tests get their own Playwright config, separate from the Vitest projects. Without it the specs under `e2e/` are run by nothing.',
        );
    }

    // ── 4. The coverage config, ratcheted ───────────────────────────────────
    const configSrc = read(config);
    const thresholdBlock = /thresholds:\s*\{([^}]*)\}/.exec(configSrc);
    if (thresholdBlock === null) {
        fail(
            config,
            'no `thresholds` block found in the coverage config',
            'Either it was removed — in which case coverage no longer fails anything — or it was reshaped and this gate can no longer read it. Both need a human.',
        );
    } else {
        for (const [metric, floor] of Object.entries(thresholds)) {
            const found = new RegExp(`${metric}:\\s*(\\d+)`).exec(thresholdBlock[1] ?? '');
            if (found === null) {
                fail(
                    config,
                    `no \`${metric}\` threshold`,
                    'All four metrics carry a floor; branches is the honest one.',
                );
            } else if (Number(found[1]) < floor) {
                fail(
                    config,
                    `\`${metric}\` threshold lowered to ${found[1]} (floor is ${floor})`,
                    'Coverage ratchets one way. Lowering the number does not fix the gap, it deletes the record of it — write the test, then raise `thresholds` in this gate to match.',
                );
            }
        }
    }

    const excludeBlock = /exclude:\s*\[([\s\S]*?)\]/.exec(configSrc);
    const allowed = Object.keys(excludes);
    if (excludeBlock === null) {
        fail(config, 'no coverage `exclude` list found', 'This gate can no longer tell whether the list has grown.');
    } else {
        const listed = [...(excludeBlock[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
        for (const entry of listed) {
            if (!allowed.includes(entry)) {
                fail(
                    config,
                    `new coverage exclude \`${entry}\``,
                    'A file at 0% is the signal to write the missing test, not to add another exclude. If this one genuinely has no testable runtime, add it to `excludes` in this gate with the reason — one sentence, written once, instead of a list nobody reviews.',
                );
            }
        }
        for (const entry of allowed) {
            if (!listed.includes(entry)) {
                fail(
                    config,
                    `\`${entry}\` is no longer excluded from coverage`,
                    'Good news, probably — remove it from `excludes` in this gate so the two lists stay in step.',
                );
            }
        }
    }

    // ── 5. Nothing at 0% (needs a coverage report) ──────────────────────────
    let measured = 0;
    let uncovered = 0;
    const haveCoverage = exists(coverageSummary);

    if (haveCoverage) {
        // Vitest's coverage-summary.json: one entry per file, plus a `total`.
        const summary: Record<string, { statements: { total: number; covered: number } }> = JSON.parse(
            read(coverageSummary),
        );
        for (const [key, entry] of Object.entries(summary)) {
            if (key === 'total') continue;
            // A key from another root stays as it is: a path printed as `../../x` tells
            // a reader less than the absolute one it was rewritten from.
            const rel = key.startsWith(root) ? path.relative(root, key) : key;
            measured++;
            if (entry.statements.total === 0) continue;
            if (entry.statements.covered === 0) {
                uncovered++;
                fail(
                    rel,
                    `0% of ${entry.statements.total} statement(s) covered — no test imports this file`,
                    'The aggregate hides this: one untested module inside a passing total is a rounding error. Write the suite, or if the file genuinely has no testable runtime, say so in `excludes` rather than leaving it at zero.',
                );
            }
        }
    }

    // ── 6. Suite hygiene, and 7. the transport ──────────────────────────────
    const vmHits: string[] = [];
    for (const rel of unitTests) {
        const source = read(rel);

        if (PATCHED_TRANSPORT.test(source)) {
            fail(
                rel,
                'patches axios or fetch directly',
                "Mock at the boundary the code talks to — the network, with MSW — not the transport it happens to use today. MSW is the standard's choice precisely so a test survives the client swapping axios for fetch or gaining an interceptor.",
            );
        }

        source.split('\n').forEach((line, i) => {
            for (const { re, what, why } of HYGIENE) {
                if (re.test(line)) fail(`${rel}:${i + 1}`, what, why);
            }
            if (VM_ACCESS.test(line)) vmHits.push(`${rel}:${i + 1}`);
        });

        for (const { title, count } of duplicateTitles(source)) {
            fail(
                rel,
                `${count} cases titled \`${title}\` in the same describe`,
                "A copy-paste that lost its edit: both run, neither fails, and the second one's intent is gone. Give it the title it was meant to have, or delete it if it duplicates the first.",
            );
        }
    }

    // ── 8. Reaching into component internals, ratcheted ─────────────────────
    if (vmHits.length > vmBaseline) {
        for (const site of vmHits.slice(vmBaseline)) {
            fail(
                site,
                "reads a component's internals through `wrapper.vm`",
                'Assert what the component DOES — what renders, what event fires, what the user sees. A test bound to internal state breaks on every refactor without catching a single real bug. If this case genuinely warrants it, raise `vmBaseline` in this gate with the reason.',
            );
        }
    } else if (vmHits.length < vmBaseline) {
        fail(
            config,
            `\`vmBaseline\` is ${vmBaseline} but only ${plural(vmHits.length, 'site')} remain`,
            'Lower it so the ratchet cannot slip back.',
        );
    }

    // ── 9. The DOM environment named by the standard ────────────────────────
    if (domEnvironment !== undefined) {
        const { name, config: envConfig, project } = domEnvironment;
        const envSrc = read(envConfig);
        // A named project's environment sits inside its own block; a single-project
        // config has exactly one, so the same read works with no project named.
        const found =
            project === undefined
                ? /environment:\s*'([\w-]+)'/.exec(envSrc)
                : new RegExp(`name:\\s*'${project}',[\\s\\S]{0,200}?environment:\\s*'([\\w-]+)'`).exec(envSrc);
        const where = project === undefined ? 'tests' : `${project} tests`;
        if (found === null) {
            fail(
                envConfig,
                `could not read the ${where} \`environment\``,
                'This gate can no longer tell which DOM implementation the suite runs on.',
            );
        } else if (found[1] !== name) {
            fail(
                envConfig,
                `${where} run on \`${found[1]}\`, but the standard names \`${name}\``,
                'Switch it back, or change the standard and `domEnvironment` here together. They are one decision — when they disagree, the config wins silently for as long as nobody reads both files on the same day.',
            );
        }

        for (const rel of unitTests) {
            const pragma = /@vitest-environment\s+([\w-]+)/.exec(read(rel));
            if (pragma !== null && pragma[1] !== name) {
                fail(
                    rel,
                    `pins itself to \`${pragma[1]}\` with an @vitest-environment pragma`,
                    `The project config chooses the environment for every suite. A pragma that disagrees with it is a per-file override nobody reading ${envConfig} would ever see.`,
                );
            }
        }
    }

    return { problems, suites: unitTests.length, specs: specs.length, measured, uncovered, haveCoverage };
}

export function checkTesting(options: TestingOptions): void {
    const { root = REPO_ROOT, standard, ...rest } = options;

    const report = createGateReport({ name: 'Testing', standard });
    const { problems, suites, specs, measured, uncovered, haveCoverage } = inspectTesting({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const { layout, e2e = false, thresholds, excludes = {}, domEnvironment } = rest;
    const placement =
        layout.kind === 'colocated'
            ? 'all co-located in `__tests__/`'
            : `all under \`${layout.root}/\` mirroring \`src/\``;
    const e2eSummary =
        e2e === false
            ? 'no E2E reintroduced'
            : specs === 0
              ? 'no Playwright spec yet'
              : `${plural(specs, 'Playwright spec')} under \`${e2e.dir}/\` with their own config`;

    report.done({
        summary:
            `${plural(suites, 'unit suite')} ${placement}, ${e2eSummary}, coverage thresholds at or above the ` +
            `${thresholds?.statements ?? 80}% floor, ${plural(Object.keys(excludes).length, 'coverage exclude')} all ` +
            'accounted for, no transport patched around the network mock, no `.only`/`.skip`/bare `test()`/' +
            'commented-out or duplicate cases, no test reading component internals' +
            `${domEnvironment === undefined ? '' : `, all on ${domEnvironment.name}`}.` +
            (haveCoverage
                ? `\n  Coverage report: ${plural(measured, 'file')} measured, ${uncovered} with no test at all.`
                : '\n  Coverage report: not present — the 0%-file check was SKIPPED. Run the coverage script first to include it.'),
        notMachineChecked:
            'whether a passing test asserts anything worth asserting, whether the next test to write is the ' +
            'highest-priority one, whether a component test would survive a refactor.',
    });
}
