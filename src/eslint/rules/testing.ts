import vitest from '@vitest/eslint-plugin';

/** The runner's names for a suite and a case. Each takes `.only`, `.skip` and `.todo`. */
const NODE_TEST_FNS = 'test|it|describe|suite';

const PARKED_CASE =
    'reports as passing while checking nothing. Fix it or delete it; deferred work goes in the tracker.';

/**
 * node:test's focused and parked cases, as a call (`test.only(…)`) or as an option
 * (`test('…', { skip: true }, fn)`). A call, not a reference: `RuleTester.itOnly = it.only`
 * wires a runner and parks nothing.
 */
export const nodeTestParkedSelectors = [
    {
        selector: `CallExpression > MemberExpression.callee[object.name=/^(${NODE_TEST_FNS})$/][property.name='only']`,
        message:
            '`.only` narrows a `--test-only` run to this case and silently drops the rest. Remove it before committing.',
    },
    {
        selector: `CallExpression > MemberExpression.callee[object.name=/^(${NODE_TEST_FNS})$/][property.name=/^(skip|todo)$/]`,
        message: `A skipped or todo case ${PARKED_CASE}`,
    },
    {
        selector: `CallExpression[callee.name=/^(${NODE_TEST_FNS})$/] > ObjectExpression > Property[key.name=/^(only|skip|todo)$/]`,
        message: `A focused, skipped or todo case ${PARKED_CASE}`,
    },
];

/** `assert.equal(1, '1')` passes on the legacy API, which compares with `==`. */
export const nodeAssertBannedImports = ['assert', 'node:assert'].map((name) => ({
    name,
    message: "Import `node:assert/strict`. The legacy API compares with `==`, so `assert.equal(1, '1')` passes.",
}));

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

/**
 * The testing standard for suites run by `node --test`. The vitest rules recognise only
 * calls imported from vitest, so none of them reach a node:test suite; this is the part
 * of them the runner has an equivalent for.
 *
 * @param files The family's test files.
 */
export const nodeTestStandards = (files: string[]) => [
    {
        files,
        plugins: { vitest },
        rules: {
            'no-restricted-syntax': ['error', ...nodeTestParkedSelectors],
            'no-restricted-imports': ['error', { paths: nodeAssertBannedImports }],
            // Reads comments, not calls, so it works whichever runner the suite uses.
            'vitest/no-commented-out-tests': 'error',
        },
    },
];
