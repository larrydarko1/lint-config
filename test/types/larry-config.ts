/**
 * What larry.config.ts's types accept and reject. Compiled by `npm run typecheck`, never
 * run: each `@ts-expect-error` fails the build if the line under it stops being an error.
 */
import { defineConfig, type GatesConfig } from '../../src/config.ts';

/** The gates every family runs that have a required option. */
const REQUIRED: GatesConfig<'library'> = {
    'code-style': { scan: ['src'] },
    'declaration-order': { sourceRoots: ['src'] },
    'duplication': { scan: ['src'], ceilings: { typescript: 2 } },
    'licenses': { distribution: 'closed' },
};

// A family's gates, each with its own options or a reason to skip it.
defineConfig({
    family: 'api',
    gates: {
        ...REQUIRED,
        'testing': { skip: 'invented for the type test' },
        'docker': { skip: 'invented for the type test' },
        'api-standards': { skip: 'invented for the type test' },
        'ws-standards': { skip: 'invented for the type test' },
        'metrics': { skip: 'invented for the type test' },
        'db-drift': { skip: 'invented for the type test' },
        'env-drift': { skip: 'invented for the type test' },
        'security-drift': { skip: 'invented for the type test' },
    },
});

// A gate with no required option may be left out.
defineConfig({ family: 'library', gates: REQUIRED });

// @ts-expect-error -- `licenses` has no default distribution, so it cannot be left out.
defineConfig({ family: 'library', gates: { ...REQUIRED, licenses: undefined } });

defineConfig({
    family: 'library',
    // @ts-expect-error -- `duplication` is missing its required `ceilings`.
    gates: { ...REQUIRED, duplication: { scan: ['src'] } },
});

defineConfig({
    family: 'library',
    gates: {
        ...REQUIRED,
        // @ts-expect-error -- not a distribution.
        licenses: { distribution: 'proprietary' },
    },
});

defineConfig({
    family: 'library',
    gates: {
        ...REQUIRED,
        // @ts-expect-error -- a library has no frontend, so it does not run i18n.
        i18n: { skip: 'no UI' },
    },
});

defineConfig({
    family: 'library',
    gates: {
        ...REQUIRED,
        // @ts-expect-error -- `root` is where the config sits, not an option.
        secrets: { root: '..' },
    },
});

// @ts-expect-error -- not a family.
defineConfig({ family: 'cli', gates: {} });

// The README's example, as written there.
defineConfig({
    family: 'library',
    gates: {
        'code-style': { scan: ['src', 'test'] },
        'duplication': { scan: ['src'], ceilings: { typescript: 2 } },
        'licenses': { distribution: 'closed' },
        'publish': { skip: 'Private until 1.0, so there is no tarball to check yet.' },
    },
});
