export const noSingleLetterDeclaration = {
    selector: 'VariableDeclarator[id.name=/^[a-hk-zA-Z$]$/]',
    message:
        'Name it. Single-letter variables are allowed only for `i`/`j` as loop counters and `_` for an ignored parameter — everywhere else the name is the only thing telling the next reader what the value is.',
};

export const noFileURLToPath = {
    selector: 'CallExpression[callee.name="fileURLToPath"]',
    message:
        'Use `import.meta.dirname` directly with `path.resolve()` instead of the `fileURLToPath` pattern. Modern ES modules support `import.meta.dirname` natively (Node.js 20.11.0+), which is simpler and more readable than converting `import.meta.url` through fileURLToPath.',
};
