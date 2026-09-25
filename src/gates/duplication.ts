/**
 * Duplication (DRY) gate.
 *
 * The failure this exists for is the one refactoring keeps producing: a module is
 * split by concern, the same guard or the same mapping is pasted into each half, and
 * every subsequent fix lands in one copy. It is invisible in review because no single
 * diff contains both halves.
 *
 * FOUR RULES, AND TWO OF THEM ARE SELF-SILENCING. The two families looked like
 * different gates — the full-stack copies check cross-workspace copies and duplicated
 * type names, the desktop copies check per-format ceilings and a cap on any single
 * clone — but only the first pair is family-shaped, and it is shaped by the repo, not
 * by the family: both rules compare one scan root against another, so in a repo with
 * ONE root they have nothing to compare and say nothing. So this is the union, with
 * no switch, and a single-root project simply never reaches rules 3 and 4.
 *
 * WHY THE CEILINGS ARE PER FORMAT AND WHY AN OMITTED FORMAT IS NOT GATED. One blended
 * percentage hides all three of the things it averages:
 *   - `typescript` is LOGIC. Two copies of a branch is the case that costs a bug.
 *   - `scss` is presentation. Repetition there is real debt, but a stale copy makes
 *     something look wrong rather than behave wrong.
 *   - `html` is SFC template markup, where structural repetition is often the correct
 *     answer and extracting a component would cost more than it saves.
 * One family gates all three; the other gates typescript alone and says so in its
 * config — its SCSS sits near 8% and most of it is the same handful of declarations
 * inside different SFCs, where `@extend` cannot cross the SFC boundary, so
 * de-duplicating means promoting each one to a real global class. That is a design
 * call about what deserves to be shared, not something a percentage should force.
 * A format with no entry in `ceilings` is therefore not a gap — it is a recorded
 * decision, and `--all` still prints its number.
 *
 * WHY A PERCENTAGE IS NOT ENOUGH BY ITSELF. A ratio quietly improves as a codebase
 * grows: a large new copy-paste can land while the number goes DOWN. `maxCloneTokens`
 * is the rule that catches that, independently of size. It is optional because the
 * number is a ratchet set just above where a repo sits today, and a repo that has
 * never had one has no number to set.
 *
 * WHY ONE jscpd RUN OVER EVERY ROOT. The clones that matter most cross a root
 * boundary — a DTO restated in the frontend against the service that produces it, or
 * a connection bootstrap pasted into each service instead of living in shared. A
 * per-root run cannot see either. `perRoot` adds the per-root runs BACK, for projects
 * that also want each root held to the ceiling on its own so a small duplicated
 * workspace is not diluted by a large clean one; it is a superset, not a replacement.
 *
 * WHAT THIS CANNOT JUDGE: jscpd matches tokens, not intent. Two blocks that look
 * identical and mean different things are a false positive, and the honest response is
 * to raise the relevant ceiling with a comment rather than contort the code. Every
 * number a project passes in is a judgement, not a measurement.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packageBin } from './bin.ts';
import { walkFiles } from './files.ts';
import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural, type GateFailure } from './report.ts';

export type Ceiling = {
    /** Percentage of duplicated tokens this format may not exceed. */
    limit: number;
    /** Why this format's number is where it is. Printed as the failure's reason. */
    note?: string;
};

export type CrossCloneAllowance = {
    /** The two repo-relative paths, in either order. */
    files: [string, string];
    /** What makes the two copies composition rather than logic. */
    why: string;
};

/** jscpd's JSON report, reduced to what this gate reads. */
export type CloneLocation = { name: string; start: number; end: number };

export type Clone = {
    format: string;
    lines: number;
    tokens: number;
    firstFile: CloneLocation;
    secondFile: CloneLocation;
};

export type JscpdReport = {
    duplicates: Clone[];
    statistics: {
        formats: Record<string, { percentageTokens: number; clones: number } | undefined>;
        total: { clones: number };
    };
};

