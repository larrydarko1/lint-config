/**
 * tsconfig drift: every rule here catches a config that makes MORE code compile.
 *
 *   1. Every project extends the base (resolved, not just spelled).
 *   2. The base holds every checking flag and no environmental setting.
 *   3. Weakening a base flag needs a reason on the line (or just above).
 *   4. A declared target names the same ES year as its lib.
 *   5. Every project declares `types`.
 *   6. Named projects: services typed `["node"]`; browser projects without Node, in
 *      config and in source (tests exempt); source-only packages never emit.
 *   7. Every project config is reached by a typecheck script.
 *   8. A solution file only runs in build mode.
 *   9. Section dividers come from the known set, in order.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './files.ts';
import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, type GateFailure } from './report.ts';
import { stripComments } from './strip-comments.ts';

export type TsconfigsOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The one config that owns strictness. Defaults to `tsconfig.base.json`. */
    base?: string;
    /** Checking flags the base must hold, at the strict value. Defaults to `BASE_FLAGS`. */
    baseFlags?: Record<string, boolean>;
    /** Settings the base may NOT hold, because they describe an environment. Defaults to `ENVIRONMENTAL`. */
    environmental?: string[];
    /** Section dividers, in the order they must appear. Defaults to `SECTIONS`. */
    sections?: string[];
    /** Extra directory names to skip, beyond the build-output defaults. */
    ignore?: string[];
    /** Configs that must declare exactly `["node"]` — a service, nothing else in scope. */
    nodeTyped?: string[];
    /** Configs for a browser program: no `node` in `types` without a reason, ES and DOM libs only. */
    browserProjects?: string[];
    /** Source trees bundled for a browser. No file in them may reach for Node. Tests are exempt. */
    browserSources?: string[];
    /** Configs for a package consumed as TypeScript source, which may set no emit setting. */
    nonEmitting?: string[];
};

type TsconfigsInspection = {
    problems: GateFailure[];
    /** Every config that checks code: not the base, not a solution file. */
    projects: string[];
    /** How many checking flags the base was held to. */
    flagCount: number;
};


type TsconfigsInput = Omit<TsconfigsOptions, 'root'> & { root: string };

/** compilerOptions, naming only the settings this gate reads by name. */
type CompilerOptions = Record<string, unknown> & { types?: string[]; lib?: string[] };

/** A tsconfig as JSON — the keys this gate reads. */
type TsconfigJson = {
    extends?: string | string[];
    compilerOptions?: CompilerOptions;
    files?: string[];
    references?: { path: string }[];
};

type ParsedConfig = {
    raw: string;
    data: TsconfigJson;
    own: CompilerOptions;
    options: CompilerOptions | undefined;
};

/** The checking flags the base must hold, at their strict value. A project may differ, with a reason. */
export const BASE_FLAGS: Record<string, boolean> = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noImplicitReturns: true,
    noPropertyAccessFromIndexSignature: true,
    noUncheckedIndexedAccess: true,
    allowUnreachableCode: false,
    allowUnusedLabels: false,
    noFallthroughCasesInSwitch: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    esModuleInterop: true,
    isolatedModules: true,
    noUncheckedSideEffectImports: true,
    resolveJsonModule: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
};

/** Settings that describe an environment, not a checking rule. The base states it holds none. */
export const ENVIRONMENTAL: string[] = [
    'target',
    'lib',
    'module',
    'moduleResolution',
    'outDir',
    'rootDir',
    'noEmit',
    'paths',
    'types',
];

/** Section dividers, in the order they must appear. */
export const SECTIONS: string[] = [
    'Output & Build',
    'Target & Environment',
    'Paths & Types',
    'Type Checking - Base',
    'Type Checking - Additional Strictness',
    'Specific Behaviors',
    'Module System',
    'Library & Syntax',
];

/** Build output carries tsconfigs that are nobody's to edit. Add to it with `ignore`. */
const DEFAULT_IGNORED = ['node_modules', 'out', 'dist', 'dist-electron', 'coverage'];

/** Emit settings. A package consumed as TypeScript source may set none of them. */
const EMIT_SETTINGS = ['outDir', 'declaration', 'composite', 'declarationDir', 'emitDeclarationOnly'];

/** Node builtins, spelled either way. `node:` is the honest form; the bare name still resolves. */
const NODE_BUILTIN =
    /^(?:node:[a-z_/]+|fs|path|os|crypto|child_process|worker_threads|stream|zlib|http|https|net|tls|dns|cluster|v8|vm|readline|repl|tty|dgram|perf_hooks|async_hooks|timers|util|events|buffer|url|querystring|string_decoder|assert|constants|module|process)$/;

