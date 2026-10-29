/**
 * `larry doctor`: whether this package is installed the way its tools need, which is
 * where a project goes wrong before any gate can say so. Node, larry.config.ts, the
 * dependency and its copy in node_modules, a leftover `install-links`, the CLIs at the
 * top of node_modules, the git hooks and the config files. A project on the base family
 * also hears when its package.json looks like a kind another family is for. It changes
 * nothing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PresetName } from '../eslint/presets.ts';
import { isRecord, readJson, stringAt } from '../gates/lib/json.ts';
import { plural } from '../gates/lib/report.ts';
import { inspectToolchainInstall } from '../gates/lib/toolchain-install.ts';
import { NODE_FLOOR, PROJECT_CLIS, SELF_NAME, SELF_VERSION } from '../toolchain.ts';
import { loadConfig } from './load-config.ts';
import { findGateScripts } from './migrations/gate-scripts.ts';
import { createTree } from './migrations/tree.ts';
import { UI_FAMILIES } from './templates.ts';

type Diagnosis = {
    /** A note is worth knowing and fails nothing. */
    status: 'ok' | 'problem' | 'note';
    what: string;
    /** What to do about it. Only a problem or a note has one. */
    fix?: string;
};

type Manifest = Record<string, unknown>;

/** Each tool's config file, by the names the tool looks for, and whether only a UI has one. */
const TOOL_CONFIGS: [tool: string, name: RegExp, uiOnly: boolean][] = [
    ['ESLint', /^eslint\.config\.[cm]?[jt]s$/, false],
    ['Prettier', /^(?:prettier\.config\.[cm]?[jt]s|\.prettierrc(?:\.\w+)?)$/, false],
    ['commitlint', /^(?:commitlint\.config\.[cm]?[jt]s|\.commitlintrc(?:\.\w+)?)$/, false],
    ['lint-staged', /^(?:lint-staged\.config\.[cm]?[jt]s|\.lintstagedrc(?:\.\w+)?)$/, false],
    ['knip', /^(?:knip\.config\.[cm]?[jt]s|\.?knip\.jsonc?)$/, false],
    ['Stylelint', /^(?:stylelint\.config\.[cm]?[jt]s|\.stylelintrc(?:\.\w+)?)$/, true],
];

const HOOKS = ['.husky/pre-commit', '.husky/commit-msg'];

/**
 * A dependency only one kind of project has, and the family for it. In this order, since
 * an Electron or Tauri app depends on Vue too.
 */
const FAMILY_DEPENDENCIES: [family: PresetName, dependency: string][] = [
    ['electron', 'electron'],
    ['tauri', '@tauri-apps/api'],
    ['spa', 'vue'],
    ['api', 'express'],
];

/**
 * @param root The repository root.
 * @param running The folder of the package the running `larry` comes from, to tell it from the project's copy.
 * @returns One diagnosis per thing checked, in the order a fix is best made.
 */
export async function diagnose(root: string, running: string): Promise<Diagnosis[]> {
    const major = Number(process.versions.node.split('.')[0]);
    const found: Diagnosis[] = [
        major >= NODE_FLOOR
            ? ok(`Node ${process.versions.node}`)
            : problem(
                  `Node ${process.versions.node} is older than ${NODE_FLOOR}`,
                  `${SELF_NAME} needs Node ${NODE_FLOOR} or later.`,
              ),
    ];

    const manifestPath = path.join(root, 'package.json');
    if (!fs.existsSync(manifestPath)) {
        return [
            ...found,
            problem(`there is no package.json in ${root}`, 'Run `npm init`, then `npx larry init <family>`.'),
        ];
    }
    const manifest = readManifest(manifestPath);
    found.push(
        manifest['type'] === 'module'
            ? ok('package.json is an ES module')
            : problem(
                  'package.json has no `"type": "module"`',
                  'The config files are ES modules. Set it, after moving any CommonJS file to .cjs.',
              ),
    );

    const { family, diagnoses } = await diagnoseConfig(root);
    found.push(...diagnoses);
    if (family === 'base') found.push(diagnoseFamilyFit(manifest));
    if (manifest['name'] === SELF_NAME) {
        return [
            ...found,
            note(
                `this is ${SELF_NAME} itself`,
                'It is not installed into itself and runs its tools from its own source, so its install, hooks and config files are not checked.',
            ),
        ];
    }
    found.push(...diagnoseInstall(root, running, manifest), ...diagnoseHooks(root, manifest));

    const files = fs.readdirSync(root);
    const missing = TOOL_CONFIGS.filter(
        ([, name, uiOnly]) =>
            (!uiOnly || (family !== null && UI_FAMILIES.includes(family))) && !files.some((file) => name.test(file)),
    ).map(([tool]) => tool);
    found.push(
        missing.length === 0
            ? ok('every tool has its config file')
            : problem(
                  `no config file for ${missing.join(', ')}`,
                  '`npx larry init <family>` writes each one that is missing and leaves the rest.',
              ),
    );
    return found;
}