export type DuplicationOptions = {
    /** Repository root. Defaults to the repo this runs in. */
    root?: string;
    /** Source trees to scan. One entry means the cross-root rules say nothing. */
    scan: string[];
    /** Per-format token-percentage ceilings. A format with no entry is not gated. */
    ceilings: Record<string, number | Ceiling>;
    /** Also hold each scan root to the ceilings on its own, one jscpd run per root. */
    perRoot?: boolean;
    /** No single clone may exceed this many tokens. Omitted means not gated. */
    maxCloneTokens?: number;
    /** Cross-root clones that are composition roots, not logic. */
    crossCloneAllowed?: CrossCloneAllowance[];
    /** jscpd config file, relative to `root`. Defaults to `.jscpd.json`. */
    config?: string;
    /** Directories the exported-type-name rule does not descend into. */
    ignoreDirs?: string[];
};

export type TypeDeclaration = { root: string; where: string };

export type DuplicationInput = {
    root: string;
    /** The run over every scan root at once. */
    report: JscpdReport;
    /** One run per scan root, keyed by root. Absent roots are simply not checked. */
    perRootReports?: Record<string, JscpdReport>;
    /** Exported type names and where each was declared. */
    declarations?: Map<string, TypeDeclaration[]>;
    scan: string[];
    ceilings: Record<string, number | Ceiling>;
    maxCloneTokens?: number | undefined;
    crossCloneAllowed?: CrossCloneAllowance[];
};

export type DuplicationInspection = {
    problems: GateFailure[];
    /** How many distinct exported type names were seen. */
    types: number;
};

/** Directories whose contents are not this repo's own source. */
const DEFAULT_IGNORE_DIRS = ['__tests__', 'tests', 'node_modules', 'dist'];

/**
 * jscpd reports an SFC's script block as `Foo.vue:typescript`. Stripping the suffix is
 * what lets a path be compared against an allowlist entry or printed for a human.
 */
const relative = (root: string, file: string): string => path.relative(root, file.replace(/:[a-z]+$/, ''));

/** Run jscpd over `paths` and read its JSON report. */
function runJscpd(root: string, paths: string[], config: string): JscpdReport {
    const bin = packageBin('jscpd');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));
    try {
        execFileSync(
            process.execPath,
            [bin, ...paths, '--config', config, '--absolute', '--reporters', 'json', '--output', outDir],
            { cwd: root, stdio: 'ignore' },
        );
    } catch {
        /* jscpd exits non-zero on its own thresholds and on its own errors; either way the report is written. */
    }

    const reportPath = path.join(outDir, 'jscpd-report.json');
    if (!fs.existsSync(reportPath)) {
        fs.rmSync(outDir, { recursive: true, force: true });
        throw new Error(`jscpd produced no report for ${paths.join(', ')}. Run it with \`--all\` to see why.`);
    }

    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as JscpdReport;
    fs.rmSync(outDir, { recursive: true, force: true });
    return parsed;
}

/**
 * Every exported type and interface name, and where it was declared.
 *
 * A regex rather than the TypeScript AST on purpose: the question is only "does this
 * NAME appear as an export in two roots", and a name is the one thing a regex reads
 * without ambiguity. Being wrong here costs a false positive on a name, not a wrong
 * program.
 */
export function exportedTypes(
    root: string,
    scan: string[],
    ignoreDirs: string[] = DEFAULT_IGNORE_DIRS,
): Map<string, TypeDeclaration[]> {
    const excluded = new RegExp(`(^|/)(${ignoreDirs.join('|')})/`);
    const declarations: Map<string, { root: string; where: string }[]> = new Map();

    for (const scanRoot of scan) {
        const files = walkFiles(root, scanRoot, {
            match: (rel) => /\.(ts|vue)$/.test(rel) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(rel),
            exclude: excluded,
        });

        for (const rel of files) {
            const source = fs.readFileSync(path.join(root, rel), 'utf8');
            for (const match of source.matchAll(/^export\s+(?:type|interface)\s+([A-Z]\w*)/gm)) {
                const name = match[1] ?? '';
                const line = source.slice(0, match.index).split('\n').length;
                const defs = declarations.get(name) ?? [];
                defs.push({ root: scanRoot, where: `${rel}:${line}` });
                declarations.set(name, defs);
            }
        }
    }

    return declarations;
}

