/**
 * Rules no existing plugin has, registered by `larry()` under the `larry/` prefix.
 * - `no-caught-message-leak` — on where code answers someone outside the process:
 *   the full-stack backend and the Electron main process.
 * - `no-inline-svg` / `icon-component` — on every component, see icons.ts.
 * - `no-native-dialog` — on everything that runs in the Vue app, see dialogs.ts.
 * - `no-tauri-outside-bridge` — on a Tauri webview outside its bridge, see tauri.ts.
 */

import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

import { dialogRules } from './dialogs.ts';
import { iconRules } from './icons.ts';
import { tauriRules } from './tauri.ts';

type Node = TSESTree.Node;
type Variable = TSESLint.Scope.Variable;
type Context = Readonly<TSESLint.RuleContext<'messageLeak', [CaughtMessageOptions]>>;

type CaughtMessageOptions = {
    /**
     * Error classes whose message is not the first argument, by name → its index.
     * Any other constructor whose name ends in `Error` takes its message first.
     */
    messageArgs?: Record<string, number>;
};

const DEFAULT_MESSAGE_ARGS: Record<string, number> = { AppError: 2 };

/** `logger.error(…)`, `req.log.warn(…)`, `log.info(…)`, `this.logger.debug(…)`. */
const LOG_LEVEL = /^(trace|debug|info|warn|error|fatal)$/;
const LOGGER_NAME = /^(log|logger|\w+Logger)$/;

/** Reading a message to decide something says nothing to anyone. */
const DECISION_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'match', 'test', 'indexOf', 'search']);
const COMPARISONS = new Set(['===', '!==', '==', '!=', 'in', 'instanceof']);

/** Nodes a string passes through unchanged on its way somewhere. */
const PASS_THROUGH = new Set([
    'TemplateLiteral',
    'LogicalExpression',
    'ArrayExpression',
    'SpreadElement',
    'ChainExpression',
    'AwaitExpression',
    'TSAsExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TaggedTemplateExpression',
]);

const calleeName = (callee: Node): string => {
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        return `${calleeName(callee.object)}.${callee.property.name}`;
    }
    if (callee.type === 'ThisExpression') return 'this';
    return '…';
};

function isLoggerCall(call: TSESTree.CallExpression): boolean {
    const callee = call.callee;
    if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return false;
    if (!LOG_LEVEL.test(callee.property.name)) return false;
    const owner = callee.object;
    if (owner.type === 'Identifier') return LOGGER_NAME.test(owner.name);
    if (owner.type === 'MemberExpression' && owner.property.type === 'Identifier') {
        return LOGGER_NAME.test(owner.property.name);
    }
    return false;
}

/** The variable `name` resolves to from `node`'s scope, walking outwards. */
function findVariable(context: Context, node: Node, name: string): Variable | null {
    for (let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const found = scope.set.get(name);
        if (found !== undefined) return found;
    }
    return null;
}

/**
 * A caught error's `message` (and `stack`) is written for whoever reads the log.
 * Put on the wire it is English the client cannot translate, and it can carry
 * whatever the failing layer knew — a hostname, a file path, a query, a token.
 * The error handler already keeps it off the THROWN path; this follows it down
 * the other one, where a catch block turns the failure into data and returns it.
 *
 * Allowed: a logger call, an error constructor's message argument, AppError's
 * `logContext`, and reads that only decide something (`msg.includes('E11000')`).
 * It follows a message through a variable, but not into a function it is passed to.
 */
