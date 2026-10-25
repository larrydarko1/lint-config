/** The manifest: what a published package owes, its ranges, and its field order. */
import { checkPackageJson } from '../../src/gates/package-json.ts';

checkPackageJson({
    rootRequired: ['name', 'version', 'description', 'license', 'author', 'type', 'files', 'exports', 'engines'],
    exactFields: {
        dependencies:
            "This package's lockfile never reaches the projects that install it, so an exact pin is the only way to give them all the same tools. See The toolchain in the README.",
    },
    tildeAllowed: {
        typescript: "typescript-eslint supports TypeScript below 6.1, so a minor bump would install one it doesn't.",
    },
});
