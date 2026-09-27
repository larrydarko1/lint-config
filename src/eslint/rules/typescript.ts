export const tsSourceSelectors = [
    {
        selector: 'ExportNamedDeclaration[source=null][declaration=null]',
        message:
            'Export at the declaration site (`export const foo = …`), not in a detached `export { foo }` block — a detached export disconnects the symbol from its definition and makes rename-refactoring unreliable. Re-export barrels (`export { x } from "./y"`) are exempt.',
    },
];

/**
 * @param layout.source Code whose modules must not `export default`.
 * @param layout.code Source and tests: explicit boundary types, no CommonJS globals.
 * @param layout.defaultExportAllowed Files a tool loads by their default export (a runner's config).
 */
export const typescriptStandards = (layout: { source: string[]; code: string[]; defaultExportAllowed: string[] }) => [
    {
        files: layout.source,
        // The `*.vue` module shim has to `export default` — the ban is for our own modules.
        ignores: ['**/*.d.ts', ...layout.defaultExportAllowed],
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
        files: layout.code,
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
