/**
 * Dead code across the import graph, via knip. Two runs: the default graph, then
 * `--production`, which drops tests so an export only its own test imports shows up
 * as `testOnlyExports` (reported once, minus what the first run named).
 * Also gated, though none of it is dead code: the other half of knip's graph — an
 * import the manifest does not declare, a binary nothing installs, an import that
 * resolves to nothing, and circular imports. Only pnpm `catalog` findings are not
 * gated (`--all` shows them).
 * `budgets` is for clearing a backlog and should be zero; never raise one to land a change.
 */
import { execFileSync } from 'node:child_process';

import { packageBin } from './lib/bin.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport } from './lib/report.ts';

export type DeadCodeOptions = {
    root?: string;
    /** Max findings per category. Zero unless a backlog is still being cleared. */
    budgets?: Record<string, number>;
    /** Where this project keeps its gates, for the closing hint. */
    checksDir?: string;
    /** The runtime-reachability examples this repo would recognise. */
    notMachineChecked?: string;
};

type DeadCodeCategory = { label: string; fix: string };

/** One knip finding, flattened. `name === file` means the whole file is unused. */
type DeadCodeHit = { file: string; name: string; line: number | undefined };

type KnipItem = { name: string; line?: number };

/** knip --reporter json, reduced to what this gate reads. */
type KnipReport = { issues?: ({ file: string } & Record<string, unknown>)[] };

type KnipRunInput = {
    root: string;
    /** Absolute path to knip's bin script, run with `process.execPath`. */
    bin: string;
    include: string[];
    extra?: string[] | undefined;
};

/** Every knip issue type this gate fails on, with its fix. Doubles as the `--include` list. */
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
    unlisted: {
        label: 'Unlisted dependencies',
        fix: "Imported here, declared in no package.json this workspace reads. It resolves only because npm hoisted another workspace's copy, so it breaks the day that workspace drops it or pins another version. Declare it in the package.json that owns this file, at the same range the other workspaces use.",
    },
    binaries: {
        label: 'Unlisted binaries',
        fix: 'A script runs this command and no dependency provides it. Declare the package that ships it, or, if it is a system tool (ffmpeg, docker), list it under `ignoreBinaries` in the knip config so the requirement is written down.',
    },
    unresolved: {
        label: 'Unresolved imports',
        fix: 'This specifier resolves to nothing — a moved file, a typo, or a path alias knip was not told about. Fix the import, or teach knip the alias; an import nothing can follow is also a module knip cannot see past.',
    },
    cycles: {
        label: 'Circular imports',
        fix: "These modules import each other, so one of them is read half-initialised at load time and the pair can only be understood, tested or moved together. Move what both need into a third module, or have the lower-level one take the dependency as a parameter. A cycle through a barrel is usually one file importing its own domain's barrel back: import the file directly.",
    },
};

/** The second pass. Separate from CATEGORIES because it is not a knip issue type. */
export const TEST_ONLY: DeadCodeCategory & { key: string } = {
    key: 'testOnlyExports',
    label: 'Exports used only by tests',
    fix: "Production code never imports this; only a test does. Decide which of the four it is: unwired production code (delete it, or wire it), a real part of the module's contract (tag `/** @public */`), an internal reached past the front door (unexport, and test it through the caller that uses it), or an expected value the test should write down as a literal instead of importing (an assertion fed from the code under test cannot fail).",
};

/** Only exports: under `--production` test helpers and test deps would all read as unused. */
const PROD_INCLUDE = ['exports', 'types', 'nsExports', 'nsTypes', 'namespaceMembers', 'enumMembers'];
const PROD_ARGS = ['--production', '--include-entry-exports'];

/** Reported by `--all`, never gated: pnpm catalogs, which the family repos do not use. */
const UNGATED = ['catalog', 'catalogReferences'];

/** Categories whose finding is an ARRAY of symbols, and how its names are joined. */
const JOINED: Record<string, string> = { duplicates: ' = ', cycles: ' → ' };

/** `file` alone when the whole file is unused; `file:line — name` otherwise. */
const where = ({ file, name, line }: DeadCodeHit): string =>
    name === file ? file : `${file}${line === undefined ? '' : `:${line}`} — ${name}`;
const identity = ({ file, name }: DeadCodeHit): string => `${file}::${name}`;

