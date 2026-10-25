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
import path from 'node:path';

import ts from 'typescript';

import { createProgram, findProjects, parseProject, realFile } from './programs.ts';

/** One export only its own file names. `name` is what it is exported as. */
type LocalOnlyType = { file: string; name: string; line: number };

/**
 * @param root Repository root.
 * @param [projects] tsconfigs, relative to `root`. Defaults to `findProjects(root)`.
 * @returns Exported types and interfaces that only their own file names, in path order.
 */
export function findLocalOnlyTypes(root: string, projects: string[] = findProjects(root)): LocalOnlyType[] {
    const key = (file: string, name: string) => `${file}#${name}`;
    const inRepo = (file: string) => !path.relative(root, file).startsWith('..') && !file.includes('/node_modules/');

    /** Keyed by the declaration's own file and name, which is what a use resolves to. */
    const candidates = new Map<string, LocalOnlyType>();
    const used = new Set<string>();

    for (const project of projects) {
        const program = createProgram(parseProject(root, project));
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
                        if (declaration?.getSourceFile() !== sourceFile) continue;
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

const isTypeDeclaration = (node: ts.Node): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
    ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node);

const hasExportKeyword = (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): boolean =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/** `/** @public *\/` opts a type out, the same tag knip honours for every other export. */
const isPublic = (node: ts.Node): boolean => ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'public');

/** The name in `export { X } from './x'` passes the type along; it is not a use of it. */
const isReExport = (id: ts.Identifier): boolean =>
    ts.isExportSpecifier(id.parent) && id.parent.parent.parent.moduleSpecifier !== undefined;
