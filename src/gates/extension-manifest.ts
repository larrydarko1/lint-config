/**
 * An editor extension's package.json is its manifest, and the editor trusts it: a command
 * it lists with no code behind it fails only when someone clicks it, a setting it declares
 * that nothing reads changes nothing. This gate holds the manifest to the source.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Identity: `publisher`, `engines.vscode`, and an `@types/vscode` no newer than it.
 *   2. `main` is the bundle, and the entry it is built from exports `activate` and
 *      `deactivate` alone.
 *   3. Every command, view and setting carries the extension's namespace.
 *   4. Contributed commands and registered ones agree, both ways; so do views. Every menu,
 *      keybinding and welcome link names a contributed command.
 *   5. Every declared setting is read, every read setting is declared, and a default given
 *      in code is the manifest's.
 *   6. No `*` activation, and no activation event the editor already derives.
 *   7. Workspace trust and virtual workspaces are declared, with a reason when limited.
 *   8. The package is an allowlist that ships `main` and no source.
 *   9. Webviews and translated strings are refused until a gate checks them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { exportedNames, readExtensionSource, type SourceSite } from './lib/extension-source.ts';
import { walkFiles } from './lib/files.ts';
import { isRecord, listAt, readJson, recordAt, stringAt, toRecord } from './lib/json.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, plural, type GateFailure } from './lib/report.ts';

export type ExtensionManifestOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The source the editor runs. Defaults to `src`. */
    src?: string;
    /** What `main` is built from. Defaults to `src/extension.ts`. */
    entry?: string;
};

type ExtensionManifestInspection = {
    problems: GateFailure[];
    counts: { commands: number; views: number; settings: number };
};

const MANIFEST = 'package.json';

/** The containers the editor has itself, which a view may sit in without contributing one. */
const BUILT_IN_CONTAINERS = new Set(['explorer', 'scm', 'debug', 'test', 'remote']);

/** What the entry may export: what the editor calls. */
const HOST_EXPORTS = new Set(['activate', 'deactivate']);

/** A file from each folder that must never ship, to test the package's patterns against. */
const NEVER_SHIPPED = [
    'src/extension.ts',
    'tests/x.test.ts',
    'e2e/x.spec.ts',
    'scripts/build.ts',
    'node_modules/x/index.js',
];

const UNCHECKED_WHY =
    'No gate checks it yet, and an unchecked webview is a page that can run script with the extension’s reach. The gate is built against the first real one: raise it before adding this.';