/**
 * Every rule, decided from a jscpd report and a map of declarations — no filesystem,
 * no child process.
 *
 * Split out for the same reason the audit gate is: the alternative way to test rule 2
 * is to check a 141-token clone into a fixture repo and run the real jscpd over it,
 * which makes the suite depend on a binary, on that binary's tokenizer, and on nobody
 * ever reformatting the fixture. Here the crafted report IS the contract, and the
 * runner's only job is to produce one.
 */
export function inspectDuplication(input: DuplicationInput): DuplicationInspection {
    const {
        root,
        report,
        perRootReports = {},
        declarations = new Map<string, TypeDeclaration[]>(),
        scan,
        ceilings,
        maxCloneTokens,
        crossCloneAllowed = [],
    } = input;

    const problems: GateFailure[] = [];
    /** @param file @param {string} what @param {string} why */
    const fail = (file: string | null, what: string, why: string) => problems.push({ file, what, why });

    const ceilingOf = (entry: number | Ceiling) =>
        typeof entry === 'number' ? { limit: entry, note: undefined } : entry;
    const rel = (file: string) => relative(root, file);
    const loc = (f: CloneLocation) => `${rel(f.name)}:${f.start}-${f.end}`;

    const clones = report.duplicates.slice().sort((a, b) => b.tokens - a.tokens);

    /**
     * Record a clone under the file it starts in, so the reporter groups it there and an
     * editor can jump straight to it. Both originals printed the two paths as unanchored
     * indented lines under a bullet, which is two clicks further away from the code.
     */
    const failClone = (clone: Clone, why: string) => {
        fail(loc(clone.firstFile), `${plural(clone.tokens, 'token')} duplicated at ${loc(clone.secondFile)}`, why);
    };

    const checkCeilings = (source: JscpdReport, where: string | null) => {
        for (const [format, entry] of Object.entries(ceilings)) {
            const stats = source.statistics.formats[format];
            if (stats === undefined) continue;

            const { limit, note } = ceilingOf(entry);
            if (stats.percentageTokens <= limit) continue;

            fail(
                where,
                `\`${format}\` duplication is ${stats.percentageTokens.toFixed(2)}% of tokens, over the ${limit}% ceiling (${plural(stats.clones, 'clone')})`,
                note === undefined
                    ? 'Extract each copy into one shared module. A ceiling is set just above where the codebase sits, so it only ever goes down.'
                    : `This ceiling is ${note}`,
            );

            const worst = source.duplicates
                .filter((d) => d.format === format)
                .sort((a, b) => b.tokens - a.tokens)
                .slice(0, 5);
            for (const clone of worst) failClone(clone, 'One of the largest copies behind the number above.');
        }
    };

    // -- 1. Ceilings -------------------------------------------------------------
    checkCeilings(report, null);
    for (const scanRoot of scan) {
        const perRoot = perRootReports[scanRoot];
        if (perRoot !== undefined) checkCeilings(perRoot, scanRoot);
    }

    // -- 2. No single clone over the cap -----------------------------------------
    if (maxCloneTokens !== undefined) {
        for (const clone of clones.filter((d) => d.tokens > maxCloneTokens).slice(0, 5)) {
            failClone(
                clone,
                `Over the ${maxCloneTokens}-token cap. A block this size pasted into a second place is the case the percentages cannot catch — the ratio can fall while this lands. Extract it, or say why the two are only incidentally alike.`,
            );
        }
    }

    // -- 3. No block copied between scan roots, whatever the percentage ----------
    const rootOf = (file: string) => scan.find((r) => rel(file).startsWith(`${r}/`));
    const isPair = /** @param c @param {[string, string]} pair */ (c: Clone, [a, b]: [string, string]) => {
        const files = [rel(c.firstFile.name), rel(c.secondFile.name)];
        return files.includes(a) && files.includes(b);
    };

    if (scan.length > 1) {
        const cross = clones
            .filter((c) => rootOf(c.firstFile.name) !== rootOf(c.secondFile.name))
            .filter((c) => !crossCloneAllowed.some((entry) => isPair(c, entry.files)));

        for (const clone of cross) {
            failClone(
                clone,
                'Copied between two scan roots. Whatever the percentage, this is two copies of one piece of logic and a fix lands in only one of them — move it into the shared package.',
            );
        }

        // 3b. Every allowance still matches a real clone, so the list only ever shrinks.
        for (const entry of crossCloneAllowed.filter((e) => !clones.some((c) => isPair(c, e.files)))) {
            fail(
                entry.files[0],
                `allowed cross-root clone with ${entry.files[1]} no longer exists`,
                'The duplication it excused is gone. Delete the entry, or the next copy pasted between these two files is allowed by a rule nobody remembers writing.',
            );
        }
    }

    // -- 4. The same exported type name declared in two roots --------------------
    if (scan.length > 1) {
        for (const [name, defs] of declarations) {
            if (new Set(defs.map((d) => d.root)).size < 2) continue;
            for (const def of defs) {
                fail(
                    def.where,
                    `exports the type \`${name}\`, which is also declared in ${defs
                        .filter((other) => other !== def)
                        .map((other) => other.where)
                        .join(', ')}`,
                    'A shape both sides use belongs in the shared package. Two declarations of one name do not stay the same shape — they drift, and the compiler cannot tell you, because each side only ever sees its own.',
                );
            }
        }
    }

    return { problems, types: declarations.size };
}

