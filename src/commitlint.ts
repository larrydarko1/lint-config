/** Conventional commits, with a narrowed type list and raised body length limits. */
import { fileURLToPath } from 'node:url';

/** Resolved from here for the same reason as in stylelint.ts: so the project does not need its own copy. */
const dep = (name: string) => fileURLToPath(import.meta.resolve(name));

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

const MULTI_WHY = [
    / and also /i,
    / and then /i,
    / as well as /i,
    /,\s*(plus|and also)\s/i,
    / \+ also /i,
    /;\s*(also|plus)\s/i,
];

const singleWhy = ({ subject }: { subject: string | null }): [boolean, string] => [
    subject === null || !MULTI_WHY.some((p) => p.test(subject)),
    'subject names two pieces of work — a commit answers one "why". Consider splitting it; a refactor and the feature that uses it review far better apart.',
];

export type CommitlintOptions = {
    subjectSingleWhy?: boolean; // Warn (never block) when a subject describes two pieces of work ("fix X and also Y"). Defaults to true.
    types?: string[]; // Replace the allowed type list outright.
    headerMaxLength?: number; // Defaults to 200.
    bodyMaxLineLength?: number; // Defaults to 400.
    rules?: Record<string, unknown>; // Extra commitlint rules, merged last.
};

export function commitlint(options: CommitlintOptions = {}) {
    const {
        subjectSingleWhy = true,
        types = TYPES,
        headerMaxLength = 200,
        bodyMaxLineLength = 400,
        rules = {},
    } = options;

    return {
        extends: [dep('@commitlint/config-conventional')],
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
