/**
 * The mechanically checkable half of the testing standard:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Suites sit where `layout` says (co-located `__tests__/` or a mirrored tree), or
 *      where `otherRunners` names the runner that finds them.
 *   2. A `.spec` file belongs to the E2E runner.
 *   3. E2E lives where `e2e` says, or nowhere; a Playwright config only once a spec exists.
 *   4. Coverage thresholds only rise; every exclude has a reason.
 *   5. No file at 0% (needs `coverage/coverage-summary.json`; skipped and said so without it).
 *   6. Suite hygiene: no `.only`/`.skip`, no commented-out cases, no duplicate titles.
 *   7. No transport patching, and (with `apiClient`) no suite replacing an
 *      export every API request goes through.
 *   8. `wrapper.vm` reads, as a ratchet.
 *   9. The DOM environment the standard names.
 *  10. The E2E run fails on a server error (opt-in: `serverErrors`): the fixtures
 *      record every 5xx with the API's log, the teardown reads the log for every
 *      error, the config wires both, and every spec takes `test` from the fixtures.
 * Not checked: test quality, assertion presence, what to write next.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    e2eSummary,
    inspectE2eLayout,
    inspectServerErrors,
    type E2eLayout,
    type ServerErrorWiring,
} from './lib/e2e.ts';
import { repoFiles } from './lib/files.ts';
import { recordAt, toRecord } from './lib/json.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, plural, type GateFailure } from './lib/report.ts';
import { callSites, splitTopLevel } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

export type TestingOptions = {
    root?: string;
    /** The config holding the coverage thresholds and excludes. */
    config: string;
    layout: TestLayout;
    /**
     * Suites another runner runs, glob → which runner and why: content the project ships
     * and runs itself, such as the tests each exercise in a course comes with. They are
     * held to suite hygiene, not to `layout`, and a glob that matches no suite fails.
     */
    otherRunners?: Record<string, string>;
    e2e?: E2eLayout;
    /** The floors as they stand. They may rise, never fall. */
    thresholds?: CoverageThresholds;
    /** Every path the coverage config may exclude, mapped to why it is not a coverage gap. */
    excludes?: Record<string, string>;
    coverageSummary?: string;
    domEnvironment?: DomEnvironment;
    /** Sites reading a component through `wrapper.vm`, as a ratchet. Raise it with a reason. */
    vmBaseline?: number;
    /** The E2E server-error tripwire (rule 10; needs `e2e`). A repo that states none is not graded on it. */
    serverErrors?: ServerErrorWiring;
    /**
     * The API client module as a suite imports it, and the exports every request
     * goes through on its way to the mock server — the typed caller and the HTTP
     * instance under it (rule 7). The mock server checks each exchange against
     * the API contract, so a suite that replaces either checks nothing.
     */
    apiClient?: { module: string; exports: string[] };
};

/** Where this project put its suites. The pattern is data; the rule is the same either way. */
type TestLayout =
    | { kind: 'colocated' }
    | {
          kind: 'mirrored';
          /** The tree the suites live in, e.g. `tests`. */
          root: string;
          /** The `src/` directories it mirrors one-for-one. Omit to allow any. */
          areas?: string[];
      };

type CoverageThresholds = {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
};

type DomEnvironment = {
    /** The environment the standard names, e.g. `jsdom`. */
    name: string;
    /** The config that sets it. */
    config: string;
    /** A named Vitest project inside that config, where the config has more than one. */
    project?: string;
};

type TestingInput = TestingOptions & { root: string };

type TestingInspection = {
    problems: GateFailure[];
    /** `.test.ts` files found where `layout` puts them. */
    suites: number;
    /** `.test.ts` files `otherRunners` names. */
    otherSuites: number;
    /** `.spec.ts` / `.spec.js` files found. */
    specs: number;
    /** Files in the coverage report, when one was present. */
    measured: number;
    /** Files in it with no covered statement at all. */
    uncovered: number;
    haveCoverage: boolean;
};

type HygieneRule = {
    re: RegExp;
    what: string;
    why: string;
};

