export type RefactoringOptions = {
    /**
     * Files that QUOTE the deferral markers — the config and the gate that enforce them —
     * so the ban must not fire on themselves. Defaults to the family's.
     */
    markerFiles?: string[];
};

/**
 * @param layout.code Source and tests: the looser depth and parameter limits.
 * @param layout.source Shipped code, which gets the stricter depth.
 * @param layout.tests Kept out of `source`'s stricter depth.
 * @param layout.markerFiles The family's default for `options.markerFiles`.
 */
export const refactoringStandards = (
    layout: { code: string[]; source: string[]; tests: string[]; markerFiles: string[] },
    options: RefactoringOptions = {},
) => {
    const { markerFiles = layout.markerFiles } = options;

    return [
        {
            files: layout.code,
            rules: {
                'max-depth': ['error', 4],
                '@typescript-eslint/max-params': ['error', { max: 6 }],
            },
        },
        {
            files: layout.source,
            ignores: layout.tests,
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
        ...(markerFiles.length ? [{ files: markerFiles, rules: { 'no-warning-comments': 'off' } }] : []),
    ];
};
