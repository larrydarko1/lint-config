/**
 * Compares what this package produces against the config files the projects use
 * today. Every difference it prints is either a bug here or a drift there — the
 * point of phase 1 is to get this to zero, then decide which drifts to keep.
 *
 * Usage: node scripts/verify.js [projectName...]
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import prettierConfig from '../src/prettier.js';
import { commitlint } from '../src/commitlint.js';
import { stylelint } from '../src/stylelint.js';
import { lintStaged } from '../src/lint-staged.js';

const PROJECTS_DIR = path.resolve(import.meta.dirname, '..', '..');

/**
 * The options each project needs to reproduce its current configs. A project that
 * needs an option nobody else does is a deliberate departure, and it is written
 * down here rather than hidden in a forked file.
 */
const PROJECTS = [
    {
        name: 'Orchid',
        family: 'full-stack',
        prettier: '.prettierrc',
        commitlint: { file: 'commitlint.config.ts', options: { subjectSingleWhy: true } },
        stylelint: {
            file: 'frontend/.stylelintrc.mjs',
            options: {
                tokenProperties: ['/color$/', 'fill', 'stroke', 'font-size', 'font-weight', 'font-family', 'border-radius'],
                ignoreZero: true,
                noScssColorFunctions: true,
                noScssImport: true,
                mobileFirst: true,
            },
        },
        lintStaged: { options: {} },
    },
    {
        name: 'Mosaic',
        family: 'full-stack',
        prettier: '.prettierrc',
        stylelint: {
            file: 'frontend/.stylelintrc.mjs',
            options: {
                tokenProperties: ['/color$/', 'fill', 'stroke', 'font-size', 'font-weight', 'font-family', 'border-radius'],
                ignoreZero: true,
                noScssColorFunctions: true,
                noScssImport: true,
                mobileFirst: true,
                bem: true,
                unknownCustomProperties: false,
                duplicateFallbacks: true,
            },
        },
    },
    {
        name: 'Fern',
        family: 'electron',
        prettier: '.prettierrc',
        commitlint: { file: 'commitlint.config.js', options: { subjectSingleWhy: false } },
        stylelint: { file: '.stylelintrc.mjs', options: { variablesOverride: true } },
        lintStaged: { options: { stylelint: true } },
    },
    {
        name: 'Quartz',
        family: 'electron',
        prettier: '.prettierrc',
        commitlint: { file: 'commitlint.config.js', options: { subjectSingleWhy: false } },
        stylelint: {
            file: '.stylelintrc.mjs',
            options: {
                spacingUnit: 'rem',
                lowercaseCurrentColor: true,
                referenceFiles: [
                    { files: ['src/renderer/styles/_themes.scss'], customSyntax: 'postcss-scss' },
                    { files: ['src/renderer/styles/_tokens.scss'], customSyntax: 'postcss-scss' },
                ],
            },
        },
        lintStaged: { options: {} },
    },
    {
        name: 'bamboo',
        family: 'electron',
        prettier: '.prettierrc',
        commitlint: { file: 'commitlint.config.js', options: { subjectSingleWhy: false } },
        stylelint: {
            file: '.stylelintrc.mjs',
            options: {
                lowercaseCurrentColor: true,
                referenceFiles: [{ files: ['src/renderer/styles/_themes.scss'], customSyntax: 'postcss-scss' }],
            },
        },
        lintStaged: { options: {} },
    },
];

/** Functions and regexes cannot be compared by value, so compare what they are instead. */
const describe = (value) => {
    if (typeof value === 'function') return '[function]';
    if (value instanceof RegExp) return `[regexp ${value.source}]`;
    return value;
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every place `ours` and `theirs` disagree, as readable `path: ours vs theirs` lines. */
const diff = (ours, theirs, at = '') => {
    const o = describe(ours);
    const t = describe(theirs);

    if (Array.isArray(o) && Array.isArray(t)) {
        const found = [];
        for (let i = 0; i < Math.max(o.length, t.length); i += 1) found.push(...diff(o[i], t[i], `${at}[${i}]`));
        return found;
    }

    if (isPlainObject(o) && isPlainObject(t)) {
        const keys = [...new Set([...Object.keys(o), ...Object.keys(t)])].sort();
        return keys.flatMap((key) => diff(o[key], t[key], at ? `${at}.${key}` : key));
    }

    if (JSON.stringify(o) === JSON.stringify(t)) return [];
    return [`${at || '(root)'}: ours ${JSON.stringify(o) ?? 'undefined'} vs theirs ${JSON.stringify(t) ?? 'undefined'}`];
};

const load = async (projectName, file) => {
    const full = path.join(PROJECTS_DIR, projectName, file);
    if (file.endsWith('.json') || file === '.prettierrc') return JSON.parse(await readFile(full, 'utf8'));
    return (await import(pathToFileURL(full).href)).default;
};

const packageJsonOf = async (projectName) =>
    JSON.parse(await readFile(path.join(PROJECTS_DIR, projectName, 'package.json'), 'utf8'));

const only = process.argv.slice(2);
const projects = only.length ? PROJECTS.filter((p) => only.includes(p.name)) : PROJECTS;

let differences = 0;
let compared = 0;

for (const project of projects) {
    console.log(`\n\x1b[1m${project.name}\x1b[0m (${project.family})`);

    const checks = [];

    if (project.prettier) checks.push(['prettier', prettierConfig, () => load(project.name, project.prettier)]);
    if (project.commitlint)
        checks.push([
            'commitlint',
            commitlint(project.commitlint.options),
            () => load(project.name, project.commitlint.file),
        ]);
    if (project.stylelint)
        checks.push([
            'stylelint',
            stylelint(project.stylelint.options),
            () => load(project.name, project.stylelint.file),
        ]);
    if (project.lintStaged)
        checks.push([
            'lint-staged',
            lintStaged(project.lintStaged.options),
            async () => (await packageJsonOf(project.name))['lint-staged'],
        ]);

    for (const [label, ours, loadTheirs] of checks) {
        compared += 1;
        let theirs;
        try {
            theirs = await loadTheirs();
        } catch (error) {
            console.log(`  \x1b[31m✗\x1b[0m ${label}: could not read — ${error.message}`);
            differences += 1;
            continue;
        }

        const found = diff(ours, theirs);
        if (found.length === 0) {
            console.log(`  \x1b[32m✓\x1b[0m ${label}`);
        } else {
            differences += found.length;
            console.log(`  \x1b[31m✗\x1b[0m ${label} — ${found.length} difference(s)`);
            for (const line of found) console.log(`      ${line}`);
        }
    }
}

console.log(
    `\n${differences === 0 ? '\x1b[32m' : '\x1b[31m'}${compared} config(s) compared, ${differences} difference(s)\x1b[0m`,
);
process.exit(differences === 0 ? 0 : 1);
