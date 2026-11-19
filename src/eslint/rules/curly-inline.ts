/**
 * `curly-inline`: a body that is one plain statement goes beside its `if` or loop, without braces,
 * when the whole line fits in Prettier's width — `if (user === null) return;`. Every other body
 * gets braces: one that doesn't fit, holds more than one statement, or is itself an `if` or loop.
 * The branches of one `if` match, so when one needs braces they all have them. Core `curly` can't
 * measure a line: `multi-or-nest` leaves a body Prettier moved below its `if` bare. `larry()` turns
 * it on after Prettier.
 */
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from '@typescript-eslint/utils';
import { util } from 'prettier';

import { prettierConfig } from '../../prettier.ts';

type MessageId = 'braces' | 'inline';
type Context = Readonly<TSESLint.RuleContext<MessageId, []>>;
type Loop = TSESTree.ForStatement | TSESTree.ForInStatement | TSESTree.ForOfStatement | TSESTree.WhileStatement;

/** A body, and what Prettier prints before it on its line: null when that head spans lines. */
type Branch = { body: TSESTree.Statement; head: string | null };

const PRINT_WIDTH = prettierConfig.printWidth ?? 80;

/** A body that is itself control flow or a declaration keeps its braces, which also keeps a dangling `else` where it is. */
const NEVER_INLINE = new Set<string>([
    AST_NODE_TYPES.IfStatement,
    AST_NODE_TYPES.ForStatement,
    AST_NODE_TYPES.ForInStatement,
    AST_NODE_TYPES.ForOfStatement,
    AST_NODE_TYPES.WhileStatement,
    AST_NODE_TYPES.DoWhileStatement,
    AST_NODE_TYPES.SwitchStatement,
    AST_NODE_TYPES.TryStatement,
    AST_NODE_TYPES.LabeledStatement,
    AST_NODE_TYPES.BlockStatement,
    AST_NODE_TYPES.EmptyStatement,
    AST_NODE_TYPES.VariableDeclaration,
    AST_NODE_TYPES.FunctionDeclaration,
    AST_NODE_TYPES.ClassDeclaration,
]);

const curlyInline: TSESLint.RuleModule<MessageId> = {
    meta: {
        defaultOptions: [],
        type: 'layout',
        fixable: 'code',
        docs: {
            description:
                "Write a one-statement body beside its `if` or loop when it fits in Prettier's width; brace it otherwise.",
        },
        schema: [],
        messages: {
            inline: "Write this body beside its `if` or loop, without braces: it is one statement and the line fits in Prettier's width.",
            braces: "Put this body in braces: it doesn't fit beside its `if` or loop in Prettier's width, it is itself an `if` or loop, or another branch of its `if` needs braces.",
        },
    },
    create(context): TSESLint.RuleListener {
        const loop = (node: Loop): void => {
            settle(context, node.loc.start.column, [{ body: node.body, head: headOf(context, node, node.body) }]);
        };
        return {
            IfStatement(node): void {
                // An `else if` is settled with the rest of its chain, from the first `if`.
                if (node.parent.type === AST_NODE_TYPES.IfStatement && node.parent.alternate === node) return;
                settle(context, node.loc.start.column, chain(context, node));
            },
            ForStatement: loop,
            ForInStatement: loop,
            ForOfStatement: loop,
            WhileStatement: loop,
            // Prettier puts the `while` of a bare `do` body on the next line, so it is never one line.
            DoWhileStatement(node): void {
                settle(context, node.loc.start.column, [{ body: node.body, head: null }]);
            },
        };
    },
};

export const curlyRules = { 'curly-inline': curlyInline };

/** Every branch goes inline when all of them fit, and is braced otherwise. */
function settle(context: Context, column: number, branches: Branch[]): void {
    const inline = branches.every((branch) => fitsInline(context, column, branch));
    for (const { body } of branches) {
        if (inline && body.type === AST_NODE_TYPES.BlockStatement) {
            unbrace(context, body);
        } else if (!inline && body.type !== AST_NODE_TYPES.BlockStatement) {
            // Prettier lays the braces out afterwards, so the fix only has to put them in.
            context.report({
                node: body,
                messageId: 'braces',
                fix: (fixer): TSESLint.RuleFix[] => [
                    fixer.insertTextBefore(body, '{ '),
                    fixer.insertTextAfter(body, ' }'),
                ],
            });
        }
    }
}

function unbrace(context: Context, block: TSESTree.BlockStatement): void {
    const [statement] = block.body;
    if (statement === undefined) return;
    context.report({
        node: block,
        messageId: 'inline',
        fix: (fixer): TSESLint.RuleFix => fixer.replaceText(block, context.sourceCode.getText(statement)),
    });
}

/** Measured the way Prettier measures it, so a body it would move below its `if` is never left bare. */
function fitsInline(context: Context, column: number, { body, head }: Branch): boolean {
    const statement = onlyStatement(context, body);
    if (head === null || statement === null || NEVER_INLINE.has(statement.type)) return false;
    const text = context.sourceCode.getText(statement);
    const oneLine = statement.loc.start.line === statement.loc.end.line;
    // Without its `;`, a statement pulled out of braces could run into the next line.
    return oneLine && text.endsWith(';') && column + util.getStringWidth(`${head} ${text}`) <= PRINT_WIDTH;
}

/** The single statement a body holds, braced or not; null when it holds more, or a comment the fix would drop. */
function onlyStatement(context: Context, body: TSESTree.Statement): TSESTree.Statement | null {
    if (body.type !== AST_NODE_TYPES.BlockStatement) return body;
    const [statement, ...rest] = body.body;
    if (statement === undefined || rest.length > 0 || context.sourceCode.getCommentsInside(body).length > 0) {
        return null;
    }
    return statement;
}

/** Each branch of an `if … else if … else` chain, with the head Prettier prints beside it. */
function chain(context: Context, root: TSESTree.IfStatement): Branch[] {
    const branches: Branch[] = [];
    let current: TSESTree.Statement | null = root;
    let prefix = '';
    while (current?.type === AST_NODE_TYPES.IfStatement) {
        const head = headOf(context, current, current.consequent);
        branches.push({ body: current.consequent, head: head === null ? null : prefix + head });
        current = current.alternate;
        prefix = 'else ';
    }
    if (current !== null) branches.push({ body: current, head: 'else' });
    return branches;
}

/** The source from the keyword to the `)` before the body, when it sits on one line. */
function headOf(context: Context, node: TSESTree.Node, body: TSESTree.Statement): string | null {
    const close = context.sourceCode.getTokenBefore(body);
    if (close?.loc.end.line !== node.loc.start.line) return null;
    return context.sourceCode.text.slice(node.range[0], close.range[1]);
}
