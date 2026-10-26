/**
 * Moves the gate scripts projects ran before `larry` existed into larry.config.ts. A gate
 * script is a `scripts/checks/check-*.ts`, or any file a package.json script runs that
 * imports a gate, wherever the project keeps it. One that imports a gate and calls it once,
 * with only `const`s its options use above the call, becomes that gate's entry: the call's
 * argument as its options, and the `const`s above the config's default export. The
 * package.json scripts, `ci:check` and CI steps that ran it run `larry check` instead. A
 * script that does anything more stays where it is, with the reason, for a person to move.
 */
import path from 'node:path';

import ts from 'typescript';

import { CONFIG_FILES } from '../../config.ts';
import { PRESETS, type PresetName } from '../../eslint/presets.ts';
import { isRecord } from '../../gates/lib/json.ts';
import { plural } from '../../gates/lib/report.ts';
import { gatesFor } from '../../gates/registry.ts';
import { SELF_NAME } from '../../toolchain.ts';
import { prettify } from '../format.ts';
import {
    applyEdits,
    importEdits,
    importsOf,
    parseConfig,
    propertyName,
    topLevelNames,
    valueOf,
    type Binding,
    type Edit,
} from './config-source.ts';
import { GATE_MODULE, importsGate, parseGateScript, type GateScript } from './gate-script.ts';
import type { Tree } from './tree.ts';

type Manifest = Record<string, unknown>;

const CHECKS_DIR = 'scripts/checks';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];

/** A package.json script that only runs one file, under node or tsx: the file, and any arguments after it. */
const RUNS_FILE =
    /^\s*(?:npx\s+)?(?:node|tsx)(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:\.\/)?(\S+)(?:\s+([^&|;\s][^&|;]*?))?\s*$/;

/** Each file a command runs under node or tsx, wherever it is in the command. */
const RUNS_FILES = /\b(?:node|tsx)(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:\.\/)?([\w./-]+\.[cm]?[jt]s)\b/g;

/** A CI step that runs one npm script, on its own line: `- run: npm run x` or `run: npm run x` under `- name:`. */
const RUN_STEP = /^(\s*)(-\s+)?run:\s*npm run ([\w:@./-]+)\s*$/;

/**
 * @param tree The project.
 * @returns A note for each script that stays, and for what the upgrade leaves to do.
 * @throws When there are gate scripts but nothing names the family, or larry.config.ts is not a shape it can add to.
 */
