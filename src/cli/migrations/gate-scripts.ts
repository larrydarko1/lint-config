/**
 * Moves the gate scripts projects ran before `larry` existed into larry.config.ts. A
 * `scripts/checks/check-*.ts` that imports one gate and calls it once becomes that gate's
 * entry, with the call's argument as its options, and the package.json scripts, `ci:check`
 * and CI steps that ran it run `larry check` instead. A script that does anything more
 * stays where it is, with the reason, for a person to move.
 */
import path from 'node:path';

import ts from 'typescript';

import { CONFIG_FILES } from '../../config.ts';
import { PRESETS, type PresetName } from '../../eslint/presets.ts';
import { isRecord } from '../../gates/lib/json.ts';
import { plural } from '../../gates/lib/report.ts';
import { GATES, gatesFor, type GateName } from '../../gates/registry.ts';
import { SELF_NAME } from '../../toolchain.ts';
import { prettify } from '../format.ts';
import {
    applyEdits,
    bindingsOf,
    importEdits,
    importsOf,
    parseConfig,
    parseSource,
    propertyName,
    valueOf,
    type Binding,
    type Edit,
} from './config-source.ts';
import type { Tree } from './tree.ts';

type GateScript = {
    file: string;
    gate: GateName;
    /** The call's argument as written, or null for a call with none. */
    options: string | null;
    /** The comments above the call, each on its own line, to go above the gate's entry. */
    comments: string;
    /** The script's imports its options use, with relative specifiers rebased on the root. */
    bindings: Binding[];
};

type Manifest = Record<string, unknown>;

const CHECKS_DIR = 'scripts/checks';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const GATE_MODULE = `${SELF_NAME}/gates/`;
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];

/** A package.json script that only runs one file, under node or tsx. */
const RUNS_FILE = /^\s*(?:npx\s+)?(?:node|tsx)(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:\.\/)?(\S+)\s*$/;

/** A CI step that runs one npm script, on its own line: `- run: npm run x` or `run: npm run x` under `- name:`. */
const RUN_STEP = /^(\s*)(-\s+)?run:\s*npm run ([\w:@./-]+)\s*$/;

/**
 * @param tree The project.
 * @returns A note for each script that stays, and for what the upgrade leaves to do.
 * @throws When there are gate scripts but nothing names the family, or larry.config.ts is not a shape it can add to.
 */
