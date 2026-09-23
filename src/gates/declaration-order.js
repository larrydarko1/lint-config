/**
 * Declaration order gate.
 *
 * The canonical order within a module:
 *    1. imports          — `import` statements
 *    2. types            — interfaces, type aliases, Zod schemas: the vocabulary
 *    3. contract         — defineProps / defineEmits: the SFC's public API, which
 *                          everything below it reads as `props`
 *    4. constants        — thresholds, ids, feature flags, SCREAMING_SNAKE config
 *    5. classes          — exported first, then private
 *    6. state            — singletons, caches, lazy loaders, module-level refs
 *    7. exported-fns     — the public API, the headline
 *    8. private-fns      — implementation detail, grouped by concern
 *    9. side-effects     — onMounted / watch / listener wiring: statements that RUN
 *                          at load and reference every layer above
 *
 * This is a hard rule. There is one exception and it is not a list someone
 * maintains — it is computed, because the only thing that can legitimately
 * override the table is the module failing to load.
 *
 * HOW THE EXCEPTION WORKS. `const` and `class` bindings sit in a temporal dead
 * zone and side-effect statements run at load, so the table is not uniformly safe
 * to impose: moving a statement above something it reads is a ReferenceError at
 * import time — the module never loads, and no test catches it because nothing
 * gets far enough to run. So the canonical order is computed as a topological sort
 * keyed by category (see analyze() below): an edge A→B exists when B reads, at load
 * time, a binding A declares, and the sort always takes the available statement
 * with the lowest (category, original position). The result is the table wherever
 * the dependencies permit, and the dependency everywhere else.
 *
 * Hoisted `function` declarations and type-only declarations create no edges — they
 * are visible wherever they sit — which is why the bulk of the ordering is free.
 *
 * The shape that earns it in a Vue codebase is `defineExpose({ el })`: contract
 * (#3) reading a template ref that is state (#6), so hoisting it to position 3
 * would put it above the `ref()` it exposes.
 *
 * SCOPE is `sourceRoots`, in two passes. Test files get the SECOND pass, against a
 * different table (TEST_CATEGORIES): imports → types → mocks → constants → helpers
 * → hooks → tests. A suite used to be out of scope on the grounds that its order
 * was dictated by `vi.mock` hoisting rather than by design, which had it backwards
 * — the hoisting is precisely what fixes `vi.mock`'s position, and a file that
 * writes it lower down misrepresents what runs first. What is true is that the
 * production table cannot express the rule: `vi.mock`, `beforeEach` and `describe`
 * are all expression statements, so it bins all three as side-effects and sorts the
 * mocks LAST. Hence two tables.
 *
 * INSIDE LAYER 1. Imports are the one category whose internal order is mechanical,
 * so a third pass sorts them — see the header of ./import-order.js for why the
 * groups are by source and not by kind. That pass is the only one `--fix` touches,
 * because it is the only one whose fix cannot change what the module does:
 * side-effect imports never move.
 *
 * WHAT THIS CANNOT SEE. Whether two statements in the SAME category are in a
 * sensible order relative to each other, imports aside. The table says private
 * functions are "grouped by concern"; grouping is a judgement about meaning, and
 * the sort preserves existing relative order within a category rather than
 * inventing one.
 *
 * WHY THIS GATE DOES NOT USE createGateReport. Its finding is not one line per
 * file: it is a headline per file with a nested, line-numbered list under it, and
 * a closing paragraph explaining that every position it names is reachable. The
 * shared reporter's shape (file → what → why) would flatten that into one entry
 * per misplaced statement and lose the grouping that makes a 40-statement module
 * reviewable.
 *
 * WHAT WAS DECIDED HERE. Five copies existed and the only differences were the
 * source roots, the import groups, and one rule: Fern's `isTestPath` also treats a
 * top-level `tests/` directory as suites, where the full-stack copies matched only
 * colocated `__tests__`. Fern's is the superset and neither full-stack repo has a
 * `tests/` directory under a source root, so it is the one that ships — the other
 * four projects' output is unchanged by it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';

import { walkFiles } from './files.js';
import { createImportOrder } from './import-order.js';
import { REPO_ROOT } from './repo-root.js';

export const CATEGORIES = [
    'imports',
    'types',
    'contract',
    'constants',
    'classes',
    'state',
    'exported-fns',
    'private-fns',
    'side-effects',
];

/**
 * A test file's order. Not a subset of CATEGORIES: three of those layers cannot
 * occur in a suite (a test file has no contract, no classes, and exports nothing),
 * and two of the rest invert. `vi.mock` is an expression statement, so the
 * production classifier bins it as a side-effect and sorts it LAST — the exact
 * opposite of where Vitest actually runs it. `beforeEach` and `describe` classify
 * identically, which collapses the three statements this rule is about into one
 * category where the sort has nothing left to say. Hence a separate list rather
 * than a flag on the existing one.
 */
