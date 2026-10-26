/**
 * `larry init <family>`: sets a project up to use this package. It writes each config
 * file, the git hooks, the CI workflow and larry.config.ts, and adds the package.json
 * scripts that run them. A file that already exists is kept as it is, and so is a script,
 * so running it again only fills in what is missing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { format } from 'prettier';

import { FULLSTACK_WORKSPACES, type PresetName } from '../eslint/presets.ts';
import { isRecord, readJson, stringAt } from '../gates/lib/json.ts';
import { CANONICAL_ORDER } from '../gates/package-json.ts';
import { prettierConfig } from '../prettier.ts';
import { UI_FAMILIES, scaffoldFiles, unconfiguredGates, type Distribution } from './templates.ts';

type Manifest = Record<string, unknown>;

type InitResult = {
    /** Files written, by path from the root. */
    written: string[];
    /** Files that were there already and were left alone. */
    kept: string[];
    /** Scripts and fields added to package.json. */
    added: string[];
    /** What is left for the project to do. */
    next: string[];
};

/** What npm writes for `test` when there is no test yet. It fails, so CI must not run it. */
const NPM_PLACEHOLDER_TEST = 'no test specified';

/** What runs every gate: the script init adds, or the CLI itself. `pipeline` holds the wiring to account. */
const RUNS_CHECK = /\bnpm run check(?![\w:.-])|\blarry check\b/;

/** The files Prettier formats; the hooks and ignore files are not code. */
const FORMATTED = /\.(?:[cm]?js|ts|json|ya?ml)$/;

/**
 * @param root The repository root.
 * @param family The project's family.
 * @param distribution Whether the app's own source is published, for the licenses gate.
 * @returns What was written, kept and added, and what is left to do.
 */
export async function init(root: string, family: PresetName, distribution: Distribution): Promise<InitResult> {
    const manifestPath = path.join(root, 'package.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`there is no package.json in ${root}. Run \`npm init\` first.`);
    const manifest = readJson(manifestPath);
    if (!isRecord(manifest)) throw new Error(`${manifestPath} does not hold a JSON object.`);
    const scripts = isRecord(manifest['scripts']) ? manifest['scripts'] : {};
    const test = stringAt(scripts, 'test');

    const ciScripts = [
        ...(scripts['typecheck'] === undefined ? [] : ['typecheck']),
        'lint',
        'format:check',
        ...(test === undefined || test.includes(NPM_PLACEHOLDER_TEST) ? [] : ['test']),
        'check',
    ];
    const { scan, sources } = sourceFolders(root, family, manifest);

    const result: InitResult = { written: [], kept: [], added: [], next: [] };
    for (const [file, content] of Object.entries(scaffoldFiles({ family, distribution, scan, sources, ciScripts }))) {
        const target = path.join(root, file);
        if (fs.existsSync(target)) {
            result.kept.push(file);
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, FORMATTED.test(file) ? await prettify(file, content) : content, {
            mode: file.startsWith('.husky/') ? 0o755 : 0o644,
        });
        result.written.push(file);
    }

    const wanted: Record<string, string> = {
        'prepare': 'husky',
        'lint': 'eslint .',
        'format:check': 'prettier --check .',
        'check': 'larry check',
        'ci:check': ciScripts.map((script) => `npm run ${script}`).join(' && '),
    };
    const newScripts = Object.entries(wanted).filter(([name]) => scripts[name] === undefined);
    let updated: Manifest = manifest;
    if (newScripts.length > 0) {
        updated = withField(updated, 'scripts', { ...scripts, ...Object.fromEntries(newScripts) });
        result.added.push(...newScripts.map(([name]) => `scripts.${name}`));
    }
    const engines = isRecord(manifest['engines']) ? manifest['engines'] : {};
    if (engines['node'] === undefined) {
        updated = withField(updated, 'engines', { ...engines, node: '>=24' });
        result.added.push('engines.node');
    }
    if (updated !== manifest) {
        fs.writeFileSync(manifestPath, await prettify('package.json', JSON.stringify(updated)));
    }

    result.next.push(...nextSteps(root, family, manifest, result));
    return result;
}

/** code-style reads the source and test folders, duplication only the source ones. Those that exist, or the conventional one. */
function sourceFolders(root: string, family: PresetName, manifest: Manifest): { scan: string[]; sources: string[] } {
    const exists = (dir: string): boolean => fs.existsSync(path.join(root, dir));
    const listed: unknown = manifest['workspaces'];
    const workspaces = Array.isArray(listed)
        ? listed.filter((dir): dir is string => typeof dir === 'string' && !dir.includes('*'))
        : [];
    const { frontend, api, services, shared } = FULLSTACK_WORKSPACES;
    const candidates =
        family === 'fullstack'
            ? [...new Set([...workspaces, frontend, api, ...services, ...shared])]
            : ['src', ...(family === 'tauri' ? ['src-tauri/src'] : [])];
    const fallback = family === 'fullstack' ? [frontend, api] : ['src'];
    const found = candidates.filter(exists);
    const sources = found.length > 0 ? found : fallback;
    return { scan: [...sources, ...['test', 'tests', 'scripts'].filter(exists)], sources };
}

function nextSteps(root: string, family: PresetName, manifest: Manifest, result: InitResult): string[] {
    const next: string[] = [];
    if (manifest['type'] !== 'module') {
        next.push(
            'package.json has no `"type": "module"`. The config files are ES modules, so set it, after moving any CommonJS file to .cjs.',
        );
    }
    const workflow = path.join(root, '.github/workflows/ci.yml');
    if (result.kept.includes('.github/workflows/ci.yml') && !RUNS_CHECK.test(fs.readFileSync(workflow, 'utf8'))) {
        next.push('.github/workflows/ci.yml was there already: give it a step that runs `npm run check`.');
    }
    const ciCheck = stringAt(manifest['scripts'], 'ci:check');
    if (ciCheck !== undefined && !RUNS_CHECK.test(ciCheck)) {
        next.push('package.json had a `ci:check` already: chain `npm run check` into it.');
    }
    const skipped = unconfiguredGates(family);
    if (result.written.includes('larry.config.ts') && skipped.length > 0) {
        next.push(
            `larry.config.ts skips ${skipped.length} gates that need paths only this project knows: ${skipped.map(([name]) => name).join(', ')}. Give each its options and remove its skip.`,
        );
    }
    if (UI_FAMILIES.includes(family) && result.written.includes('.stylelintrc.mjs')) {
        next.push(
            ".stylelintrc.mjs uses the defaults. The README's Stylelint table lists the options a UI usually sets.",
        );
    }
    next.push('Run `npm install`, so `prepare` installs the git hooks, then `npx larry doctor` to check the install.');
    return next;
}

/** `manifest` with `field` set, placed where the canonical order puts it if it is new. */
function withField(manifest: Manifest, field: string, value: unknown): Manifest {
    if (Object.hasOwn(manifest, field)) return { ...manifest, [field]: value };
    const rank = (key: string): number => {
        const at = CANONICAL_ORDER.indexOf(key);
        return at === -1 ? CANONICAL_ORDER.length : at;
    };
    const entries: [string, unknown][] = Object.entries(manifest);
    const before = entries.findIndex(([key]) => rank(key) > rank(field));
    entries.splice(before === -1 ? entries.length : before, 0, [field, value]);
    return Object.fromEntries(entries);
}

/** Formatted as the project's own `format:check` will read it. */
const prettify = (file: string, content: string): Promise<string> =>
    format(content, { ...prettierConfig, filepath: file });
