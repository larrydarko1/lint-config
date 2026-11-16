import type { Linter } from 'eslint';

const LOG_METHODS = '/^(trace|debug|info|warn|error)$/';

/** The extension's log is a `LogOutputChannel`, which the person reads in the Output panel and the log file. */
export const loggerCallSelectors = [
    {
        selector: `CallExpression[callee.property.name=${LOG_METHODS}] > TemplateLiteral[expressions.length>0]:first-child`,
        message:
            'No interpolation in the log message — the message must stay low-cardinality so identical events read alike in the Output panel. Pass the variables as arguments: log.warn("Kata not found", { kataId }).',
    },
    {
        selector: `CallExpression[callee.property.name=${LOG_METHODS}] Property[key.name=/^(err|error)$/] > MemberExpression[property.name='message']`,
        message:
            'Log the whole error, not its `message` — the output channel writes the stack and the error’s own fields (an fs error’s `code`), which are the part that tells you what happened.',
    },
];

/** A console in the extension host writes to the editor's own developer tools, where the person never looks. */
export const loggingStandards = (source: string[], consoleAllowed: string[]): Linter.Config[] => [
    { files: source, rules: { 'no-console': 'error' } } satisfies Linter.Config,
    ...(consoleAllowed.length > 0
        ? [{ files: consoleAllowed, rules: { 'no-console': 'off' } } satisfies Linter.Config]
        : []),
];
