/**
 * The configuration a Tauri app's security is made of, tauri.instructions.md's
 * *Configuration* and *Capabilities*:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1.  `csp` is set, and no script source is wider than `'self'` — in `devCsp` too.
 *   2.  No `dangerousDisableAssetCspModification`, no `withGlobalTauri`.
 *   3.  `freezePrototype: true`.
 *   4.  An enabled `assetProtocol` names its directories, never `**`, `$HOME` or `/`.
 *   5.  `app.security.capabilities` lists every capability file, and only those.
 *   6.  Every window has a label, and exactly one capability names it.
 *   7.  `"version": "../package.json"`.
 *   8.  A capability is one window's: its `identifier` is the label, `windows` is that
 *       label alone, and it has no `remote`.
 *   9.  Never granted: running programs, `opener:allow-open-path` unscoped, `fs:default`,
 *       an fs bundle instead of its commands, an fs scope outside the app's own
 *       directories, and a path scope of `**`, `$HOME` or `/`.
 * - `tauri.<platform>.conf.json` merges over the base, so each one is read for the
 * settings it could undo. Capabilities are read as JSON.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type TauriSecurityOptions = {
    /** Default: the repo root. */
    root?: string;
    /** The Tauri crate, holding `tauri.conf.json` and `capabilities/`. Default `src-tauri`. */
    tauriDir?: string;
};

type TauriSecurityInput = Omit<TauriSecurityOptions, 'root'> & { root: string };

type TauriSecurityInspection = {
    problems: GateFailure[];
    counts: { windows: number; capabilities: number; permissions: number };
};

/** The parts of `tauri.conf.json` this gate reads. Anything can be anything, so every field is checked before use. */
type TauriConfig = {
    version?: unknown;
    app?: {
        windows?: unknown;
        withGlobalTauri?: unknown;
        security?: {
            csp?: unknown;
            devCsp?: unknown;
            freezePrototype?: unknown;
            dangerousDisableAssetCspModification?: unknown;
            assetProtocol?: { enable?: unknown; scope?: unknown };
            capabilities?: unknown;
        };
    };
};

type CapabilityFile = { identifier?: unknown; windows?: unknown; remote?: unknown; permissions?: unknown };

type Capability = { file: string; data: CapabilityFile };

/** A permission written as an object, to scope it: `{ "identifier": "fs:scope", "allow": [{ "path": "$APPDATA/**" }] }`. */
type ScopedPermission = { identifier?: unknown; allow?: unknown };

const PLATFORM_CONFIGS = [
    'tauri.macos.conf.json',
    'tauri.windows.conf.json',
    'tauri.linux.conf.json',
    'tauri.ios.conf.json',
    'tauri.android.conf.json',
];

/** The script sources a policy may name. Anything else lets a script in from somewhere other than the bundle. */
const SAFE_SCRIPT_SOURCE =
    /^(?:'self'|'none'|'wasm-unsafe-eval'|'strict-dynamic'|'nonce-[^']+'|'sha(?:256|384|512)-[^']+')$/;

/** Permissions that run a program the webview names. */
const PROGRAM_RUNNERS = ['shell:allow-execute', 'shell:allow-spawn', 'shell:allow-stdin-write'];

/** fs permission sets that grant whole groups of commands. */
const FS_BUNDLES = ['fs:read-all', 'fs:read-dirs', 'fs:read-files', 'fs:read-meta', 'fs:write-all', 'fs:write-files'];

/** The base directories the fs plugin's preset scopes are named after (`fs:allow-home-read`). */
const FS_DIRS =
    /^fs:(?:allow|scope)-(app|appcache|appconfig|appdata|applocaldata|applog|audio|cache|config|data|desktop|document|download|exe|font|home|localdata|log|picture|public|resource|runtime|temp|template|video)(?:-|$)/;

