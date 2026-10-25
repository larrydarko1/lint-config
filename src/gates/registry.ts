/**
 * Every gate, the families it applies to, and where its `check*` function lives. A runner
 * reads the list from here, and test/gate-registry.test.js holds it to the gate modules,
 * the package's exports and the README's gate table.
 *
 * A gate loads on first use: each one brings its own parsers (TypeScript, YAML, jscpd),
 * and running one gate should not load the rest.
 */
import type { PresetName } from '../eslint/presets.ts';

/** A gate's `check*` function, which prints its report and sets the exit code. */
type Check = (options: never) => void | Promise<void>;

type GateEntry = {
    /** The families whose projects run this gate. */
    families: readonly PresetName[];
    /** Loads the gate's `check*` function. */
    load: () => Promise<Check>;
};

type GateName = keyof typeof GATES;

const ALL: readonly PresetName[] = ['api', 'electron', 'fullstack', 'library', 'spa', 'tauri'];
/** The families whose suites run on Vitest. A library's run on `node --test`, which ESLint checks instead. */
const VITEST: readonly PresetName[] = ['api', 'electron', 'fullstack', 'spa', 'tauri'];
/** The families with a frontend in the repository: an `index.html`, styles and locale files. */
const UI: readonly PresetName[] = ['electron', 'fullstack', 'spa', 'tauri'];
/** The families with an Express API: on its own (`api`) or as a workspace (`fullstack`). */
const BACKEND: readonly PresetName[] = ['api', 'fullstack'];

/** Keyed by the gate's export path under `gates/`. */
export const GATES = {
    'audit': { families: ALL, load: async (): Promise<Check> => (await import('./audit.ts')).checkAudit },
    'code-style': { families: ALL, load: async (): Promise<Check> => (await import('./code-style.ts')).checkCodeStyle },
    'contrast': { families: UI, load: async (): Promise<Check> => (await import('./contrast.ts')).checkContrast },
    'dead-code': { families: ALL, load: async (): Promise<Check> => (await import('./dead-code.ts')).checkDeadCode },
    'declaration-order': {
        families: ALL,
        load: async (): Promise<Check> => (await import('./declaration-order.ts')).checkDeclarationOrder,
    },
    'duplication': {
        families: ALL,
        load: async (): Promise<Check> => (await import('./duplication.ts')).checkDuplication,
    },
    'html-standards': {
        families: UI,
        load: async (): Promise<Check> => (await import('./html-standards.ts')).checkHtmlStandards,
    },
    'i18n': { families: UI, load: async (): Promise<Check> => (await import('./i18n.ts')).checkI18n },
    'licenses': { families: ALL, load: async (): Promise<Check> => (await import('./licenses.ts')).checkLicenses },
    'package-json': {
        families: ALL,
        load: async (): Promise<Check> => (await import('./package-json.ts')).checkPackageJson,
    },
    'pipeline': { families: ALL, load: async (): Promise<Check> => (await import('./pipeline.ts')).checkPipeline },
    'refactoring': {
        families: ALL,
        load: async (): Promise<Check> => (await import('./refactoring.ts')).checkRefactoring,
    },
    'scss-standards': {
        families: UI,
        load: async (): Promise<Check> => (await import('./scss-standards.ts')).checkScssStandards,
    },
    'secrets': { families: ALL, load: async (): Promise<Check> => (await import('./secrets.ts')).checkSecrets },
    'testing': { families: VITEST, load: async (): Promise<Check> => (await import('./testing.ts')).checkTesting },
    'tsconfigs': { families: ALL, load: async (): Promise<Check> => (await import('./tsconfigs.ts')).checkTsconfigs },
    'electron-security': {
        families: ['electron'],
        load: async (): Promise<Check> => (await import('./electron-security.ts')).checkElectronSecurity,
    },
    'error-handling/electron': {
        families: ['electron'],
        load: async (): Promise<Check> => (await import('./error-handling/electron.ts')).checkElectronErrorHandling,
    },
    'ipc-standards': {
        families: ['electron'],
        load: async (): Promise<Check> => (await import('./ipc-standards.ts')).checkIpcStandards,
    },
    'tauri-security': {
        families: ['tauri'],
        load: async (): Promise<Check> => (await import('./tauri-security.ts')).checkTauriSecurity,
    },
    'tauri-commands': {
        families: ['tauri'],
        load: async (): Promise<Check> => (await import('./tauri-commands.ts')).checkTauriCommands,
    },
    'error-handling/tauri': {
        families: ['tauri'],
        load: async (): Promise<Check> => (await import('./error-handling/tauri.ts')).checkTauriErrorHandling,
    },
    'publish': { families: ['library'], load: async (): Promise<Check> => (await import('./publish.ts')).checkPublish },
    'api-standards': {
        families: BACKEND,
        load: async (): Promise<Check> => (await import('./api-standards.ts')).checkApiStandards,
    },
    'db-drift': { families: BACKEND, load: async (): Promise<Check> => (await import('./db-drift.ts')).checkDbDrift },
    'docker': { families: BACKEND, load: async (): Promise<Check> => (await import('./docker.ts')).checkDocker },
    'env-drift': {
        families: BACKEND,
        load: async (): Promise<Check> => (await import('./env-drift.ts')).checkEnvDrift,
    },
    'error-handling/fullstack': {
        families: BACKEND,
        load: async (): Promise<Check> => (await import('./error-handling/fullstack.ts')).checkFullstackErrorHandling,
    },
    'metrics': { families: BACKEND, load: async (): Promise<Check> => (await import('./metrics.ts')).checkMetrics },
    'security-drift': {
        families: BACKEND,
        load: async (): Promise<Check> => (await import('./security-drift.ts')).checkSecurityDrift,
    },
    'ws-standards': {
        families: BACKEND,
        load: async (): Promise<Check> => (await import('./ws-standards.ts')).checkWsStandards,
    },
} as const satisfies Record<string, GateEntry>;

/** The gates a project of `family` runs, in the order they are listed above. */
export function gatesFor(family: PresetName): GateName[] {
    return (Object.keys(GATES) as GateName[]).filter((name) => {
        // Widened from the literal tuple `as const` gives each entry.
        const families: readonly PresetName[] = GATES[name].families;
        return families.includes(family);
    });
}
