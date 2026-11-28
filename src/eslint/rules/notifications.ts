/**
 * One way to tell the user something failed: `notify` from the app's one notification
 * module, rendered by one `NotificationCenter` that is always mounted. And every caught
 * failure goes somewhere the user or the caller will see it.
 * - `notify-usage` — `notify` and `useNotifications` come from `composables/ui/useNotifications`,
 *   and `notify` has `error` and `dismiss`, nothing else.
 * - `notify-translated` — `notify.error`'s message is a translation call. Switched on by the
 *   i18n block, so a single-language app is spared it.
 * - `notification-center` — `<NotificationCenter>` appears once, in `App.vue`, outside every
 *   `v-if`, `v-show` and `v-for`. Whether it appears at all is the dead-code gate's: a module
 *   whose reader nothing imports is an unused export.
 * - `catch-reports` — a `catch` shows the failure, passes it on, or carries a disable comment
 *   saying why it does neither.
 */
import { AST_NODE_TYPES, ASTUtils, TSESLint, type TSESTree } from '@typescript-eslint/utils';
import type { AST, Rule } from 'eslint';

type Node = TSESTree.Node;
type Variable = TSESLint.Scope.Variable;
type AnyContext = Readonly<TSESLint.RuleContext<string, []>>;

/** The few template nodes `notification-center` reads. vue-eslint-parser's own types are not a dependency here. */
type VDirective = { directive: true; key: { name: { name: string } } };
type VAttribute = { directive: false };
type VNode = { type: string };
type VElement = VNode & {
    type: 'VElement';
    rawName: string;
    parent: VElement | VNode;
    startTag: { attributes: (VAttribute | VDirective)[]; loc: AST.SourceLocation };
};
type TemplateServices = {
    defineTemplateBodyVisitor(templateVisitor: Record<string, (node: VElement) => void>): Rule.RuleListener;
};

/** Any module of that name, wherever it sits: the one a wrong-folder copy is reported against. */
const NOTIFICATIONS_MODULE = /(?:^|\/)useNotifications$/;
/** Where it belongs, under whatever the app's `@/` points at (`@/renderer/` in Electron). */
const NOTIFICATIONS_HOME = /^@\/(?:[\w-]+\/)*composables\/ui\/useNotifications$/;
const NOTIFY_METHODS = new Set(['error', 'dismiss']);
/** Directives that leave an element unmounted, or mounted more than once. */
const CONDITIONAL = new Set(['if', 'else-if', 'else', 'show', 'for']);
/** Calls that record the failure in a collection the caller reads (a batch's rejected list). */
const RECORDING_METHODS = new Set(['push', 'unshift', 'add', 'set']);

const { DefinitionType } = TSESLint.Scope;

const notifyUsage: TSESLint.RuleModule<'home' | 'method'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: {
            description: "`notify` comes from the app's one notification module and has `error` and `dismiss` only.",
        },
        schema: [],
        messages: {
            home: 'The notification module lives at `@/composables/ui/useNotifications`, in every project, so every failure reaches the one `NotificationCenter`. A notifications *feature* (an inbox) is named for what it is — `useInbox` — so the two never share a name.',
            method: '`notify` has `error` and `dismiss`, nothing else. A success the user can already see needs no notice: confirming what is on screen trains people to ignore the corner the errors appear in.',
        },
    },
    create(context): TSESLint.RuleListener {
        return {
            ImportDeclaration(node): void {
                const source = node.source.value;
                if (NOTIFICATIONS_MODULE.test(source) && !NOTIFICATIONS_HOME.test(source)) {
                    context.report({ node: node.source, messageId: 'home' });
                }
            },
            MemberExpression(node): void {
                if (!isNotify(context, node.object)) return;
                const name = propertyName(node);
                if (name === null || !NOTIFY_METHODS.has(name)) {
                    context.report({ node: node.property, messageId: 'method' });
                }
            },
        };
    },
};

const notifyTranslated: TSESLint.RuleModule<'translated'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: "`notify.error`'s message is translated where it is called." },
        schema: [],
        messages: {
            translated:
                "Translate the message where you call `notify.error`: `notify.error(t('errors.save_file_failed'))`. A string built elsewhere and passed in is one the locale files never see, so a missing translation ships in English.",
        },
    },
    create(context): TSESLint.RuleListener {
        return {
            CallExpression(node): void {
                const { callee } = node;
                if (callee.type !== AST_NODE_TYPES.MemberExpression || propertyName(callee) !== 'error') return;
                if (!isNotify(context, callee.object)) return;
                const [message] = node.arguments;
                if (message === undefined || !isTranslation(context, message)) {
                    context.report({ node: message ?? node, messageId: 'translated' });
                }
            },
        };
    },
};

const notificationCenter: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: { description: '`<NotificationCenter>` is mounted once, in `App.vue`, outside every condition.' },
        schema: [],
        messages: {
            notApp: '`<NotificationCenter>` is mounted in `App.vue` and nowhere else. A second one renders every notification twice; one inside a view disappears with the view.',
            twice: '`<NotificationCenter>` is mounted once. A second one renders every notification twice.',
            conditional:
                '`<NotificationCenter>` sits outside every `v-if`, `v-show` and `v-for`, so a failure has somewhere to appear on every screen, the welcome screen included.',
        },
    },
    create(context): Rule.RuleListener {
        const services: unknown = context.sourceCode.parserServices;
        if (!hasTemplateVisitor(services)) return {};
        const inApp = /(?:^|[\\/])App\.vue$/.test(context.filename);
        let seen = 0;
        return services.defineTemplateBodyVisitor({
            VElement(element): void {
                if (element.rawName.replaceAll('-', '').toLowerCase() !== 'notificationcenter') return;
                seen += 1;
                const loc = element.startTag.loc;
                if (!inApp) context.report({ loc, messageId: 'notApp' });
                else if (seen > 1) context.report({ loc, messageId: 'twice' });
                else if (underCondition(element)) context.report({ loc, messageId: 'conditional' });
            },
        });
    },
};

