/**
 * Dead-code gate — the reachability half of "unused", which a linter cannot see.
 *
 * ESLint reasons inside one file: it knows a variable you assigned and never read.
 * It cannot know that nothing in the repository imports the module that variable
 * lives in. This gate asks knip for the whole import graph and fails on anything
 * nothing reaches. The first run in a repo usually proves the difference: in one of
 * them every single frontend file came back unreachable, because `index.html`
 * pointed at `/src/main.js` and the entry point is `main.ts` — the typecheck
 * compiles the files it is given, the build has its own resolution, and a stale
 * entry in an HTML file is invisible in a diff.
 *
 * WHY THIS IS ONE GATE WITH ALMOST NO OPTIONS. All five copies were the same file.
 * With comments stripped they differ in four lines: which knip issue types are left
 * ungated, one environment variable, the path named in the closing hint, and the
 * glyph in front of the word. Nothing about it is family-shaped — knip reports what
 * it finds, and a repo without pnpm catalogs simply has no catalog findings.
 *
 * TWO RUNS, NOT ONE. knip's default graph counts a test file as a consumer, so an
 * export that only its own test imports looks alive — a fully tested owner-role
 * middleware mounted on zero routes passed this gate for months. The second run adds
 * `--production`, which drops test files from the graph, and reports what is left
 * minus whatever the first pass already named, so each finding is reported once.
 * Four different things land in that bucket and they do NOT share a fix, which is
 * why nothing here is automatic: production code nobody wired (delete it, or wire
 * it), a symbol the module genuinely publishes (tag it), an implementation detail a
 * test reached past the front door for (unexport it and test it through its caller),
 * and an expected value the test imported instead of writing down. That last one is
 * the reason to care: an assertion fed from the code under test is `x === x`, so
 * sharing a constant with the code under test does not keep the test in sync, it
 * stops the test from ever noticing.
 *
 * WHAT IS DELIBERATELY NOT GATED, and the line is "dead code, not drift":
 *   - `unlisted` / `binaries` / `unresolved`. knip also reports the mirror image —
 *     imported but not declared — which root scripts and e2e suites do constantly
 *     and get away with only because npm hoists workspace deps into the root
 *     `node_modules`. That is real drift and worth fixing, but it is a manifest
 *     problem, not dead code, and a gate that fails for a reason its name does not
 *     describe is a gate people learn to skip. `--all` shows them.
 *   - `cycles`. A cycle is a design smell about direction, not a claim that anything
 *     is unreachable — every file in one is very much alive. It wants its own check.
 *   - `catalog` / `catalogReferences`. pnpm catalogs, in npm-workspace repos.
 * Also out of scope, in the knip config rather than here: SCSS. knip does not follow
 * `@use`, so every partial imported by `index.scss` came back unused. Eleven false
 * positives is how a gate teaches you to ignore it; stylelint owns those files.
 *
 * `budgets` EXISTS AND IS ZERO EVERYWHERE. It is the shape of a backlog being
 * cleared, not a dial: every category in all five repos is at 0 and stays there,
 * `testOnlyExports` included — its opening 31 in the reference repo were worked
 * through by hand, one decision each. Never raise one to land a change.
 */
import { execFileSync } from 'node:child_process';

import { packageBin } from './bin.ts';
import { REPO_ROOT } from './repo-root.ts';
import { createGateReport } from './report.ts';

export type DeadCodeCategory = { label: string; fix: string };

/** One knip finding, flattened. `name === file` means the whole file is unused. */
export type DeadCodeHit = { file: string; name: string; line: number | undefined };

export type KnipItem = { name: string; line?: number };

/** knip --reporter json, reduced to what this gate reads. */
export type KnipReport = { issues?: ({ file: string } & Record<string, unknown>)[] };

export type KnipRunInput = {
    root: string;
    /** Absolute path to knip's bin script, run with `process.execPath`. */
    bin: string;
    include: string[];
    extra?: string[] | undefined;
};

export type DeadCodeOptions = {
    root?: string;
    /** Max findings per category. Zero unless a backlog is still being cleared. */
    budgets?: Record<string, number>;
    /** Where this project keeps its gates, for the closing hint. */
    checksDir?: string;
    /** The runtime-reachability examples this repo would recognise. */
    notMachineChecked?: string;
};

/**
 * Every knip issue type this gate fails on, with the fix for each. This object
 * doubles as the `--include` list: knip only reports the types it is asked for, and
 * several of these (`nsExports`, `duplicates`, `enumMembers`) are off by default, so
 * naming them here rather than taking the defaults minus an exclude list is what
 * keeps the two in step — add a key and it is asked for, with no second list.
 */