export async function moveGateScripts(tree: Tree): Promise<string[]> {
    const files = tree
        .list(CHECKS_DIR)
        .filter((name) => /^check-.+\.ts$/.test(name))
        .map((name) => `${CHECKS_DIR}/${name}`);
    if (files.length === 0) return [];

    const existing = CONFIG_FILES.find((name) => tree.exists(name));
    const configFile = existing ?? 'larry.config.ts';
    const family = familyOf(tree, existing);
    if (family === undefined) {
        throw new Error(
            `${CHECKS_DIR} holds gate scripts, but neither larry.config.ts nor eslint.config.js names the project's family. Add \`family\` to larry.config.ts (\`npx larry init <family>\` writes one) and run \`larry upgrade\` again.`,
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
    const moved: GateScript[] = [];
    /** Each script that stays, with why, and the gate it imports when there is one. */
    const stays = new Map<string, { reason: string; gate: string | undefined }>();

    for (const file of files) {
        const text = tree.read(file) ?? '';
        const parsed = parseGateScript(file, text);
        const reason =
            typeof parsed === 'string' ? parsed : whyItStays(parsed, { family, runs, gates, moved, scripts, taken });
        if (typeof parsed === 'string' || reason !== undefined) {
            const gate = new RegExp(`['"]${GATE_MODULE}([\\w/-]+)['"]`).exec(text)?.[1];
            stays.set(file, { reason: reason ?? '', gate });
            continue;
        }
        for (const binding of parsed.bindings) taken.set(binding.local, binding);
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
    const edits: Edit[] = [...importEdits(source, [...new Map(added.map((b) => [b.local, b])).values()])];
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

/** A gate script reduced to its gate, options and imports, or why it is more than that. */
function parseGateScript(file: string, text: string): GateScript | string {
    const source = parseSource(file, text);
    const bindings: Binding[] = [];
    const calls: [statement: ts.Statement, call: ts.CallExpression][] = [];
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            if (statement.importClause === undefined) return `it imports ${specifier} for what that runs`;
            bindings.push(...bindingsOf(statement, rebase(file, specifier)));
            continue;
        }
        const call = ts.isExpressionStatement(statement) ? callIn(statement.expression) : undefined;
        if (call === undefined) {
            const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
            return `line ${line} does more than import a gate and call it`;
        }
        calls.push([statement, call]);
    }
    const [statement, call] = calls[0] ?? [];
    if (statement === undefined || call === undefined || calls.length > 1) {
        return calls.length === 0 ? 'it calls no gate' : 'it calls more than one function';
    }

    const callee = call.expression.getText();
    const binding = bindings.find(({ local }) => local === callee);
    const gate = binding?.module.startsWith(GATE_MODULE) === true ? binding.module.slice(GATE_MODULE.length) : '';
    if (binding === undefined || !isGate(gate) || !binding.imported.startsWith('check')) {
        return `it calls \`${callee}\`, which is not a gate's check function`;
    }
    if (call.arguments.length > 1) return `it passes \`${callee}\` more than its options`;
    const [argument] = call.arguments;
    if (
        argument !== undefined &&
        uses(argument, (node) => ts.isMetaProperty(node) || isIdentifier(node, '__dirname'))
    ) {
        return 'its options use import.meta, which would mean larry.config.ts instead';
    }
    if (argument !== undefined && ts.isObjectLiteralExpression(argument) && valueOf(argument, 'root') !== undefined) {
        return 'it passes `root`, and `larry check` runs every gate from the repository root';
    }
    const named = argument === undefined ? new Set<string>() : identifiersIn(argument);
    return {
        file,
        gate,
        options: argument?.getText() ?? null,
        comments: (ts.getLeadingCommentRanges(text, statement.pos) ?? [])
            .map(({ pos, end }) => `${text.slice(pos, end)}\n`)
            .join(''),
        bindings: bindings.filter(({ local }) => local !== callee && named.has(local)),
    };
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
        return other !== undefined && (other.module !== binding.module || other.imported !== binding.imported);
    });
    if (clash !== undefined) return `its import \`${clash.local}\` would clash with another of the same name`;
    const shared = Object.entries(context.scripts).find(
        ([, command]) => typeof command === 'string' && command.includes(file) && runsFile(command) !== file,
    );
    if (shared !== undefined) return `package.json's \`${shared[0]}\` runs it along with other commands`;
    return undefined;
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

/** The workflow with each step that only runs a removed script taken out, and the first replaced by one running `larry check`. */
function rewireWorkflow(workflow: string, removed: string[], runLarry: string, runsLarry: boolean): string {
    const lines = workflow.split('\n');
    const indent = (line: string): number => line.length - line.trimStart().length;
    const spans: { start: number; end: number; dash: number }[] = [];

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
        spans.push({ start, end, dash });
    });

    // From the bottom up, so each span's lines are still where they were found.
    const first = spans[0]?.start;
    for (const { start, end, dash } of spans.reverse()) {
        const step = start === first && !runsLarry ? [`${' '.repeat(dash)}- run: ${runLarry}`] : [];
        lines.splice(start, end - start, ...step);
    }
    return lines.join('\n');
}

/** The file a script runs when that is all it does, by path from the root. */
function runsFile(command: unknown): string | undefined {
    return typeof command === 'string' ? RUNS_FILE.exec(command)?.[1] : undefined;
}

/** A relative specifier from `file`, as it reads from the root. */
function rebase(file: string, specifier: string): string {
    if (!specifier.startsWith('.')) return specifier;
    const fromRoot = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    return fromRoot.startsWith('../') ? fromRoot : `./${fromRoot}`;
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

/** Unwraps `await` and `void` to the call underneath. */
function callIn(expression: ts.Expression): ts.CallExpression | undefined {
    const inner =
        ts.isAwaitExpression(expression) || ts.isVoidExpression(expression) ? expression.expression : expression;
    return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) ? inner : undefined;
}

/** Whether `test` holds for `node` or any node inside it. */
function uses(node: ts.Node, test: (node: ts.Node) => boolean): boolean {
    return test(node) || (ts.forEachChild(node, (child) => uses(child, test) || undefined) ?? false);
}

/** The name of every identifier in `node`. */
function identifiersIn(node: ts.Node, names = new Set<string>()): Set<string> {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, (child) => {
        identifiersIn(child, names);
    });
    return names;
}

const isIdentifier = (node: ts.Node, name: string): boolean => ts.isIdentifier(node) && node.text === name;

const isFamily = (name: string): name is PresetName => Object.hasOwn(PRESETS, name);

const isGate = (name: string): name is GateName => Object.hasOwn(GATES, name);

/** Matches `npm run <script>` and not a longer name it begins. */
const npmRuns = (script: string): RegExp =>
    new RegExp(`\\bnpm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:.-])`);