/**
 * A caught failure is shown (`notify`, a ref or a field the template reads, an `emit`),
 * passed on (`throw`, a returned value, a rejecting callback, a list the caller reads), or
 * silenced on purpose behind a disable comment that says why. Logging is none of these:
 * the user still sees nothing happen.
 */
const catchReports: TSESLint.RuleModule<'silent'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: 'A caught failure is shown to the user or passed on, never only logged or dropped.' },
        schema: [],
        messages: {
            silent: 'This catch neither shows the failure nor passes it on, so the user sees nothing happen. Show it where they are looking — `notify.error(t(…))`, or a ref the template reads — or `throw`/`return` it to a caller that does. If dropping it is safe, say why: `// eslint-disable-next-line larry/catch-reports -- <reason>`. A log line alone is for you, not for them.',
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

        const handles = (fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression): boolean => {
            const { body } = fn;
            if (body.type === AST_NODE_TYPES.BlockStatement) return reports(body);
            // An expression body returns its value, unless the expression is a call made for what it does.
            if (isCall(body)) return reports(body);
            return !isUndefined(body);
        };

        return {
            CatchClause(node): void {
                if (reports(node.body)) return;
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

export const notificationRules = {
    'notify-usage': notifyUsage,
    'notify-translated': notifyTranslated,
    'notification-center': notificationCenter,
    'catch-reports': catchReports,
};

/** `.catch(onFailed)`, or `.then(onDone, onFailed)`, whose second argument is a `.catch`. */
function failureHandler(method: string | null, args: TSESTree.CallExpressionArgument[]): Node | undefined {
    if (method === 'catch') return args[0];
    if (method === 'then') return args[1];
    return undefined;
}

function resolve(context: AnyContext, identifier: TSESTree.Identifier): Variable | null {
    return ASTUtils.findVariable(context.sourceCode.getScope(identifier), identifier);
}

/** `notify`, bound by an import of the notification module, wherever that module sits. */
function isNotify(context: AnyContext, node: Node): boolean {
    if (node.type !== AST_NODE_TYPES.Identifier) return false;
    const def = resolve(context, node)?.defs[0];
    if (def?.type !== DefinitionType.ImportBinding || def.node.type !== AST_NODE_TYPES.ImportSpecifier) return false;
    const name = importedName(def.node);
    return (
        name === 'notify' &&
        def.parent.type === AST_NODE_TYPES.ImportDeclaration &&
        NOTIFICATIONS_MODULE.test(def.parent.source.value)
    );
}

/**
 * A call of vue-i18n's `t`, under whatever local name: destructured (`const { t } = useI18n()`,
 * `{ t: translate } = i18n.global`), read off (`const translate = i18n.global.t`), imported
 * (`import { t } from '@/i18n'`), or called as a member (`i18n.global.t(…)`). A function the
 * file writes itself is not one, whatever it is called.
 */
function isTranslation(context: AnyContext, node: Node): boolean {
    if (node.type !== AST_NODE_TYPES.CallExpression) return false;
    const { callee } = node;
    if (callee.type === AST_NODE_TYPES.MemberExpression) return isTranslateKey(propertyName(callee));
    if (callee.type !== AST_NODE_TYPES.Identifier) return false;
    const def = resolve(context, callee)?.defs[0];
    if (def === undefined) return false;
    if (def.type === DefinitionType.ImportBinding) {
        return def.node.type === AST_NODE_TYPES.ImportSpecifier && isTranslateKey(importedName(def.node));
    }
    if (def.node.type !== AST_NODE_TYPES.VariableDeclarator) return false;
    const { id, init } = def.node;
    if (id.type === AST_NODE_TYPES.ObjectPattern) return isTranslateKey(destructuredKey(id, def.name));
    return init?.type === AST_NODE_TYPES.MemberExpression && isTranslateKey(propertyName(init));
}

const isTranslateKey = (name: string | null): boolean => name === 't';

const importedName = (specifier: TSESTree.ImportSpecifier): string =>
    specifier.imported.type === AST_NODE_TYPES.Identifier ? specifier.imported.name : specifier.imported.value;

/** The key `local` was destructured from: `t` in `{ t: translate }`. */
function destructuredKey(pattern: TSESTree.ObjectPattern, local: Node): string | null {
    const property = pattern.properties.find(
        (p): p is TSESTree.Property => p.type === AST_NODE_TYPES.Property && p.value === local,
    );
    if (property === undefined || property.computed || property.key.type !== AST_NODE_TYPES.Identifier) return null;
    return property.key.name;
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

function propertyName(member: TSESTree.MemberExpression): string | null {
    const { property } = member;
    if (!member.computed && property.type === AST_NODE_TYPES.Identifier) return property.name;
    if (property.type === AST_NODE_TYPES.Literal && typeof property.value === 'string') return property.value;
    return null;
}

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

const hasTemplateVisitor = (services: unknown): services is TemplateServices =>
    typeof services === 'object' &&
    services !== null &&
    'defineTemplateBodyVisitor' in services &&
    typeof services.defineTemplateBodyVisitor === 'function';

/** Whether the element, or anything it sits in, mounts only sometimes or more than once. */
function underCondition(element: VElement): boolean {
    for (let node: VElement | VNode = element; isElement(node); node = node.parent) {
        const conditional = node.startTag.attributes.some((a) => a.directive && CONDITIONAL.has(a.key.name.name));
        if (conditional) return true;
    }
    return false;
}

const isElement = (node: VElement | VNode): node is VElement => node.type === 'VElement';
