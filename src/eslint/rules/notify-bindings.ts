/**
 * What a name in the Vue app is bound to: `notify` from the notification module, vue-i18n's
 * `t`. Resolved through scope, so a local function of the same name is not one.
 */
import { AST_NODE_TYPES, ASTUtils, TSESLint, type TSESTree } from '@typescript-eslint/utils';

export type Node = TSESTree.Node;
type Variable = TSESLint.Scope.Variable;
type AnyContext = Readonly<TSESLint.RuleContext<string, []>>;

/** Any module of that name, wherever it sits: the one a wrong-folder copy is reported against. */
export const NOTIFICATIONS_MODULE = /(?:^|\/)useNotifications$/;

const { DefinitionType } = TSESLint.Scope;

export function resolve(context: AnyContext, identifier: TSESTree.Identifier): Variable | null {
    return ASTUtils.findVariable(context.sourceCode.getScope(identifier), identifier);
}

/** `notify`, bound by an import of the notification module, wherever that module sits. */
export function isNotify(context: AnyContext, node: Node): boolean {
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
export function isTranslation(context: AnyContext, node: Node): boolean {
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

export function propertyName(member: TSESTree.MemberExpression): string | null {
    const { property } = member;
    if (!member.computed && property.type === AST_NODE_TYPES.Identifier) return property.name;
    if (property.type === AST_NODE_TYPES.Literal && typeof property.value === 'string') return property.value;
    return null;
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
