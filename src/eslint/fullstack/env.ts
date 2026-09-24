export const configModuleSelectors = [
    {
        selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
        message: 'Do not read process.env.X in config. Add the key to the Zod schema and read it from `parsed`.',
    },
    {
        selector: "CallExpression[callee.name='parseInt']",
        message: 'Use z.coerce.number() in the schema instead of parseInt().',
    },
    {
        selector: "CallExpression[callee.name='parseFloat']",
        message: 'Use z.coerce.number() in the schema instead of parseFloat().',
    },
];

export const noImportMetaEnv = {
    selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
    message:
        'Do not read `import.meta.env` here. Validate it once with Zod in a single frontend config module and import the typed `config` — every VITE_* var is inlined into the bundle, so this is also the boundary that keeps a secret from being published to every visitor.',
};

export default [
    {
        rules: {
            'no-process-env': 'error',
        },
    },
    {
        files: [
            '**/lib/config.ts',
            '**/config/env.ts',
            '**/__tests__/**/*.ts',
            '**/*.test.ts',
            '**/*.setup.ts',
            'e2e/**/*.ts',
        ],
        rules: {
            'no-process-env': 'off',
        },
    },
    {
        files: ['scripts/**/*.ts', 'db/**/*.js'],
        rules: {
            'no-process-env': 'off',
        },
    },
];
