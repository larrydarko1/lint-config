/**
 * TypeScript programs over a repository, for the passes answered by the checker rather
 * than by reading text: one program per tsconfig that checks code, each resolving
 * imports with its own `paths`. A `.vue` file is read as its script blocks, at their
 * original offsets so line numbers are the file's own.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';

type TsconfigJson = { extends?: string | string[]; files?: string[] };

/** Build output and dependencies: never a project, and too big to walk. */
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'dist-electron', 'coverage']);

/** How a `.vue` file is shown to TypeScript: `<file>.vue.ts`, which never exists on disk. */
const VUE_SUFFIX = '.vue.ts';

/**
 * Every tsconfig that checks code: not a `files: []` solution file, and not a base
 * another config extends (a base usually has no `include`, which tsc reads as every
 * file under it — the whole repository).
 */
export function findProjects(root: string): string[] {
    const configs: string[] = [];
    const walk = (rel: string): void => {
        for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
            const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(child);
            else if (/^tsconfig(\..+)?\.json$/.test(entry.name)) configs.push(child);
        }
    };
    walk('');

    const data = new Map<string, TsconfigJson>();
    for (const rel of configs) {
        const { config, error } = ts.readConfigFile(path.join(root, rel), (f) => ts.sys.readFile(f));
        // Unparseable: the tsconfigs gate reports it; here it simply checks nothing.
        if (error === undefined) data.set(rel, config as TsconfigJson);
    }

    const extended = new Set<string>();
    for (const [rel, json] of data) {
        for (const parent of [json.extends ?? []].flat()) {
            if (!parent.startsWith('.')) continue; // a package preset, not a file in this repo
            extended.add(
                path
                    .relative(root, path.resolve(root, path.dirname(rel), parent))
                    .split(path.sep)
                    .join('/'),
            );
        }
    }
    return [...data]
        .filter(([rel, json]) => !extended.has(rel) && !(Array.isArray(json.files) && json.files.length === 0))
        .map(([rel]) => rel)
        .sort();
}

/** A tsconfig read the way tsc reads it, `.vue` files included in its file list. */
export function parseProject(root: string, project: string): ts.ParsedCommandLine {
    const configPath = path.join(root, project);
    const { config } = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
    return ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath, undefined, [
        { extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
    ]);
}

/** The program for a parsed project, each `.vue` file in it served as its script blocks. */
export function createProgram(parsed: ts.ParsedCommandLine): ts.Program {
    const options = { ...parsed.options, noEmit: true };
    const rootNames = parsed.fileNames.map((f) => (f.endsWith('.vue') ? `${f}.ts` : f));
    return ts.createProgram({ rootNames, options, host: vueAwareHost(options) });
}

/** The file on disk behind a program's file name: `X.vue` for the `X.vue.ts` it was shown as. */
export const realFile = (fileName: string): string =>
    fileName.endsWith(VUE_SUFFIX) ? fileName.slice(0, -3) : fileName;

/** An SFC's script blocks in place, everything else blanked so offsets and lines survive. */
function vueScript(vuePath: string): string {
    const source = fs.readFileSync(vuePath, 'utf8');
    const { descriptor } = parseSfc(source, { filename: vuePath });
    const blocks = [descriptor.script, descriptor.scriptSetup].filter((b) => b !== null);
    let out = source.replace(/[^\n]/g, ' ');
    for (const { loc } of blocks) {
        out =
            out.slice(0, loc.start.offset) + source.slice(loc.start.offset, loc.end.offset) + out.slice(loc.end.offset);
    }
    return out;
}

/**
 * A compiler host that serves each `.vue` file as `<file>.vue.ts`. An import of `./X.vue`
 * then resolves there by itself: bundler resolution appends `.ts` to a specifier whose
 * extension it does not know, which is the resolution every Vite project uses.
 */
function vueAwareHost(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options);
    const isVirtual = (f: string) => f.endsWith(VUE_SUFFIX);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (f) => (isVirtual(f) ? fs.existsSync(f.slice(0, -3)) : fileExists(f));
    host.getSourceFile = (f, language, ...rest) =>
        isVirtual(f)
            ? ts.createSourceFile(f, vueScript(f.slice(0, -3)), language, true, ts.ScriptKind.TS)
            : getSourceFile(f, language, ...rest);
    return host;
}
