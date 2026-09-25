/**
 * @param [options.markerFiles=['eslint.config.js']] Files that QUOTE the deferral
 *   markers — the config and the gate that enforce them — so the ban must not fire on themselves.
 */
export const refactoringStandards = (options: { markerFiles?: string[] } = {}) => {
    const { markerFiles = ['eslint.config.js'] } = options;

    return [
        {
            files: [
                'api/src/**/*.ts',
                'worker/src/**/*.ts',
                'frontend/src/**/*.{ts,vue}',
                'packages/shared/src/**/*.ts',
                'e2e/**/*.ts',
            ],
            rules: {
                'max-depth': ['error', 4],
                '@typescript-eslint/max-params': ['error', { max: 6 }],
            },
        },
        {
            files: [
                'api/src/**/*.ts',
                'worker/src/**/*.ts',
                'frontend/src/**/*.{ts,vue}',
                'packages/shared/src/**/*.ts',
            ],
            ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
            rules: { 'max-depth': ['error', 3] },
        },
        {
            rules: {
                'no-else-return': ['error', { allowElseIf: false }],
                'no-warning-comments': [
                    'error',
                    {
                        terms: ['todo', 'fixme', 'fix me', 'hack', 'xxx', 'wip', 'tbd'],
                        location: 'anywhere',
                    },
                ],
            },
        },
        { files: markerFiles, rules: { 'no-warning-comments': 'off' } },
    ];
};
