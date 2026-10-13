/**
 * Bridge members the renderer never uses — the first link of renderer → preload → handler,
 * the one nothing else checks. The preload calls every channel it exposes and main handles
 * every channel the preload calls, so a bridge method no screen uses keeps the whole chain
 * looking alive: to the IPC rules, to knip, and to the tests that call it through a mock.
 *
 * Answered by the TypeScript checker, not by searching for names: `kata.get` and a
 * `history.get` are both `get`, and a use reaches the contract through aliases
 * (`const api = window.electronAPI`) and destructuring (`const { kata } = api`) that a
 * text search cannot follow. A member counts as used when a renderer file reads it, or when
 * an object holding it leaves the checker's sight — passed to a function, returned, stored
 * in another object — because what happens to it there is not this pass's to see.
 * - Only code under the renderer directories counts, and not their test files: a test that
 * calls a method through a mock does not wire it to anything.
 * - Only expressions count. `typeof window.electronAPI.kata.get` in a type is not a call.
 * - A `.vue` file is read as its script blocks. A member used only from a `<template>` is
 * not seen; reach the bridge from script, which is where a composable would hold it anyway.
 */
import path from 'node:path';

import ts from 'typescript';

import { createProgram, findProjects, parseProject, realFile } from './programs.ts';

/** One leaf of the contract — a method or value the renderer can read — that nothing reads. */
export type UnusedBridgeMember = { member: string; file: string; line: number };

export type BridgeReachability = {
    /** Every leaf of the contract, by dotted path. */
    members: number;
    unused: UnusedBridgeMember[];
    /** False when no tsconfig both reaches the contract type and holds a renderer file. */
    covered: boolean;
};

type BridgeReachabilityInput = {
    root: string;
    contract: string;
    contractType: string;
    /** Directories, relative to `root`, whose code is the renderer. */
    renderer: string[];
    /** tsconfigs, relative to `root`. Defaults to `findProjects(root)`. */
    projects?: string[];
};

type Fern = { file: string; line: number };

/** Objects nested deeper than this are taken as data, not API: nobody namespaces a bridge five deep. */
const MAX_DEPTH = 4;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:test|spec)\.vue$/;