export async function moveGateScripts(tree: Tree): Promise<string[]> {
    const files = findGateScripts(tree);
    if (files.length === 0) return [];

    const existing = CONFIG_FILES.find((name) => tree.exists(name));
    const configFile = existing ?? 'larry.config.ts';
    const family = familyOf(tree, existing);
    if (family === undefined) {
        throw new Error(
            `The project has gate scripts, but neither larry.config.ts nor eslint.config.js names the project's family. Add \`family\` to larry.config.ts (\`npx larry init <family>\` writes one) and run \`larry upgrade\` again.`,
        );
    }
    const configText = (existing === undefined ? undefined : tree.read(existing)) ?? skeleton(family);
    const { source, gates } = parseConfig(configFile, configText);
    if (gates === null) {
        throw new Error(
            `${configFile} does not default-export defineConfig({ family, gates: { … } }), so the gate scripts have nowhere to go.`,
        );
    }

    const manifest = readManifest(tree);
    const scripts = isRecord(manifest['scripts']) ? manifest['scripts'] : {};
    const runs: readonly string[] = gatesFor(family);
    const taken = importsOf(source);
    /** The names the config declares at its top level, and those the moved scripts' `const`s add. */
    const declared = new Set(source.statements.flatMap(topLevelNames));
    const moved: GateScript[] = [];
    /** Each script that stays, with why, and the gate it imports when there is one. */
    const stays = new Map<string, { reason: string; gate: string | undefined }>();

    for (const file of files) {
        const text = tree.read(file) ?? '';
        const parsed = parseGateScript(file, text);
        const reason =
            typeof parsed === 'string'
                ? parsed
                : whyItStays(parsed, { family, runs, gates, moved, scripts, taken, declared });
        if (typeof parsed === 'string' || reason !== undefined) {
            const gate = new RegExp(`['"]${GATE_MODULE}([\\w/-]+)['"]`).exec(text)?.[1];
            stays.set(file, { reason: reason ?? '', gate });
            continue;
        }
        for (const binding of parsed.bindings) taken.set(binding.local, binding);
        for (const name of parsed.declared) declared.add(name);
        moved.push(parsed);
    }

    const notes = [...stays].map(
        ([file, { reason }]) =>
            `${file} stays: ${reason}. Move its options into ${configFile} by hand, then delete it and the script that runs it.`,
    );
    if (moved.length === 0) return notes;

    // ── larry.config.ts ──────────────────────────────────────────────────────
    const own = importsOf(source);
    const added = moved.flatMap(({ bindings }) => bindings).filter(({ local }) => !own.has(local));
    const entries: [gate: string, text: string][] = [];
    const declarations = moved.flatMap((script) => script.declarations);
    const exported = source.statements.find(ts.isExportAssignment)?.getFullStart() ?? configText.length;
    // Ahead of the import edits: at the same offset, a later edit's text lands before an earlier one's,
    // and the imports belong above the constants.
    const edits: Edit[] = [
        ...(declarations.length > 0
            ? [{ start: exported, end: exported, text: `\n\n${declarations.join('\n\n')}` }]
            : []),
        ...importEdits(source, [...new Map(added.map((b) => [b.local, b])).values()]),
    ];
    for (const { gate, options, comments } of moved) {
        const skipped = gates.properties.find((property) => propertyName(property) === gate);
        if (skipped !== undefined && ts.isPropertyAssignment(skipped)) {
            const start = skipped.getStart();
            if (comments !== '') edits.push({ start, end: start, text: comments });
            edits.push({ start: skipped.initializer.getStart(), end: skipped.initializer.end, text: options ?? '{}' });
        } else {
            entries.push([gate, `${comments}'${gate}': ${options ?? '{}'},`]);
        }
    }
    // A new config skips what no script ran, so the upgrade changes how the project is checked, not what passes.
    const unrun = existing === undefined ? runs.filter((gate) => !moved.some((script) => script.gate === gate)) : [];
    for (const gate of unrun) {
        const stayed = [...stays].find(([, script]) => script.gate === gate)?.[0];
        const reason =
            stayed === undefined
                ? 'No script ran it before larry upgrade.'
                : `Still runs from ${stayed} until its options move here.`;
        entries.push([gate, `'${gate}': { skip: '${reason}' },`]);
    }
    if (entries.length > 0) {
        const comma = gates.properties.length > 0 && !gates.properties.hasTrailingComma ? ',' : '';
        const at = gates.getEnd() - 1;
        // In the registry's order, which is the order `larry check` runs them in.
        const text = entries
            .sort(([a], [b]) => runs.indexOf(a) - runs.indexOf(b))
            .map(([, entry]) => entry)
            .join('\n');
        edits.push({ start: at, end: at, text: `${comma}\n${text}\n` });
    }
    tree.write(configFile, await prettify(configFile, applyEdits(configText, edits)));
    const newlySkipped = unrun.filter((gate) => ![...stays.values()].some((script) => script.gate === gate));
    if (newlySkipped.length > 0) {
        notes.push(
            `${configFile} skips ${plural(newlySkipped.length, 'gate')} no script ran before: ${newlySkipped.join(', ')}. Remove a skip to run that gate.`,
        );
    }

    // ── package.json and CI ──────────────────────────────────────────────────
    const movedFiles = new Set(moved.map(({ file }) => file));
    const removed = Object.keys(scripts).filter((name) => movedFiles.has(runsFile(scripts[name]) ?? ''));
    const larryScript = Object.keys(scripts).find((name) => scripts[name] === 'larry check');
    const addCheck = larryScript === undefined && scripts['check'] === undefined;
    const larryName = larryScript ?? (addCheck ? 'check' : undefined);
    const runLarry = larryName === undefined ? 'npx larry check' : `npm run ${larryName}`;
    const runsLarry = (text: string): boolean =>
        /\blarry check\b/.test(text) || (larryName !== undefined && npmRuns(larryName).test(text));

    const rewired: Record<string, unknown> = {};
    for (const [name, command] of Object.entries(scripts)) {
        if (removed.includes(name)) continue;
        rewired[name] = typeof command === 'string' ? rechain(command, removed, runLarry, runsLarry) : command;
    }
    if (addCheck) rewired['check'] = 'larry check';
    const ciCheck = rewired['ci:check'];
    if (typeof ciCheck === 'string' && !runsLarry(ciCheck)) rewired['ci:check'] = `${ciCheck} && ${runLarry}`;
    if (typeof ciCheck !== 'string') {
        notes.push(`package.json has no \`ci:check\`: add one that runs \`${runLarry}\` with the other checks.`);
    }
    tree.write('package.json', await prettify('package.json', JSON.stringify({ ...manifest, scripts: rewired })));

    const workflow = tree.read(CI_WORKFLOW);
    if (workflow !== undefined) {
        const text = rewireWorkflow(workflow, removed, runLarry, runsLarry(workflow));
        tree.write(CI_WORKFLOW, text);
        const left = removed.filter((name) => npmRuns(name).test(text));
        if (left.length > 0) {
            notes.push(
                `${CI_WORKFLOW} still runs ${left.map((name) => `\`npm run ${name}\``).join(', ')} inside a longer step. Those scripts are gone: remove them from it.`,
            );
        }
        if (!runsLarry(text)) notes.push(`${CI_WORKFLOW} does not run \`${runLarry}\`: give it a step that does.`);
    }

    for (const file of movedFiles) tree.remove(file);
    return notes;
}

