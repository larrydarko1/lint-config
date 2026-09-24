import type { Linter } from 'eslint';

/**
 * `@typescript-eslint/naming-convention`, which was copied verbatim into all five
 * projects — about 60 lines each. It is the same everywhere because it describes
 * how Larry names things, not what any one project does.
 */
export const NAMING_CONVENTION: Linter.RuleEntry = [
    'error',
    // Catch-all: camelCase for anything not matched below.
    {
        selector: 'default',
        format: ['camelCase'],
        leadingUnderscore: 'allow',
        trailingUnderscore: 'forbid',
    },
    // Variables: camelCase or UPPER_CASE constants; PascalCase for Vue component refs.
    {
        selector: 'variable',
        format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
        leadingUnderscore: 'allow',
        trailingUnderscore: 'forbid',
    },
    // Import bindings: PascalCase for Vue SFCs and class constructors.
    { selector: 'import', format: ['camelCase', 'PascalCase'] },
    // Functions: camelCase; PascalCase allowed for Vue SFCs.
    { selector: 'function', format: ['camelCase', 'PascalCase'] },
    // Parameters: leading `_` for intentionally unused params only.
    {
        selector: 'parameter',
        format: ['camelCase'],
        leadingUnderscore: 'allow',
        trailingUnderscore: 'forbid',
    },
    // Class / type properties: camelCase; UPPER_CASE for static readonly.
    {
        selector: 'property',
        format: ['camelCase', 'UPPER_CASE'],
        leadingUnderscore: 'allow',
        trailingUnderscore: 'forbid',
    },
    // Escape hatch for class/type quoted properties.
    { selector: 'property', modifiers: ['requiresQuotes'], format: null },
    // Object literal properties — snake_case too, for payloads shaped by an external API.
    {
        selector: 'objectLiteralProperty',
        format: ['camelCase', 'UPPER_CASE', 'PascalCase', 'snake_case'],
        leadingUnderscore: 'allow',
        trailingUnderscore: 'forbid',
    },
    // Escape hatch for object literals with quoted keys.
    {
        selector: 'objectLiteralProperty',
        modifiers: ['requiresQuotes'],
        format: null,
    },
    // Classes, interfaces, type aliases, enums: PascalCase.
    { selector: 'typeLike', format: ['PascalCase'] },
    // Enum members: UPPER_CASE.
    { selector: 'enumMember', format: ['UPPER_CASE'] },
    // Generic type parameters: T-prefixed PascalCase.
    { selector: 'typeParameter', format: ['PascalCase'], prefix: ['T'] },
];
