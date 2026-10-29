import type { Linter } from 'eslint';

export const errorHandlingSelectors = [
    {
        selector:
            'CatchClause > BlockStatement > ExpressionStatement:has(CallExpression[callee.property.name=/^(error|warn|fatal)$/]) + ThrowStatement',
        message:
            'Do not log and rethrow — that logs the same failure once per layer. Log once at the boundary that handles it (the IPC handler), or attach the extra fields to the error you throw so the boundary writes them into the single line.',
    },
];

/**
 * A caught error's message reaches a log or an error's message, never the renderer: an
 * IPC reply carrying `err.message` is English the window cannot translate, and it can
 * name paths on the user's disk.
 */
export const errorHandlingStandards = (mainAndPreload: string[]): Linter.Config[] => [
    {
        files: mainAndPreload,
        rules: { 'larry/no-caught-message-leak': 'error' },
    },
];