/** The app's own directories, and its bundled resources. */
const OWN_DIR = /^(?:app|appcache|appconfig|appdata|applocaldata|applog|resource)$/;
const OWN_PATH = /^\$(?:APP|APPCACHE|APPCONFIG|APPDATA|APPLOCALDATA|APPLOG|RESOURCE)(?:\/|$)/;

const isObject = (value: unknown): value is object =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : typeof value === 'string'
          ? [value]
          : [];

/** A path scope that reaches the whole disk or the whole home directory. */
function isWideScope(scope: string): boolean {
    const base = scope
        .trim()
        .replace(/\\/g, '/')
        .replace(/(?:\/\*\*?)+$/, '')
        .replace(/\/+$/, '');
    return ['', '*', '**', '~', '$HOME'].includes(base) || /^[A-Za-z]:$/.test(base);
}

/** A CSP's directives, from either form Tauri accepts: `{ "default-src": "'self'" }` or one policy string. */
function directives(csp: unknown): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (typeof csp === 'string') {
        for (const part of csp.split(';')) {
            const [name, ...sources] = part.trim().split(/\s+/);
            if (name !== undefined && name !== '') out.set(name.toLowerCase(), sources);
        }
    } else if (isObject(csp)) {
        for (const [name, value] of Object.entries(csp as Record<string, unknown>))
            out.set(
                name.toLowerCase(),
                strings(value)
                    .flatMap((v) => v.split(/\s+/))
                    .filter(Boolean),
            );
    }
    return out;
}

/** The paths an object permission scopes itself to. */
const scopedPaths = (permission: ScopedPermission): string[] =>
    (Array.isArray(permission.allow) ? (permission.allow as unknown[]) : []).flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        const { path: scoped } = isObject(entry) ? (entry as { path?: unknown }) : {};
        return typeof scoped === 'string' ? [scoped] : [];
    });