/** The ways a suite goes wrong while every run stays green, so none of them announce themselves. */
const HYGIENE: HygieneRule[] = [
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

/**
 * Where a suite replaces one of `client.exports`: a `vi.mock`/`vi.doMock` of the
 * module with no factory (which replaces every export) or with one that hands
 * back a property of that name, or a `vi.spyOn` on it. Replacing the module's
 * other exports, around the real request path, is fine.
 */
export function replacedClient(
    source: string,
    client: { module: string; exports: string[] },
): { line: number; name: string }[] {
    const module = client.module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
    const found: { line: number; name: string }[] = [];
    const mocks = [...callSites(source, 'vi.mock('), ...callSites(source, 'vi.doMock(')];
    for (const site of mocks) {
        const [target = '', factory = ''] = splitTopLevel(site.args, ',').map((arg) => arg.trim());
        if (!new RegExp(`^['"\`]${module}['"\`]$`).test(target)) continue;
        for (const name of client.exports) {
            // No factory automocks every export; otherwise `name: …`, or the shorthand `{ name }` / `{ …, name }`.
            const own = new RegExp(`(?:^|[^\\w$.])${name}\\s*(?::|,|\\})`);
            if (factory === '' || own.test(factory)) {
                found.push({ line: lineOf(site.index), name });
            }
        }
    }
    for (const site of callSites(source, 'vi.spyOn(')) {
        const [, method = ''] = splitTopLevel(site.args, ',').map((arg) => arg.trim());
        const name = client.exports.find((candidate) => new RegExp(`^['"\`]${candidate}['"\`]$`).test(method));
        if (name !== undefined) {
            found.push({ line: lineOf(site.index), name });
        }
    }
    return found.sort((a, b) => a.line - b.line);
}

/** Duplicate case titles within one `describe`. `it.each` titles are skipped (they expand at run time). */
export function duplicateTitles(source: string): { title: string; count: number }[] {
    const stack = [];
    const seen = new Map<string, number>();
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
            if (ch === '{' || ch === '(') {
                depth++;
            } else if (ch === '}' || ch === ')') {
                depth--;
            }
        }
        while (stack.length > 0 && depth <= (stack.at(-1)?.depth ?? -Infinity)) {
            stack.pop();
        }
    }

    return [...seen].filter(([, count]) => count > 1).map(([title, count]) => ({ title, count }));
}

