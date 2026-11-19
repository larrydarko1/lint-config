// This package's own gates, run by its own CLI from source: `npm run check`.
import { defineConfig } from './src/config.ts';
import { packageEntries } from './src/knip.ts';

export default defineConfig({
    family: 'library',
    gates: {
        'code-style': {
            scan: ['src', 'scripts', 'test'],
            casing: [{ files: /\.(?:ts|js)$/, style: 'kebab' }],
            // Over the softcap when this package first checked itself, plus the lines the brace rule added. Lower a number, never raise it.
            baseline: {
                'src/eslint/index.ts': 409,
                'src/eslint/presets.ts': 401,
                'src/gates/api-standards.ts': 1609,
                'src/gates/db-drift.ts': 757,
                'src/gates/declaration-order.ts': 531,
                'src/gates/docker.ts': 575,
                'src/gates/electron-security.ts': 712,
                'src/gates/error-handling/fullstack.ts': 560,
                'src/gates/extension-manifest.ts': 403,
                'src/gates/ipc-standards.ts': 485,
                'src/gates/lib/rust.ts': 439,
                'src/gates/metrics.ts': 723,
                'src/gates/pipeline.ts': 667,
                'src/gates/scss-standards.ts': 469,
                'src/gates/security-drift.ts': 935,
                'src/gates/tauri-commands.ts': 520,
                'src/gates/tauri-security.ts': 439,
                'src/gates/testing.ts': 484,
                'src/gates/tsconfigs.ts': 520,
                'src/gates/ws-standards.ts': 634,
            },
        },
        'dead-code': { publicApi: packageEntries() },
        'declaration-order': { sourceRoots: ['src', 'scripts'] },
        // The suites repeat their fixtures on purpose, so they are not scanned.
        'duplication': {
            scan: ['src'],
            ceilings: {
                typescript: { limit: 1.7, note: 'Where the gates stood when this package first checked itself.' },
            },
            maxCloneTokens: 125,
        },
        // The source is public, but the projects that install this package may not be.
        'licenses': { distribution: 'closed' },
        'package-json': {
            rootRequired: [
                'name',
                'version',
                'description',
                'license',
                'author',
                'type',
                'files',
                'exports',
                'engines',
            ],
            exactFields: {
                dependencies:
                    "This package's lockfile never reaches the projects that install it, so an exact pin is the only way to give them all the same tools. See The toolchain in the README.",
            },
            tildeAllowed: {
                typescript:
                    "typescript-eslint supports TypeScript below 6.1, so a minor bump would install one it doesn't.",
            },
        },
        'refactoring': { claudeCode: true },
        'secrets': {
            allowlist: [
                {
                    file: 'test/gate-env-drift.test.js',
                    rule: 'private-key',
                    reason: 'A bare header with no key after it: the input that proves env-drift spots one in an example file.',
                },
            ],
        },
    },
});
