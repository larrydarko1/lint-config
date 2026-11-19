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
                'src/gates/api-standards.ts': 1643,
                'src/gates/db-drift.ts': 761,
                'src/gates/declaration-order.ts': 551,
                'src/gates/docker.ts': 583,
                'src/gates/duplication.ts': 404,
                'src/gates/electron-security.ts': 718,
                'src/gates/error-handling/fullstack.ts': 568,
                'src/gates/extension-manifest.ts': 407,
                'src/gates/ipc-standards.ts': 489,
                'src/gates/lib/rust.ts': 458,
                'src/gates/metrics.ts': 727,
                'src/gates/pipeline.ts': 683,
                'src/gates/scss-standards.ts': 482,
                'src/gates/security-drift.ts': 946,
                'src/gates/tauri-commands.ts': 532,
                'src/gates/tauri-security.ts': 447,
                'src/gates/testing.ts': 501,
                'src/gates/tsconfigs.ts': 532,
                'src/gates/ws-standards.ts': 636,
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
