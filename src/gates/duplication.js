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
 * decision, and `npm run lint:dup` still prints its number.
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

import { walkFiles } from './files.js';
import { REPO_ROOT } from './repo-root.js';
import { createGateReport, plural } from './report.js';

/** Directories whose contents are not this repo's own source. */
const DEFAULT_IGNORE_DIRS = ['__tests__', 'tests', 'node_modules', 'dist'];

/**
 * jscpd reports an SFC's script block as `Foo.vue:typescript`. Stripping the suffix is
 * what lets a path be compared against an allowlist entry or printed for a human.
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
const relative = (root, file) => path.relative(root, file.replace(/:[a-z]+$/, ''));

/**
 * @typedef {object} CloneLocation
 * @property {string} name
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {object} Clone
 * @property {string} format
 * @property {number} lines
 * @property {number} tokens
 * @property {CloneLocation} firstFile
 * @property {CloneLocation} secondFile
 */

/**
 * @typedef {object} JscpdReport
 * @property {Clone[]} duplicates
 * @property {{ formats: Record<string, { percentageTokens: number; clones: number } | undefined>,
 *             total: { clones: number } }} statistics
 */

/**
 * Run jscpd over `paths` and read its JSON report.
 *
 * jscpd is resolved out of `node_modules/.bin` rather than imported, because it is a
 * CLI. knip cannot see a binary reached that way — a path built at runtime is just a
 * string — so what keeps the dependency visible is the `lint:dup` script in
 * package.json, which names `jscpd` directly. That script is the console-reporter
 * version of this gate, for reading the clones rather than being told the total, and
 * it shares the same config file, so the two can never disagree about what counts as
 * a clone.
 *
 * @param {string} root
 * @param {string[]} paths
 * @param {string} config
 * @returns {JscpdReport}
 */
function runJscpd(root, paths, config) {
    const bin = path.resolve(root, 'node_modules/.bin/jscpd');
    if (!fs.existsSync(bin)) {
        console.error('✗ Duplication check: jscpd is not installed. Run `npm ci`.');
        process.exitCode = 1;
        return { duplicates: [], statistics: { formats: {}, total: { clones: 0 } } };
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));
    try {
        execFileSync(bin, [...paths, '--config', config, '--absolute', '--reporters', 'json', '--output', outDir], {
            cwd: root,
            stdio: 'ignore',
        });
    } catch {
        /* jscpd exits non-zero on its own thresholds and on its own errors; either way the report is written. */
    }

    const reportPath = path.join(outDir, 'jscpd-report.json');
    if (!fs.existsSync(reportPath)) {
        fs.rmSync(outDir, { recursive: true, force: true });
        console.error('✗ Duplication check: jscpd produced no report.');
        process.exitCode = 1;
        return { duplicates: [], statistics: { formats: {}, total: { clones: 0 } } };
    }

    const parsed = /** @type {JscpdReport} */ (JSON.parse(fs.readFileSync(reportPath, 'utf8')));
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
 *
 * @param {string} root
 * @param {string[]} scan
 * @param {string[]} ignoreDirs
 * @returns {Map<string, { root: string; where: string }[]>}
 */