/** One knip run, flattened and bucketed by category. */
function runKnip(input: KnipRunInput): Record<string, DeadCodeHit[]> {
    const { root, bin, include, extra = [] } = input;
    const args = ['--no-progress', '--reporter', 'json', '--tags=-public', '--include', include.join(','), ...extra];

    let raw: string;
    try {
        raw = execFileSync(process.execPath, [bin, ...args], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
            // dotenv's stdout banner would corrupt the JSON.
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

/** knip's JSON report, bucketed. Separate from the run so it is testable. */
export function collectHits(report: KnipReport, include: string[]): Record<string, DeadCodeHit[]> {
    const found: Record<string, DeadCodeHit[]> = Object.fromEntries(include.map((key) => [key, []]));
    for (const entry of report.issues ?? []) {
        for (const category of include) {
            const items = entry[category];
            if (!Array.isArray(items)) continue;
            for (const item of items as (KnipItem | KnipItem[])[]) {
                (found[category] ??= []).push(
                    // `duplicates`: the names one symbol is exported under. `cycles`: each file
                    // on the loop in import order, so the start is repeated to close it.
                    Array.isArray(item)
                        ? {
                              file: entry.file,
                              name: [...item, ...(category === 'cycles' ? item.slice(0, 1) : [])]
                                  .map((symbol) => symbol.name)
                                  .join(JOINED[category] ?? ' = '),
                              line: item[0]?.line,
                          }
                        : { file: entry.file, name: item.name, line: item.line },
                );
            }
        }
    }
    return found;
}

/** Pass one, then pass two minus whatever pass one already named. */
export function inspectDeadCode(
    knip: (include: string[], extra?: string[]) => Record<string, DeadCodeHit[]>,
): Record<string, DeadCodeHit[]> {
    const found = knip(Object.keys(CATEGORIES));

    const alreadyReported = new Set(Object.values(found).flat().map(identity));
    found[TEST_ONLY.key] = Object.values(knip(PROD_INCLUDE, PROD_ARGS))
        .flat()
        .filter((hit) => !alreadyReported.has(identity(hit)));

    return found;
}

const ALL_CATEGORIES: [string, DeadCodeCategory][] = [...Object.entries(CATEGORIES), [TEST_ONLY.key, TEST_ONLY]];

/**
 * The categories over budget, in CATEGORIES order with the second pass last, then the
 * budgets that should not be there: one naming no category, and one whose category is
 * back at zero — left in place, it is a licence to regrow to the old count.
 */
export function deadCodeProblems(
    found: Record<string, DeadCodeHit[]>,
    budgets: Record<string, number> = {},
    checksDir = 'scripts/checks',
): { what: string; why: string }[] {
    const problems: { what: string; why: string }[] = [];
    for (const [category, { label, fix }] of ALL_CATEGORIES) {
        const hits = found[category] ?? [];
        const budget = budgets[category] ?? 0;
        if (hits.length <= budget) continue;

        const listed = [...hits].sort((a, b) => a.file.localeCompare(b.file)).map((hit) => `      • ${where(hit)}`);
        problems.push({
            what: `${label}: ${hits.length} exceeds the budget of ${budget}.\n${listed.join('\n')}`,
            why: `${fix}\n      Budgets live in ${checksDir}/check-dead-code.ts and only ever go down. If an export is public by design, tag it \`/** @public */\` rather than raising one.`,
        });
    }

    const known = new Map(ALL_CATEGORIES);
    for (const [category, budget] of Object.entries(budgets)) {
        const entry = known.get(category);
        if (!entry) {
            problems.push({
                what: `The budget for \`${category}\` names no category.`,
                why: `A misspelt key budgets nothing, so the category it meant is still held at 0. The categories are: ${[...known.keys()].join(', ')}.`,
            });
        } else if (budget > 0 && (found[category] ?? []).length === 0) {
            problems.push({
                what: `${entry.label}: back at 0, but still budgeted ${budget}.`,
                why: `Remove the \`${category}\` budget from ${checksDir}/check-dead-code.ts so the ratchet cannot quietly slip back. A budget left behind is a licence to regrow to the old count.`,
            });
        }
    }
    return problems;
}

/**
 * The pass line. "All at 0" only when it is true; a budget still in use is named with
 * its count, so a backlog being cleared stays visible on every green run.
 */
export function deadCodeSummary(found: Record<string, DeadCodeHit[]>, budgets: Record<string, number> = {}): string {
    const backlog = ALL_CATEGORIES.flatMap(([category, { label }]) => {
        const count = (found[category] ?? []).length;
        return count > 0 ? [`${label.toLowerCase()} ${count} of ${budgets[category] ?? 0}`] : [];
    });
    const head = `No dead code or import-graph drift — ${ALL_CATEGORIES.length} categories`;
    if (backlog.length === 0) return `${head}, all at 0.`;
    return `${head}, ${ALL_CATEGORIES.length - backlog.length} at 0; within budget: ${backlog.join(', ')}.`;
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

    // `--all`: knip's own output, every category, no budgets.
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
        summary: deadCodeSummary(found, budgets),
        notMachineChecked,
    });
}