export const TEST_CATEGORIES = ['imports', 'types', 'mocks', 'constants', 'helpers', 'hooks', 'tests'];

/**
 * Classifying a statement is an AST question, not a regex one: telling
 * `const x = () => {}` (a function) from `const x = ref(0)` (state) from
 * `const X = 'a'` (config) is a question about an initializer's shape, and "is this
 * identifier exported" is a question about modifiers.
 *
 * Two judgement calls are baked in, because the categories genuinely overlap:
 *
 *   1. A ZOD SCHEMA IS VOCABULARY, NOT STATE. `const FileInfoSchema = z.object({})`
 *      is the runtime half of a type declaration — Zod blurs the type/value line on
 *      purpose, and the whole idiom is `const XSchema` sitting next to
 *      `type X = z.infer<typeof XSchema>`. Binning the schema as state would rule
 *      that pairing a violation and make a schemas/ directory unfixable without
 *      making it worse to read.
 *   2. SCREAMING_SNAKE IS CONFIG EVEN WHEN COMPUTED. `const FERN_HOME =
 *      path.join(os.homedir(), '.fern')` is configuration; the call in the
 *      initializer does not make it mutable state. The naming convention is the
 *      only signal that separates the two, so it is the one used.
 */

/** @typedef {{ categories: string[]; classify: (s: ts.Statement) => string; eager?: string }} Profile */
/** @typedef {{ i: number; cat: string; name: string; line: number; decls: string[]; refs: Set<string>; hoisted: boolean; typeOnly: boolean }} Item */
/** @typedef {{ cat: string; name: string; line: number; belongsAfter: string }} Misplaced */
/** @typedef {{ misplaced: Misplaced[]; count: number; cycle?: boolean; order?: number[] }} Analysis */

/** @type {Profile} */
const PRODUCTION_PROFILE = { categories: CATEGORIES, classify: (s) => classify(s) };

/**
 * `eager` names the category whose function bodies run during the import phase.
 * A `vi.mock` / `vi.hoisted` factory is an arrow, so the default analysis skips
 * its body as "runs later", which is true of every other arrow in a module and
 * false of these two — Vitest invokes them while resolving imports. Without this,
 * a fake class the factory closes over looks unreferenced and the sort cheerfully
 * moves it below the mock that needs it, which is a TDZ ReferenceError at import
 * time.
 *
 * @type {Profile}
 */
const TEST_PROFILE = { categories: TEST_CATEGORIES, classify: (s) => classifyTest(s), eager: 'mocks' };

/**
 * A suite, or a module that only exists to support one: a `tests/` directory holds
 * nothing else.
 *
 * @param {string} rel
 * @returns {boolean}
 */
export const isTestPath = (rel) => /(^|\/)(tests|__tests__)\//.test(rel) || /\.(test|spec)\.ts$/.test(rel);

/**
 * @param {string} rel
 * @returns {Profile}
 */
const profileFor = (rel) => (isTestPath(rel) ? TEST_PROFILE : PRODUCTION_PROFILE);

const MACROS = new Set(['defineProps', 'defineEmits', 'defineModel', 'defineSlots', 'defineExpose', 'withDefaults']);

/**
 * @param {ts.Node | undefined} n
 * @returns {boolean}
 */
const isFnLike = (n) => n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