export function exportedTypes(root, scan, ignoreDirs = DEFAULT_IGNORE_DIRS) {
    const excluded = new RegExp(`(^|/)(${ignoreDirs.join('|')})/`);
    /** @type {Map<string, { root: string; where: string }[]>} */
    const declarations = new Map();

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
 * @typedef {object} Ceiling
 * @property {number} limit Percentage of duplicated tokens this format may not exceed.
 * @property {string} [note] Why this format's number is where it is.
 */

/**
 * @typedef {object} CrossCloneAllowance
 * @property {[string, string]} files The two repo-relative paths, in either order.
 * @property {string} why What makes the two copies composition rather than logic.
 */

/**
 * @typedef {object} DuplicationOptions
 * @property {string} [root] Repository root. Defaults to the repo this runs in.
 * @property {string[]} scan Source trees to scan. One entry means rules 3 and 4 say nothing.
 * @property {Record<string, number | Ceiling>} ceilings Per-format token-percentage
 *   ceilings. A format with no entry is not gated.
 * @property {boolean} [perRoot] Also hold each scan root to the ceilings on its own.
 * @property {number} [maxCloneTokens] No single clone may exceed this. Omitted = not gated.
 * @property {CrossCloneAllowance[]} [crossCloneAllowed] Cross-root clones that are
 *   composition roots, not logic. An entry whose clone no longer exists fails the gate.
 * @property {string} [config] jscpd config file, relative to `root`. Defaults to `.jscpd.json`.
 * @property {string[]} [ignoreDirs] Directories rule 4 does not descend into.
 */

/**
 * @typedef {object} DuplicationInput
 * @property {string} root
 * @property {JscpdReport} report The run over every scan root at once.
 * @property {Record<string, JscpdReport>} [perRootReports] One run per scan root, keyed by root.
 * @property {Map<string, { root: string; where: string }[]>} [declarations] Exported type
 *   names and where each was declared.
 * @property {string[]} scan
 * @property {Record<string, number | Ceiling>} ceilings
 * @property {number} [maxCloneTokens]
 * @property {CrossCloneAllowance[]} [crossCloneAllowed]
 */

/**
 * Every rule, decided from a jscpd report and a map of declarations — no filesystem,
 * no child process.
 *
 * Split out for the same reason the audit gate is: the alternative way to test rule 2
 * is to check a 141-token clone into a fixture repo and run the real jscpd over it,
 * which makes the suite depend on a binary, on that binary's tokenizer, and on nobody
 * ever reformatting the fixture. Here the crafted report IS the contract, and the
 * runner's only job is to produce one.
 *
 * @param {DuplicationInput} input
 * @returns {{ problems: import('./report.js').GateFailure[]; types: number }}
 */
export function inspectDuplication(input) {
    const {
        root,
        report,
        perRootReports = {},
        declarations = new Map(),
        scan,
        ceilings,
        maxCloneTokens,
        crossCloneAllowed = [],
    } = input;

    /** @type {import('./report.js').GateFailure[]} */
    const problems = [];
    /** @param {string | null} file @param {string} what @param {string} why */
    const fail = (file, what, why) => problems.push({ file, what, why });

    /** @param {number | Ceiling} entry */
    const ceilingOf = (entry) => (typeof entry === 'number' ? { limit: entry, note: undefined } : entry);
    const rel = /** @param {string} file */ (file) => relative(root, file);
    const loc = /** @param {CloneLocation} f */ (f) => `${rel(f.name)}:${f.start}-${f.end}`;

    const clones = report.duplicates.slice().sort((a, b) => b.tokens - a.tokens);

    /**
     * Record a clone under the file it starts in, so the reporter groups it there and an
     * editor can jump straight to it. Both originals printed the two paths as unanchored
     * indented lines under a bullet, which is two clicks further away from the code.
     *
     * @param {Clone} clone
     * @param {string} why
     */
    const failClone = (clone, why) => {
        fail(loc(clone.firstFile), `${plural(clone.tokens, 'token')} duplicated at ${loc(clone.secondFile)}`, why);
    };

    /**
     * @param {JscpdReport} source
     * @param {string | null} where
     */
    const checkCeilings = (source, where) => {
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
    const rootOf = /** @param {string} file */ (file) => scan.find((r) => rel(file).startsWith(`${r}/`));
    const isPair = /** @param {Clone} c @param {[string, string]} pair */ (c, [a, b]) => {
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

/**
 * @param {DuplicationOptions} options
 * @returns {void}
 */
export function checkDuplication(options) {
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

    const report = createGateReport({ name: 'Duplication', standard: 'refactoring.instructions.md' });

    const full = runJscpd(root, scan, config);
    /** @type {Record<string, JscpdReport>} */
    const perRootReports = {};
    if (perRoot) {
        for (const scanRoot of scan) perRootReports[scanRoot] = runJscpd(root, [scanRoot], config);
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

    const ceilingOf = /** @param {number | Ceiling} entry */ (entry) =>
        typeof entry === 'number' ? entry : entry.limit;

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
            'whether two identical blocks mean the same thing. jscpd matches tokens, not intent — a false positive is answered by raising the ceiling with a comment, not by contorting the code. The full report, including formats this gate does not gate, is `npm run lint:dup`.',
    });
}

export default checkDuplication;