export const CATEGORIES: Record<string, DeadCodeCategory> = {
    files: {
        label: 'Unused files',
        fix: 'No entry point reaches this module. Delete it, or import it from something that is reached — a barrel nobody imports is worse than no barrel.',
    },
    exports: {
        label: 'Unused exports',
        fix: 'Nothing imports this. Drop the `export` keyword if the value is still used inside its own file, otherwise delete it. If it is public by design, tag it `/** @public */`.',
    },
    types: {
        label: 'Unused exported types',
        fix: 'Nothing imports this type. Unexport or delete it — a stale exported type reads as a contract, so the next person writes against a shape nothing produces any more. That makes it the more dangerous of the two.',
    },
    nsExports: {
        label: 'Unused exports in a namespace',
        fix: 'Only reachable via `import * as ns` and never accessed off it. The live namespace object is what kept it looking used — same fix as an unused export: unexport or delete.',
    },
    nsTypes: {
        label: 'Unused exported types in a namespace',
        fix: 'Only reachable via `import * as ns` and never referenced off it. Unexport or delete.',
    },
    namespaceMembers: {
        label: 'Unused namespace members',
        fix: 'A member of a namespace nothing reads. Delete it — the namespace being imported says nothing about this member being used.',
    },
    enumMembers: {
        label: 'Unused enum members',
        fix: 'Nothing ever compares against this case. Delete it, or find out which code path was supposed to produce it.',
    },
    duplicates: {
        label: 'Duplicate exports',
        fix: 'The same symbol is exported twice under different names. Keep the one callers use and delete the alias — the spare is what someone imports by mistake a year from now.',
    },
    dependencies: {
        label: 'Unused dependencies',
        fix: 'Declared in this package.json, imported nowhere in that workspace. Uninstall it — it costs install time, image size and audit surface for nothing. If the code that needs it lives in another workspace, move the declaration there rather than relying on npm hoisting. If it is loaded indirectly (a native backend, a builder hook), list it under `ignoreDependencies` in the knip config with a reason.',
    },
    devDependencies: {
        label: 'Unused devDependencies',
        fix: 'Declared in this package.json, used by nothing in that workspace. Uninstall it — a dev tool nothing runs still costs every CI install.',
    },
    optionalPeerDependencies: {
        label: 'Unused optional peer dependencies',
        fix: 'Declared as an optional peer, imported nowhere. Drop it from the manifest.',
    },
};

/**
 * The second pass. Keyed separately because `testOnlyExports` is this gate's own
 * word, not a knip issue type — it cannot be asked for on the CLI, and it cannot sit
 * in CATEGORIES, which doubles as the `--include` list.
 */
export const TEST_ONLY: DeadCodeCategory & { key: string } = {
    key: 'testOnlyExports',
    label: 'Exports used only by tests',
    fix: "Production code never imports this; only a test does. Decide which of the four it is: unwired production code (delete it, or wire it), a real part of the module's contract (tag `/** @public */`), an internal reached past the front door (unexport, and test it through the caller that uses it), or an expected value the test should write down as a literal instead of importing (an assertion fed from the code under test cannot fail).",
};

/**
 * CATEGORIES minus `files` and the dependency ones: under `--production` the test
 * files leave the graph, so `vitest` and every test helper come back "unused" and
 * the run would be nothing but noise. Exports are the only thing this pass has a
 * real claim to.
 */
const PROD_INCLUDE = ['exports', 'types', 'nsExports', 'nsTypes', 'namespaceMembers', 'enumMembers'];
const PROD_ARGS = ['--production', '--include-entry-exports'];

/** Reported by `--all`, never gated. The header says why each is out. */
const UNGATED = ['unlisted', 'binaries', 'unresolved', 'cycles', 'catalog', 'catalogReferences'];

/** `file` alone when the whole file is unused; `file:line — name` otherwise. */
const where = ({ file, name, line }: DeadCodeHit): string =>
    name === file ? file : `${file}${line === undefined ? '' : `:${line}`} — ${name}`;
const identity = ({ file, name }: DeadCodeHit): string => `${file}::${name}`;

/**
 * One knip run, flattened and bucketed by category. `extra` is what separates the
 * two passes.
 */
export function runKnip(input: KnipRunInput): Record<string, DeadCodeHit[]> {
    const { root, bin, include, extra = [] } = input;
    const args = ['--no-progress', '--reporter', 'json', '--tags=-public', '--include', include.join(','), ...extra];

    let raw: string;
    try {
        raw = execFileSync(process.execPath, [bin, ...args], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
            // dotenv prints a banner to stdout on load, which lands in the middle of the
            // JSON this parses. Harmless in a repo that does not use dotenv.
            env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
        });
    } catch (error) {
        // knip exits non-zero whenever it finds anything, but still prints the report.
        const { stdout, stderr } = error as { stdout?: string; stderr?: string | Buffer };
        raw = stdout ?? '';
        if (raw.trim() === '') {
            const detail = stderr === undefined ? '' : `\n${stderr.toString().trim()}`;
            throw new Error(`knip produced no output.${detail}`);
        }
    }

    let report: KnipReport;
    try {
        report = JSON.parse(raw);
    } catch {
        throw new Error(`could not parse knip's JSON report.\n${raw.slice(0, 500)}`);
    }

    return collectHits(report, include);
}