/** Node globals, bounded so `audioBuffer.getChannelData` is not a `Buffer.` hit. */
const NODE_GLOBAL =
    /(?:^|[^A-Za-z0-9_$.])(process\s*\.\s*(?:env|argv|cwd|exit|platform)|Buffer\s*\.|__dirname|__filename|globalThis\s*\.\s*process)/;

/** A test file. Tests in a browser tree run in Node under vitest, so Node is fair game there. */
const IS_TEST = /(?:^|\/)(?:__tests__|__mocks__)\//;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Inspect every tsconfig in the repo without printing. */
export function inspectTsconfigs({
    root,
    base: BASE = 'tsconfig.base.json',
    baseFlags = BASE_FLAGS,
    environmental = ENVIRONMENTAL,
    sections = SECTIONS,
    ignore = [],
    nodeTyped = [],
    browserProjects = [],
    browserSources = [],
    nonEmitting = [],
}: TsconfigsInput): TsconfigsInspection {
    const problems: GateFailure[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };

    const ignored = new Set([...DEFAULT_IGNORED, ...ignore]);
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const configs = new Map(listConfigs('.').map((rel) => [rel, parse(rel)]));
    const baseConfig = configs.get(BASE);

    if (baseConfig === undefined) {
        fail(
            BASE,
            'is missing',
            'It is the one file that decides what is checked. Every other rule here is about whether a project honours it.',
        );
        return { problems, projects: [], flagCount: Object.keys(baseFlags).length };
    }

    /** Configs that actually check code: not the base, not a `files: []` solution file. */
    const projects = [...configs].filter(([rel, cfg]) => rel !== BASE && cfg.options !== undefined);

    // ── 1. Every project extends the base, and the base wins ────────────────
    // Resolved, not spelled: tsc only warns on a missing `extends` target.
    for (const [rel, cfg] of projects) {
        const parents = cfg.data.extends === undefined ? [] : [cfg.data.extends].flat();
        const at = parents.findIndex((p) => resolveExtends(p, rel) === BASE);

        if (at === -1) {
            const spelled = parents.find((p) => p.endsWith(BASE));
            if (spelled !== undefined) {
                fail(
                    rel,
                    `extends "${spelled}", which does not resolve to ${BASE}`,
                    `From this file that path is ${path.relative(root, path.resolve(path.dirname(path.join(root, rel)), spelled))}, which is not a file. tsc warns and carries on, so the project silently checks nothing it names.`,
                );
            } else {
                fail(
                    rel,
                    `does not extend ${BASE}`,
                    'A project outside the base decides its own strictness, and the default is lax. Extend it, even to override one flag afterwards.',
                );
            }
        } else if (at !== parents.length - 1) {
            fail(
                rel,
                `extends ${BASE} at position ${at + 1} of ${parents.length}`,
                'Later entries win. A base ahead of a preset is overridden by it: the file names the strict config and compiles under the lax one, with nothing to show for it. Put the base last.',
            );
        }
    }

    // ── 2. The base holds every checking flag and no environment ────────────
    for (const [flag, strictValue] of Object.entries(baseFlags)) {
        const actual = baseConfig.options?.[flag];
        if (actual === undefined) {
            fail(
                BASE,
                `does not set \`${flag}\``,
                'Every checking rule lives here, so that turning one off is one visible edit rather than a value a workspace quietly never set.',
            );
        } else if (actual !== strictValue) {
            fail(
                BASE,
                `sets \`${flag}: ${JSON.stringify(actual)}\``,
                `The base carries the strict value (${strictValue}). A project that genuinely cannot hold this overrides it locally, with the reason next to it — rule 3.`,
            );
        }
    }
    for (const setting of environmental) {
        if (baseConfig.options?.[setting] !== undefined) {
            fail(
                BASE,
                `sets \`${setting}\``,
                'The base is checking rules only. A target, a lib or an emit path differs per project and each one records why it is what it is; a value here is one nobody chose and every project silently inherits.',
            );
        }
    }

    // ── 3. Weakening a base flag needs the reason written next to it ────────
    for (const [rel, cfg] of projects) {
        for (const flag of Object.keys(baseFlags)) {
            if (cfg.own[flag] === undefined || cfg.own[flag] === baseFlags[flag]) continue;
            if (!hasReason(cfg.raw, flag)) {
                fail(
                    rel,
                    `overrides \`${flag}: ${JSON.stringify(cfg.own[flag])}\` with no reason`,
                    'Relaxing an inherited check is a decision, and the next person reads the file, not the commit. Write what forces it and what would let it be removed.',
                );
            }
        }
    }

    // ── 4. A declared target names the same ES year as its lib ──────────────
    for (const [rel, cfg] of projects) {
        const { target, lib } = cfg.own;
        if (target === undefined) continue;
        if (lib === undefined) {
            fail(
                rel,
                `sets \`target: "${target}"\` with no \`lib\``,
                'Without one the library surface is inferred from the target, which is fine until the target moves and nothing says the two are meant to agree. State it.',
            );
        } else if (String(lib[0]).toLowerCase() !== String(target).toLowerCase()) {
            fail(
                rel,
                `targets ${target} but its lib starts at ${lib[0]}`,
                'A lib behind the target types the old standard library while the emit uses the new syntax; a lib ahead of it types methods the runtime floor does not have. The first lib entry is the ES year and must match.',
            );
        }
    }

    // ── 5. Every project declares `types` ───────────────────────────────────
    // The default is every hoisted `@types/*` package, not none.
    for (const [rel, cfg] of projects) {
        if (cfg.own.types === undefined) {
            fail(
                rel,
                'does not declare `types`',
                'Omitting it pulls in every hoisted `@types/*` package, so what is in scope is decided by the dependency tree. List what this project actually needs.',
            );
        }
    }
    for (const rel of nodeTyped) {
        const own = configs.get(rel)?.own;
        if (own !== undefined && JSON.stringify(own.types) !== JSON.stringify(['node'])) {
            fail(
                rel,
                `declares types ${JSON.stringify(own.types)}`,
                'A Node service takes `["node"]` and nothing else — no DOM lib, no test globals in the shipped program.',
            );
        }
    }

    // ── 6a. A browser project is not typed against Node ─────────────────────
    // `node` is allowed with a reason next to it, as in rule 3.
    for (const rel of browserProjects) {
        const cfg = configs.get(rel);
        if (cfg === undefined) continue;
        if ((cfg.own.types ?? []).includes('node') && !hasReason(cfg.raw, 'types')) {
            fail(
                rel,
                'declares `node` in `types` with no reason',
                'Everything a browser program may touch arrives over the network or the preload bridge. Typing Node globals in makes unreachable APIs compile. If something forces it, write what — and see `browserSources`, which checks what the code actually does.',
            );
        }
        const libs = cfg.own.lib ?? [];
        if (libs.some((entry) => !/^(es|dom)/i.test(String(entry)))) {
            fail(rel, `declares lib ${JSON.stringify(libs)}`, 'A browser program takes ES and DOM libraries only.');
        }
    }

    // ── 6b. Browser SOURCE does not touch Node ──────────────────────────────
    // A dependency's `/// <reference types="node" />` brings Node in without a declaration.
    for (const rel of walkFiles(root, browserSources, {
        match: /\.(?:vue|[cm]?tsx?)$/,
        exclude: (p) => IS_TEST.test(p) || TEST_FILE.test(p) || p.endsWith('.d.ts'),
    })) {
        const source = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
        for (const [, specifier = ''] of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
            if (NODE_BUILTIN.test(specifier)) {
                fail(
                    rel,
                    `imports the Node builtin "${specifier}"`,
                    'This file is bundled for a browser, where that module does not exist. It compiles, bundles to a broken chunk or a shim, and fails at runtime.',
                );
                break;
            }
        }
        const global = NODE_GLOBAL.exec(source);
        if (global !== null) {
            fail(
                `${rel}:${source.slice(0, global.index).split('\n').length}`,
                `uses the Node global \`${(global[1] ?? '').trim()}\``,
                "It is in scope only because a dependency's typings pulled @types/node into this program. There is no such value in a browser.",
            );
        }
    }

    // ── 6c. A source-only package never emits ───────────────────────────────
    for (const rel of nonEmitting) {
        const cfg = configs.get(rel);
        for (const setting of EMIT_SETTINGS) {
            if (cfg?.own[setting] !== undefined) {
                fail(
                    rel,
                    `sets \`${setting}\``,
                    'Nothing compiles this package, so an emit here produces a dist/ that is stale the moment it is written — and the first `exports` edit that points at it ships the stale copy.',
                );
            }
        }
    }

    // ── 7. Every project config is reached by a typecheck script ────────────
    const { reached, pointed } = reachableConfigs();

    for (const [rel] of projects) {
        if (!reached.has(rel)) {
            fail(
                rel,
                'is not reached by any typecheck script',
                'Add it to a `typecheck` script — `-p <file>`, or `-b <solution file>` if a project reference already leads to it. Rules 1 to 6 only constrain what a config says; nothing but a compiler run constrains whether it is true.',
            );
        }
    }

    // ── 8. A solution file is only ever run in build mode ───────────────────
    // Rule 7 trusts `-b` to follow references.
    for (const rel of pointed) {
        const cfg = configs.get(rel);
        if (cfg !== undefined && isSolution(cfg.data)) {
            fail(
                rel,
                'is a solution file run without `-b`',
                'It declares `files: []`, so under `-p` tsc has no input, checks not one line and exits 0 — the script reads as a typecheck of everything the file references and is a no-op. Only `-b`/`--build` follows `references`.',
            );
        }
    }

    // ── 9. Section dividers come from the known set, in order ───────────────
    for (const [rel, cfg] of configs) {
        let highest = -1;
        for (const { name, line } of sectionsOf(cfg.raw)) {
            const at = sections.indexOf(name);
            if (at === -1) {
                fail(
                    `${rel}:${line}`,
                    `unknown section divider "${name}"`,
                    `One of: ${sections.join(', ')}. A divider nobody else uses sorts nowhere and stops grouping anything.`,
                );
            } else if (at < highest) {
                fail(
                    `${rel}:${line}`,
                    `section "${name}" is out of order`,
                    `Dividers run in a fixed order so the same setting sits in the same place in every file: ${sections.join(' → ')}.`,
                );
            } else {
                highest = at;
            }
        }
    }

    return { problems, projects: projects.map(([rel]) => rel), flagCount: Object.keys(baseFlags).length };

    /** Every tsconfig in the repo, minus build output and dotted directories. */
    function listConfigs(rel: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
            const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) listConfigs(child, out);
            else if (/^tsconfig(\..+)?\.json$/.test(entry.name)) out.push(child);
        }
        return out;
    }

    /** A config as text and data: `options` includes ancestors, `own` is only this file (rules 3–6). */
    function parse(rel: string): ParsedConfig {
        const raw = read(rel);
        let data: TsconfigJson;
        try {
            data = JSON.parse(stripComments(raw));
        } catch (e) {
            fail(
                rel,
                `is not parseable JSON (${e instanceof Error ? e.message : String(e)})`,
                'tsc reads JSONC — comments are fine, a trailing comma is not.',
            );
            data = {};
        }
        return { raw, data, own: data.compilerOptions ?? {}, options: effective(rel, data) };
    }

    /** compilerOptions merged down the `extends` chain, nearest file winning. */
    function effective(rel: string, data: TsconfigJson, seen = new Set<string>()): CompilerOptions | undefined {
        if (seen.has(rel)) return {}; // cyclic extends: tsc's error to report, not ours
        seen.add(rel);

        let inherited: CompilerOptions = {};
        for (const specifier of data.extends === undefined ? [] : [data.extends].flat()) {
            const parent = resolveExtends(specifier, rel);
            if (parent === null) continue; // an unresolvable parent is tsc's complaint
            try {
                inherited = { ...inherited, ...effective(parent, JSON.parse(stripComments(read(parent))), seen) };
            } catch {
                continue;
            }
        }
        return data.compilerOptions === undefined && Object.keys(inherited).length === 0
            ? undefined
            : { ...inherited, ...(data.compilerOptions ?? {}) };
    }

    /** Resolve one `extends` entry to a repo-relative path, or null for a package outside the tree. */
    function resolveExtends(specifier: string, fromRel: string): string | null {
        if (!specifier.startsWith('.')) return null; // a published preset — not ours to check
        const abs = path.resolve(path.dirname(path.join(root, fromRel)), specifier);
        const hit = [abs, `${abs}.json`, path.join(abs, 'tsconfig.json')].find(
            (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
        );
        return hit === undefined ? null : path.relative(root, hit);
    }

    /** Is there a comment on this setting's line, or on the lines immediately above it? */
    function hasReason(raw: string, flag: string): boolean {
        const lines = raw.split('\n');
        const at = lines.findIndex((line) => new RegExp(`^\\s*"${flag}"\\s*:`).test(line));
        if (at === -1) return false;
        if (/\/\/|\/\*/.test((lines[at] ?? '').replace(new RegExp(`^\\s*"${flag}"\\s*:.*?(?=//|/\\*|$)`), '')))
            return true;

        for (let i = at - 1; i >= 0; i--) {
            const above = (lines[i] ?? '').trim();
            if (above === '') continue;
            // A section divider is a label, not a reason — keep walking past it.
            if (
                /^\/\*.*\*\/$/.test(above) &&
                sections.includes(above.replace(/^\/\*\s*|\s*\*\/$/g, '').split(' — ')[0] ?? '')
            )
                continue;
            return above.startsWith('//') || above.startsWith('*') || above.endsWith('*/');
        }
        return false;
    }

    /**
     * Single-line comment blocks, which is what a section divider is. A
     * multi-line block is prose about the setting under it and is left alone.
     */
    function sectionsOf(raw: string) {
        return raw
            .split('\n')
            .map((line, i) => ({ line: i + 1, text: line.trim() }))
            .filter(({ text }) => /^\/\*[^*].*\*\/$/.test(text))
            .map(({ line, text }) => ({
                line,
                name:
                    text
                        .replace(/^\/\*\s*|\s*\*\/$/g, '')
                        .split(' — ')[0]
                        ?.trim() ?? '',
            }));
    }

    /**
     * Configs a compiler is pointed at, from every `&&` segment of every script
     * (`-p`, `-b` plus references, or the default `tsconfig.json`). `pointed` is
     * the subset named without build mode, for rule 8.
     */
    function reachableConfigs() {
        const reached = new Set<string>();
        const pointed = new Set<string>();

        for (const dir of ['.', ...workspaceDirs()]) {
            const scripts: Record<string, string> = JSON.parse(read(path.join(dir, 'package.json'))).scripts ?? {};
            for (const segment of Object.values(scripts).flatMap((command) => command.split('&&'))) {
                const args = segment.trim().split(/\s+/);
                const at = args.findIndex((arg) => /^(?:vue-)?tsc$/.test(arg));
                if (at === -1) continue; // not a compiler run — `tsc-alias`, `tsx`, a path with tsc in it

                const flags = args.slice(at + 1);
                const building = flags.includes('-b') || flags.includes('--build');
                // Build mode reads its projects positionally; -p is the only form otherwise.
                const named = building
                    ? flags.filter((arg) => !arg.startsWith('-'))
                    : [/(?:-p|--project)\s+(\S+)/.exec(segment)?.[1]].filter((arg) => arg !== undefined);

                for (const specifier of named.length > 0 ? named : ['tsconfig.json']) {
                    const rel = toConfigPath(specifier, dir);
                    if (building) addWithReferences(rel, reached);
                    else {
                        reached.add(rel);
                        pointed.add(rel);
                    }
                }
            }
        }
        return { reached, pointed };
    }

    /** A `-b` root drags in everything it references, and everything those reference. */
    function addWithReferences(rel: string, out: Set<string>): void {
        if (out.has(rel)) return; // also the cycle guard; tsc reports a reference cycle itself
        out.add(rel);
        for (const { path: specifier } of configs.get(rel)?.data.references ?? []) {
            addWithReferences(toConfigPath(specifier, path.dirname(rel)), out);
        }
    }

    /** `-p`, `-b` and `references` all take a directory to mean the `tsconfig.json` inside it. */
    function toConfigPath(specifier: string, fromDir: string): string {
        const abs = path.resolve(root, fromDir, specifier);
        const file = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'tsconfig.json') : abs;
        return path.relative(root, file);
    }

    /** A config that holds no source of its own and exists only to point at others. */
    function isSolution(data: TsconfigJson): boolean {
        return Array.isArray(data.files) && data.files.length === 0 && (data.references ?? []).length > 0;
    }

    /** Workspaces, or none — a single-manifest repo declares no `workspaces` at all. */
    function workspaceDirs(): string[] {
        const workspaces: string[] = JSON.parse(read('package.json')).workspaces ?? [];
        return workspaces.filter((dir) => fs.existsSync(path.join(root, dir, 'package.json')));
    }
}

/** Run the gate and print. */
export function checkTsconfigs({ root = REPO_ROOT, ...rest }: TsconfigsOptions = {}): void {
    const report = createGateReport({ name: 'tsconfigs' });
    const { problems, projects, flagCount } = inspectTsconfigs({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary: `${projects.length} projects, each extending the base last, ${flagCount} checking flags owned by the base and nothing environmental, every override explained, every target matched to its lib, every project scoping its own \`types\` and reached by a compiler.`,
        notMachineChecked:
            'Whether a target is the right one for its runtime, whether an override is still needed, or whether the browser floor the bundler enforces matches what the frontend typechecks against.',
    });
}