export function inspectTauriSecurity({ root, tauriDir = 'src-tauri' }: TauriSecurityInput): TauriSecurityInspection {
    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => problems.push({ file, what, why });
    const counts = { windows: 0, capabilities: 0, permissions: 0 };

    const configRel = `${tauriDir}/tauri.conf.json`;
    const readJson = (rel: string): object | null => {
        try {
            const data: unknown = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
            if (isObject(data)) return data;
            fail(rel, 'is not a JSON object', 'This gate reads it as Tauri does, and Tauri expects an object.');
        } catch (err: unknown) {
            fail(
                rel,
                `cannot be read as JSON (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'})`,
                'This gate reads the JSON forms. A config it cannot read is one nothing checks.',
            );
        }
        return null;
    };

    if (!fs.existsSync(path.join(root, configRel))) {
        fail(
            configRel,
            'does not exist',
            'This gate reads the app’s security settings from here. Point `tauriDir` at the Tauri crate, or write the config as JSON if it is `tauri.conf.json5` or `Tauri.toml`.',
        );
        return { problems, counts };
    }
    const config = readJson(configRel) as TauriConfig | null;
    if (config === null) return { problems, counts };
    const app = config.app ?? {};
    const security = app.security ?? {};

    // ── 1. A policy, and no script source beyond the bundle ──────────────────
    if (security.csp === undefined || security.csp === null) {
        fail(
            configRel,
            `\`app.security.csp\` is ${security.csp === null ? '`null`' : 'not set'}`,
            'With no policy the webview has none at all: an injected script runs and can reach every command the capability grants. Tauri adds its nonces and hashes only to a policy you write.',
        );
    }
    const checkScripts = (rel: string, key: 'csp' | 'devCsp', csp: unknown) => {
        if (csp === undefined || csp === null) return;
        const policy = directives(csp);
        const directive = policy.has('script-src') ? 'script-src' : 'default-src';
        const sources = policy.get(directive);
        if (sources === undefined) {
            fail(
                rel,
                `\`${key}\` has neither \`script-src\` nor \`default-src\``,
                'Without one, scripts may load from anywhere. Start from `"default-src": "\'self\'"`.',
            );
            return;
        }
        for (const extra of ['script-src-elem', 'script-src-attr']) {
            for (const source of policy.get(extra) ?? [])
                if (!SAFE_SCRIPT_SOURCE.test(source))
                    fail(
                        rel,
                        `\`${key}\` allows \`${source}\` in \`${extra}\``,
                        'The same rule as `script-src`: scripts come from the bundle and nowhere else.',
                    );
        }
        for (const source of sources) {
            if (SAFE_SCRIPT_SOURCE.test(source)) continue;
            fail(
                rel,
                `\`${key}\` allows \`${source}\` in \`${directive}\``,
                source === "'unsafe-eval'" || source === "'unsafe-inline'"
                    ? 'It is the half of XSS a CSP exists to stop: an injected string becomes running code, and running code can call every granted command.'
                    : "A script from anywhere but the bundle runs with the bridge in reach. Bundle it instead; `'wasm-unsafe-eval'` is the one addition, for an app that ships WebAssembly.",
            );
        }
    };

    // ── 2/3/4. Flags a platform file could undo ──────────────────────────────
    const checkFlags = (rel: string, data: TauriConfig) => {
        const a = data.app ?? {};
        const sec = a.security ?? {};
        if (rel !== configRel && sec.csp === null)
            fail(
                rel,
                'sets `app.security.csp` to `null`',
                'A platform file merges over the base config, so this removes the policy on that platform alone — where nobody is looking.',
            );
        checkScripts(rel, 'csp', sec.csp);
        checkScripts(rel, 'devCsp', sec.devCsp);
        if (
            sec.dangerousDisableAssetCspModification !== undefined &&
            sec.dangerousDisableAssetCspModification !== false
        ) {
            fail(
                rel,
                'sets `dangerousDisableAssetCspModification`',
                'It strips the nonces and hashes Tauri adds to the policy. The CSP is still written in the config, and it no longer protects anything.',
            );
        }
        if (a.withGlobalTauri === true) {
            fail(
                rel,
                'sets `app.withGlobalTauri: true`',
                'It puts the whole API on `window.__TAURI__`, so any script that runs — an injected one included — can call it without going through the bridge.',
            );
        }
        if (sec.freezePrototype === false || (rel === configRel && sec.freezePrototype !== true)) {
            fail(
                rel,
                `\`app.security.freezePrototype\` is ${sec.freezePrototype === undefined ? 'not set' : String(sec.freezePrototype)}`,
                'Frozen, `Object.prototype` cannot be rewritten by a dependency or an injected script before your code runs. A library that needs it unfrozen is the one to replace.',
            );
        }
        const asset = sec.assetProtocol;
        if (asset?.enable === true) {
            const scope = isObject(asset.scope)
                ? strings((asset.scope as { allow?: unknown }).allow)
                : strings(asset.scope);
            if (scope.length === 0)
                fail(
                    rel,
                    '`assetProtocol` is enabled with no `scope`',
                    'The asset protocol serves files by URL to any script in the webview. Name the directories it may serve, such as `$APPDATA/thumbnails/**`.',
                );
            for (const entry of scope.filter(isWideScope))
                fail(
                    rel,
                    `\`assetProtocol.scope\` includes \`${entry}\``,
                    'That serves the whole disk, or the whole home directory, to any script in the webview. Name the directories the app displays files from.',
                );
        }
    };
    checkFlags(configRel, config);
    for (const name of PLATFORM_CONFIGS) {
        const rel = `${tauriDir}/${name}`;
        if (!fs.existsSync(path.join(root, rel))) continue;
        const data = readJson(rel);
        if (data !== null) checkFlags(rel, data as TauriConfig);
    }

    // ── 7. One version ───────────────────────────────────────────────────────
    if (typeof config.version !== 'string' || !config.version.endsWith('package.json')) {
        fail(
            configRel,
            `\`version\` is ${config.version === undefined ? 'not set' : `\`${String(config.version)}\``}, not \`"../package.json"\``,
            'Read from the package, the bundle, the About box and the log cannot disagree with the release tag. Written here, or left to Cargo.toml, it is a second version to keep in step.',
        );
    }

    // ── 5. The capability list ───────────────────────────────────────────────
    const capabilitiesDir = `${tauriDir}/capabilities`;
    const capabilities: Capability[] = [];
    const onDisk = fs.existsSync(path.join(root, capabilitiesDir))
        ? fs.readdirSync(path.join(root, capabilitiesDir)).sort()
        : [];
    for (const name of onDisk) {
        const rel = `${capabilitiesDir}/${name}`;
        if (!name.endsWith('.json')) {
            if (/\.(?:json5|toml)$/.test(name))
                fail(
                    rel,
                    'is not JSON',
                    'This gate reads capabilities as JSON. One it cannot read is one whose grants nobody checks — write it as `.json`.',
                );
            continue;
        }
        const data = readJson(rel);
        if (data !== null) capabilities.push({ file: rel, data: data as CapabilityFile });
    }

    const listed = Array.isArray(security.capabilities) ? security.capabilities : null;
    if (listed === null || listed.length === 0) {
        fail(
            configRel,
            '`app.security.capabilities` does not list the capabilities',
            'Without the list, every file in `capabilities/` is enabled, so a file dropped into the folder grants its permissions with nobody having named it.',
        );
    } else {
        for (const entry of listed) {
            if (isObject(entry)) {
                capabilities.push({ file: `${configRel} (inline capability)`, data: entry as CapabilityFile });
                continue;
            }
            if (typeof entry === 'string' && !capabilities.some((c) => c.data.identifier === entry)) {
                fail(
                    configRel,
                    `\`app.security.capabilities\` lists \`${entry}\`, which no capability file declares`,
                    'Drop it, or add the file. A name that resolves to nothing reads as a grant to whoever reviews the list.',
                );
            }
        }
        for (const { file, data } of capabilities) {
            if (file.endsWith('(inline capability)') || listed.includes(data.identifier)) continue;
            fail(
                file,
                `\`${String(data.identifier)}\` is not listed in \`app.security.capabilities\``,
                'It grants nothing until it is named there. Delete it, or list it: a capability that looks active and is not misleads every review of the folder.',
            );
        }
    }
    counts.capabilities = capabilities.length;

    // ── 6. Windows and the capabilities that name them ───────────────────────
    const windows = Array.isArray(app.windows) ? (app.windows as unknown[]).filter(isObject) : [];
    counts.windows = windows.length;
    for (const [index, window] of windows.entries()) {
        const { label } = window as { label?: unknown };
        if (typeof label !== 'string') {
            fail(
                configRel,
                `\`app.windows[${index}]\` has no \`label\``,
                'Capabilities bind to labels, never to titles. Name the window, and name its capability after it.',
            );
            continue;
        }
        const naming = capabilities.filter((c) => strings(c.data.windows).includes(label));
        if (naming.length === 0) {
            fail(
                configRel,
                `no capability names the \`${label}\` window`,
                'It can call no command and no plugin. Give it a capability named after its label, granting what it uses.',
            );
        } else if (naming.length > 1) {
            fail(
                configRel,
                `the \`${label}\` window is named by ${naming.length} capabilities (${naming.map((c) => String(c.data.identifier)).join(', ')})`,
                'A window gets the union of every capability naming it, and nobody reviews the union. One capability per window.',
            );
        }
    }

    // ── 8/9. Each capability ─────────────────────────────────────────────────
    for (const { file, data } of capabilities) {
        const named = strings(data.windows);
        if (named.length !== 1 || /[*?[]/.test(named[0] ?? '')) {
            fail(
                file,
                `\`windows\` is ${JSON.stringify(data.windows ?? null)}, not one window’s label`,
                'A capability is one window’s list of what it may ask for. A pattern or a second label grants the same list to windows nobody had in mind.',
            );
        } else if (data.identifier !== named[0]) {
            fail(
                file,
                `\`identifier\` is \`${String(data.identifier)}\`, not the window’s label \`${named[0] ?? ''}\``,
                'Named after the label, the capability that governs a window is found from the window, and a second one for it stands out.',
            );
        }
        if (data.remote !== undefined) {
            fail(
                file,
                'declares `remote`',
                'It lets a website’s scripts call your commands. On Linux and Android, Tauri cannot tell an embedded `<iframe>` from the window itself.',
            );
        }

        const permissions = Array.isArray(data.permissions) ? (data.permissions as unknown[]) : [];
        counts.permissions += permissions.length;
        for (const permission of permissions) {
            const object = isObject(permission) ? (permission as ScopedPermission) : null;
            const id =
                typeof permission === 'string'
                    ? permission
                    : typeof object?.identifier === 'string'
                      ? object.identifier
                      : '';
            const scoped = object === null ? [] : scopedPaths(object);
            if (PROGRAM_RUNNERS.includes(id)) {
                fail(
                    file,
                    `grants \`${id}\``,
                    'It runs programs the webview names. An XSS becomes code execution on the user’s machine.',
                );
            } else if (id === 'opener:allow-open-path' && scoped.length === 0) {
                fail(
                    file,
                    'grants `opener:allow-open-path` with no scope',
                    'Unscoped, the webview can open any path with its default program, which runs executables and scripts. Give it an `allow` list.',
                );
            } else if (id === 'fs:default') {
                fail(
                    file,
                    'grants `fs:default`',
                    'fs is granted command by command: `fs:allow-read-text-file`, `fs:allow-write-text-file`. The files a user picks reach the scope through the dialog plugin, and need nothing more.',
                );
            } else if (FS_BUNDLES.includes(id)) {
                fail(
                    file,
                    `grants the bundle \`${id}\``,
                    'It grants every command in the group, used or not. Grant the commands the app calls, one by one.',
                );
            } else {
                const dir = FS_DIRS.exec(id)?.[1];
                if (dir !== undefined && !OWN_DIR.test(dir)) {
                    fail(
                        file,
                        `grants \`${id}\``,
                        `That scope is the user’s \`$${dir.toUpperCase()}\`, not the app’s own directories. A file the user picks needs no static scope: the dialog adds it.`,
                    );
                }
            }
            for (const entry of scoped) {
                if (id.startsWith('fs:') ? !OWN_PATH.test(entry) || entry.includes('..') : isWideScope(entry)) {
                    fail(
                        file,
                        `scopes \`${id}\` to \`${entry}\``,
                        id.startsWith('fs:')
                            ? 'A static fs scope is for the app’s own directories (`$APPDATA/**`). The files a user picks are added by the dialog plugin, for the session.'
                            : 'That reaches the whole disk or the whole home directory. Name the directories the app needs.',
                    );
                }
            }
        }
    }

    return { problems, counts };
}

export function checkTauriSecurity({ root = REPO_ROOT, ...rest }: TauriSecurityOptions = {}): void {
    const report = createGateReport({ name: 'Tauri security' });
    const { problems, counts } = inspectTauriSecurity({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Tauri security OK — a CSP with scripts from the bundle alone, the prototype frozen, no global API; ` +
            `${plural(counts.windows, 'window')} each named by one capability, ${plural(counts.capabilities, 'capability', 'capabilities')} listed and one window’s each, ` +
            `${plural(counts.permissions, 'permission')} with nothing that runs programs and no scope beyond the app’s own directories.`,
        notMachineChecked:
            'whether a granted permission is the one the app needs (a JS function can call a command other than its name), what `connect-src` and `img-src` allow, a window Rust creates at runtime, and what only the real webview applies — run `tauri build --debug --no-bundle` after changing the CSP or a capability.',
    });
}
