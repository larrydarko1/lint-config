export const noDirectErrorResponse = {
    selector: "CallExpression[callee.object.name='res'][callee.property.name='status'] > Literal[value>=400]",
    message:
        'Do not respond to an error directly — throw `new AppError(status, code, message, params?, logContext?, securityEvent?)` so the central error handler owns the response + the boundary log. If this is a deliberate exception (a stream where headers may already be sent, a health probe, a self-logging operational path, or the error handler itself), add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
};

export const loggerCallSelectors = [
    {
        selector: `CallExpression[callee.property.name='/^(trace|debug|info|warn|error|fatal)$/'] > TemplateLiteral[expressions.length>0]`,
        message:
            "No interpolation in log messages — the message must be low-cardinality so identical events aggregate. Put variables in the structured object: logger.info({ userId }, 'Watched video').",
    },
    {
        selector: `CallExpression[callee.property.name='/^(trace|debug|info|warn|error|fatal)$/'] > Literal[value=/^\\[/]`,
        message:
            "No prefix tags like '[worker]' in the message — the service name is a base binding (pino `name`), and the operation goes in an `op` field (e.g. { op: 'jobs.transcode' }).",
    },
    {
        selector: `CallExpression[callee.property.name='/^(trace|debug|info|warn|error|fatal)$/'] Property[key.name='err'] > MemberExpression[property.name='message']`,
        message:
            "Log the whole error as { err } — pino's serialiser keeps the stack AND the error's own fields (an S3 error's code, an ioredis error's command). { err: err.message } throws all of that away.",
    },
];

/**
 * @param [options.consoleAllowed=[]] Files where `console` is the point — the app shell
 *   reporting a boot failure it cannot yet log any other way.
 */
export const loggingStandards = (options: { consoleAllowed?: string[] } = {}) => {
    const { consoleAllowed = [] } = options;

    return [
        {
            files: ['api/src/**/*.ts', 'worker/src/**/*.ts'],
            ignores: ['**/__tests__/**'],
            rules: {
                'no-console': 'error',
            },
        },
        {
            files: ['frontend/src/**/*.{ts,vue}'],
            ignores: ['**/__tests__/**'],
            rules: {
                'no-console': 'error',
            },
        },
        ...(consoleAllowed.length ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } }] : []),
    ];
};
