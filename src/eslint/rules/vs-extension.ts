/**
 * An editor extension runs in the editor's extension host: one Node process that every
 * installed extension shares, for as long as the window is open. Two mistakes cost the
 * other extensions too, and neither shows on the extension's own screen:
 * - `no-sync-io`: a blocking file or process call stalls the host, so every extension's
 *   features in the window wait with it.
 * - `no-floating-disposable`: a registration or listener whose Disposable is dropped can
 *   never be undone, so it outlives deactivation and stacks up on each reload.
 * `vsExtensionStandards()` turns both on for the extension's source.
 */
import { AST_NODE_TYPES, TSESLint, type TSESTree } from '@typescript-eslint/utils';

type Context = Readonly<TSESLint.RuleContext<'blocking' | 'dropped', []>>;

/** The modules whose `*Sync` calls wait on the disk or on another process. */
const BLOCKING_MODULES = new Set(['fs', 'node:fs', 'child_process', 'node:child_process']);

/** The VS Code API calls that hand back a Disposable. A terminal belongs to the person, so it is theirs to close. */
const DISPOSABLE = /^(?:register[A-Z]|on(?:Did|Will)[A-Z]|create(?!Terminal$)[A-Z])/;

const noSyncIo: TSESLint.RuleModule<'blocking'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: 'No blocking file or process call in code the extension host runs.' },
        schema: [],
        messages: {
            blocking:
                '`{{name}}` blocks the extension host, the one Node process every installed extension shares: while it waits, every extension in the window waits too. Use the async form, from `node:fs/promises` or a promisified `execFile`.',
        },
    },
    create(context): TSESLint.RuleListener {
        const report = (node: TSESTree.Node, name: string): void => {
            context.report({ node, messageId: 'blocking', data: { name } });
        };
        return {
            ImportDeclaration(node): void {
                if (!BLOCKING_MODULES.has(node.source.value)) return;
                for (const specifier of node.specifiers) {
                    if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
                        const name = nameOf(specifier.imported);
                        if (name.endsWith('Sync')) report(specifier, name);
                        continue;
                    }
                    for (const [site, name] of syncReads(context, specifier)) report(site, name);
                }
            },
        };
    },
};

const noFloatingDisposable: TSESLint.RuleModule<'dropped'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: 'Keep the Disposable a VS Code registration or listener returns.' },
        schema: [],
        messages: {
            dropped:
                '`{{method}}` returns a Disposable, and this one is dropped: nothing can undo it, so it outlives deactivation and a second copy joins it on every reload. Push it into `context.subscriptions`, or keep it and dispose it when its owner goes.',
        },
    },
    create(context): TSESLint.RuleListener {
        return {
            ExpressionStatement(node): void {
                const expression =
                    node.expression.type === AST_NODE_TYPES.UnaryExpression && node.expression.operator === 'void'
                        ? node.expression.argument
                        : node.expression;
                if (expression.type !== AST_NODE_TYPES.CallExpression) return;
                const { callee } = expression;
                if (callee.type !== AST_NODE_TYPES.MemberExpression) return;
                const method = propertyName(callee);
                if (method === null || !DISPOSABLE.test(method) || !isVscodeApi(context, callee)) return;
                context.report({ node: expression, messageId: 'dropped', data: { method } });
            },
        };
    },
};

export const vsExtensionRules = { 'no-sync-io': noSyncIo, 'no-floating-disposable': noFloatingDisposable };

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
    node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;

/** `a.b` and `a['b']` → `'b'`; `a[b]` names no property. */
function propertyName(member: TSESTree.MemberExpression): string | null {
    const { property } = member;
    if (!member.computed && property.type === AST_NODE_TYPES.Identifier) return property.name;
    return property.type === AST_NODE_TYPES.Literal && typeof property.value === 'string' ? property.value : null;
}

/**
 * Each `*Sync` a default or namespace import of a blocking module is read for:
 * `fs.readFileSync(…)`, and `const { readFileSync } = fs`.
 */
function syncReads(
    context: Context,
    specifier: TSESTree.ImportDefaultSpecifier | TSESTree.ImportNamespaceSpecifier,
): [TSESTree.Node, string][] {
    const [variable] = context.sourceCode.getDeclaredVariables(specifier);
    return (variable?.references ?? []).flatMap(({ identifier }): [TSESTree.Node, string][] => {
        const { parent } = identifier;
        if (parent.type === AST_NODE_TYPES.MemberExpression && parent.object === identifier) {
            const name = propertyName(parent);
            return name?.endsWith('Sync') === true ? [[parent, name]] : [];
        }
        if (parent.type !== AST_NODE_TYPES.VariableDeclarator || parent.id.type !== AST_NODE_TYPES.ObjectPattern) {
            return [];
        }
        return parent.id.properties.flatMap((property): [TSESTree.Node, string][] => {
            if (property.type !== AST_NODE_TYPES.Property || property.key.type !== AST_NODE_TYPES.Identifier) return [];
            return property.key.name.endsWith('Sync') ? [[property, property.key.name]] : [];
        });
    });
}

/** Whether the call's object chain starts at a binding imported from `vscode`, not at a name that happens to read so. */
function isVscodeApi(context: Context, callee: TSESTree.MemberExpression): boolean {
    let root: TSESTree.Expression = callee.object;
    while (root.type === AST_NODE_TYPES.MemberExpression) root = root.object;
    if (root.type !== AST_NODE_TYPES.Identifier) return false;
    let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(callee);
    while (scope !== null) {
        const variable = scope.set.get(root.name);
        if (variable !== undefined) {
            const [definition] = variable.defs;
            return (
                definition?.type === TSESLint.Scope.DefinitionType.ImportBinding &&
                definition.parent.type === AST_NODE_TYPES.ImportDeclaration &&
                definition.parent.source.value === 'vscode'
            );
        }
        scope = scope.upper;
    }
    return false;
}