/**
 * A literal-ish initializer: safe to call "constant" rather than "state".
 *
 * @param {ts.Node | undefined} n
 * @returns {boolean}
 */
function isConstantInit(n) {
    if (n === undefined) return false;
    if (ts.isAsExpression(n)) return isConstantInit(n.expression);
    if (ts.isLiteralExpression(n) || ts.isNumericLiteral(n) || ts.isStringLiteral(n)) return true;
    if (
        n.kind === ts.SyntaxKind.TrueKeyword ||
        n.kind === ts.SyntaxKind.FalseKeyword ||
        n.kind === ts.SyntaxKind.NullKeyword
    )
        return true;
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isRegularExpressionLiteral(n)) return true;
    if (ts.isPrefixUnaryExpression(n)) return isConstantInit(n.operand);
    if (ts.isArrayLiteralExpression(n)) return n.elements.every(isConstantInit);
    if (ts.isObjectLiteralExpression(n))
        return n.properties.every((p) => ts.isPropertyAssignment(p) && isConstantInit(p.initializer));
    if (
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        ['Set', 'Map', 'RegExp'].includes(n.expression.text)
    ) {
        return (n.arguments ?? []).every(isConstantInit);
    }
    return false;
}

/**
 * The identifier a call/property chain is rooted at: `z.object({}).strict()` → `z`.
 *
 * @param {ts.Node | undefined} n
 * @returns {string | null}
 */
function rootIdentifier(n) {
    let e = n;
    while (e !== undefined) {
        if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
        else if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
        else break;
    }
    return e !== undefined && ts.isIdentifier(e) ? e.text : null;
}

/**
 * @param {ts.Node | undefined} n
 * @returns {string | null}
 */
function callName(n) {
    let e = n;
    if (e !== undefined && ts.isAsExpression(e)) e = e.expression;
    if (e !== undefined && ts.isCallExpression(e)) {
        if (ts.isIdentifier(e.expression)) return e.expression.text;
        if (ts.isPropertyAccessExpression(e.expression)) return e.expression.name.text;
    }
    return null;
}

/**
 * @param {ts.Statement} stmt
 * @returns {string}
 */
function classify(stmt) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) return 'imports';
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) return 'imports';
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return 'types';
    if (ts.isClassDeclaration(stmt)) return 'classes';
    if (ts.isEnumDeclaration(stmt)) return 'constants';

    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(stmt)) return exported ? 'exported-fns' : 'private-fns';

    if (ts.isVariableStatement(stmt)) {
        const decls = stmt.declarationList.declarations;
        if (decls.some((d) => MACROS.has(callName(d.initializer) ?? ''))) return 'contract';
        if (decls.some((d) => isFnLike(d.initializer))) return exported ? 'exported-fns' : 'private-fns';
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
        // A Zod schema is the runtime half of a type declaration — vocabulary, not state.
        // Zod deliberately blurs the type/value line, and `const XSchema = z.object({})`
        // sitting beside `type X = z.infer<typeof XSchema>` is the point of using it.
        if (isConst && decls.some((d) => rootIdentifier(d.initializer) === 'z' || /Schema$/.test(d.name.getText())))
            return 'types';
        if (!isConst) return 'state';
        // A reactive container or an explicit mutable holder is state whatever it is named.
        const REACTIVE = new Set([
            'ref',
            'shallowRef',
            'reactive',
            'shallowReactive',
            'computed',
            'customRef',
            'useTemplateRef',
        ]);
        if (decls.some((d) => REACTIVE.has(callName(d.initializer) ?? ''))) return 'state';
        // SCREAMING_SNAKE is the repo's marker for config, even when it is computed
        // (`const FERN_HOME = path.join(os.homedir(), '.fern')` is configuration, not state).
        const allShouty = decls.every((d) => ts.isIdentifier(d.name) && /^[A-Z][A-Z0-9_]*$/.test(d.name.text));
        if (allShouty) return 'constants';
        if (decls.every((d) => isConstantInit(d.initializer))) return 'constants';
        return 'state';
    }

    if (ts.isExpressionStatement(stmt)) {
        if (MACROS.has(callName(stmt.expression) ?? '')) return 'contract';
        return 'side-effects';
    }
    return 'side-effects';
}

