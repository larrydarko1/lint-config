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

export const utilsBannedImportPatterns = [
    {
        group: ['@/lib/*', '@/api/*', '@/services/*', '@/composables/*', '@/stores/*', '**/lib/*', '**/services/*'],
        message:
            'utils/ is pure functions — no side effects, no state, no I/O. Importing infrastructure makes it none of those. Move the function to lib/ (owns one external concern) or to the composable that needs it.',
    },
];

export const libBannedImportPatterns = [
    {
        group: ['@/services/*', '@/services/**', '**/services/*', '**/services/**'],
        message:
            'lib/ owns one external concern and is consumed BY services/ — never the reverse. If lib needs this type, the type belongs in lib (or packages/shared), not in the service.',
    },
];
