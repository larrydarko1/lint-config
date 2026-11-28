/**
 * `catch-reports`: every caught failure in the Vue app reaches the user or the caller. Judged
 * from the catch body alone, following calls into helpers declared in the same file.
 */
import { AST_NODE_TYPES, TSESLint, type TSESTree } from '@typescript-eslint/utils';

import { isPlaceholderReason } from '../../gates/lib/swallowed-errors.ts';
import { isNotify, isTranslation, type Node, propertyName, resolve } from './notify-bindings.ts';

/** Calls that record the failure in a collection the caller reads (a batch's rejected list). */
const RECORDING_METHODS = new Set(['push', 'unshift', 'add', 'set']);

const { DefinitionType } = TSESLint.Scope;

/**
 * A caught failure is shown (`notify`, a ref or a field the template reads, an `emit`),
 * passed on (`throw`, a returned value, a rejecting callback, a list the caller reads), or
 * silenced on purpose with a reason. An empty catch gives it in a comment inside, where
 * `no-empty` and the error-handling gate already ask for it; any other catch gives it in a
 * disable comment. Logging is none of these: the user still sees nothing happen.
 */
export const catchReports: TSESLint.RuleModule<'silent'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: 'A caught failure is shown to the user or passed on, never only logged or dropped.' },
        schema: [],
        messages: {
            silent: 'This catch neither shows the failure nor passes it on, so the user sees nothing happen. Show it where they are looking — `notify.error(t(…))`, or a ref the template reads — or `throw`/`return` it to a caller that does. If dropping it is safe, say why: in an empty catch, a comment inside it (`catch { /* the file was already gone */ }`); otherwise `// eslint-disable-next-line larry/catch-reports -- <reason>` above it. A log line alone is for you, not for them.',
        },
    },
    create(context): TSESLint.RuleListener {
        /** Same-file helpers already judged, so a recursive one ends. */
        const helpers = new Map<Node, boolean>();

        /**
         * A helper is held to more. What it returns goes back to a catch that may drop it,
         * its parameters are not the caller's, and a ref it writes is as likely `loading` as
         * a message: only a notice, an emit, a throw or a translated message counts. Its own
         * catch blocks answer its own failures, not the caller's.
         */
        const reports = (root: Node, inHelper = false): boolean => {
            let found = false;
            walk(root, inHelper, (node) => {
                if (!found) found = signals(node, root, inHelper);
            });
            return found;
        };

        const signals = (node: Node, root: Node, inHelper: boolean): boolean => {
            if (node.type === AST_NODE_TYPES.ThrowStatement) return !caughtWithin(node, root);
            if (node.type === AST_NODE_TYPES.ReturnStatement) {
                return !inHelper && node.argument !== null && !isUndefined(node.argument);
            }
            if (node.type === AST_NODE_TYPES.AssignmentExpression) {
                if (node.left.type !== AST_NODE_TYPES.MemberExpression) return false;
                return !inHelper || containsTranslation(node.right);
            }
            if (node.type === AST_NODE_TYPES.CallExpression) return callReports(node, inHelper);
            return false;
        };

        const callReports = (call: TSESTree.CallExpression, inHelper: boolean): boolean => {
            const { callee } = call;
            if (callee.type === AST_NODE_TYPES.MemberExpression) {
                if (isNotify(context, callee.object)) return true;
                const method = propertyName(callee);
                if (inHelper || method === null || !RECORDING_METHODS.has(method)) return false;
                return declaredOutside(callee.object, call);
            }
            if (callee.type !== AST_NODE_TYPES.Identifier) return false;
            const variable = resolve(context, callee);
            const def = variable?.defs[0];
            if (def === undefined) return false;
            if (def.type === DefinitionType.Parameter) return !inHelper;
            if (isEmit(def.node)) return true;
            const helper = helperBody(def.node);
            return helper !== null && helperReports(helper);
        };

        const containsTranslation = (value: Node): boolean => {
            let found = false;
            walk(value, false, (node) => {
                if (!found) found = isTranslation(context, node);
            });
            return found;
        };

        const helperReports = (body: Node): boolean => {
            const known = helpers.get(body);
            if (known !== undefined) return known;
            helpers.set(body, false);
            const result = reports(body, true);
            helpers.set(body, result);
            return result;
        };

        /** Whether `target` is bound outside the catch that `at` sits in: state the caller reads. */
        const declaredOutside = (target: Node, at: Node): boolean => {
            const root = rootIdentifier(target);
            if (root === null) return false;
            const def = resolve(context, root)?.defs[0];
            if (def === undefined) return false;
            const handler = enclosingHandler(at);
            return handler === null || !contains(handler, def.name);
        };

        /** An empty block whose comment says why the failure is dropped. `/* ignore *\/` says nothing. */
        const explainedEmpty = (block: TSESTree.BlockStatement): boolean => {
            if (block.body.length > 0) return false;
            const reason = context.sourceCode
                .getCommentsInside(block)
                .filter((comment) => !/^\s*eslint/.test(comment.value))
                .map((comment) => comment.value)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            return !isPlaceholderReason(reason);
        };

        const handles = (fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression): boolean => {
            const { body } = fn;
            if (body.type === AST_NODE_TYPES.BlockStatement) return explainedEmpty(body) || reports(body);
            // An expression body returns its value, unless the expression is a call made for what it does.
            if (isCall(body)) return reports(body);
            return !isUndefined(body);
        };

        return {
            CatchClause(node): void {
                if (explainedEmpty(node.body) || reports(node.body)) return;
                context.report({ loc: { start: node.loc.start, end: node.body.loc.start }, messageId: 'silent' });
            },
            CallExpression(node): void {
                if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return;
                const handler = failureHandler(propertyName(node.callee), node.arguments);
                if (handler === undefined || !isFunction(handler) || handles(handler)) return;
                context.report({ loc: { start: handler.loc.start, end: handler.body.loc.start }, messageId: 'silent' });
            },
        };
    },
};

