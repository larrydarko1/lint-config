/**
 * Every gate, the families it applies to, and where its `check*` function lives. A runner
 * reads the list from here, and test/gate-registry.test.js holds it to the gate modules,
 * the package's exports and the README's gate table.
 *
 * A gate loads on first use: each one brings its own parsers (TypeScript, YAML, jscpd),
 * and running one gate should not load the rest.
 */
import type { PresetName } from '../eslint/presets.ts';

type GateEntry = {
    /** The families whose projects run this gate. */
    families: readonly PresetName[];
    /** The gate's `check*` function, which prints its report and sets the exit code. */
    load: () => Promise<(options: never) => void | Promise<void>>;
};

const ALL: readonly PresetName[] = ['api', 'electron', 'fullstack', 'spa', 'tauri'];
/** The families with a frontend in the repository: an `index.html`, styles and locale files. */
const UI: readonly PresetName[] = ['electron', 'fullstack', 'spa', 'tauri'];
/** The families with an Express API: on its own (`api`) or as a workspace (`fullstack`). */
const BACKEND: readonly PresetName[] = ['api', 'fullstack'];

/** Keyed by the gate's export path under `gates/`. */
export const GATES = {
    'audit': { families: ALL, load: async () => (await import('./audit.ts')).checkAudit },
    'code-style': { families: ALL, load: async () => (await import('./code-style.ts')).checkCodeStyle },
    'contrast': { families: UI, load: async () => (await import('./contrast.ts')).checkContrast },
    'dead-code': { families: ALL, load: async () => (await import('./dead-code.ts')).checkDeadCode },
    'declaration-order': {
        families: ALL,
        load: async () => (await import('./declaration-order.ts')).checkDeclarationOrder,
    },
    'duplication': { families: ALL, load: async () => (await import('./duplication.ts')).checkDuplication },
    'html-standards': { families: UI, load: async () => (await import('./html-standards.ts')).checkHtmlStandards },
    'i18n': { families: UI, load: async () => (await import('./i18n.ts')).checkI18n },
    'package-json': { families: ALL, load: async () => (await import('./package-json.ts')).checkPackageJson },
    'pipeline': { families: ALL, load: async () => (await import('./pipeline.ts')).checkPipeline },
    'refactoring': { families: ALL, load: async () => (await import('./refactoring.ts')).checkRefactoring },
    'scss-standards': { families: UI, load: async () => (await import('./scss-standards.ts')).checkScssStandards },
    'testing': { families: ALL, load: async () => (await import('./testing.ts')).checkTesting },
    'tsconfigs': { families: ALL, load: async () => (await import('./tsconfigs.ts')).checkTsconfigs },
    'electron-security': {
        families: ['electron'],
        load: async () => (await import('./electron-security.ts')).checkElectronSecurity,
    },
    'error-handling/electron': {
        families: ['electron'],
        load: async () => (await import('./error-handling/electron.ts')).checkElectronErrorHandling,
    },
    'ipc-standards': {
        families: ['electron'],
        load: async () => (await import('./ipc-standards.ts')).checkIpcStandards,
    },
    'tauri-security': {
        families: ['tauri'],
        load: async () => (await import('./tauri-security.ts')).checkTauriSecurity,
    },
    'tauri-commands': {
        families: ['tauri'],
        load: async () => (await import('./tauri-commands.ts')).checkTauriCommands,
    },
    'error-handling/tauri': {
        families: ['tauri'],
        load: async () => (await import('./error-handling/tauri.ts')).checkTauriErrorHandling,
    },
    'api-standards': { families: BACKEND, load: async () => (await import('./api-standards.ts')).checkApiStandards },
    'db-drift': { families: BACKEND, load: async () => (await import('./db-drift.ts')).checkDbDrift },
    'docker': { families: BACKEND, load: async () => (await import('./docker.ts')).checkDocker },
    'env-drift': { families: BACKEND, load: async () => (await import('./env-drift.ts')).checkEnvDrift },
    'error-handling/fullstack': {
        families: BACKEND,
        load: async () => (await import('./error-handling/fullstack.ts')).checkFullstackErrorHandling,
    },
    'metrics': { families: BACKEND, load: async () => (await import('./metrics.ts')).checkMetrics },
    'security-drift': { families: BACKEND, load: async () => (await import('./security-drift.ts')).checkSecurityDrift },
    'ws-standards': { families: BACKEND, load: async () => (await import('./ws-standards.ts')).checkWsStandards },
} as const satisfies Record<string, GateEntry>;

export type GateName = keyof typeof GATES;

/** The options a gate takes, as its `check*` function declares them. */
export type GateOptions<N extends GateName> = Parameters<Awaited<ReturnType<(typeof GATES)[N]['load']>>>[0];

/** The gates a project of `family` runs, in the order they are listed above. */
export function gatesFor(family: PresetName): GateName[] {
    return (Object.keys(GATES) as GateName[]).filter((name) => {
        // Widened from the literal tuple `as const` gives each entry.
        const families: readonly PresetName[] = GATES[name].families;
        return families.includes(family);
    });
}
