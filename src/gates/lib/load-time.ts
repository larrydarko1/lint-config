/**
 * What a module's top-level statement does when the module loads: the names it binds,
 * the names it reads, and the functions it may run, whose bodies then run too. The
 * declaration-order gate builds its dependency graph from these, so a statement never
 * moves above a binding it reads before that binding exists.
 */
import ts from 'typescript';

export const isFnLike = (n: ts.Node | undefined): boolean =>
    n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

/** Names a statement binds at module scope. */
export function declaredNames(stmt: ts.Statement): string[] {
    if (ts.isVariableStatement(stmt)) return stmt.declarationList.declarations.flatMap((d) => bindingNames(d.name));
    if (ts.isImportDeclaration(stmt)) {
        const c = stmt.importClause;
        const own = c?.name === undefined ? [] : [c.name.text];
        const named = c?.namedBindings;
        if (named === undefined) return own;
        if (ts.isNamespaceImport(named)) return [...own, named.name.text];
        return [...own, ...named.elements.map((e) => e.name.text)];
    }
    const named =
        ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt);
    return named && stmt.name !== undefined ? [stmt.name.text] : [];
}

/**
 * Identifiers a statement evaluates AT LOAD TIME. Function/arrow bodies are skipped:
 * they run later, so a name they reference need not be declared above them.
 */
export function loadTimeRefs(stmt: ts.Statement, eager = false): Set<string> {
    const out = new Set<string>();
    const isTypePos = (n: ts.Node): boolean => {
        for (let p = n.parent; !ts.isSourceFile(p); p = p.parent) {
            if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
            if (ts.isExpression(p) || ts.isStatement(p)) return false;
        }
        return false;
    };
    const visit = (n: ts.Node): void => {
        // Skip the body; parameter defaults still evaluate at call time, not load.
        // Unless `eager`: a mock factory's body IS load time (see TEST_PROFILE).
        if (isFnNode(n) && !eager) return;
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
 * Identifiers a function, class or arrow declaration reads when it runs: its own body,
 * and a class's methods. A callback or inner function in it is left out, as
 * `loadTimeRefs` leaves one out at the top level, since it runs only when something
 * calls it: `.refine((v) => isProd())` reads `isProd` when it validates, not when the
 * schema is built. One passed by name is followed by `bodyCalls` instead. Otherwise
 * over-approximate (a local that shadows a module binding still counts).
 */
export function bodyRefs(stmt: ts.Statement): Set<string> {
    const callable = callableOf(stmt);
    if (callable === undefined) return new Set();
    const out = new Set<string>();
    const visit = (n: ts.Node): void => {
        if (isInnerFunction(n)) return;
        if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) out.add(n.text);
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(callable, visit);
    for (const d of declaredNames(stmt)) out.delete(d);
    return out;
}

/**
 * The names a statement may run: a call's or a `new`'s callee, a tag, and a name passed
 * straight to a call, which may call it back (`items.map(normalize)`). A name only stored,
 * in an object, an array or a binding, runs nothing by being stored: `defineExpose({ open })`
 * does not call `open`. Into function bodies only when `intoFunctions`, as `loadTimeRefs`.
 */
export function calledNames(stmt: ts.Statement, intoFunctions: boolean): Set<string> {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) {
        return new Set();
    }
    const skip = intoFunctions ? (): boolean => false : isFnNode;
    // A class body's heritage clause runs at load; methods do not.
    if (ts.isClassDeclaration(stmt)) return collectCalls(stmt.heritageClauses ?? [], skip);
    return collectCalls([stmt], skip);
}

/** What a function or class body may run, by `calledNames`, leaving out what `bodyRefs` leaves out. */
export function bodyCalls(stmt: ts.Statement): Set<string> {
    const callable = callableOf(stmt);
    return callable === undefined ? new Set() : collectCalls([callable], isInnerFunction);
}

/**
 * Adds to `it.refs` what each function it runs reads when called, and what that runs, and
 * so on down. Only what it runs: a function it merely names reads nothing until called.
 */
export function readThroughCalls(
    it: { decls: string[]; refs: Set<string>; calls: Set<string> },
    runs: Map<string, { reads: Set<string>; calls: Set<string> }>,
): void {
    const seen = new Set<string>();
    const queue = [...it.calls];
    for (let r = queue.pop(); r !== undefined; r = queue.pop()) {
        if (seen.has(r)) continue;
        seen.add(r);
        const body = runs.get(r);
        if (body === undefined) continue;
        for (const name of body.reads) if (!it.decls.includes(name)) it.refs.add(name);
        queue.push(...body.calls);
    }
}

function collectCalls(nodes: readonly ts.Node[], skip: (n: ts.Node) => boolean): Set<string> {
    const out = new Set<string>();
    const add = (n: ts.Node | undefined): void => {
        if (n !== undefined && ts.isIdentifier(n)) out.add(n.text);
    };
    const visit = (n: ts.Node): void => {
        if (skip(n)) return;
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            add(n.expression);
            for (const argument of n.arguments ?? []) add(argument);
        }
        if (ts.isTaggedTemplateExpression(n)) add(n.tag);
        ts.forEachChild(n, visit);
    };
    for (const node of nodes) ts.forEachChild(node, visit);
    return out;
}

/** The function or class a statement declares, whose body runs when it is called or constructed. */
function callableOf(stmt: ts.Statement): ts.Node | undefined {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return stmt;
    if (!ts.isVariableStatement(stmt)) return undefined;
    return stmt.declarationList.declarations.map((d) => d.initializer).find(isFnLike);
}

/** The names a binding binds, through any destructuring. */
function bindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((el) => (ts.isBindingElement(el) ? bindingNames(el.name) : []));
}

/** Inside a body, a callback or an inner function: a class's methods are not one. */
const isInnerFunction = (n: ts.Node): boolean =>
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);

/** A node whose body runs when it is called, not where it stands. */
const isFnNode = (n: ts.Node): boolean =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n);