/**
 * `vi.hoisted` is in the mock block, not among the constants: the factory below it
 * reads the spies it returns, and Vitest lifts both above the imports together.
 */
const MOCK_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'hoisted']);
const HOOK_CALLS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const TEST_CALLS = new Set(['describe', 'it', 'test']);

/**
 * @param {ts.Statement} stmt
 * @returns {string}
 */
function classifyTest(stmt) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) return 'imports';
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) return 'imports';
    if (ts.isFunctionDeclaration(stmt)) return 'helpers';
    // Types, enums and fake classes are the vocabulary the mock block is written in
    // — `class FakeProc extends EventEmitter` exists to be returned from a factory.
    // They sit above it for the same reason types sit at layer 2 in production.
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return 'types';
    if (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) return 'types';

    if (ts.isVariableStatement(stmt)) {
        const decls = stmt.declarationList.declarations;
        if (decls.some((d) => MOCK_CALLS.has(callName(d.initializer) ?? ''))) return 'mocks';
        if (decls.some((d) => isFnLike(d.initializer))) return 'helpers';
        // Everything else a suite declares is fixture data. The production
        // classifier's state/constants split is about a module's mutable surface,
        // which is not a question a test file raises.
        return 'constants';
    }

    if (ts.isExpressionStatement(stmt)) {
        const call = callName(stmt.expression);
        const root = rootIdentifier(stmt.expression);
        if (root === 'vi' && MOCK_CALLS.has(call ?? '')) return 'mocks';
        if (HOOK_CALLS.has(call ?? '')) return 'hooks';
        // `describe.each([...])('…')` roots at `describe` but has no callName —
        // its callee is itself a call — so the root is what identifies it.
        if (TEST_CALLS.has(root ?? '')) return 'tests';
        // Anything else running at load — `vi.useFakeTimers()`, `expect.extend()`,
        // `enableAutoUnmount(afterEach)` — is setup, and setup precedes the tests.
        return 'hooks';
    }
    return 'hooks';
}

/**
 * Names a statement binds at module scope.
 *
 * @param {ts.Statement} stmt
 * @returns {string[]}
 */
function declaredNames(stmt) {
    /** @type {string[]} */
    const out = [];
    /** @param {ts.Node | undefined} n */
    const push = (n) => {
        if (n !== undefined && ts.isIdentifier(n)) out.push(n.text);
    };
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) push(stmt.name);
    else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt))
        push(stmt.name);
    else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
            /** @param {ts.BindingName} name */
            const collect = (name) => {
                if (ts.isIdentifier(name)) out.push(name.text);
                else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
                    for (const el of name.elements) if (ts.isBindingElement(el)) collect(el.name);
                }
            };
            collect(d.name);
        }
    } else if (ts.isImportDeclaration(stmt)) {
        const c = stmt.importClause;
        if (c?.name !== undefined) out.push(c.name.text);
        if (c?.namedBindings !== undefined) {
            if (ts.isNamespaceImport(c.namedBindings)) out.push(c.namedBindings.name.text);
            else for (const e of c.namedBindings.elements) out.push(e.name.text);
        }
    }
    return out;
}

/**
 * Identifiers a statement evaluates AT LOAD TIME. Function/arrow bodies are skipped:
 * they run later, so a name they reference need not be declared above them.
 *
 * @param {ts.Statement} stmt
 * @param {boolean} [eager=false]
 * @returns {Set<string>}
 */
