/**
 * The options each gate takes, by name, so `larry check` can refuse one it does not: an option
 * a release removed, or a misspelt one, would otherwise be passed to the gate and never read.
 * The options types are gone by the time larry.config.ts runs, so the names are listed here,
 * and the compiler holds the list to those types both ways.
 */
import type { GateName, GateOptions } from '../gates/registry.ts';
import { RENAMED_OPTIONS, type RenamedOption } from './renames.ts';

/** What larry.config.ts may set: `root` is where the config sits, and `versioning` comes from its top level. */
type OptionName<TName extends GateName> = Exclude<keyof GateOptions<TName>, 'root' | 'versioning'>;

type OptionLists = { readonly [TName in GateName]: readonly OptionName<TName>[] };

/** Each gate's options the list leaves out, as a property the compiler then asks for by name. */
type Unlisted<TLists extends OptionLists> = {
    [TName in GateName]: [Exclude<OptionName<TName>, TLists[TName][number]>] extends [never]
        ? unknown
        : { unlisted: Exclude<OptionName<TName>, TLists[TName][number]> };
};

/** Every gate's options. A name the gate does not take is a type error, and so is one left out. */
const OPTION_NAMES = everyOption({
    'audit': ['allowlist', 'failSeverities', 'omit', 'today'],
    'changelog': [],
    'code-style': [
        'aliasedRoots',
        'baseline',
        'casing',
        'globalStyles',
        'headers',
        'lineCap',
        'scan',
        'styleExplanations',
    ],
    'contrast': ['backgrounds', 'minRatio', 'scan', 'text', 'textAliases', 'themes'],
    'dead-code': ['budgets', 'checksDir', 'notMachineChecked', 'publicApi'],
    'declaration-order': ['exclude', 'importOrder', 'sourceRoots'],
    'duplication': ['ceilings', 'config', 'crossCloneAllowed', 'ignoreDirs', 'maxCloneTokens', 'perRoot', 'scan'],
    'html-standards': ['baseScss', 'csp', 'indexHtml', 'placeholderOrigin', 'require'],
    'i18n': ['configFile', 'configNotes', 'customLocales', 'localeDir', 'reference'],
    'licenses': ['allowLicenses', 'allowlist', 'distribution', 'includeDev', 'today'],
    'package-json': [
        'canonicalOrder',
        'electronViteConfig',
        'exactFields',
        'provided',
        'rootRequired',
        'tildeAllowed',
        'workspaceRequired',
    ],
    'pipeline': ['checksDir', 'ciWorkflow'],
    'refactoring': ['claudeCode', 'ignore', 'linted', 'skip'],
    'scss-standards': [
        'componentLocalVars',
        'emitters',
        'fontDir',
        'fontFaceFile',
        'html',
        'injectedSpecifier',
        'injectionGuard',
        'mainScript',
        'packageJson',
        'src',
        'styles',
        'themes',
        'viteConfigs',
    ],
    'secrets': ['allowlist'],
    'testing': [
        'apiClient',
        'config',
        'coverageSummary',
        'domEnvironment',
        'e2e',
        'excludes',
        'layout',
        'otherRunners',
        'serverErrors',
        'thresholds',
        'vmBaseline',
    ],
    'tsconfigs': [
        'base',
        'baseFlags',
        'browserProjects',
        'browserSources',
        'environmental',
        'ignore',
        'nodeTyped',
        'nonEmitting',
        'sections',
    ],
    'electron-security': ['mainDir', 'preloadDir', 'rendererDir', 'sanitizers', 'vHtml'],
    'error-handling/electron': ['cleanupRequired', 'mainDir', 'mainIndex', 'rendererDir'],
    'ipc-standards': ['contract', 'contractType', 'mainIndex', 'preload', 'receiverTypes', 'renderer', 'servicesDir'],
    'tauri-security': ['tauriDir'],
    'tauri-commands': ['bridgeDir', 'commandsDir', 'errorCodes', 'errorFile', 'tauriDir'],
    'error-handling/tauri': ['bridgeDir', 'tauriDir', 'webviewDir'],
    'extension-manifest': ['entry', 'src'],
    'publish': [],
    'api-standards': [
        'apiClient',
        'clientFactory',
        'contract',
        'indexFile',
        'jobs',
        'mountPrefix',
        'optionalAuth',
        'packageJson',
        'rateLimiters',
        'requestId',
        'responses',
        'routesDir',
        'schemas',
        'tiers',
        'tokenBucket',
    ],
    'db-drift': [
        'appDirs',
        'architecture',
        'backups',
        'bootstrap',
        'checksums',
        'collectionTypes',
        'collectionsExport',
        'drainOrder',
        'examplesDir',
        'indexAppliers',
        'indexExports',
        'manifest',
        'manifestSpecifier',
        'migrationsDir',
        'noIndexByDesign',
        'ops',
        'packageManifests',
        'services',
        'testsDir',
        'ttlFields',
        'typesFile',
    ],
    'docker': [
        'buildContext',
        'buildWorkflow',
        'deployments',
        'dockerDir',
        'dockerignore',
        'glibc',
        'kustomization',
        'nonrootBases',
        'packageJson',
    ],
    'env-drift': ['businessDirs', 'canonicalGroups', 'exampleFiles', 'gitignore', 'ignored', 'services', 'sharedEnv'],
    'error-handling/fullstack': [
        'allowedStatus',
        'apiDir',
        'appError',
        'appErrorBanDirs',
        'client',
        'codes',
        'directCodeEmitters',
        'entry',
        'frontend',
        'frontendDir',
        'handler',
        'handlerBranches',
        'localeDir',
        'notSecurityEvents',
        'parseLevel400',
        'securityEventCodes',
        'serviceDirs',
    ],
    'metrics': [
        'gaugeRefresh',
        'headlessServices',
        'healthzHandlers',
        'kubeLinter',
        'listenBeforeInit',
        'livezHandlers',
        'manifests',
        'metricModules',
        'monitoringNamespace',
        'ownWorkloads',
        'queueConsumers',
        'routeLabel',
        'unboundedLabels',
        'workflow',
    ],
    'security-drift': [
        'auth',
        'backendDirs',
        'config',
        'credentials',
        'derivations',
        'entry',
        'envModule',
        'fileRoutes',
        'frontendDirs',
        'nginx',
        'regexDirs',
        'traefik',
        'unauthenticatedMounts',
    ],
    'ws-standards': [
        'authModule',
        'client',
        'clientDirs',
        'connectionKey',
        'emitHelpers',
        'events',
        'frontend',
        'gateway',
        'gatewayDir',
        'messageKeyPrefix',
        'redisAdapter',
        'rooms',
        'serverDirs',
        'sessionTeardown',
        'teardownFn',
        'tokenAccessor',
    ],
});

