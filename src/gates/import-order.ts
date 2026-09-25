/**
 * Import order. Imports are grouped by how far away the code lives, farthest first:
 *
 *    1. builtin    — `node:fs`, and bare `fs` / `path`
 *    2. external   — npm packages, `electron` included
 *    3. workspace  — this monorepo's other packages (only where `workspaceScope` is set)
 *    4. local      — `@/…`, `./…`, `../…`, `#…`, and any `localAliases`
 *
 * One blank line between groups, none inside one, alphabetical by specifier
 * (case-insensitive) within a group. Groups are by source, not kind: inline type
 * imports share a statement with values.
 *
 * Side-effect imports (`import 'dotenv/config'`) never move; they split the run into
 * segments sorted independently. Only the leading run of imports is checked.
 */
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';

export type ImportProblem = { line: number; message: string };

export type ImportAnalysis = {
    /** Every place the import run departs from canonical order, sorted by line. */
    problems: ImportProblem[];
    /** How many imports were in the leading run. */
    count: number;
    /** The same source with the run rewritten into canonical order. */
    fixed: string;
};

export type ImportOrderOptions = {
    /** The npm scope this monorepo's own packages use, e.g. `'@acme/'`. */
    workspaceScope?: string;
    /** tsconfig `paths` entries that look like packages but point into this repo. */
    localAliases?: string[];
};

/** Function-valued properties, not methods, so destructuring does not trip `unbound-method`. */
export type ImportOrder = {
    IMPORT_GROUPS: string[];
    /** `null` when the file is an SFC with no script block. */
    checkImportsInFile: (rel: string, root: string) => ImportAnalysis | null;
    /** Rewrites the file in place. Returns whether anything changed. */
    fixImportsInFile: (rel: string, root: string) => boolean;
};

/** One import in the leading run, with the span of text that moves with it. */
type ImportItem = { spec: string; group: number; line: number; sideEffect: boolean; start: number; end: number };

const BUILTINS = new Set(builtinModules);

/**
 * @param [options.workspaceScope] The npm scope this monorepo's own packages use
 *   (`'@acme/'`). Set it and those imports get their own group between external and local;
 *   leave it out and there are three groups, which is what a single-package repo wants.
 * @param [options.localAliases=[]] tsconfig `paths` entries that look like npm
 *   packages but point into this repo (`'@test-utils'`), so they sort as local.
 */