function loadTimeRefs(stmt, eager = false) {
    /** @type {Set<string>} */
    const out = new Set();
    /** @param {ts.Node} n */
    const isTypePos = (n) => {
        /** @type {ts.Node | undefined} */
        let p = n.parent;
        while (p !== undefined) {
            if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
            if (ts.isExpression(p) || ts.isStatement(p)) return false;
            p = p.parent;
        }
        return false;
    };
    /** @param {ts.Node} n */
    const visit = (n) => {
        const isFnNode =
            ts.isFunctionDeclaration(n) ||
            ts.isFunctionExpression(n) ||
            ts.isArrowFunction(n) ||
            ts.isMethodDeclaration(n) ||
            ts.isGetAccessor(n) ||
            ts.isSetAccessor(n);
        // Skip the body; parameter defaults still evaluate at call time, not load.
        // Unless `eager`: a mock factory's body IS load time (see TEST_PROFILE).
        if (isFnNode && !eager) return;
        if (ts.isIdentifier(n)) {
            const p = n.parent;
            const isPropName =
                (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
            if (!isPropName && !isTypePos(n)) out.add(n.text);
        }
        ts.forEachChild(n, visit);
    };
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) return out;
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
        // A class body's heritage clause evaluates at load; methods do not.
        if (ts.isClassDeclaration(stmt) && stmt.heritageClauses !== undefined) {
            for (const h of stmt.heritageClauses) ts.forEachChild(h, visit);
        }
        return out;
    }
    ts.forEachChild(stmt, visit);
    // A declaration does not reference itself: the binding name is not a read.
    for (const d of declaredNames(stmt)) out.delete(d);
    return out;
}

/**
 * @param {ts.Statement} s
 * @param {ts.SourceFile} sf
 * @returns {string}
 */