/** Every problem in one extension's manifest, without printing anything. */
export function inspectExtensionManifest(
    input: Omit<ExtensionManifestOptions, 'root'> & { root: string },
): ExtensionManifestInspection {
    const { root, src = 'src', entry = `${src}/extension.ts` } = input;
    const { problems, fail } = collectFailures();
    const manifest = toRecord(readJson(path.join(root, MANIFEST)));
    const contributes = recordAt(manifest, 'contributes');
    const files = walkFiles(root, src, { match: /\.ts$/, exclude: /\.d\.ts$/ });
    const source = readExtensionSource(
        files.map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') })),
    );

    // ── 1. Identity ─────────────────────────────────────────────────────────
    const engine = stringAt(recordAt(manifest, 'engines'), 'vscode');
    if (stringAt(manifest, 'publisher') === undefined) {
        fail(
            MANIFEST,
            'has no `publisher`',
            'vsce refuses to package without one, and the editor names the extension `<publisher>.<name>`.',
        );
    }
    if (engine === undefined) {
        fail(
            MANIFEST,
            'has no `engines.vscode`',
            'It is the oldest editor the extension runs on; the editor refuses to load one without it.',
        );
    } else {
        const types = stringAt(recordAt(manifest, 'devDependencies'), '@types/vscode');
        if (types !== undefined && compareFloors(types, engine) > 0) {
            fail(
                MANIFEST,
                `\`@types/vscode\` ${types} is newer than \`engines.vscode\` ${engine}`,
                'The types would let the code call an API the oldest editor it claims to support does not have, and vsce refuses to package it. Move both together.',
            );
        }
    }

    // ── 2. main and the entry ───────────────────────────────────────────────
    const main = stringAt(manifest, 'main');
    if (main === undefined || main.endsWith('.ts')) {
        fail(
            MANIFEST,
            '`main` does not name the bundle',
            'The editor loads `main` as JavaScript: point it at the file the build writes, such as `./out/extension.cjs`.',
        );
    }
    if (!fs.existsSync(path.join(root, entry))) {
        fail(entry, 'missing', 'It is what `main` is built from, the module the editor calls `activate` on.');
    } else {
        const exported = exportedNames(entry, fs.readFileSync(path.join(root, entry), 'utf8'));
        if (!exported.includes('activate')) {
            fail(
                entry,
                'does not export `activate`',
                'The editor calls `activate` when an activation event fires; without it the extension never starts.',
            );
        }
        for (const name of exported.filter((exportName) => !HOST_EXPORTS.has(exportName))) {
            fail(
                entry,
                `exports \`${name}\``,
                'The entry is what the editor calls: `activate` and `deactivate`. Anything else exported here is called by nothing; move it to the module it belongs in.',
            );
        }
    }

    // ── 3–5. Namespace, commands, views, settings ───────────────────────────
    const namespace = camelCase(stringAt(manifest, 'name') ?? '');
    const contributed = {
        commands: listAt(contributes, 'commands').flatMap((command) => stringAt(command, 'command') ?? []),
        views: Object.values(recordAt(contributes, 'views')).flatMap((list) =>
            (Array.isArray(list) ? list : []).flatMap((view) => stringAt(view, 'id') ?? []),
        ),
        containers: Object.values(recordAt(contributes, 'viewsContainers')).flatMap((list) =>
            (Array.isArray(list) ? list : []).flatMap((container) => stringAt(container, 'id') ?? []),
        ),
        settings: new Map(configurationEntries(contributes)),
    };
    const owned = [...contributed.commands, ...contributed.views, ...contributed.settings.keys()];
    for (const id of owned.filter((name) => !name.startsWith(`${namespace}.`))) {
        fail(
            MANIFEST,
            `\`${id}\` is outside the \`${namespace}.\` namespace`,
            'Commands, views and settings share one namespace with every other extension. The extension’s own prefix, its name in camelCase, keeps them apart and says whose they are.',
        );
    }
    for (const id of contributed.containers.filter((name) => name !== namespace && !name.startsWith(`${namespace}.`))) {
        fail(
            MANIFEST,
            `view container \`${id}\` is outside the \`${namespace}\` namespace`,
            'A container id is shared with every other extension too.',
        );
    }

    drift(fail, 'command', contributed.commands, source.commands, 'registerCommand');
    drift(fail, 'view', contributed.views, source.views, 'registerTreeDataProvider');
    for (const [container] of Object.entries(recordAt(contributes, 'views'))) {
        if (!BUILT_IN_CONTAINERS.has(container) && !contributed.containers.includes(container)) {
            fail(
                MANIFEST,
                `views sit in \`${container}\`, which no \`viewsContainers\` entry contributes`,
                'The editor drops views whose container does not exist.',
            );
        }
    }
    for (const [where, id] of commandReferences(contributes)) {
        if (!contributed.commands.includes(id)) {
            fail(
                MANIFEST,
                `${where} names \`${id}\`, which is not a contributed command`,
                'The editor shows the entry and does nothing when it is used. Contribute the command, or remove the entry.',
            );
        }
    }
    for (const view of listAt(contributes, 'viewsWelcome').flatMap((welcome) => stringAt(welcome, 'view') ?? [])) {
        if (!contributed.views.includes(view)) {
            fail(
                MANIFEST,
                `a welcome names view \`${view}\`, which is not contributed`,
                'A welcome for a view that does not exist is never shown.',
            );
        }
    }

    const read = new Set(source.settings.map((setting) => setting.name));
    for (const key of [...contributed.settings.keys()].filter((name) => !read.has(name))) {
        fail(
            MANIFEST,
            `setting \`${key}\` is read nowhere`,
            'A setting nothing reads changes nothing when the person changes it. Read it, or remove it.',
        );
    }
    for (const { name, at, fallback } of source.settings) {
        if (!contributed.settings.has(name)) {
            fail(
                at,
                `reads setting \`${name}\`, which the manifest does not declare`,
                'An undeclared setting has no description, no type and no place in the Settings editor, so nobody can find it to change it.',
            );
        } else if (fallback !== undefined && fallback !== contributed.settings.get(name)) {
            fail(
                at,
                `reads \`${name}\` with the default ${JSON.stringify(fallback)}, not the manifest’s ${JSON.stringify(contributed.settings.get(name))}`,
                'The manifest’s default is the one the Settings editor shows. Two defaults drift, and the code then does what the person was not told.',
            );
        }
    }
    for (const { name, at } of source.unread) {
        fail(
            at,
            `\`${name}\` is given an id this gate cannot read`,
            'Pass the id as a string literal, at the call or at the call of the helper it passes through, so the manifest can be held to it.',
        );
    }

    // ── 6. Activation ───────────────────────────────────────────────────────
    for (const event of listAt(manifest, 'activationEvents').filter((value) => typeof value === 'string')) {
        const [kind = '', id = ''] = event.split(':');
        if (event === '*') {
            fail(
                MANIFEST,
                'activates on `*`',
                'The extension starts with every window, before the person asks for anything, and slows every startup. Name the events that need it.',
            );
        } else if (
            (kind === 'onCommand' && contributed.commands.includes(id)) ||
            (kind === 'onView' && contributed.views.includes(id))
        ) {
            fail(
                MANIFEST,
                `lists \`${event}\``,
                'The editor activates on a contributed command or view by itself, so the line repeats the contribution and outlives it when one is removed.',
            );
        }
    }

    // ── 7. Workspace trust and virtual workspaces ───────────────────────────
    const capabilities = recordAt(manifest, 'capabilities');
    const trust = capabilities['untrustedWorkspaces'];
    const supported = isRecord(trust) ? trust['supported'] : undefined;
    if (supported !== true && supported !== false && supported !== 'limited') {
        fail(
            MANIFEST,
            '`capabilities.untrustedWorkspaces.supported` is not declared',
            'Left out, the editor disables the extension in every folder the person has not trusted, and they see it vanish without a reason. Declare `true`, `false` or `limited`.',
        );
    } else if (supported !== true && stringAt(trust, 'description') === undefined) {
        fail(
            MANIFEST,
            'a limited or unsupported untrusted workspace gives no `description`',
            'The editor shows it to the person deciding whether to trust the folder.',
        );
    }
    for (const key of isRecord(trust) ? listAt(trust, 'restrictedConfigurations') : []) {
        if (typeof key !== 'string' || !contributed.settings.has(key)) {
            fail(
                MANIFEST,
                `restricts \`${String(key)}\`, which is not a declared setting`,
                'A restriction on a setting the extension does not have protects nothing.',
            );
        }
    }
    const virtual = capabilities['virtualWorkspaces'];
    if (typeof virtual !== 'boolean' && !(isRecord(virtual) && 'supported' in virtual)) {
        fail(
            MANIFEST,
            '`capabilities.virtualWorkspaces` is not declared',
            'In a folder that is not on disk (a GitHub repository opened in the browser) the editor otherwise guesses. Declare it.',
        );
    }

    // ── 8. The package ──────────────────────────────────────────────────────
    packageProblems(root, manifest, main, fail);

    // ── 9. Not checked yet ──────────────────────────────────────────────────
    const nls = fs.readdirSync(root).filter((name) => /^package\.nls(\..+)?\.json$/.test(name));
    for (const site of [...source.unchecked, ...nls.map((name) => ({ name, at: name }))]) {
        fail(site.at, `uses ${site.name}, which no gate checks yet`, UNCHECKED_WHY);
    }
    if ('l10n' in manifest) fail(MANIFEST, 'names an `l10n` bundle, which no gate checks yet', UNCHECKED_WHY);

    return {
        problems,
        counts: {
            commands: contributed.commands.length,
            views: contributed.views.length,
            settings: contributed.settings.size,
        },
    };
}