/** Every problem in one repository's suites, without printing anything. */
export function inspectTesting(input: TestingInput): TestingInspection {
    const {
        root,
        config,
        layout,
        otherRunners = {},
        e2e = false,
        thresholds = { statements: 80, branches: 80, functions: 80, lines: 80 },
        excludes = {},
        coverageSummary = 'coverage/coverage-summary.json',
        domEnvironment,
        vmBaseline = 0,
        serverErrors,
        apiClient,
    } = input;

    const { problems, fail } = collectFailures();
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));

    const files = repoFiles(root);
    const unitTests = files.filter((rel) => rel.endsWith('.test.ts'));
    const specs = files.filter((rel) => /\.spec\.[tj]s$/.test(rel));
    const runElsewhere = (rel: string): boolean =>
        Object.keys(otherRunners).some((glob) => path.matchesGlob(rel, glob));
    const placed = unitTests.filter((rel) => !runElsewhere(rel));

    // ── 1. Placement: whichever pattern this project picked ─────────────────
    const half =
        'The standard allows either pattern but not both: half a convention is worse than either half, because now nobody knows where to look for a file that might not exist.';

    for (const glob of Object.keys(otherRunners)) {
        if (!unitTests.some((rel) => path.matchesGlob(rel, glob))) {
            fail(
                glob,
                '`otherRunners` names it, but it matches no suite',
                'An entry that matches nothing exempts nothing today and whatever lands there tomorrow. Remove it from `otherRunners` in this gate.',
            );
        }
    }
    for (const rel of placed) {
        const colocated = rel.includes('/__tests__/') || rel.startsWith('__tests__/');
        if (layout.kind === 'colocated') {
            if (!colocated) {
                fail(
                    rel,
                    'a .test.ts outside a `__tests__/` directory',
                    `This project uses the co-located \`__tests__/\` pattern — all ${placed.length - 1} other suites are in one. ${half}`,
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
        const [area = '', ...below] = rel.slice(layout.root.length + 1).split('/');
        if (layout.areas !== undefined && below.length === 0) {
            // A suite at the top of the tree mirrors a file at the top of src/: tests/App.test.ts ↔ src/App.vue.
            const stem = area.replace(/\.test\.ts$/, '');
            if (!['.ts', '.vue'].some((ext) => exists(`src/${stem}${ext}`))) {
                fail(
                    rel,
                    `sits at the top of \`${layout.root}/\`, but \`src/\` has no \`${stem}.ts\` or \`${stem}.vue\``,
                    `A suite directly in \`${layout.root}/\` mirrors a file directly in \`src/\`. With nothing there to mirror, the suite belongs in the area of the code it tests.`,
                );
            }
            continue;
        }
        if (layout.areas !== undefined && !layout.areas.includes(area)) {
            fail(
                rel,
                `sits under \`${layout.root}/${area}/\`, which mirrors no \`src/\` directory`,
                `\`${layout.root}/\` mirrors \`src/\` one-for-one (${layout.areas.join(', ')}). A tree that only half-mirrors is one you have to search rather than navigate — if this really is a new area, add it to \`layout.areas\` in this gate along with the \`src/\` directory it mirrors.`,
            );
        }
    }

    // ── 2 and 3. Where E2E lives, which may be nowhere ──────────────────────
    inspectE2eLayout(e2e, { files, specs }, { read, exists, fail });

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
        for (const [key, entry] of Object.entries(toRecord(JSON.parse(read(coverageSummary))))) {
            const { total, covered } = recordAt(entry, 'statements');
            if (key === 'total' || typeof total !== 'number' || typeof covered !== 'number') continue;
            // A key outside the root stays absolute.
            const rel = key.startsWith(root) ? path.relative(root, key) : key;
            measured++;
            if (total === 0) continue;
            if (covered === 0) {
                uncovered++;
                // A component's statements are its render function: importing it covers none of them.
                const component = rel.endsWith('.vue');
                fail(
                    rel,
                    `0% of ${total} statement(s) covered — ${component ? 'no test renders this component' : 'no test imports this file'}`,
                    component
                        ? 'Being imported by a tested parent is not enough: a shallow mount, a stub or a `v-if` the tests never take all leave it unrendered. Mount it in a test of its own — a folder of icons can share one that mounts each — or if it genuinely has no testable runtime, say so in `excludes` rather than leaving it at zero.'
                        : 'The aggregate hides this: one untested module inside a passing total is a rounding error. Write the suite, or if the file genuinely has no testable runtime, say so in `excludes` rather than leaving it at zero.',
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

        if (apiClient !== undefined) {
            for (const { line, name } of replacedClient(stripComments(source), apiClient)) {
                fail(
                    `${rel}:${line}`,
                    `replaces \`${name}\` from ${apiClient.module}`,
                    `Every request goes through \`${name}\` to the mock server, which checks each exchange against the API contract. A stand-in answers whatever the test hands it — a login missing half its fields passes as one — so the code under test is never held to the API it will meet. Answer the route on the mock server instead.`,
                );
            }
        }

        source.split('\n').forEach((line, i) => {
            for (const { re, what, why } of HYGIENE) {
                if (re.test(line)) {
                    fail(`${rel}:${i + 1}`, what, why);
                }
            }
            if (VM_ACCESS.test(line)) {
                vmHits.push(`${rel}:${i + 1}`);
            }
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
        // Works for a named project's block and for a single-project config alike.
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

    // ── 10. A server error fails the E2E run ────────────────────────────────
    if (serverErrors !== undefined) {
        inspectServerErrors(serverErrors, e2e, specs, { read, exists, fail });
    }

    return {
        problems,
        suites: placed.length,
        otherSuites: unitTests.length - placed.length,
        specs: specs.length,
        measured,
        uncovered,
        haveCoverage,
    };
}

export function checkTesting(options: TestingOptions): void {
    const { root = REPO_ROOT, ...rest } = options;

    const report = createGateReport({ name: 'Testing' });
    const { problems, suites, otherSuites, specs, measured, uncovered, haveCoverage } = inspectTesting({
        root,
        ...rest,
    });
    for (const { file, what, why } of problems) {
        report.fail(file, what, why);
    }

    const { layout, e2e = false, thresholds, excludes = {}, domEnvironment, serverErrors, apiClient } = rest;
    const placement =
        layout.kind === 'colocated'
            ? 'all co-located in `__tests__/`'
            : `all under \`${layout.root}/\` mirroring \`src/\``;
    const elsewhere = otherSuites === 0 ? '' : ` (and ${plural(otherSuites, 'suite')} another runner runs)`;
    report.done({
        summary:
            `${plural(suites, 'unit suite')} ${placement}${elsewhere}, ${e2eSummary(e2e, specs)}, coverage thresholds at or above the ` +
            `${thresholds?.statements ?? 80}% floor, ${plural(Object.keys(excludes).length, 'coverage exclude')} all ` +
            `accounted for, no transport patched around the network mock, no \`.only\`/\`.skip\`/bare \`test()\`/` +
            `commented-out or duplicate cases, no test reading component internals${
                domEnvironment === undefined ? '' : `, all on ${domEnvironment.name}`
            }${
                apiClient === undefined
                    ? ''
                    : `, no suite replacing the API client's ${apiClient.exports.map((name) => `\`${name}\``).join('/')}`
            }${serverErrors === undefined ? '' : ', every spec held to the server-error tripwire'}.${
                haveCoverage
                    ? `\n  Coverage report: ${plural(measured, 'file')} measured, ${uncovered} at 0%.`
                    : '\n  Coverage report: not present — the 0%-file check was SKIPPED. Run the coverage script first to include it.'
            }`,
        notMachineChecked:
            'whether a passing test asserts anything worth asserting, whether the next test to write is the ' +
            'highest-priority one, whether a component test would survive a refactor.',
    });
}
