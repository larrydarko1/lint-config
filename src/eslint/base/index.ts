/**
 * The base family: code no other family describes, so nothing about it is assumed. Its
 * rules are the shared ones that hold for any TypeScript, whatever runs it — no crypto
 * the package bans, no `eval`, explicit module boundaries, no default exports, and the
 * refactoring limits — given the paths the project names in `larry({ paths })`. Nothing
 * about logging, the environment, a test runner or an architecture is, since those
 * differ from one kind of project to the next. The selectors a project composes into
 * its own blocks are re-exported individually below.
 */
import { familyStandards, type FamilyStandards } from '../family.ts';
import { refactoringStandards, type RefactoringOptions } from '../rules/refactoring.ts';
import { securityStandards, type SecurityOptions } from '../rules/security.ts';
import { typescriptStandards } from '../rules/typescript.ts';

export { bannedCryptoModules } from '../rules/security.ts';
export { configModuleSelectors } from '../rules/env.ts';
export { noSingleLetterDeclaration, noFileURLToPath } from '../rules/code-style.ts';
export { tsSourceSelectors } from '../rules/typescript.ts';
export { functionContractsPlugin } from '../rules/function-contracts.ts';

export type BaseStandardsOptions = {
    /** Modules a tool loads by their default export: a runner's config, an entry point a host requires. */
    defaultExportAllowed?: string[];
    /** See rules/security.ts — `vHtmlAllowed`, for a project that sets `vue: true`. */
    security?: SecurityOptions;
    /** See rules/refactoring.ts — `markerFiles`. */
    refactoring?: RefactoringOptions;
};

export function baseStandards(options: BaseStandardsOptions = {}): FamilyStandards<'base'> {
    const { defaultExportAllowed = [], security, refactoring } = options;

    return familyStandards('base', [], (paths) => {
        const code = [...paths.source, ...paths.tests];

        return [
            ...securityStandards({ code, vue: paths.vue }, security),
            ...typescriptStandards({
                source: paths.source,
                // `explicit-module-boundary-types` needs types to read, so only what a tsconfig covers.
                code: paths.typedSource,
                defaultExportAllowed,
            }),
            ...refactoringStandards(
                { code, source: paths.source, tests: paths.tests, markerFiles: ['eslint.config.js'] },
                refactoring,
            ),
        ];
    });
}
