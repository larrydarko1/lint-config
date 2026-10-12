/**
 * The mechanically checkable half of the testing standard:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Suites sit where `layout` says (co-located `__tests__/` or a mirrored tree).
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

import { repoFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { callArgs, callSites, splitTopLevel } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

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

/** Where the E2E tripwire for server errors is wired. */
type ServerErrorWiring = {
    /**
     * The fixtures module every spec imports `test` from. It must create the
     * recorder with the API's `logFile`, watch the browser context, and drain it.
     */
    fixtures: string;
    /** The Playwright global teardown. It must read the API's log with `logErrors`. */
    teardown: string;
};

/** Where the E2E suite lives, or `false` where there deliberately is none. */
type E2eLayout = false | { dir: string; config: string };

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

/** A named import from Playwright itself: `import { test, expect } from '@playwright/test'`. */
const PLAYWRIGHT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]/g;

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
    const lineOf = (index: number) => source.slice(0, index).split('\n').length;
    const found: { line: number; name: string }[] = [];
    const mocks = [...callSites(source, 'vi.mock('), ...callSites(source, 'vi.doMock(')];
    for (const site of mocks) {
        const [target = '', factory = ''] = splitTopLevel(site.args, ',').map((arg) => arg.trim());
        if (!new RegExp(`^['"\`]${module}['"\`]$`).test(target)) continue;
        for (const name of client.exports) {
            // No factory automocks every export; otherwise `name: …`, or the shorthand `{ name }` / `{ …, name }`.
            const own = new RegExp(`(?:^|[^\\w$.])${name}\\s*(?::|,|\\})`);
            if (factory === '' || own.test(factory)) found.push({ line: lineOf(site.index), name });
        }
    }
    for (const site of callSites(source, 'vi.spyOn(')) {
        const [, method = ''] = splitTopLevel(site.args, ',').map((arg) => arg.trim());
        const name = client.exports.find((candidate) => new RegExp(`^['"\`]${candidate}['"\`]$`).test(method));
        if (name !== undefined) found.push({ line: lineOf(site.index), name });
    }
    return found.sort((a, b) => a.line - b.line);
}

/** Duplicate case titles within one `describe`. `it.each` titles are skipped (they expand at run time). */
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

