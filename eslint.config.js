// This package lints itself with the library family, imported from its own source.
import { larry } from './src/eslint/index.ts';
import { PRESETS } from './src/eslint/presets.ts';
import { libraryStandards } from './src/eslint/library/index.ts';

export default larry({
    preset: 'library',
    rootDir: import.meta.dirname,
    paths: {
        // A rule module's visitor keys are AST selectors (`CallExpression`, `Program:exit`), not names.
        configFiles: [...PRESETS.library.configFiles, 'src/eslint/rules/**/*.ts'],
    },
    standards: libraryStandards({
        // A gate's job is its report, which it prints for the script that ran it; the CLI's is its output.
        logging: { consoleAllowed: ['src/gates/**/*.ts', 'src/cli/**/*.ts'] },
        // knip and npm run as children, and are given this process's environment.
        env: { processEnvAllowed: ['src/gates/dead-code.ts', 'src/gates/publish.ts'] },
        // The shareable configs: each tool loads one by its default export.
        defaultExportAllowed: ['src/commitlint.ts', 'src/lint-staged.ts', 'src/prettier.ts', 'src/stylelint.ts'],
        // The rule and the gate that ban deferral markers, and their tests, quote them.
        refactoring: {
            markerFiles: [
                'eslint.config.js',
                'src/eslint/rules/refactoring.ts',
                'src/eslint/rules/testing.ts',
                'src/gates/refactoring.ts',
                'test/gate-refactoring.test.js',
            ],
        },
    }),
    overrides: [
        // The suites' fixtures are workflows, Dockerfiles and templates, which spell `${…}` literally.
        { files: ['test/**/*.js'], rules: { 'no-template-curly-in-string': 'off' } },
    ],
});