/**
 * knip's JSON report, reduced to what this gate reads. Split out from the run so the
 * bucketing is testable against a real report without a repository to point knip at.
 */
export function collectHits(report: KnipReport, include: string[]): Record<string, DeadCodeHit[]> {
    const found: Record<string, DeadCodeHit[]> = Object.fromEntries(include.map((key) => [key, []]));
    for (const entry of report.issues ?? []) {
        for (const category of include) {
            const items = entry[category];
            if (!Array.isArray(items)) continue;
            for (const item of items as (KnipItem | KnipItem[])[]) {
                (found[category] ??= []).push(
                    // A `duplicates` finding is an ARRAY of the names one symbol is exported under.
                    Array.isArray(item)
                        ? { file: entry.file, name: item.map((symbol) => symbol.name).join(' = '), line: item[0]?.line }
                        : { file: entry.file, name: item.name, line: item.line },
                );
            }
        }
    }
    return found;
}

/**
 * Pass one, then pass two minus whatever pass one already named.
 */
export function inspectDeadCode(
    knip: (include: string[], extra?: string[]) => Record<string, DeadCodeHit[]>,
): Record<string, DeadCodeHit[]> {
    const found = knip(Object.keys(CATEGORIES));

    // Anything the first pass named is dead outright and is reported there; the
    // remainder is alive only because a test imports it.
    const alreadyReported = new Set(Object.values(found).flat().map(identity));
    found[TEST_ONLY.key] = Object.values(knip(PROD_INCLUDE, PROD_ARGS))
        .flat()
        .filter((hit) => !alreadyReported.has(identity(hit)));

    return found;
}

/**
 * The budget decision, separated from the run so it is testable without knip: which
 * categories are over budget, in the order CATEGORIES declares them, with the second
 * pass last because it is the one that needs a judgement rather than a deletion.
 */
export function deadCodeProblems(
    found: Record<string, DeadCodeHit[]>,
    budgets: Record<string, number> = {},
    checksDir = 'scripts/checks',
): { what: string; why: string }[] {
    const problems: { what: string; why: string }[] = [];
    const categories: [string, DeadCodeCategory][] = [...Object.entries(CATEGORIES), [TEST_ONLY.key, TEST_ONLY]];
    for (const [category, { label, fix }] of categories) {
        const hits = found[category] ?? [];
        const budget = budgets[category] ?? 0;
        if (hits.length <= budget) continue;

        const listed = [...hits].sort((a, b) => a.file.localeCompare(b.file)).map((hit) => `      • ${where(hit)}`);
        problems.push({
            what: `${label}: ${hits.length} exceeds the budget of ${budget}.\n${listed.join('\n')}`,
            why: `${fix}\n      Budgets live in ${checksDir}/check-dead-code.ts and only ever go down. If an export is public by design, tag it \`/** @public */\` rather than raising one.`,
        });
    }
    return problems;
}

/**
 * @param [options.budgets] Max findings per category. Zero unless a backlog is still being cleared.
 * @param [options.checksDir] Where this project keeps its gates, for the closing hint.
 * @param [options.notMachineChecked] The runtime-reachability examples this repo would recognise.
 */
export function checkDeadCode(options: DeadCodeOptions = {}): void {
    const {
        root = REPO_ROOT,
        budgets = {},
        checksDir = 'scripts/checks',
        notMachineChecked = 'code reachable from an entry point but never reached at RUNTIME — a route nothing links to, a branch no config enables, a queue with no producer.',
    } = options;

    const report = createGateReport({ name: 'Dead code' });
    const gated = Object.keys(CATEGORIES);

    // `--all` is the human-facing view, not a stricter gate: hand the terminal straight
    // to knip so you get every category it knows about — including the ones this gate
    // deliberately does not fail on — in its own formatting, with no budgets applied.
    if (process.argv.includes('--all')) {
        const bin = packageBin('knip');
        try {
            execFileSync(
                process.execPath,
                [bin, '--no-progress', '--tags=-public', '--include', [...gated, ...UNGATED].join(',')],
                { cwd: root, stdio: 'inherit' },
            );
        } catch {
            /* Findings make knip exit non-zero; in this mode we are only reporting. */
        }
        return;
    }

    let found;
    try {
        const bin = packageBin('knip');
        found = inspectDeadCode((include, extra) => runKnip({ root, bin, include, extra }));
    } catch (error) {
        console.error(`✗ Dead code check failed — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    for (const { what, why } of deadCodeProblems(found, budgets, checksDir)) report.fail(null, what, why);

    report.done({
        summary: `No dead code — ${gated.length + 1} categories, all at 0.`,
        notMachineChecked,
    });
}