export function createImportOrder(options: ImportOrderOptions = {}): ImportOrder {
    const { workspaceScope, localAliases = [] } = options;

    const IMPORT_GROUPS = workspaceScope
        ? ['builtin', 'external', 'workspace', 'local']
        : ['builtin', 'external', 'local'];

    const LOCAL = IMPORT_GROUPS.length - 1;

    const groupOf = (spec: string): number => {
        if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0] ?? spec)) return 0;
        if (spec.startsWith('@/') || spec.startsWith('.') || spec.startsWith('#')) return LOCAL;
        if (localAliases.some((alias) => spec === alias || spec.startsWith(`${alias}/`))) return LOCAL;
        if (workspaceScope !== undefined && spec.startsWith(workspaceScope)) return 2;
        return 1;
    };

    const sortKey = (item: ImportItem): string => item.spec.toLowerCase();

    const compare = (a: ImportItem, b: ImportItem): number => {
        if (a.group !== b.group) return a.group - b.group;
        const ka = sortKey(a);
        const kb = sortKey(b);
        if (ka === kb) return 0;
        return ka < kb ? -1 : 1;
    };

    /**
     * The leading run of imports. Attached comments move with their import, except the
     * first import's leading comment, which is the file header.
     */
    const collect = (code: string, sf: ts.SourceFile): ImportItem[] => {
        const items: ImportItem[] = [];
        for (const stmt of sf.statements) {
            if (!ts.isImportDeclaration(stmt)) break;
            const lineEnd = code.indexOf('\n', stmt.end);
            const end = lineEnd === -1 ? code.length : lineEnd;
            let start = stmt.getStart(sf);
            if (items.length > 0) {
                const comments = ts.getLeadingCommentRanges(code, stmt.getFullStart()) ?? [];
                const first = comments.find((c) => !/\n\s*\n/.test(code.slice(c.end, start)));
                if (first !== undefined) start = first.pos;
            }
            const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
            items.push({
                spec,
                group: groupOf(spec),
                line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
                sideEffect: stmt.importClause === undefined,
                start,
                end,
            });
        }
        return items;
    };

    /** Splits the run at side-effect imports, which never move. */
    const segments = (items: ImportItem[]): ImportItem[][] => {
        const out: ImportItem[][] = [[]];
        for (const item of items) {
            if (item.sideEffect) out.push([]);
            else out[out.length - 1]?.push(item);
        }
        return out.filter((seg) => seg.length > 0);
    };

    const blankLinesBetween = (code: string, a: ImportItem, b: ImportItem): number =>
        code.slice(a.end, b.start).split('\n').length - 2;

    const render = (code: string, seg: ImportItem[]): string => {
        const sorted = [...seg].sort(compare);
        return sorted
            .map((item, idx) => {
                const prev = sorted[idx - 1];
                if (prev === undefined) return code.slice(item.start, item.end);
                return (prev.group === item.group ? '\n' : '\n\n') + code.slice(item.start, item.end);
            })
            .join('');
    };

    const analyzeImports = (code: string, filename: string): ImportAnalysis => {
        const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
        const items = collect(code, sf);
        const problems: ImportProblem[] = [];
        let fixed = code;

        // Right to left, so earlier offsets stay valid while later segments are replaced.
        for (const seg of segments(items).reverse()) {
            const sorted = [...seg].sort(compare);
            sorted.forEach((item, idx) => {
                if (seg[idx] !== item) {
                    const prev = sorted[idx - 1];
                    problems.push({
                        line: item.line,
                        message: `"${item.spec}" (${IMPORT_GROUPS[item.group]}) belongs ${prev === undefined ? 'first' : `after "${prev.spec}"`}`,
                    });
                }
            });

            for (let idx = 1; idx < seg.length; idx += 1) {
                const prev = seg[idx - 1];
                const item = seg[idx];
                if (prev === undefined || item === undefined || prev.group > item.group) continue;
                const blanks = blankLinesBetween(code, prev, item);
                const want = prev.group === item.group ? 0 : 1;
                if (blanks !== want) {
                    problems.push({
                        line: item.line,
                        message:
                            want === 0
                                ? `blank line inside the ${IMPORT_GROUPS[item.group]} group, above "${item.spec}"`
                                : `needs exactly one blank line between the ${IMPORT_GROUPS[prev.group]} and ${IMPORT_GROUPS[item.group]} groups, above "${item.spec}"`,
                    });
                }
            }

            const first = seg[0];
            const last = seg[seg.length - 1];
            // A floating comment belongs to neither import; report but do not rewrite.
            const floating = seg.some(
                (item, idx) => idx > 0 && code.slice(seg[idx - 1]?.end, item.start).trim() !== '',
            );
            if (first !== undefined && last !== undefined && !floating) {
                fixed = fixed.slice(0, first.start) + render(code, seg) + fixed.slice(last.end);
            }
        }

        problems.sort((a, b) => a.line - b.line);
        return { problems, count: items.length, fixed };
    };

    /** One file's script text, unwrapping an SFC's <script setup> — and where it sits. */
    const readScript = (rel: string, root: string): { source: string; code: string; offset: number } | null => {
        const source = fs.readFileSync(path.join(root, rel), 'utf8');
        if (!rel.endsWith('.vue')) return { source, code: source, offset: 0 };
        const { descriptor } = parseSfc(source, { filename: rel });
        const block = descriptor.scriptSetup ?? descriptor.script;
        if (block === null) return null;
        return { source, code: block.content, offset: block.loc.start.offset };
    };

    /** Analyses a file's imports, with problem lines relative to the whole file. */
    const checkImportsInFile = (rel: string, root: string): ImportAnalysis | null => {
        const script = readScript(rel, root);
        if (script === null) return null;
        const res = analyzeImports(script.code, rel.endsWith('.vue') ? `${rel}.ts` : rel);
        const lineOffset = script.source.slice(0, script.offset).split('\n').length - 1;
        for (const problem of res.problems) problem.line += lineOffset;
        return res;
    };

    /** Rewrites a file's import block into canonical order. Returns whether it changed. */
    const fixImportsInFile = (rel: string, root: string): boolean => {
        const script = readScript(rel, root);
        if (script === null) return false;
        const { fixed } = analyzeImports(script.code, rel);
        if (fixed === script.code) return false;
        const { source, offset, code } = script;
        fs.writeFileSync(path.join(root, rel), source.slice(0, offset) + fixed + source.slice(offset + code.length));
        return true;
    };

    return { IMPORT_GROUPS, checkImportsInFile, fixImportsInFile };
}
