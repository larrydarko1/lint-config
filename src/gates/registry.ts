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
type Check<TOptions> = (options: TOptions) => void | Promise<void>;

type GateEntry<TFamilies extends readonly PresetName[], TOptions> = {
    /** The families whose projects run this gate. */
    families: TFamilies;
    /** Loads the gate's `check*` function. */
    load: () => Promise<Check<TOptions>>;
};

export type GateName = keyof typeof GATES;

/** What `name`'s `check*` function takes, as larry.config.ts gives it. */
export type GateOptions<TName extends GateName> = NonNullable<
    Parameters<Awaited<ReturnType<(typeof GATES)[TName]['load']>>>[0]
>;

/** The gates a project of `Family` runs. */
export type FamilyGate<TFamily extends PresetName> = {
    [TName in GateName]: TFamily extends (typeof GATES)[TName]['families'][number] ? TName : never;
}[GateName];

const ALL = ['api', 'electron', 'fullstack', 'library', 'spa', 'tauri'] as const;
/** The families whose suites run on Vitest. A library's run on `node --test`, which ESLint checks instead. */
const VITEST = ['api', 'electron', 'fullstack', 'spa', 'tauri'] as const;
/** The families with a frontend in the repository: an `index.html`, styles and locale files. */
const UI = ['electron', 'fullstack', 'spa', 'tauri'] as const;
/** The families with an Express API: on its own (`api`) or as a workspace (`fullstack`). */
const BACKEND = ['api', 'fullstack'] as const;

/** Keyed by the gate's export path under `gates/`. */
export const GATES = {
    'audit': gate(ALL, async () => (await import('./audit.ts')).checkAudit),
    'code-style': gate(ALL, async () => (await import('./code-style.ts')).checkCodeStyle),
    'contrast': gate(UI, async () => (await import('./contrast.ts')).checkContrast),
    'dead-code': gate(ALL, async () => (await import('./dead-code.ts')).checkDeadCode),
    'declaration-order': gate(ALL, async () => (await import('./declaration-order.ts')).checkDeclarationOrder),
    'duplication': gate(ALL, async () => (await import('./duplication.ts')).checkDuplication),
    'html-standards': gate(UI, async () => (await import('./html-standards.ts')).checkHtmlStandards),
    'i18n': gate(UI, async () => (await import('./i18n.ts')).checkI18n),
    'licenses': gate(ALL, async () => (await import('./licenses.ts')).checkLicenses),
    'package-json': gate(ALL, async () => (await import('./package-json.ts')).checkPackageJson),
    'pipeline': gate(ALL, async () => (await import('./pipeline.ts')).checkPipeline),
    'refactoring': gate(ALL, async () => (await import('./refactoring.ts')).checkRefactoring),
    'scss-standards': gate(UI, async () => (await import('./scss-standards.ts')).checkScssStandards),
    'secrets': gate(ALL, async () => (await import('./secrets.ts')).checkSecrets),
    'testing': gate(VITEST, async () => (await import('./testing.ts')).checkTesting),
    'tsconfigs': gate(ALL, async () => (await import('./tsconfigs.ts')).checkTsconfigs),
    'electron-security': gate(['electron'], async () => (await import('./electron-security.ts')).checkElectronSecurity),
    'error-handling/electron': gate(
        ['electron'],
        async () => (await import('./error-handling/electron.ts')).checkElectronErrorHandling,
    ),
    'ipc-standards': gate(['electron'], async () => (await import('./ipc-standards.ts')).checkIpcStandards),
    'tauri-security': gate(['tauri'], async () => (await import('./tauri-security.ts')).checkTauriSecurity),
    'tauri-commands': gate(['tauri'], async () => (await import('./tauri-commands.ts')).checkTauriCommands),
    'error-handling/tauri': gate(
        ['tauri'],
        async () => (await import('./error-handling/tauri.ts')).checkTauriErrorHandling,
    ),
    'publish': gate(['library'], async () => (await import('./publish.ts')).checkPublish),
    'api-standards': gate(BACKEND, async () => (await import('./api-standards.ts')).checkApiStandards),
    'db-drift': gate(BACKEND, async () => (await import('./db-drift.ts')).checkDbDrift),
    'docker': gate(BACKEND, async () => (await import('./docker.ts')).checkDocker),
    'env-drift': gate(BACKEND, async () => (await import('./env-drift.ts')).checkEnvDrift),
    'error-handling/fullstack': gate(
        BACKEND,
        async () => (await import('./error-handling/fullstack.ts')).checkFullstackErrorHandling,
    ),
    'metrics': gate(BACKEND, async () => (await import('./metrics.ts')).checkMetrics),
    'security-drift': gate(BACKEND, async () => (await import('./security-drift.ts')).checkSecurityDrift),
    'ws-standards': gate(BACKEND, async () => (await import('./ws-standards.ts')).checkWsStandards),
};

/** The gates a project of `family` runs, in the order they are listed above. */
export function gatesFor<TFamily extends PresetName>(family: TFamily): FamilyGate<TFamily>[] {
    return (Object.keys(GATES) as GateName[]).filter((name): name is FamilyGate<TFamily> => {
        // Widened from the literal tuple each entry keeps.
        const families: readonly PresetName[] = GATES[name].families;
        return families.includes(family);
    });
}

/** One entry. A helper rather than a literal so each keeps its own families and options in its type. */
function gate<const TFamilies extends readonly PresetName[], TOptions>(
    families: TFamilies,
    load: () => Promise<Check<TOptions>>,
): GateEntry<TFamilies, TOptions> {
    return { families, load };
}
