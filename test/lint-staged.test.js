/**
 * The commit hook. What is worth testing is the order on script files: a rule
 * whose verdict depends on layout (the brace rule on a body Prettier moved to its own
 * line) only sees the committed layout when Prettier runs before ESLint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintStaged } from '../src/lint-staged.ts';

test('script files are formatted before ESLint judges them, and again after it fixes them', () => {
    assert.deepEqual(lintStaged()['*.{ts,vue}'], ['prettier --write', 'eslint --fix', 'prettier --write']);
});

test('stylelint and extra tasks are added without touching the script-file order', () => {
    const config = lintStaged({ stylelint: true, tasks: { '*.sh': 'shellcheck' } });
    assert.deepEqual(config['*.{ts,vue}'], ['prettier --write', 'eslint --fix', 'prettier --write']);
    assert.deepEqual(config['*.{scss,vue}'], ['stylelint --fix']);
    assert.equal(config['*.sh'], 'shellcheck');
});