/**
 * @param tree The project.
 * @returns Its gate scripts by path from the root: each `check-*.ts` in scripts/checks, and
 * each other file a package.json script runs that imports a gate.
 */
export function findGateScripts(tree: Tree): string[] {
    const inChecks = tree
        .list(CHECKS_DIR)
        .filter((name) => /^check-.+\.ts$/.test(name))
        .map((name) => `${CHECKS_DIR}/${name}`);
    const run = Object.values(scriptsOf(tree))
        .flatMap((command) => (typeof command === 'string' ? [...command.matchAll(RUNS_FILES)] : []))
        .map(([, file = '']) => path.posix.normalize(file))
        .filter((file) => !inChecks.includes(file) && importsGate(tree.read(file) ?? ''));
    return [...new Set([...inChecks, ...run])].sort();
}

/** The family larry.config.ts names, or else the preset eslint.config.js passes to `larry()`. */
function familyOf(tree: Tree, configFile: string | undefined): PresetName | undefined {
    const configText = configFile === undefined ? undefined : tree.read(configFile);
    const named =
        configText !== undefined && configFile !== undefined
            ? parseConfig(configFile, configText).family
            : ESLINT_CONFIGS.map((file) => /\bpreset:\s*['"]([\w-]+)['"]/.exec(tree.read(file) ?? '')?.[1]).find(
                  (preset) => preset !== undefined,
              );
    return named !== undefined && isFamily(named) ? named : undefined;
}

function whyItStays(
    script: GateScript,
    context: {
        family: PresetName;
        runs: readonly string[];
        gates: ts.ObjectLiteralExpression;
        moved: GateScript[];
        scripts: Record<string, unknown>;
        taken: Map<string, Binding>;
        declared: Set<string>;
    },
): string | undefined {
    const { gate, file, bindings } = script;
    if (!context.runs.includes(gate)) return `${gate} is not a gate ${context.family} projects run`;
    if (context.moved.some((other) => other.gate === gate)) return `another script already ran ${gate}`;
    const configured = valueOf(context.gates, gate);
    if (
        configured !== undefined &&
        !(ts.isObjectLiteralExpression(configured) && valueOf(configured, 'skip') !== undefined)
    ) {
        return `larry.config.ts already configures ${gate}`;
    }
    const clash = bindings.find((binding) => {
        const other = context.taken.get(binding.local);
        return (
            context.declared.has(binding.local) ||
            (other !== undefined && (other.module !== binding.module || other.imported !== binding.imported))
        );
    });
    if (clash !== undefined) return `its import \`${clash.local}\` would clash with another of the same name`;
    const twice = script.declared.find((name) => context.declared.has(name) || context.taken.has(name));
    if (twice !== undefined) return `its \`${twice}\` would clash with another of the same name`;
    const shared = Object.entries(context.scripts).find(
        ([, command]) => typeof command === 'string' && command.includes(file) && runsFile(command) !== file,
    );
    if (shared === undefined) return undefined;
    const [name, command] = shared;
    const args = typeof command === 'string' ? RUNS_FILE.exec(command) : null;
    return args?.[1] === file && args[2] !== undefined
        ? `package.json's \`${name}\` runs it with \`${args[2]}\`, which \`larry check\` does not pass on`
        : `package.json's \`${name}\` runs it along with other commands`;
}

/**
 * `command` with each `npm run` of a removed script taken out of its `&&` chain, and the
 * first replaced by `runLarry` unless the chain already runs `larry check`.
 */
function rechain(command: string, removed: string[], runLarry: string, runsLarry: (text: string) => boolean): string {
    const parts = command.split(/\s*&&\s*/);
    const gone = (part: string): boolean =>
        removed.some((name) => new RegExp(`^${npmRuns(name).source}$`).test(part.trim()));
    if (!parts.some(gone)) return command;
    let replaced = runsLarry(command);
    return parts
        .flatMap((part) => {
            if (!gone(part)) return [part];
            if (replaced) return [];
            replaced = true;
            return [runLarry];
        })
        .join(' && ');
}

/**
 * The workflow with each step that only runs a removed script taken out, along with the
 * blank line that set it apart, and the first replaced by one running `larry check`: named
 * when the step it replaces was.
 */
function rewireWorkflow(workflow: string, removed: string[], runLarry: string, runsLarry: boolean): string {
    const lines = workflow.split('\n');
    const indent = (line: string): number => line.length - line.trimStart().length;
    const blank = (at: number): boolean => (lines[at] ?? 'end').trim() === '';
    const spans: { start: number; end: number; dash: number; run: number }[] = [];

    lines.forEach((line, at) => {
        const match = RUN_STEP.exec(line);
        if (match === null || !removed.includes(match[3] ?? '')) return;
        const own = (match[1] ?? '').length;
        let start = at;
        if (match[2] === undefined) {
            start = lines.findLastIndex((above, i) => i < at && /^\s*-\s/.test(above) && indent(above) < own);
            if (
                start === -1 ||
                lines
                    .slice(start + 1, at)
                    .some((between) => between.trim() !== '' && indent(between) <= indent(lines[start] ?? ''))
            ) {
                return;
            }
        }
        const dash = indent(lines[start] ?? '');
        let end = start + 1;
        while (end < lines.length && ((lines[end] ?? '').trim() === '' || indent(lines[end] ?? '') > dash)) end++;
        while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') end--;
        spans.push({ start, end, dash, run: own });
    });

    // From the bottom up, so each span's lines are still where they were found.
    const first = spans[0]?.start;
    for (const { start, end, dash, run } of spans.reverse()) {
        if (start === first && !runsLarry) {
            const named = /^\s*-\s+name:/.test(lines[start] ?? '');
            const step = named
                ? [`${' '.repeat(dash)}- name: larry check`, `${' '.repeat(run)}run: ${runLarry}`]
                : [`${' '.repeat(dash)}- run: ${runLarry}`];
            lines.splice(start, end - start, ...step);
            continue;
        }
        let [from, to] = [start, end];
        if (blank(from - 1)) while (blank(from - 1)) from--;
        else while (to < lines.length && blank(to)) to++;
        lines.splice(from, to - from);
    }
    return lines.join('\n');
}

/** The file a script runs when that is all it does, with no arguments, by path from the root. */
function runsFile(command: unknown): string | undefined {
    const match = typeof command === 'string' ? RUNS_FILE.exec(command) : null;
    return match?.[2] === undefined ? match?.[1] : undefined;
}

/** package.json's scripts, or none when it is missing or not a JSON object. */
function scriptsOf(tree: Tree): Record<string, unknown> {
    try {
        const { scripts } = readManifest(tree);
        return isRecord(scripts) ? scripts : {};
    } catch {
        return {};
    }
}

function readManifest(tree: Tree): Manifest {
    const text = tree.read('package.json');
    const manifest: unknown = text === undefined ? undefined : JSON.parse(text);
    if (!isRecord(manifest)) throw new Error('package.json is missing or does not hold a JSON object.');
    return manifest;
}

const skeleton = (family: PresetName): string =>
    [
        "// The gates `larry check` runs, and each one's options. The editor lists every option a gate takes.",
        `import { defineConfig } from '${SELF_NAME}/config';`,
        '',
        `export default defineConfig({ family: '${family}', gates: {} });`,
        '',
    ].join('\n');

const isFamily = (name: string): name is PresetName => Object.hasOwn(PRESETS, name);

/** Matches `npm run <script>` and not a longer name it begins. */
const npmRuns = (script: string): RegExp =>
    new RegExp(`\\bnpm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:.-])`);
