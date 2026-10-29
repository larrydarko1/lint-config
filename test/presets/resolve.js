/**
 * The rules each preset resolves, with its family's standards at their defaults, on one
 * file per area. Shared by preset-snapshots.test.js and `npm run presets:record`.
 *
 * Asked of ESLint itself rather than read off the config array: flat config is
 * last-match-wins, so what a file gets is the resolver's answer, not any one block's.
 * The files need not exist; `calculateConfigForFile` matches paths, not contents.
 */
import { ESLint } from 'eslint';

import { apiStandards } from '../../src/eslint/api/index.ts';
import { baseStandards } from '../../src/eslint/base/index.ts';
import { electronStandards } from '../../src/eslint/electron/index.ts';
import { fullstackStandards } from '../../src/eslint/fullstack/index.ts';
import { larry } from '../../src/eslint/index.ts';
import { libraryStandards } from '../../src/eslint/library/index.ts';
import { spaStandards } from '../../src/eslint/spa/index.ts';
import { tauriStandards } from '../../src/eslint/tauri/index.ts';

/** Not a real project: nothing is read from it, and every path below is relative to it. */
const ROOT = '/tmp/lint-config-preset-snapshots';

/**
 * Each preset's standards at their defaults, and one file for each area its rules address.
 * The base preset has no defaults, so it is given an invented layout of its own.
 */
export const PRESETS = {
    api: {
        standards: apiStandards,
        files: [
            'src/index.ts',
            'src/routes/users.ts',
            'src/gateway/socket.ts',
            'src/lib/config.ts',
            'src/lib/db.ts',
            'src/middleware/error-handler.ts',
            'src/routes/__tests__/users.test.ts',
            'e2e/login.spec.ts',
            'scripts/seed.ts',
            'db/migrations/001-init.js',
            'eslint.config.js',
        ],
    },
    base: {
        standards: baseStandards,
        paths: {
            source: ['app/**/*.ts'],
            tests: ['spec/**/*.ts'],
            browser: [],
            node: ['app/**/*.ts', 'spec/**/*.ts', 'tools/**/*.ts'],
        },
        files: ['app/index.ts', 'app/server/routes.ts', 'spec/index.spec.ts', 'tools/release.ts', 'eslint.config.js'],
    },
    electron: {
        standards: electronStandards,
        files: [
            'src/main/index.ts',
            'src/preload/index.ts',
            'src/renderer/App.vue',
            'src/renderer/composables/useClock.ts',
            'tests/main/index.test.ts',
            'scripts/release.ts',
            'eslint.config.js',
        ],
    },
    fullstack: {
        standards: fullstackStandards,
        files: [
            'frontend/src/App.vue',
            'frontend/src/composables/useClock.ts',
            'api/src/routes/users.ts',
            'api/src/lib/config.ts',
            'api/src/__tests__/users.test.ts',
            'worker/src/index.ts',
            'packages/shared/src/index.ts',
            'e2e/login.spec.ts',
            'db/migrations/001-init.js',
            'eslint.config.js',
        ],
    },
    library: {
        standards: libraryStandards,
        files: ['src/index.ts', 'test/index.test.js', 'test/index.test.ts', 'scripts/release.ts', 'eslint.config.js'],
    },
    spa: {
        standards: spaStandards,
        files: [
            'src/main.ts',
            'src/App.vue',
            'src/composables/__tests__/useClock.test.ts',
            'src/i18n/locales/en.json',
            'e2e/login.spec.ts',
            'vite.config.ts',
            'eslint.config.js',
        ],
    },
    tauri: {
        standards: tauriStandards,
        files: [
            'src/main.ts',
            'src/App.vue',
            'src/bridge/commands.ts',
            'tests/composables/useClock.test.ts',
            'vitest.setup.ts',
            'eslint.config.js',
        ],
    },
};

const isOff = (entry) => {
    const severity = Array.isArray(entry) ? entry[0] : entry;
    return severity === 0 || severity === 'off';
};

/** A severity spelled one way, so `2` and `'error'` are not a difference. */
const SEVERITY = { 1: 'warn', 2: 'error', warn: 'warn', error: 'error' };

/** `"error"`, or `["error", ...options]` when the rule has options. */
const normalise = (entry) => {
    const [severity, ...options] = Array.isArray(entry) ? entry : [entry];
    return options.length ? [SEVERITY[severity], ...options] : SEVERITY[severity];
};

/**
 * `{ rule: [{ files, entry }] }`: each rule that is on, with each distinct entry it
 * resolves to and the files that get it (`"*"` for every file). A rule that is off is
 * left out, so `off` and absent, which do the same, read the same.
 */
export async function resolvePreset(preset) {
    const { standards, paths, files } = PRESETS[preset];
    const eslint = new ESLint({
        overrideConfigFile: true,
        baseConfig: larry({ preset, rootDir: ROOT, standards: standards(), ...(paths ? { paths } : {}) }),
        cwd: ROOT,
    });
    /** rule → serialised entry → files, in PRESETS order. */
    const byRule = new Map();
    for (const file of files) {
        const config = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
        for (const [rule, entry] of Object.entries(config?.rules ?? {})) {
            if (isOff(entry)) continue;
            const variants = byRule.get(rule) ?? new Map();
            const key = JSON.stringify(normalise(entry));
            variants.set(key, [...(variants.get(key) ?? []), file]);
            byRule.set(rule, variants);
        }
    }
    return Object.fromEntries(
        [...byRule.keys()].sort().map((rule) => [
            rule,
            [...byRule.get(rule)].map(([entry, matched]) => ({
                files: matched.length === files.length ? '*' : matched,
                entry: JSON.parse(entry),
            })),
        ]),
    );
}

/**
 * One rule per key and one variant per line, with a long option list one element per
 * line, so a diff of the snapshot points at the selector or option that moved.
 */
export function serialise(snapshot) {
    const entryOf = (entry) => {
        const flat = JSON.stringify(entry);
        if (!Array.isArray(entry) || flat.length <= 120) return flat;
        return `[\n${entry.map((part) => `                ${JSON.stringify(part)}`).join(',\n')}\n            ]`;
    };
    const rules = Object.entries(snapshot).map(([rule, variants]) => {
        const lines = variants.map(
            ({ files, entry }) => `        { "files": ${JSON.stringify(files)}, "entry": ${entryOf(entry)} }`,
        );
        return `    ${JSON.stringify(rule)}: [\n${lines.join(',\n')}\n    ]`;
    });
    return `{\n${rules.join(',\n')}\n}\n`;
}
