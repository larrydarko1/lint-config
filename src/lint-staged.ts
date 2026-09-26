/**
 * What runs on staged files before a commit. Each project's hook decides what
 * else to run around it (a typecheck, for instance) — that stays in .husky/.
 */

export type LintStagedOptions = {
    /** Also run `stylelint --fix` on staged SCSS and Vue files. Defaults to false. */
    stylelint?: boolean;
    /** Extra glob → command entries, merged last. */
    tasks?: Record<string, string | string[]>;
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
