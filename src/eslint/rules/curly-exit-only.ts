/**
 * `curly-exit-only`: a body goes without braces only when it leaves, written whole on the line
 * of its `if` — `if (user === null) return;`. That line reads as a guard at a glance; every body
 * that does work gets a block, so work always looks the same and a line added to it lands inside.
 * Core `curly` has no option that tells a jump from work. `larry()` turns it on after Prettier.
 */
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from '@typescript-eslint/utils';

type Context = Readonly<TSESLint.RuleContext<'braces', []>>;

const EXITS = new Set<string>([
    AST_NODE_TYPES.ReturnStatement,
    AST_NODE_TYPES.ThrowStatement,
    AST_NODE_TYPES.BreakStatement,
    AST_NODE_TYPES.ContinueStatement,
]);

const curlyExitOnly: TSESLint.RuleModule<'braces'> = {
    meta: {
        defaultOptions: [],
        type: 'suggestion',
        fixable: 'code',
        docs: {
            description: 'Brace every body except a `return`, `throw`, `break` or `continue` on the line of its `if`.',
        },
        schema: [],
        messages: {
            braces: 'Put this body in braces. Only a `return`, `throw`, `break` or `continue` written on the line of its `if` goes without: that line reads as a guard, and a block makes every body that does work look the same.',
        },
    },
    create(context): TSESLint.RuleListener {
        const loop = (node: { body: TSESTree.Statement }): void => {
            requireBraces(context, node.body);
        };
        return {
            IfStatement(node): void {
                if (!isExitOnConditionLine(context, node.consequent)) {
                    requireBraces(context, node.consequent);
                }
                if (node.alternate !== null && node.alternate.type !== AST_NODE_TYPES.IfStatement) {
                    requireBraces(context, node.alternate);
                }
            },
            ForStatement: loop,
            ForInStatement: loop,
            ForOfStatement: loop,
            WhileStatement: loop,
            DoWhileStatement: loop,
        };
    },
};

export const curlyRules = { 'curly-exit-only': curlyExitOnly };

/** Prettier lays the braces out afterwards, so the fix only has to put them in. */
function requireBraces(context: Context, body: TSESTree.Statement): void {
    if (body.type === AST_NODE_TYPES.BlockStatement) return;
    context.report({
        node: body,
        messageId: 'braces',
        fix: (fixer): TSESLint.RuleFix[] => [fixer.insertTextBefore(body, '{ '), fixer.insertTextAfter(body, ' }')],
    });
}

function isExitOnConditionLine(context: Context, body: TSESTree.Statement): boolean {
    const closingParen = context.sourceCode.getTokenBefore(body);
    return (
        EXITS.has(body.type) &&
        closingParen?.loc.end.line === body.loc.start.line &&
        body.loc.start.line === body.loc.end.line
    );
}
