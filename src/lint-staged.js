/**
 * What runs on staged files before a commit. Each project's hook decides what
 * else to run around it (a typecheck, for instance) — that stays in .husky/.
 */

/**
 * @param {object} [options]
 * @param {boolean} [options.stylelint=false] Also run `stylelint --fix` on staged SCSS and Vue files.
 * @param {object} [options.tasks={}] Extra glob → command entries, merged last.
 */
export function lintStaged(options = {}) {
    const { stylelint = false, tasks = {} } = options;

    return {
        '*.{ts,vue}': ['eslint --fix', 'prettier --write'],
        ...(stylelint ? { '*.{scss,vue}': ['stylelint --fix'] } : {}),
        '*.{scss,json,md}': ['prettier --write'],
        ...tasks,
    };
}

export default lintStaged();