/** larry.config.ts, and the family it names: null when it is missing or does not load. */
async function diagnoseConfig(root: string): Promise<{ family: PresetName | null; diagnoses: Diagnosis[] }> {
    try {
        const config = await loadConfig(root);
        const skipped = config.skipped.size > 0 ? `, with ${plural(config.skipped.size, 'gate')} skipped` : '';
        return {
            family: config.family,
            diagnoses: [ok(`${config.file} loads: the ${config.family} family${skipped}`)],
        };
    } catch (error) {
        const scripts = findGateScripts(createTree(root));
        const [first = '', ...rest] = scripts;
        const named =
            rest.length === 0
                ? `${first} is a gate script`
                : `${first} and ${plural(rest.length, 'other')} are gate scripts`;
        return {
            family: null,
            diagnoses: [
                problem(
                    error instanceof Error ? error.message : String(error),
                    scripts.length > 0
                        ? `${named} from before \`larry\`: \`npx larry upgrade\` moves ${rest.length === 0 ? 'it' : 'them'} into larry.config.ts.`
                        : 'With no config, `npx larry init <family>` writes one. One that does not load fails `larry check` too.',
                ),
            ],
        };
    }
}

/** Whether a base project's package.json says it is a kind another family has rules for. */
function diagnoseFamilyFit(manifest: Manifest): Diagnosis {
    const dependencies = [manifest['dependencies'], manifest['devDependencies']].flatMap((field) =>
        isRecord(field) ? Object.keys(field) : [],
    );
    const published = manifest['private'] !== true && manifest['exports'] !== undefined;
    const signs: [family: PresetName, sign: string][] = [
        ...FAMILY_DEPENDENCIES.filter(([, dependency]) => dependencies.includes(dependency)).map(
            ([family, dependency]): [PresetName, string] => [family, `depends on ${dependency}`],
        ),
        ...(published ? [['library', 'publishes `exports`'] as [PresetName, string]] : []),
    ];
    const [first] = signs;
    if (first === undefined) return ok('nothing in package.json says another family fits better than base');
    const [fit, sign] = first;
    return note(
        `larry.config.ts names the base family, but package.json ${sign}, as ${fit} projects do`,
        `If this is one, the ${fit} family has rules and gates for it: set \`family: '${fit}'\` in larry.config.ts and \`preset: '${fit}'\` in eslint.config.js. The base family is for code no family describes.`,
    );
}

