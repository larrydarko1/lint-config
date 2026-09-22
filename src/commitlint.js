/**
 * Commit message rules: conventional commits, with the type list the projects
 * actually use and the two length limits raised for bodies that explain a why.
 */

const TYPES = [
    // Core work (most common)
    'feat', // A new feature
    'fix', // A bug fix
    'perf', // A code change that improves performance (no behavior change)
    'refactor', // A code change that neither fixes a bug nor adds a feature

    // Quality & safety
    'test', // Adding missing tests or correcting existing tests
    'security', // Security-specific fix or hardening

    // Documentation & style
    'docs', // Documentation only (including JSDoc, README, instruction files)
    'style', // Formatting / CSS only (Prettier, whitespace)

    // Maintenance & operations
    'chore', // Pipeline changes, lockfile updates, misc maintenance
    'bump', // Version bump (`bump: version 1.0.1`) — release commits

    // Special
    'revert', // Reverts a previous commit
];

const MULTI_WHY = [/ and also /i, / and then /i, / as well as /i, /,\s*(plus|and also)\s/i, / \+ also /i, /;\s*(also|plus)\s/i];

const singleWhy = ({ subject }) => [
    subject === null || !MULTI_WHY.some((p) => p.test(subject)),
    'subject names two pieces of work — a commit answers one "why". Consider splitting it; a refactor and the feature that uses it review far better apart.',
];

/**
 * @param {object} [options]
 * @param {boolean} [options.subjectSingleWhy=true] Warn when a subject line describes two pieces of
 *   work ("fix X and also Y"). Severity 1 — it never blocks a commit.
 * @param {string[]} [options.types] Replace the allowed type list outright.
 * @param {number} [options.headerMaxLength=200]
 * @param {number} [options.bodyMaxLineLength=400]
 * @param {object} [options.rules] Extra commitlint rules, merged last.
 */
export function commitlint(options = {}) {
    const {
        subjectSingleWhy = true,
        types = TYPES,
        headerMaxLength = 200,
        bodyMaxLineLength = 400,
        rules = {},
    } = options;

    return {
        extends: ['@commitlint/config-conventional'],
        ...(subjectSingleWhy ? { plugins: [{ rules: { 'subject-single-why': singleWhy } }] } : {}),
        rules: {
            'header-max-length': [2, 'always', headerMaxLength],
            'body-max-line-length': [2, 'always', bodyMaxLineLength],
            ...(subjectSingleWhy ? { 'subject-single-why': [1, 'always'] } : {}),
            'type-enum': [2, 'always', types],
            ...rules,
        },
    };
}

export default commitlint();
