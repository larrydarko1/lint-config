/**
 * Duplication, via one jscpd run over every scan root:
 * ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Per-format token-percentage ceilings. A format with no entry is not gated;
 *      `--all` still prints it.
 *   2. No single clone over `maxCloneTokens`, which a shrinking ratio cannot hide.
 *   3. No block copied between scan roots, except allowed composition roots.
 *   4. No exported type name declared in two roots.
 *   5. No two icon components draw the same picture.
 * - Rules 3 and 4 say nothing in a single-root repo, rule 5 nothing in one with no
 * `components/icons/`. `perRoot` also holds each root to the ceilings on its own.
 * jscpd matches tokens, not intent: raise a ceiling with a reason rather than contort
 * the code.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packageBin } from './lib/bin.ts';
import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

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

type Ceiling = {
    /** Percentage of duplicated tokens this format may not exceed. */
    limit: number;
    /** Why this format's number is where it is. Printed as the failure's reason. */
    note?: string;
};

type CrossCloneAllowance = {
    /** The two repo-relative paths, in either order. */
    files: [string, string];
    /** What makes the two copies composition rather than logic. */
    why: string;
};

/** jscpd's JSON report, reduced to what this gate reads. */
type CloneLocation = { name: string; start: number; end: number };

type Clone = {
    format: string;
    lines: number;
    tokens: number;
    firstFile: CloneLocation;
    secondFile: CloneLocation;
};

type JscpdReport = {
    duplicates: Clone[];
    statistics: {
        formats: Record<string, { percentageTokens: number; clones: number } | undefined>;
        total: { clones: number };
    };
};

type TypeDeclaration = { root: string; where: string };

type DuplicationInput = {
    root: string;
    /** The run over every scan root at once. */
    report: JscpdReport;
    /** One run per scan root, keyed by root. Absent roots are simply not checked. */
    perRootReports?: Record<string, JscpdReport>;
    /** Exported type names and where each was declared. */
    declarations?: Map<string, TypeDeclaration[]>;
    /** Icon components grouped by what they draw: one key, every file drawing it. */
    icons?: Map<string, string[]>;
    scan: string[];
    ceilings: Record<string, number | Ceiling>;
    maxCloneTokens?: number | undefined;
    crossCloneAllowed?: CrossCloneAllowance[];
};

type DuplicationInspection = {
    problems: GateFailure[];
    /** How many distinct exported type names were seen. */
    types: number;
    /** How many icon components were seen. */
    icons: number;
};

/** Directories whose contents are not this repo's own source. */
const DEFAULT_IGNORE_DIRS = ['__tests__', 'tests', 'node_modules', 'dist'];

/** Where the standard keeps icons: one component per icon, in this folder. */
const ICON_FILE = /(^|\/)components\/icons\/[^/]+\.vue$/;

/**
 * What an icon draws, as a string two copies of one drawing share. The viewBox and the
 * root's `fill`/`stroke` are part of the picture — the same star filled and outlined
 * is two icons. The stroke's width and its caps and joins are not: those are what a
 * caller overrides (`<IconImage stroke-width="1.5" />`), so two files differing only
 * there are one icon at two weights. Attribute order, whitespace and `<x></x>` vs
 * `<x />` are spelling. Null when the file holds no `<svg>`.
 */
export function iconDrawing(source: string): string | null {
    const svg = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(source);
    if (svg === null) return null;

    const attrs = (raw: string) =>
        [...raw.matchAll(/([:@\w.-]+)(?:\s*=\s*"([^"]*)")?/g)].map(([, name = '', value]) =>
            value === undefined ? name : `${name}="${value}"`,
        );
    const root = attrs(svg[1] ?? '')
        .filter((a) => /^(viewBox|fill|stroke)=/.test(a))
        .sort();
    const body = (svg[2] ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<([\w:-]+)([^>]*?)>\s*<\/\1>/g, '<$1$2/>')
        .replace(
            /<([\w:-]+)([^>]*?)\s*(\/?)>/g,
            (_, tag: string, raw: string, close: string) => `${[`<${tag}`, ...attrs(raw).sort()].join(' ')}${close}>`,
        )
        .replace(/\s+/g, ' ')
        .replace(/>\s+</g, '><')
        .trim();
    return `${root.join(' ')}|${body}`;
}

