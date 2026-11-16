/** A failure is logged once, where it is handled: the command or event handler that tells the person. */
export const errorHandlingSelectors = [
    {
        selector:
            'CatchClause > BlockStatement > ExpressionStatement:has(CallExpression[callee.property.name=/^(error|warn)$/]) + ThrowStatement',
        message:
            'Do not log and rethrow — that logs the same failure once per layer. Let it reach the command or event handler that shows it to the person, and log it once there.',
    },
];
