/**
 * A failure is logged once, at the boundary that handles it: a Rust command logs its own
 * where it returns it, and a bridge wrapper logs a plugin's where it turns it into a code.
 */
export const errorHandlingSelectors = [
    {
        selector:
            'CatchClause > BlockStatement > ExpressionStatement:has(CallExpression[callee.property.name=/^(error|warn|fatal)$/]) + ThrowStatement',
        message:
            'Do not log and rethrow — that logs the same failure once per layer. A bridge wrapper logs a plugin’s rejection and returns `{ success: false, error: code }`; a command’s failure was already logged in Rust, so return its code without logging it again.',
    },
];
