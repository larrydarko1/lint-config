/**
 * One gate script, read as source: the gate it calls, the options it passes, and the
 * imports and `const`s those options use, or why the script is more than that.
 */
import path from 'node:path';

import ts from 'typescript';

import { GATES, type GateName } from '../../gates/registry.ts';
import { SELF_NAME } from '../../toolchain.ts';
import { bindingsOf, parseSource, valueOf, type Binding } from './config-source.ts';

export type GateScript = {
    file: string;
    gate: GateName;
    /** The call's argument as written, or null for a call with none. */
    options: string | null;
    /** The comments above the call, each on its own line, to go above the gate's entry. */
    comments: string;
    /** The script's imports its options use, with relative specifiers rebased on the root. */
    bindings: Binding[];
    /** The `const` statements its options use, in their order, each with the comments above it. */
    declarations: string[];
    /** The names those statements declare. */
    declared: string[];
};

/** Where every gate's module is, under this package's name. */
export const GATE_MODULE = `${SELF_NAME}/gates/`;

/** Whether a script's source imports a gate's own module: a helper under `gates/lib` is not one. */
export function importsGate(text: string): boolean {
    const modules = text.matchAll(new RegExp(`['"]${GATE_MODULE}([\\w/-]+)['"]`, 'g'));
    return [...modules].some(([, gate = '']) => isGate(gate));
}

/** A gate script reduced to its gate, options and imports, or why it is more than that. */
export function parseGateScript(file: string, text: string): GateScript | string {
    const source = parseSource(file, text);
    const bindings: Binding[] = [];
    const constants: ts.VariableStatement[] = [];
    const calls: [statement: ts.Statement, call: ts.CallExpression][] = [];
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            if (statement.importClause === undefined) return `it imports ${specifier} for what that runs`;
            bindings.push(...bindingsOf(statement, rebase(file, specifier)));
            continue;
        }
        if (calls.length === 0 && isPlainConst(statement)) {
            constants.push(statement);
            continue;
        }
        const call = ts.isExpressionStatement(statement) ? callIn(statement.expression) : undefined;
        if (call === undefined) return `line ${lineOf(statement)} does more than import a gate and call it`;
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
    if (argument !== undefined && usesImportMeta(argument)) {
        return 'its options use import.meta, which would mean larry.config.ts instead';
    }
    if (argument !== undefined && ts.isObjectLiteralExpression(argument) && valueOf(argument, 'root') !== undefined) {
        return 'it passes `root`, and `larry check` runs every gate from the repository root';
    }
    const named = argument === undefined ? new Set<string>() : identifiersIn(argument);
    // From the last `const` up, so one that only an earlier one's initializer uses is still kept.
    const kept: ts.VariableStatement[] = [];
    for (const constant of constants.toReversed()) {
        if (!namesOf(constant).some((name) => named.has(name))) {
            return `line ${lineOf(constant)} declares \`${namesOf(constant).join(', ')}\`, which its options do not use`;
        }
        if (usesImportMeta(constant)) {
            return `line ${lineOf(constant)} uses import.meta, which would mean larry.config.ts instead`;
        }
        identifiersIn(constant, named);
        kept.unshift(constant);
    }
    const declared = kept.flatMap(namesOf);
    return {
        file,
        gate,
        options: argument?.getText() ?? null,
        comments: commentsAbove(text, statement),
        bindings: bindings.filter(({ local }) => local !== callee && named.has(local) && !declared.includes(local)),
        declarations: kept.map((constant) => `${commentsAbove(text, constant)}${constant.getText()}`),
        declared,
    };
}

/** The comments above a statement, each on its own line. */
const commentsAbove = (text: string, statement: ts.Statement): string =>
    (ts.getLeadingCommentRanges(text, statement.pos) ?? []).map(({ pos, end }) => `${text.slice(pos, end)}\n`).join('');

/** `const` with a plain name and a value each, and nothing exported: a value the options can be built from. */
function isPlainConst(statement: ts.Statement): statement is ts.VariableStatement {
    return (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.modifiers === undefined &&
        statement.declarationList.declarations.every(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.initializer !== undefined,
        )
    );
}

const namesOf = (constant: ts.VariableStatement): string[] =>
    constant.declarationList.declarations.map(({ name }) => name.getText());

/** A relative specifier from `file`, as it reads from the root. */
function rebase(file: string, specifier: string): string {
    if (!specifier.startsWith('.')) return specifier;
    const fromRoot = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    return fromRoot.startsWith('../') ? fromRoot : `./${fromRoot}`;
}

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

/** Whether `node` reads `import.meta` or `__dirname`: where the script is, which larry.config.ts is not. */
const usesImportMeta = (node: ts.Node): boolean =>
    uses(node, (inner) => ts.isMetaProperty(inner) || (ts.isIdentifier(inner) && inner.text === '__dirname'));

const isGate = (name: string): name is GateName => Object.hasOwn(GATES, name);