const noCaughtMessageLeak: TSESLint.RuleModule<'messageLeak', [CaughtMessageOptions]> = {
    defaultOptions: [{}],
    meta: {
        type: 'problem',
        docs: {
            description: "A caught error's message may reach a log or an error's message, nothing else.",
        },
        schema: [
            {
                type: 'object',
                properties: {
                    messageArgs: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            messageLeak:
                "`{{text}}` carries a caught error's message into {{sink}}. The message is for the log: it is English the client cannot translate, and it can carry internals (a hostname, a path, a query). Send a code instead — `err instanceof AppError ? err.code : 'SOMETHING_FAILED'` — and log the error, or throw `new AppError(status, code, message)` so the error handler sends the code and logs the message.",
        },
    },
    create(context) {
        const messageArgs = { ...DEFAULT_MESSAGE_ARGS, ...context.options[0]?.messageArgs };
        const seen = new Set<Variable>();
        const text = (node: Node): string => context.sourceCode.getText(node).replace(/\s+/g, ' ').slice(0, 60);

        const report = (start: Node, sink: string): void =>
            context.report({ node: start, messageId: 'messageLeak', data: { text: text(start), sink } });

        /** Every read of a variable now holding message text. */
        function followText(variable: Variable | null): void {
            if (variable === null || seen.has(variable)) return;
            seen.add(variable);
            for (const ref of variable.references) {
                if (ref.isRead()) followMessage(ref.identifier);
            }
        }

        /** Every use of a variable holding the caught error itself. */
        function followError(variable: Variable | null): void {
            if (variable === null || seen.has(variable)) return;
            seen.add(variable);
            for (const ref of variable.references) {
                if (!ref.isRead()) continue;
                const id = ref.identifier;
                let outer: Node = id;
                while (outer.parent?.type === 'TSAsExpression' || outer.parent?.type === 'TSNonNullExpression') {
                    outer = outer.parent;
                }
                const parent = outer.parent;
                if (parent === undefined) continue;

                if (
                    parent.type === 'MemberExpression' &&
                    parent.object === outer &&
                    !parent.computed &&
                    parent.property.type === 'Identifier'
                ) {
                    const name = parent.property.name;
                    if (name === 'message' || name === 'stack') followMessage(parent);
                    else if (name === 'toString' && parent.parent.type === 'CallExpression') {
                        followMessage(parent.parent);
                    }
                } else if (
                    parent.type === 'CallExpression' &&
                    parent.callee.type === 'Identifier' &&
                    parent.callee.name === 'String'
                ) {
                    followMessage(parent);
                } else if (parent.type === 'TemplateLiteral') {
                    followMessage(parent);
                } else if (parent.type === 'VariableDeclarator' && parent.init === outer) {
                    // `const e = err` — an alias is the same error under another name.
                    for (const alias of context.sourceCode.getDeclaredVariables(parent)) followError(alias);
                }
            }
        }

        /** Walk outwards from an expression holding message text until it is used up or leaves. */
        function followMessage(start: Node): void {
            let child: Node = start;
            let parent: Node | undefined = start.parent;

            while (parent !== undefined) {
                switch (parent.type) {
                    case 'MemberExpression': {
                        if (parent.object !== child) return;
                        const name = parent.property.type === 'Identifier' ? parent.property.name : '';
                        const call = parent.parent;
                        if (name === 'length' || DECISION_METHODS.has(name)) return;
                        // `msg.slice(0, 80)`, `msg.trim()` — still the message.
                        if (call.type === 'CallExpression' && call.callee === parent) {
                            child = call;
                            parent = call.parent;
                            continue;
                        }
                        return;
                    }
                    case 'BinaryExpression':
                        if (COMPARISONS.has(parent.operator)) return;
                        break;
                    case 'ConditionalExpression':
                        if (parent.test === child) return;
                        break;
                    case 'UnaryExpression':
                    case 'IfStatement':
                    case 'WhileStatement':
                    case 'DoWhileStatement':
                    case 'SwitchStatement':
                    case 'SwitchCase':
                    case 'ExpressionStatement':
                    case 'ThrowStatement':
                        return;
                    case 'CallExpression':
                        if (parent.callee === child) return;
                        if (isLoggerCall(parent)) return;
                        if (parent.callee.type === 'Identifier' && parent.callee.name === 'String') break;
                        if (
                            parent.callee.type === 'MemberExpression' &&
                            parent.callee.property.type === 'Identifier' &&
                            parent.callee.property.name === 'test'
                        ) {
                            return;
                        }
                        report(start, `a call to \`${calleeName(parent.callee)}\``);
                        return;
                    case 'NewExpression': {
                        const name = parent.callee.type === 'Identifier' ? parent.callee.name : '';
                        const index = messageArgs[name] ?? (name.endsWith('Error') ? 0 : -1);
                        if (index >= 0 && parent.arguments[index] === child) return;
                        report(start, `an argument of \`new ${name || '…'}\` that is not its message`);
                        return;
                    }
                    case 'Property': {
                        if (parent.value !== child) return;
                        const object = parent.parent;
                        const key = parent.key.type === 'Identifier' ? parent.key.name : '';
                        if (
                            key === 'logContext' &&
                            object.parent?.type === 'NewExpression' &&
                            object.parent.callee.type === 'Identifier' &&
                            object.parent.callee.name in messageArgs
                        ) {
                            return;
                        }
                        child = object;
                        parent = object.parent;
                        continue;
                    }
                    case 'VariableDeclarator':
                        if (parent.init !== child) return;
                        for (const variable of context.sourceCode.getDeclaredVariables(parent)) followText(variable);
                        return;
                    case 'AssignmentExpression':
                        if (parent.right !== child) return;
                        if (parent.left.type === 'Identifier') {
                            followText(findVariable(context, parent, parent.left.name));
                            return;
                        }
                        report(start, `\`${text(parent.left)}\``);
                        return;
                    case 'ReturnStatement':
                        report(start, 'a return value');
                        return;
                    case 'ArrowFunctionExpression':
                        if (parent.body === child) report(start, 'a return value');
                        return;
                    case 'YieldExpression':
                        report(start, 'a yielded value');
                        return;
                    default:
                        if (!PASS_THROUGH.has(parent.type)) return;
                }
                child = parent;
                parent = parent.parent;
            }
        }

        /** `catch (err)`, or `catch ({ message })`. */
        function fromParam(param: Node | null | undefined, owner: Node): void {
            if (param == null) return;
            const id = param.type === 'AssignmentPattern' ? param.left : param;
            if (id.type === 'Identifier') {
                followError(context.sourceCode.getDeclaredVariables(owner).find((v) => v.name === id.name) ?? null);
                return;
            }
            if (id.type !== 'ObjectPattern') return;
            for (const prop of id.properties) {
                if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
                if (prop.key.name !== 'message' && prop.key.name !== 'stack') continue;
                const bound = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
                if (bound.type !== 'Identifier') continue;
                followText(context.sourceCode.getDeclaredVariables(owner).find((v) => v.name === bound.name) ?? null);
            }
        }

        return {
            CatchClause(node) {
                fromParam(node.param, node);
            },
            // `promise.catch((err) => …)`
            CallExpression(node) {
                if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier') return;
                if (node.callee.property.name !== 'catch') return;
                const handler = node.arguments[0];
                if (handler?.type !== 'ArrowFunctionExpression' && handler?.type !== 'FunctionExpression') return;
                fromParam(handler.params[0], handler);
            },
        };
    },
};

export const larryPlugin = {
    rules: {
        'no-caught-message-leak': noCaughtMessageLeak,
        ...iconRules,
        ...dialogRules,
        ...tauriRules,
    },
};