export function checkDuplication(options: DuplicationOptions): void {
    const {
        root = REPO_ROOT,
        scan,
        ceilings,
        perRoot = false,
        maxCloneTokens,
        crossCloneAllowed = [],
        config = '.jscpd.json',
        ignoreDirs = DEFAULT_IGNORE_DIRS,
    } = options;

    // `--all` is the human-facing view: jscpd's own console report over the same roots
    // and the same config, so the clones can be read rather than counted, formats this
    // gate does not gate included. No ceilings are applied.
    if (process.argv.includes('--all')) {
        const bin = packageBin('jscpd');
        try {
            execFileSync(process.execPath, [bin, ...scan, '--config', config, '--reporters', 'console'], {
                cwd: root,
                stdio: 'inherit',
            });
        } catch {
            /* jscpd exits non-zero on its own thresholds; in this mode we are only reporting. */
        }
        return;
    }

    const report = createGateReport({ name: 'Duplication', standard: 'refactoring.instructions.md' });

    let full: JscpdReport;
    const perRootReports: Record<string, JscpdReport> = {};
    try {
        full = runJscpd(root, scan, config);
        if (perRoot) {
            for (const scanRoot of scan) perRootReports[scanRoot] = runJscpd(root, [scanRoot], config);
        }
    } catch (error) {
        console.error(`✗ Duplication check failed — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    const { problems, types } = inspectDuplication({
        root,
        report: full,
        perRootReports,
        declarations: scan.length > 1 ? exportedTypes(root, scan, ignoreDirs) : new Map(),
        scan,
        ceilings,
        maxCloneTokens,
        crossCloneAllowed,
    });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const ceilingOf = (entry: number | Ceiling) => (typeof entry === 'number' ? entry : entry.limit);

    const percentages = Object.entries(ceilings)
        .flatMap(([format, entry]) => {
            const stats = full.statistics.formats[format];
            return stats === undefined ? [] : [`${format} ${stats.percentageTokens.toFixed(2)}%/${ceilingOf(entry)}%`];
        })
        .join(', ');

    const largest = full.duplicates.reduce((n, d) => Math.max(n, d.tokens), 0);
    const cap = maxCloneTokens === undefined ? '' : ` (cap ${maxCloneTokens})`;

    report.done({
        summary:
            `Duplication OK — ${percentages}; ${plural(full.statistics.total.clones, 'clone')} across ` +
            `${plural(scan.length, 'scan root')}, largest ${largest} tokens${cap}` +
            (scan.length > 1
                ? `; no cross-root copies and no name among ${plural(types, 'exported type')} declared twice`
                : '') +
            '.',
        notMachineChecked:
            'whether two identical blocks mean the same thing. jscpd matches tokens, not intent — a false positive is answered by raising the ceiling with a comment, not by contorting the code. The full report, including formats this gate does not gate, is this gate run with `--all`.',
    });
}