export function checkExtensionManifest(options: ExtensionManifestOptions = {}): void {
    const { root = REPO_ROOT, ...rest } = options;
    const report = createGateReport({ name: 'Extension manifest' });
    const { problems, counts } = inspectExtensionManifest({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);
    report.done({
        summary: `Extension manifest OK — ${plural(counts.commands, 'command')}, ${plural(counts.views, 'view')} and ${plural(counts.settings, 'setting')}, each in its namespace and matched in the source; activation, workspace trust and the package declared.`,
        notMachineChecked:
            'whether a command does what its title says, whether `when` clauses name context keys the code sets, what the .vsix holds beyond the allowlist (run `vsce ls`), and whether the extension works in an untrusted or remote window.',
    });
}

/** Each contributed id the source never registers, and each registered one the manifest never lists. */
function drift(
    fail: (file: string, what: string, why: string) => void,
    noun: string,
    listed: string[],
    found: SourceSite[],
    api: string,
): void {
    const registered = new Set(found.map((site) => site.name));
    for (const id of listed.filter((name) => !registered.has(name))) {
        fail(
            MANIFEST,
            `${noun} \`${id}\` is contributed but nothing registers it`,
            `The editor shows it, and using it fails with "not found". Register it with \`${api}('${id}', …)\`, or remove it from the manifest.`,
        );
    }
    for (const { name, at } of found.filter((site) => !listed.includes(site.name))) {
        fail(
            at,
            `registers ${noun} \`${name}\`, which the manifest does not contribute`,
            `A ${noun} the manifest does not list has no title anywhere the person can find it. Contribute it, hidden from the palette with \`when: false\` if it is internal.`,
        );
    }
}

/** Every setting the manifest declares, with its default. `configuration` is one object or a list of them. */
function configurationEntries(contributes: Record<string, unknown>): [string, unknown][] {
    const configuration = contributes['configuration'];
    const blocks = Array.isArray(configuration) ? configuration : [configuration];
    return blocks.flatMap((block) =>
        Object.entries(recordAt(block, 'properties')).map(([key, spec]): [string, unknown] => [
            key,
            toRecord(spec)['default'],
        ]),
    );
}

/** Every command a menu, a keybinding or a welcome link names, and where. */
function commandReferences(contributes: Record<string, unknown>): [string, string][] {
    const menus = Object.entries(recordAt(contributes, 'menus')).flatMap(([menu, items]) =>
        (Array.isArray(items) ? items : []).flatMap((item): [string, string][] =>
            ['command', 'alt'].flatMap((key) => stringAt(item, key) ?? []).map((id) => [`menu \`${menu}\``, id]),
        ),
    );
    const keybindings = [contributes['keybindings'] ?? []].flat().flatMap((binding): [string, string][] => {
        const id = stringAt(binding, 'command');
        return id === undefined || id.startsWith('-') ? [] : [['a keybinding', id]];
    });
    const links = listAt(contributes, 'viewsWelcome').flatMap((welcome) =>
        [...(stringAt(welcome, 'contents') ?? '').matchAll(/\(command:([\w.-]+)/g)].map(
            ([, id = '']): [string, string] => ['a welcome link', id],
        ),
    );
    return [...menus, ...keybindings, ...links];
}

/** Rule 8: `.vscodeignore` as an allowlist, or `files`; either way `main` ships and the source does not. */
function packageProblems(
    root: string,
    manifest: Record<string, unknown>,
    main: string | undefined,
    fail: (file: string, what: string, why: string) => void,
): void {
    const ignoreFile = path.join(root, '.vscodeignore');
    let shipped: string[];
    let where: string;
    if (Array.isArray(manifest['files'])) {
        shipped = manifest['files'].filter((entry) => typeof entry === 'string');
        where = '`files`';
    } else if (fs.existsSync(ignoreFile)) {
        const lines = fs
            .readFileSync(ignoreFile, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#'));
        if (lines[0] !== '**') {
            fail(
                '.vscodeignore',
                'does not start by leaving everything out',
                'A list of what to leave out ships whatever nobody thought to list: a new folder of fixtures, an `.env`. Start with `**`, then name what ships with `!`.',
            );
        }
        shipped = lines.filter((line) => line.startsWith('!')).map((line) => line.slice(1));
        where = '.vscodeignore';
    } else {
        fail(
            MANIFEST,
            'has neither `files` nor a .vscodeignore',
            'vsce then packages the whole folder: the source, the tests and anything else in it.',
        );
        return;
    }
    const ships = (rel: string): boolean =>
        shipped.some((pattern) => path.matchesGlob(rel, pattern.replace(/\/$/, '/**')));
    const bundle = main?.replace(/^\.\//, '');
    if (bundle !== undefined && !ships(bundle)) {
        fail(
            where,
            `does not ship \`main\` (${bundle})`,
            'The package installs, and the editor finds nothing to load.',
        );
    }
    for (const rel of NEVER_SHIPPED.filter(ships)) {
        fail(
            where,
            `ships \`${rel.split('/')[0] ?? rel}/\``,
            'The bundle already holds the code the editor runs; the rest is weight, and source the person did not need.',
        );
    }
}

const camelCase = (name: string): string =>
    name.replace(/-([a-z0-9])/g, (_dash, letter: string) => letter.toUpperCase());

/** Compares two ranges by the version each starts at: `^1.90.0` against `~1.92.0`. */
function compareFloors(left: string, right: string): number {
    const floor = (range: string): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(range) ?? []).slice(1).map(Number);
    const [a, b] = [floor(left), floor(right)];
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
}