function nameOf(s, sf) {
    if (
        ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isEnumDeclaration(s)
    )
        return s.name?.text ?? '';
    if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => d.name.getText(sf)).join(', ');
    if (ts.isImportDeclaration(s)) return s.moduleSpecifier.getText(sf).replace(/['"]/g, '');
    return (s.getText(sf).split('\n')[0] ?? '').slice(0, 40);
}

/**
 * The canonical order for a module's statements, and which of them are misplaced.
 *
 * Order is a topological sort keyed by category: an edge A→B exists when B reads,
 * at load time, a binding that A declares. Kahn's algorithm then always takes the
 * available statement with the lowest (category, original position). The result is
 * canonical order everywhere the dependencies permit, and never places a statement
 * above something it reads — so the ONLY departures from the table are the ones
 * where obeying it would throw a ReferenceError at import time.
 *
 * Hoisted `function` declarations and type-only declarations contribute no edges:
 * they are visible regardless of where they sit.
 *
 * `misplaced` is the minimum set of statements to move, computed as everything
 * outside the longest common subsequence of the actual and ideal sequences — so one
 * statement in the wrong place is reported as one problem, not as every statement
 * after it having shifted.
 *
 * @param {string} code
 * @param {string} filename
 * @param {Profile} [profile]
 * @returns {Analysis}
 */
function analyze(code, filename, profile = PRODUCTION_PROFILE) {
    const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const stmts = [...sf.statements];
    if (stmts.length < 2) return { misplaced: [], count: stmts.length };

    /** @param {string} c */
    const rank = (c) => profile.categories.indexOf(c);
    /** @type {Item[]} */
    const items = stmts.map((s, i) => {
        const cat = profile.classify(s);
        return {
            i,
            cat,
            name: nameOf(s, sf),
            line: sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1,
            decls: declaredNames(s),
            refs: loadTimeRefs(s, profile.eager === cat),
            hoisted: ts.isFunctionDeclaration(s),
            typeOnly: ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s),
        };
    });

    /** @type {Map<string, Item>} */
    const declaredBy = new Map();
    for (const it of items) {
        if (it.hoisted || it.typeOnly) continue;
        for (const d of it.decls) if (!declaredBy.has(d)) declaredBy.set(d, it);
    }

    // Every item is put in both maps here, so `edges` cannot miss.
    /** @type {Map<Item, Set<Item>>} */
    const deps = new Map(items.map((it) => [it, new Set()]));
    /** @type {Map<Item, Set<Item>>} */
    const dependents = new Map(items.map((it) => [it, new Set()]));
    /**
     * @param {Map<Item, Set<Item>>} graph
     * @param {Item} it
     * @returns {Set<Item>}
     */
    const edges = (graph, it) => {
        const set = graph.get(it);
        if (set === undefined) throw new Error(`declaration-order: "${it.name}" is missing from the graph`);
        return set;
    };
    for (const it of items) {
        for (const r of it.refs) {
            const src = declaredBy.get(r);
            if (src !== undefined && src !== it) {
                edges(deps, it).add(src);
                edges(dependents, src).add(it);
            }
        }
    }

    const indegree = new Map(items.map((it) => [it, edges(deps, it).size]));
    const ready = items.filter((it) => indegree.get(it) === 0);
    /** @type {Item[]} */
    const ideal = [];
    for (;;) {
        ready.sort((a, b) => {
            const byRank = rank(a.cat) - rank(b.cat);
            return byRank !== 0 ? byRank : a.i - b.i;
        });
        const next = ready.shift();
        if (next === undefined) break;
        ideal.push(next);
        for (const d of edges(dependents, next)) {
            const left = (indegree.get(d) ?? 0) - 1;
            indegree.set(d, left);
            if (left === 0) ready.push(d);
        }
    }
    // A cycle cannot be ordered; leave the module alone rather than guess.
    if (ideal.length !== items.length) return { misplaced: [], count: items.length, cycle: true };

    // Longest common subsequence of actual (0..n-1) and ideal, by original index.
    const a = items.map((it) => it.i);
    const b = ideal.map((it) => it.i);
    const n = a.length;
    // An (n+1)×(n+1) table stored flat, row by row. Every read is within it.
    const dp = new Array((n + 1) * (n + 1)).fill(0);
    /**
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    const at = (x, y) => dp[x * (n + 1) + y] ?? 0;
    for (let x = n - 1; x >= 0; x--) {
        for (let y = n - 1; y >= 0; y--) {
            dp[x * (n + 1) + y] = a[x] === b[y] ? at(x + 1, y + 1) + 1 : Math.max(at(x + 1, y), at(x, y + 1));
        }
    }
    /** @type {Set<number>} */
    const keep = new Set();
    let x = 0;
    let y = 0;
    while (x < n && y < n) {
        const ax = a[x];
        if (ax !== undefined && ax === b[y]) {
            keep.add(ax);
            x++;
            y++;
        } else if (at(x + 1, y) >= at(x, y + 1)) x++;
        else y++;
    }

    /** @type {Misplaced[]} */
    const misplaced = [];
    for (const [p, it] of ideal.entries()) {
        if (keep.has(it.i)) continue;
        const after = p > 0 ? ideal[p - 1] : undefined;
        misplaced.push({
            cat: it.cat,
            name: it.name,
            line: it.line,
            belongsAfter: after !== undefined ? `${after.cat} "${after.name}"` : 'the top of the module',
        });
    }
    // `order` is the ideal sequence as original statement indices — what a fixer
    // needs to rewrite the file, and the same sequence `misplaced` is derived from.
    return { misplaced, count: items.length, order: ideal.map((it) => it.i) };
}

/**
 * Reads a file (unwrapping an SFC's <script setup>) and analyses it.
 *
 * @param {string} rel
 * @param {string} root
 * @param {Profile} [profile]
 * @returns {Analysis | null}
 */
export function analyzeFile(rel, root, profile = profileFor(rel)) {
    let code = fs.readFileSync(path.join(root, rel), 'utf8');
    let lineOffset = 0;
    if (rel.endsWith('.vue')) {
        const { descriptor } = parseSfc(code, { filename: rel });
        const block = descriptor.scriptSetup ?? descriptor.script;
        if (block === null) return null;
        lineOffset = code.slice(0, block.loc.start.offset).split('\n').length - 1;
        code = block.content;
    }
    const res = analyze(code, rel.endsWith('.vue') ? `${rel}.ts` : rel, profile);
    for (const m of res.misplaced) m.line += lineOffset;
    return res;
}

/**
 * @typedef {object} DeclarationOrderOptions
 * @property {string} [root] Repository root. Defaults to the caller's repo root.
 * @property {string[]} sourceRoots Directories to walk, relative to `root`.
 * @property {object} [importOrder] Forwarded to `createImportOrder` — `workspaceScope`
 *   for a monorepo's own scope, `localAliases` for tsconfig paths that look like packages.
 */

