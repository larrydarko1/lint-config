export const tsSourceSelectors = [
    {
        selector: 'ExportNamedDeclaration[source=null][declaration=null]',
        message:
            'Export at the declaration site (`export const foo = …`), not in a detached `export { foo }` block — a detached export disconnects the symbol from its definition and makes rename-refactoring unreliable. Re-export barrels (`export { x } from "./y"`) are exempt.',
    },
];

export const sharedPackageBannedImports = {
    patterns: [
        {
            group: ['vue', 'vue/*', '@vue/*', 'vue-router', 'pinia', 'vue-i18n'],
            message:
                'The shared package is framework-neutral — api and worker import it, so it must not pull in Vue. A Vue-flavoured type belongs in frontend/src/types/, "Two hard constraints on the shared package").',
        },
        {
            group: ['express', 'express/*', '@types/express', 'mongodb', 'bullmq', 'ioredis'],
            message:
                'The shared package is dependency-light and framework-neutral — it must not import a server framework or a driver. Share the plain shape (a type or constant), and let each workspace import the library itself.',
        },
    ],
};

export const typescriptStandards = [
    {
        files: [
            'api/src/**/*.ts',
            'worker/src/**/*.ts',
            'frontend/src/**/*.{ts,vue}',
            'packages/shared/src/**/*.ts',
            'e2e/**/*.ts',
        ],
        ignores: ['e2e/playwright.config.ts', 'e2e/support/global-setup.ts'],
        rules: {
            'no-restricted-exports': [
                'error',
                {
                    restrictDefaultExports: {
                        direct: true,
                        named: true,
                        defaultFrom: true,
                        namedFrom: true,
                        namespaceFrom: true,
                    },
                },
            ],
        },
    },
    {
        files: [
            'api/src/**/*.ts',
            'worker/src/**/*.ts',
            'frontend/src/**/*.{ts,vue}',
            'packages/shared/src/**/*.ts',
            'e2e/**/*.ts',
        ],
        rules: {
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            'no-restricted-globals': [
                'error',
                {
                    name: '__dirname',
                    message: 'Use `import.meta.dirname` (Node 21.2+) — `__dirname` is CommonJS-only.',
                },
                {
                    name: '__filename',
                    message: 'Use `import.meta.filename` (Node 21.2+) — `__filename` is CommonJS-only.',
                },
            ],
        },
    },
];