/**
 * @param gate The gate the options are for.
 * @param options Its options, as larry.config.ts gives them.
 * @param renames Old names, which renamedOptionProblems reports with their new one.
 * @returns A problem for each option the gate does not take.
 */
export function unknownOptionProblems(
    gate: GateName,
    options: Record<string, unknown>,
    renames: readonly RenamedOption[] = RENAMED_OPTIONS,
): string[] {
    const known: readonly string[] = OPTION_NAMES[gate];
    const renamed = new Set(renames.filter((rename) => rename.gate === gate).map((rename) => rename.from));
    const takes =
        known.length === 0
            ? `"${gate}" takes no options`
            : `"${gate}" takes ${known.map((name) => `\`${name}\``).join(', ')}`;
    return Object.keys(options)
        .filter((name) => !known.includes(name) && !renamed.has(name))
        .map((name) => {
            if (name === 'root') return `"${gate}".root can't be set: a gate runs on the folder larry.config.ts is in.`;
            if (name === 'versioning') {
                return `"${gate}".versioning can't be set: the family numbers its releases, or a base config's top-level \`versioning\`.`;
            }
            return `"${gate}" has no option \`${name}\`: it was removed, or is misspelt. ${takes}.`;
        });
}

/** Returns the lists as given. A function so the compiler can name the options a list leaves out. */
function everyOption<const TLists extends OptionLists>(lists: TLists & Unlisted<TLists>): TLists {
    return lists;
}