/**
 * @param {DeclarationOrderOptions} options
 * @returns {void}
 */
export function checkDeclarationOrder(options) {
    const { root = REPO_ROOT, sourceRoots, importOrder = {} } = options;
    const { IMPORT_GROUPS, checkImportsInFile, fixImportsInFile } = createImportOrder(importOrder);

    const FIX = process.argv.includes('--fix');

    /**
     * @type {{ file: string; headline: string; misplaced: ({ cat: string; name: string; line: number; belongsAfter: string } | { line: number; text: string })[]; why: string }[]}
     */
    const failures = [];

    const discovered = walkFiles(root, sourceRoots, {
        match: (rel) => /\.(ts|vue)$/.test(rel) && !rel.endsWith('.d.ts'),
    });
    const files = discovered.filter((rel) => !isTestPath(rel));
    // .vue is production-only; a suite is always a .ts module.
    const testFiles = discovered.filter((rel) => isTestPath(rel) && rel.endsWith('.ts'));
    let statementsChecked = 0;

    for (const rel of [...files, ...testFiles]) {
        const result = analyzeFile(rel, root);
        if (result === null) continue;
        statementsChecked += result.count;

        if (result.cycle === true) {
            failures.push({
                file: rel,
                headline: 'has a circular load-time dependency between top-level statements',
                misplaced: [],
                why: 'No order satisfies it, so the canonical order cannot be computed. Break the cycle — at module scope it means two statements each read a binding the other declares.',
            });
            continue;
        }

        if (result.misplaced.length > 0) {
            failures.push({
                file: rel,
                headline: `${result.misplaced.length} statement(s) out of canonical order`,
                misplaced: result.misplaced,
                why: `Order is: ${(isTestPath(rel) ? TEST_CATEGORIES : CATEGORIES).join(' → ')}.`,
            });
        }
    }

    // Imports get their own pass over the same files, since a suite's imports follow
    // the same rule as a module's.
    let importsChecked = 0;
    let filesFixed = 0;
    for (const rel of [...files, ...testFiles]) {
        if (FIX && fixImportsInFile(rel, root)) filesFixed++;
        const result = checkImportsInFile(rel, root);
        if (result === null) continue;
        importsChecked += result.count;
        if (result.problems.length === 0) continue;
        failures.push({
            file: rel,
            headline: `${result.problems.length} import(s) out of order`,
            misplaced: result.problems.map((p) => ({ line: p.line, text: p.message })),
            why: `Imports go ${IMPORT_GROUPS.join(' → ')}, one blank line between groups, alphabetical inside each. \`--fix\` rewrites them.`,
        });
    }
    if (FIX) console.log(`Import order: rewrote ${filesFixed} file(s).`);

    // ── Report ───────────────────────────────────────────────────────────────
    if (failures.length > 0) {
        const total = failures.reduce((n, f) => n + f.misplaced.length, 0);
        console.error(`✗ Declaration order check failed — ${failures.length} file(s), ${total} statement(s):\n`);
        for (const { file, headline, why, misplaced } of failures) {
            console.error(`  ${file} — ${headline}`);
            console.error(`    ${why}`);
            for (const m of misplaced) {
                const text = 'text' in m ? m.text : `${m.cat} "${m.name.slice(0, 40)}" belongs after ${m.belongsAfter}`;
                console.error(`      L${String(m.line).padStart(4)}  ${text}`);
            }
            console.error('');
        }
        console.error(
            'Every declaration position reported here is reachable: the target order is computed as a\n' +
                'topological sort, so it already respects every load-time dependency. If a move\n' +
                'looks unsafe, the dependency is missing from the analysis — say so rather than\n' +
                'reordering blindly.',
        );
        process.exitCode = 1;
        return;
    }

    console.log(
        `✓ Declaration order check passed — ${files.length} modules + ${testFiles.length} suites, ` +
            `${statementsChecked} top-level statements, all in canonical order (or held by a load-time dependency); ` +
            `${importsChecked} imports grouped and sorted.`,
    );
}

export default checkDeclarationOrder;
