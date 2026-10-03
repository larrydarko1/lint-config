import type { FullstackLayout } from '../presets.ts';

export const errorHandlingSelectors = [
    {
        selector:
            'CatchClause > BlockStatement > ExpressionStatement:has(CallExpression[callee.property.name=/^(error|warn|fatal)$/]) + ThrowStatement',
        message:
            'Do not log and rethrow — that logs the same failure once per layer. Log once at the boundary that handles it, or carry the extra fields as the AppError `logContext` argument so the error handler writes them into the single boundary line.',
    },
    {
        selector:
            "CallExpression[callee.property.name='json'] > ObjectExpression > Property[key.name='error'] > MemberExpression[property.name=/^(message|stack)$/]",
        message:
            "Never put an Error's `message` or `stack` on the wire — it is English the frontend cannot translate and may carry internals or reflected input. Throw `new AppError(status, 'SOME_CODE', message)` instead: the code goes to the client, the message stays in the log.",
    },
];

/**
 * A caught error's message reaches a log or an error's message, never a response: the
 * error handler keeps it off the thrown path, and this keeps it off the path where a
 * catch block turns the failure into data (a per-item `error` in a batch result).
 */
export const errorHandlingStandards = (layout: FullstackLayout) => [
    {
        files: layout.backend,
        ignores: ['**/__tests__/**', '**/*.test.ts'],
        rules: { 'larry/no-caught-message-leak': 'error' },
    },
];