export function findUnusedBridgeMembers({
    root,
    contract,
    contractType,
    renderer,
    projects = findProjects(root),
}: BridgeReachabilityInput): BridgeReachability {
    const contractPath = path.join(root, contract);
    const rendererDirs = renderer.map((dir) => path.join(root, dir) + path.sep);
    const isRendererFile = (file: string) =>
        rendererDirs.some((dir) => file.startsWith(dir)) && !TEST_FILE.test(file) && !file.endsWith('.d.ts');

    /** Pooled across programs by dotted path: each program has its own nodes. */
    const leaves = new Map<string, Fern>();
    const used = new Set<string>();
    let covered = false;

    for (const project of projects) {
        const parsed = parseProject(root, project);
        // Building a program is the expensive part; most projects hold no renderer file at all.
        if (!parsed.fileNames.some((f) => isRendererFile(path.resolve(f)))) continue;
        const program = createProgram(parsed);
        const checker = program.getTypeChecker();

        const contractFile = program.getSourceFile(contractPath);
        const declaration = contractFile?.statements.find(
            (s): s is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
                (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === contractType,
        );
        const symbol = declaration === undefined ? undefined : checker.getSymbolAtLocation(declaration.name);
        if (symbol === undefined) continue;
        covered = true;

        // ── The contract, as a tree of dotted paths ──────────────────────────
        /** A member's declaration → its path. */
        const memberPaths = new Map<ts.Declaration, string>();
        /** An object type in the contract (or its declaration) → the path holding it; '' is the root. */
        const objectPaths = new Map<ts.Type | ts.Declaration, string>();
        const rememberObject = (type: ts.Type, at: string): void => {
            objectPaths.set(type, at);
            const typeDeclaration = type.getSymbol()?.declarations?.[0];
            if (typeDeclaration !== undefined) objectPaths.set(typeDeclaration, at);
        };
        const walk = (type: ts.Type, prefix: string, depth: number): void => {
            for (const property of type.getProperties()) {
                const member = prefix === '' ? property.name : `${prefix}.${property.name}`;
                const memberDeclaration = property.valueDeclaration ?? property.declarations?.[0];
                if (memberDeclaration === undefined) continue;
                memberPaths.set(memberDeclaration, member);
                const memberType = checker.getNonNullableType(checker.getTypeOfSymbol(property));
                const isNamespace =
                    depth < MAX_DEPTH &&
                    memberType.getCallSignatures().length === 0 &&
                    (memberType.flags & ts.TypeFlags.Object) !== 0 &&
                    memberType.getProperties().length > 0;
                if (isNamespace) {
                    rememberObject(memberType, member);
                    walk(memberType, member, depth + 1);
                } else {
                    const source = memberDeclaration.getSourceFile();
                    leaves.set(member, {
                        file: path.relative(root, realFile(source.fileName)).split(path.sep).join('/'),
                        line: source.getLineAndCharacterOfPosition(memberDeclaration.getStart(source)).line + 1,
                    });
                }
            }
        };
        const contractTypeObject = checker.getDeclaredTypeOfSymbol(symbol);
        rememberObject(contractTypeObject, '');
        walk(contractTypeObject, '', 0);

        // ── Uses ─────────────────────────────────────────────────────────────
        const markSymbol = (property: ts.Symbol | undefined): void => {
            for (const d of property?.declarations ?? []) {
                const member = memberPaths.get(d);
                if (member !== undefined) used.add(member);
            }
        };
        /** Everything under `prefix` counts: an object holding it went where the checker cannot follow. */
        const markSubtree = (type: ts.Type): void => {
            const prefix =
                objectPaths.get(type) ??
                (type.getSymbol()?.declarations ?? []).map((d) => objectPaths.get(d)).find((p) => p !== undefined);
            if (prefix === undefined) return;
            for (const member of memberPaths.values()) {
                if (prefix === '' || member === prefix || member.startsWith(`${prefix}.`)) used.add(member);
            }
        };

        for (const sourceFile of program.getSourceFiles()) {
            if (!isRendererFile(realFile(sourceFile.fileName))) continue;
            const visit = (node: ts.Node): void => {
                if (ts.isTypeNode(node)) return;
                if (ts.isPropertyAccessExpression(node)) {
                    markSymbol(checker.getSymbolAtLocation(node.name));
                } else if (ts.isElementAccessExpression(node)) {
                    markSymbol(checker.getSymbolAtLocation(node.argumentExpression));
                } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
                    const parentType = checker.getTypeAtLocation(node.parent);
                    if (node.dotDotDotToken !== undefined) {
                        markSubtree(parentType);
                    } else {
                        const key = node.propertyName ?? node.name;
                        if (ts.isIdentifier(key) || ts.isStringLiteral(key))
                            markSymbol(parentType.getProperty(key.text));
                    }
                }
                if (ts.isExpression(node) && escapes(node)) markSubtree(checker.getTypeAtLocation(node));
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }
    }

    const unused = [...leaves]
        .filter(([member]) => !used.has(member))
        .map(([member, at]) => ({ member, ...at }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { members: leaves.size, unused, covered };
}

/**
 * Is `node` in a position where the value leaves the checker's sight — handed on rather
 * than read? A variable initializer is not one: the checker follows the alias itself.
 */
function escapes(node: ts.Expression): boolean {
    let child: ts.Node = node;
    let parent = node.parent;
    // `(api)` and `api!` are the same value in the position around them.
    while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
        child = parent;
        parent = parent.parent;
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
        return parent.arguments?.includes(child as ts.Expression) ?? false;
    if (ts.isArrowFunction(parent)) return parent.body === child;
    if (ts.isPropertyAssignment(parent)) return parent.initializer === child;
    if (ts.isBinaryExpression(parent)) {
        return parent.right === child && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    }
    return (
        ts.isReturnStatement(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isExportAssignment(parent)
    );
}
