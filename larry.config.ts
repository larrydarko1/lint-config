// This package's own gates, run by its own CLI from source: `npm run check`.
import { defineConfig } from './src/config.ts';
import { packageEntries } from './src/knip.ts';

export default defineConfig({
    family: 'library',
    gates: {
        'code-style': {
            scan: ['src', 'scripts', 'test'],
            casing: [{ files: /\.(?:ts|js)$/, style: 'kebab' }],
            // Over the softcap when this package first checked itself. Lower a number, never raise it.
            baseline: {
                'src/gates/api-standards.ts': 1617,
                'src/gates/code-style.ts': 441,
                'src/gates/db-drift.ts': 853,
                'src/gates/declaration-order.ts': 520,
                'src/gates/docker.ts': 645,
                'src/gates/electron-security.ts': 733,
                'src/gates/error-handling/fullstack.ts': 566,
                'src/gates/ipc-standards.ts': 487,
                'src/gates/lib/rust.ts': 424,
                'src/gates/metrics.ts': 761,
                'src/gates/pipeline.ts': 710,
                'src/gates/scss-standards.ts': 731,
                'src/gates/security-drift.ts': 952,
                'src/gates/tauri-commands.ts': 503,
                'src/gates/tauri-security.ts': 434,
                'src/gates/testing.ts': 612,
                'src/gates/tsconfigs.ts': 521,
                'src/gates/ws-standards.ts': 638,
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
