/**
 * Exported types that no OTHER file names — the case knip counts as used. knip treats an
 * exported type as alive whenever it appears in the signature of another export that is
 * used (`export type UseXReturn` as the return type of an imported `useX()`), because a
 * caller receives the shape. It has no option to turn that off. But receiving a shape is
 * not naming it: if no other file writes the name, the `export` is only noise, and it
 * reads as a contract other code depends on.
 *
 * Answered by the TypeScript checker, not by searching for names: two files may each
 * declare a different `Props`, and a name search counts one as a use of the other. Every
 * tsconfig that checks code gets its own program, so each file resolves imports with its
 * own `paths`; uses from all of them are pooled, because a type in a shared package is
 * usually named only from another workspace. A `.vue` file is read as its script blocks,
 * at their original offsets so line numbers are the file's own.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';

/** One export only its own file names. `name` is what it is exported as. */
export type LocalOnlyType = { file: string; name: string; line: number };

/** Build output and dependencies: never a project, and too big to walk. */
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'dist-electron', 'coverage']);

/** How a `.vue` file is shown to TypeScript: `<file>.vue.ts`, which never exists on disk. */
const VUE_SUFFIX = '.vue.ts';

type TsconfigJson = { extends?: string | string[]; files?: string[] };

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
    const { fileExists, getSourceFile } = host;
    host.fileExists = (f) => (isVirtual(f) ? fs.existsSync(f.slice(0, -3)) : fileExists.call(host, f));
    host.getSourceFile = (f, language, ...rest) =>
        isVirtual(f)
            ? ts.createSourceFile(f, vueScript(f.slice(0, -3)), language, true, ts.ScriptKind.TS)
            : getSourceFile.call(host, f, language, ...rest);
    return host;
}

const isTypeDeclaration = (node: ts.Node): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
    ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node);

const hasExportKeyword = (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): boolean =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/** `/** @public *\/` opts a type out, the same tag knip honours for every other export. */
const isPublic = (node: ts.Node): boolean => ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'public');

/** The name in `export { X } from './x'` passes the type along; it is not a use of it. */
const isReExport = (id: ts.Identifier): boolean =>
    ts.isExportSpecifier(id.parent) && id.parent.parent.parent.moduleSpecifier !== undefined;

/**
 * @param root Repository root.
 * @param [projects] tsconfigs, relative to `root`. Defaults to `findProjects(root)`.
 * @returns Exported types and interfaces that only their own file names, in path order.
 */
export function findLocalOnlyTypes(root: string, projects: string[] = findProjects(root)): LocalOnlyType[] {
    const realFile = (fileName: string) => (fileName.endsWith(VUE_SUFFIX) ? fileName.slice(0, -3) : fileName);
    const key = (file: string, name: string) => `${file}#${name}`;
    const inRepo = (file: string) => !path.relative(root, file).startsWith('..') && !file.includes('/node_modules/');

    /** Keyed by the declaration's own file and name, which is what a use resolves to. */
    const candidates = new Map<string, LocalOnlyType>();
    const used = new Set<string>();

    for (const project of projects) {
        const configPath = path.join(root, project);
        const { config } = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
        const parsed = ts.parseJsonConfigFileContent(
            config,
            ts.sys,
            path.dirname(configPath),
            undefined,
            configPath,
            undefined,
            [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }],
        );
        const options = { ...parsed.options, noEmit: true };
        const rootNames = parsed.fileNames.map((f) => (f.endsWith('.vue') ? `${f}.ts` : f));
        const program = ts.createProgram({ rootNames, options, host: vueAwareHost(options) });
        const checker = program.getTypeChecker();

        for (const sourceFile of program.getSourceFiles()) {
            if (!inRepo(sourceFile.fileName)) continue;
            const file = realFile(sourceFile.fileName);
            const rel = path.relative(root, file).split(path.sep).join('/');
            const lineOf = (node: ts.Node) =>
                sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

            // Candidates: `export type X`, `export interface X`, and `export { X }` of a local one.
            // A declaration file is never one, but the names it writes are uses like any other.
            for (const statement of sourceFile.isDeclarationFile ? [] : sourceFile.statements) {
                if (isTypeDeclaration(statement) && hasExportKeyword(statement) && !isPublic(statement)) {
                    const { text } = statement.name;
                    candidates.set(key(file, text), { file: rel, name: text, line: lineOf(statement.name) });
                } else if (
                    ts.isExportDeclaration(statement) &&
                    statement.moduleSpecifier === undefined &&
                    statement.exportClause !== undefined &&
                    ts.isNamedExports(statement.exportClause) &&
                    !isPublic(statement)
                ) {
                    for (const element of statement.exportClause.elements) {
                        const local = checker.getExportSpecifierLocalTargetSymbol(element);
                        const declaration = local?.declarations?.find(isTypeDeclaration);
                        if (declaration === undefined || declaration.getSourceFile() !== sourceFile) continue;
                        candidates.set(key(file, declaration.name.text), {
                            file: rel,
                            name: element.name.text,
                            line: lineOf(element),
                        });
                    }
                }
            }

            // Uses: every name here that resolves, through any imports, to a type declared elsewhere.
            const visit = (node: ts.Node): void => {
                if (ts.isIdentifier(node) && !isReExport(node)) {
                    let symbol = checker.getSymbolAtLocation(node);
                    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
                        symbol = checker.getAliasedSymbol(symbol);
                    }
                    for (const declaration of symbol?.declarations ?? []) {
                        if (!isTypeDeclaration(declaration)) continue;
                        const declaredIn = realFile(declaration.getSourceFile().fileName);
                        if (declaredIn !== file) used.add(key(declaredIn, declaration.name.text));
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }
    }

    return [...candidates]
        .filter(([k]) => !used.has(k))
        .map(([, hit]) => hit)
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