/** Every icon component under the scan roots, grouped by what it draws. */
export function iconDrawings(root: string, scan: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const rel of walkFiles(root, scan, { match: ICON_FILE })) {
        const drawing = iconDrawing(fs.readFileSync(path.join(root, rel), 'utf8'));
        if (drawing === null) continue;
        groups.set(drawing, [...(groups.get(drawing) ?? []), rel]);
    }
    return groups;
}

/** Every exported type and interface name, and where it was declared. */
export function exportedTypes(
    root: string,
    scan: string[],
    ignoreDirs: string[] = DEFAULT_IGNORE_DIRS,
): Map<string, TypeDeclaration[]> {
    const excluded = new RegExp(`(^|/)(${ignoreDirs.join('|')})/`);
    const declarations = new Map<string, { root: string; where: string }[]>();

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

/** Every rule, decided from a jscpd report and a map of declarations, so it is testable without jscpd. */
export function inspectDuplication(input: DuplicationInput): DuplicationInspection {
    const {
        root,
        report,
        perRootReports = {},
        declarations = new Map<string, TypeDeclaration[]>(),
        icons = new Map<string, string[]>(),
        scan,
        ceilings,
        maxCloneTokens,
        crossCloneAllowed = [],
    } = input;

    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => problems.push({ file, what, why });

    const ceilingOf = (entry: number | Ceiling) =>
        typeof entry === 'number' ? { limit: entry, note: undefined } : entry;
    const rel = (file: string) => relative(root, file);
    const loc = (f: CloneLocation) => `${rel(f.name)}:${f.start}-${f.end}`;

    const clones = report.duplicates.slice().sort((a, b) => b.tokens - a.tokens);

    /** Record a clone under the file it starts in, so an editor can jump to it. */
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
    const isPair = (c: Clone, [a, b]: [string, string]) => {
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

    // -- 5. Two icon components drawing the same picture -------------------------
    for (const files of icons.values()) {
        if (files.length < 2) continue;
        const [first = '', ...rest] = files;
        fail(
            first,
            `draws the same icon as ${rest.join(', ')}`,
            'Keep one file and import it everywhere. Two copies of one icon are how it drifts — one gets redrawn and the other does not. A different stroke weight is not a different icon: pass `stroke-width` where it is used.',
        );
    }

    return { problems, types: declarations.size, icons: [...icons.values()].flat().length };
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

    // `--all`: jscpd's own console report, every format, no ceilings.
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

    const report = createGateReport({ name: 'Duplication' });

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

    const { problems, types, icons } = inspectDuplication({
        root,
        report: full,
        perRootReports,
        declarations: scan.length > 1 ? exportedTypes(root, scan, ignoreDirs) : new Map(),
        icons: iconDrawings(root, scan),
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
            `${plural(scan.length, 'scan root')}, largest ${largest} tokens${cap}${
                scan.length > 1
                    ? `; no cross-root copies and no name among ${plural(types, 'exported type')} declared twice`
                    : ''
            }${icons > 0 ? `; ${plural(icons, 'icon')}, none drawn twice` : ''}.`,
        notMachineChecked:
            'whether two identical blocks mean the same thing. jscpd matches tokens, not intent — a false positive is answered by raising the ceiling with a comment, not by contorting the code. Two icons that draw one picture with different shapes (a `<polyline>` and the `<path>` tracing it, four slightly different bins) — only identical drawings are caught. The full report, including formats this gate does not gate, is this gate run with `--all`.',
    });
}

/** jscpd reports an SFC's script block as `Foo.vue:typescript`; strip the suffix. */
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