/** Every problem in one repository's suites, without printing anything. */
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
        serverErrors,
        apiClient,
    } = input;

    const problems: GateFailure[] = [];
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
            // A key outside the root stays absolute.
            const rel = key.startsWith(root) ? path.relative(root, key) : key;
            measured++;
            if (entry.statements.total === 0) continue;
            if (entry.statements.covered === 0) {
                uncovered++;
                // A component's statements are its render function: importing it covers none of them.
                const component = rel.endsWith('.vue');
                fail(
                    rel,
                    `0% of ${entry.statements.total} statement(s) covered — ${component ? 'no test renders this component' : 'no test imports this file'}`,
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

    return { problems, suites: unitTests.length, specs: specs.length, measured, uncovered, haveCoverage };
}

/**
 * The name the recorder is reached by: the fixture key or the variable its
 * `createServerErrorRecorder(` call sits under. Another recorder's `.watch(` —
 * the response-leak one, say — must not answer for this one.
 */
function recorderName(source: string): string {
    const before = source.slice(0, source.indexOf('createServerErrorRecorder('));
    const bindings = [...before.matchAll(/(\w+)\s*(?::\s*\[|:\s*async\b|=(?![=>]))/g)];
    return bindings.at(-1)?.[1] ?? '\\w+';
}

type FileAccess = {
    read: (rel: string) => string;
    exists: (rel: string) => boolean;
    fail: (file: string, what: string, why: string) => void;
};

/** Rule 10: the recorder, the teardown, the config that wires them, and specs that use them. */
function inspectServerErrors(wiring: ServerErrorWiring, e2e: E2eLayout, specs: string[], io: FileAccess): void {
    const { read, exists, fail } = io;
    const { fixtures, teardown } = wiring;

    if (e2e === false) {
        fail(
            fixtures,
            '`serverErrors` is stated but there is no E2E suite',
            'The tripwire runs inside the E2E suite: it needs the real API serving the browser. State `e2e` first, or drop `serverErrors`.',
        );
        return;
    }

    if (!exists(fixtures)) {
        fail(
            fixtures,
            'missing',
            'It is the fixtures module every spec imports `test` from, where the recorder lives.',
        );
    } else {
        const source = stripComments(read(fixtures));
        const created = callArgs(source, 'createServerErrorRecorder(');
        if (created.length === 0) {
            fail(
                fixtures,
                'never creates a server-error recorder',
                'A test that checks what it came to check walks straight past a 500 on the side: the page still renders, a spinner just never stops. The recorder watches every API response and fails the test that received a 5xx.',
            );
        } else {
            if (!created.some((args) => /\blogFile\b/.test(args))) {
                fail(
                    fixtures,
                    "creates the server-error recorder without the API's `logFile`",
                    'Without the log, a failure says that a request failed but not why. With it, the failure carries what the API logged for that request id: the error, its message and the line it came from.',
                );
            }
            const name = recorderName(source);
            for (const [method, what] of [
                ['watch', 'never watches a browser context'],
                ['drain', 'never drains the recorder'],
            ] as const) {
                if (!new RegExp(`\\b${name}\\s*\\.\\s*${method}\\s*\\(`).test(source)) {
                    fail(
                        fixtures,
                        `${what} for server errors`,
                        'The recorder sees only the contexts it watches, and fails a test only when it is drained after it. Watch the context every test gets, and drain in an `auto` fixture.',
                    );
                }
            }
        }
    }

    if (!exists(teardown)) {
        fail(teardown, 'missing', 'It is where the run reads the API log for errors no test saw as a 5xx.');
    } else if (!/\blogErrors\s*\(/.test(stripComments(read(teardown)))) {
        fail(
            teardown,
            'never reads the API log with `logErrors`',
            'Some failures never become a 5xx: a socket push its schema refused, a job that died in the background, an error logged inside a request that still answered 2xx. The teardown is the net for those — read every error-level line of the run and fail on any.',
        );
    }

    const config = stripComments(read(e2e.config));
    const teardownName = path.basename(teardown).replace(/\.[cm]?[jt]s$/, '');
    if (!new RegExp(`globalTeardown\\s*:\\s*['"][^'"]*${teardownName}`).test(config)) {
        fail(
            e2e.config,
            `does not run \`${teardown}\` as its globalTeardown`,
            'A teardown nothing registers never runs, and the run passes over every error the API logged.',
        );
    }
    if (!/\bLOG_FILE\b/.test(config)) {
        fail(
            e2e.config,
            'does not hand the API a `LOG_FILE`',
            'The API writes the JSON log the recorder and the teardown read only when `LOG_FILE` is set. Set it in the `webServer` env the suite boots the API with.',
        );
    }

    for (const rel of specs.filter((spec) => spec.startsWith(`${e2e.dir}/`))) {
        const source = stripComments(read(rel));
        for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
            const names = (match[1] ?? '').split(',').map((name) => name.trim());
            if (!names.includes('test')) continue;
            fail(
                `${rel}:${source.slice(0, match.index).split('\n').length}`,
                'imports `test` from @playwright/test, not from the fixtures',
                `Playwright's own \`test\` runs none of the project's fixtures, so this spec is watched by no tripwire: a 5xx, a leaked field, anything the \`auto\` fixtures check passes unseen. Import \`test\` from ${fixtures}.`,
            );
        }
    }
}

export function checkTesting(options: TestingOptions): void {
    const { root = REPO_ROOT, ...rest } = options;

    const report = createGateReport({ name: 'Testing' });
    const { problems, suites, specs, measured, uncovered, haveCoverage } = inspectTesting({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const { layout, e2e = false, thresholds, excludes = {}, domEnvironment, serverErrors, apiClient } = rest;
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
            `${domEnvironment === undefined ? '' : `, all on ${domEnvironment.name}`}` +
            `${apiClient === undefined ? '' : `, no suite replacing the API client's ${apiClient.exports.map((name) => `\`${name}\``).join('/')}`}` +
            `${serverErrors === undefined ? '' : ', every spec held to the server-error tripwire'}.` +
            (haveCoverage
                ? `\n  Coverage report: ${plural(measured, 'file')} measured, ${uncovered} at 0%.`
                : '\n  Coverage report: not present — the 0%-file check was SKIPPED. Run the coverage script first to include it.'),
        notMachineChecked:
            'whether a passing test asserts anything worth asserting, whether the next test to write is the ' +
            'highest-priority one, whether a component test would survive a refactor.',
    });
}