function diagnoseInstall(root: string, running: string, manifest: Manifest): Diagnosis[] {
    const spec = stringAt(manifest['devDependencies'], SELF_NAME) ?? stringAt(manifest['dependencies'], SELF_NAME);
    if (spec === undefined) return [problem(`${SELF_NAME} is not a dependency`, `Run \`npm i -D ${SELF_NAME}@beta\`.`)];

    const fromFolder = spec.startsWith('file:');
    const found = [
        fromFolder
            ? note(
                  `${SELF_NAME} is installed from a local path (${spec})`,
                  "That is for trying a change to it. CI and fresh clones can't install it, so switch back to the published version before committing.",
              )
            : ok(`${SELF_NAME} ${spec} is a dependency`),
    ];

    const npmrc = path.join(root, '.npmrc');
    if (
        !fromFolder &&
        fs.existsSync(npmrc) &&
        /^\s*install-links\s*=\s*true\s*$/m.test(fs.readFileSync(npmrc, 'utf8'))
    ) {
        found.push(
            problem(
                '.npmrc still sets `install-links=true`',
                `It was there to install ${SELF_NAME} from a local path, which this project no longer does. Remove the line.`,
            ),
        );
    }

    const installed = path.join(root, 'node_modules', SELF_NAME);
    if (!fs.existsSync(path.join(installed, 'package.json'))) {
        return [...found, problem(`${SELF_NAME} is not in node_modules`, 'Run `npm install`.')];
    }
    if (fs.lstatSync(installed).isSymbolicLink()) {
        found.push(
            problem(
                `node_modules/${SELF_NAME} is a link to a folder, so the tools it installs stay inside that folder`,
                'Set `install-links=true` in .npmrc, so npm installs a copy laid out as a registry install would, and reinstall it.',
            ),
        );
    }
    const version = stringAt(readJson(path.join(installed, 'package.json')), 'version');
    if (fs.realpathSync(installed) !== fs.realpathSync(running) && version !== SELF_VERSION) {
        found.push(
            problem(
                `this larry is ${SELF_VERSION}, from ${running}, but the project has ${version ?? 'no version'}`,
                "Run the project's own copy: through an npm script, or `npx larry` from inside the project.",
            ),
        );
    }

    const listed: unknown = manifest['workspaces'];
    const workspaces = Array.isArray(listed) ? listed.filter((dir): dir is string => typeof dir === 'string') : [];
    const manifests = [
        { file: 'package.json', pkg: manifest },
        ...workspaces
            .map((dir) => path.posix.join(dir, 'package.json'))
            .filter((file) => fs.existsSync(path.join(root, file)))
            .map((file) => ({ file, pkg: readManifest(path.join(root, file)) })),
    ];
    const toolchain = inspectToolchainInstall(root, manifests);
    found.push(
        ...(toolchain.length === 0
            ? [
                  ok(
                      `${Object.values(PROJECT_CLIS).join(', ')} are at the top of node_modules, at the versions ${SELF_NAME} pins`,
                  ),
              ]
            : toolchain.map(({ what, why }) => problem(what, why))),
    );
    return found;
}

function diagnoseHooks(root: string, manifest: Manifest): Diagnosis[] {
    const found: Diagnosis[] = [];
    const runsHusky = /\bhusky\b/.test(stringAt(manifest['scripts'], 'prepare') ?? '');
    if (!runsHusky) {
        found.push(
            problem(
                '`prepare` does not run husky',
                'Add `"prepare": "husky"` to the scripts, so `npm install` installs the git hooks.',
            ),
        );
    }
    const missing = HOOKS.filter((hook) => !fs.existsSync(path.join(root, hook)));
    if (missing.length > 0) {
        found.push(
            problem(
                `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
                '`npx larry init <family>` writes them.',
            ),
        );
    }
    if (!fs.existsSync(path.join(root, '.git'))) return found;
    if (hooksPath(root) !== '.husky/_') {
        found.push(
            problem(
                'git does not run the hooks in .husky',
                'Run `npm install`: its `prepare` script points git at them.',
            ),
        );
    } else if (found.length === 0) {
        found.push(ok('the git hooks are installed'));
    }
    return found;
}

/** `core.hooksPath`, or '' when it is not set. */
function hooksPath(root: string): string {
    try {
        return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
        // git exits 1 when the key is not set.
        return '';
    }
}

const ok = (what: string): Diagnosis => ({ status: 'ok', what });
const problem = (what: string, fix: string): Diagnosis => ({ status: 'problem', what, fix });
const note = (what: string, fix: string): Diagnosis => ({ status: 'note', what, fix });

/** A package.json's fields, or none when it does not hold an object. */
const readManifest = (file: string): Manifest => {
    const value = readJson(file);
    return isRecord(value) ? value : {};
};
