/**
 * What runs on staged files before a commit. Each project's hook decides what
 * else to run around it (a typecheck, for instance) — that stays in .husky/.
 */

export type LintStagedOptions = {
    stylelint?: boolean; // Also run `stylelint --fix` on staged SCSS and Vue files. Defaults to false.
    tasks?: Record<string, string | string[]>; // Extra glob → command entries, merged last.
};

export function lintStaged(options: LintStagedOptions = {}): Record<string, string | string[]> {
    const { stylelint = false, tasks = {} } = options;

    return {
        '*.{ts,vue}': ['eslint --fix', 'prettier --write'],
        ...(stylelint ? { '*.{scss,vue}': ['stylelint --fix'] } : {}),
        '*.{scss,json,md}': ['prettier --write'],
        ...tasks,
    };
}

export default lintStaged();