/** `.catch(onFailed)`, or `.then(onDone, onFailed)`, whose second argument is a `.catch`. */
function failureHandler(method: string | null, args: TSESTree.CallExpressionArgument[]): Node | undefined {
    if (method === 'catch') return args[0];
    if (method === 'then') return args[1];
    return undefined;
}

/** `const emit = defineEmits<…>()`. */
function isEmit(node: Node): boolean {
    if (node.type !== AST_NODE_TYPES.VariableDeclarator || node.init?.type !== AST_NODE_TYPES.CallExpression) {
        return false;
    }
    const { callee } = node.init;
    return callee.type === AST_NODE_TYPES.Identifier && callee.name === 'defineEmits';
}

/** The body of a function declared in this file: `function f() {}` or `const f = () => {}`. */
function helperBody(node: Node): Node | null {
    if (node.type === AST_NODE_TYPES.FunctionDeclaration) return node.body;
    if (node.type === AST_NODE_TYPES.VariableDeclarator && node.init !== null && isFunction(node.init)) {
        return node.init.body;
    }
    return null;
}

/** The catch body or `.catch` handler `node` sits in, stopping at the nearest one. */
function enclosingHandler(node: Node): Node | null {
    for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
        if (current.type === AST_NODE_TYPES.CatchClause) return current;
        if (isFunction(current)) return current;
    }
    return null;
}

/** Whether a `try` between `node` and `root` catches what `node` throws. */
function caughtWithin(node: Node, root: Node): boolean {
    for (
        let child = node, parent = node.parent;
        parent !== undefined && child !== root;
        child = parent, parent = parent.parent
    ) {
        if (parent.type === AST_NODE_TYPES.TryStatement && parent.handler !== null && parent.block === child) {
            return true;
        }
    }
    return false;
}

function rootIdentifier(node: Node): TSESTree.Identifier | null {
    if (node.type === AST_NODE_TYPES.Identifier) return node;
    if (node.type === AST_NODE_TYPES.MemberExpression) return rootIdentifier(node.object);
    return null;
}

const contains = (outer: Node, inner: Node): boolean =>
    outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

const isFunction = (node: Node): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression =>
    node.type === AST_NODE_TYPES.ArrowFunctionExpression || node.type === AST_NODE_TYPES.FunctionExpression;

const isCall = (node: Node): boolean =>
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.AwaitExpression ||
    node.type === AST_NODE_TYPES.ChainExpression ||
    node.type === AST_NODE_TYPES.AssignmentExpression;

/** `undefined` and `void x`: a value that says nothing to the caller. */
const isUndefined = (node: Node): boolean =>
    (node.type === AST_NODE_TYPES.Identifier && node.name === 'undefined') ||
    (node.type === AST_NODE_TYPES.UnaryExpression && node.operator === 'void');

/**
 * Every node under `root`, not entering a nested function: what it does runs later, if at
 * all. With `skipCatches`, not entering a catch block either.
 */
function walk(root: Node, skipCatches: boolean, visit: (node: Node) => void): void {
    const stack: Node[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        visit(node);
        const skipped = (child: Node): boolean =>
            isFunctionNode(child) || (skipCatches && child.type === AST_NODE_TYPES.CatchClause);
        stack.push(...children(node).filter((child) => !skipped(child)));
    }
}

const children = (node: Node): Node[] =>
    Object.entries(node)
        .filter(([key]) => key !== 'parent')
        .flatMap(([, value]: [string, unknown]): unknown[] => (isArray(value) ? value : [value]))
        .filter(isNode);

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isNode = (value: unknown): value is Node =>
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'range' in value;

const isFunctionNode = (node: Node): boolean => isFunction(node) || node.type === AST_NODE_TYPES.FunctionDeclaration;
