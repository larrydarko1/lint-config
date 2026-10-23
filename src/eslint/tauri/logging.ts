const LOG_METHODS = '/^(trace|debug|info|warn|error)$/';

export const loggerCallSelectors = [
    {
        selector: `CallExpression[callee.property.name=${LOG_METHODS}] > TemplateLiteral[expressions.length>0]:first-child`,
        message:
            'No interpolation in the log message — the message must stay low-cardinality so identical events group together when you read the log file. Pass the variables as fields: log.warn("File not found", { path }).',
    },
    {
        selector: `CallExpression[callee.property.name=${LOG_METHODS}] Property[key.name='err'] > MemberExpression[property.name='message']`,
        message:
            'Log the whole error as { err }, not `err.message` — the bridge’s log writes its stack, and for a rejection from Rust the value itself is the error code.',
    },
];

export const loggingStandards = (source: string[], tests: string[]) => [
    // The webview's console is read by nobody once the app ships; the log file is.
    { files: source, ignores: tests, rules: { 'no-console': 'error' } },
];
