import vitest from '@vitest/eslint-plugin';

/** @param files The family's test files. */
export const testingStandards = (files: string[]) => [
    {
        files,
        plugins: { vitest },
        rules: {
            'vitest/no-focused-tests': 'error',
            'vitest/no-disabled-tests': 'error',
            'vitest/expect-expect': 'error',
            'vitest/no-identical-title': 'error',
            'vitest/valid-expect': 'error',
            'vitest/no-standalone-expect': 'error',
            'vitest/valid-describe-callback': 'error',
            'vitest/no-commented-out-tests': 'error',
            'vitest/consistent-test-it': ['error', { fn: 'test', withinDescribe: 'it' }],
            // An `expect` behind an `if` is a test that passes when the thing it looks for is missing.
            'vitest/no-conditional-expect': 'error',
            'vitest/no-conditional-in-test': 'error',
            'vitest/valid-expect-in-promise': 'error',
            'vitest/require-awaited-expect-poll': 'error',
            'vitest/no-test-return-statement': 'error',
            'vitest/no-duplicate-hooks': 'error',
            'vitest/prefer-hooks-on-top': 'error',
            // A bare `toThrow()` passes on any error, including the TypeError of a broken fixture.
            'vitest/require-to-throw-message': 'error',
            'vitest/prefer-to-be': 'error',
            'vitest/prefer-to-have-length': 'error',
        },
    },
];
