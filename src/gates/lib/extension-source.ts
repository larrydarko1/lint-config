/**
 * What an editor extension's source does with the VS Code API, read from its syntax: the
 * command and view ids it registers, the settings it reads and the default it reads each
 * with, the API it calls that no gate checks yet, and what its entry exports. An id passed
 * through a local helper, `command('a.run', run)` calling `registerCommand(name, …)`, is
 * followed one hop to the literal at the helper's call; one the gate cannot follow is
 * reported as such, never guessed.
 */
import ts from 'typescript';

/** One place in the source, and what it names. */
export type SourceSite = { name: string; at: string };

/** A setting read: its full key, and the literal it falls back to when one is passed. */
type SettingRead = SourceSite & { fallback?: unknown };

type ExtensionSource = {
    commands: SourceSite[];
    views: SourceSite[];
    settings: SettingRead[];
    /** Registrations and reads whose id is not a literal, even one hop away. */
    unread: SourceSite[];
    /** Calls into the API no gate checks yet: webviews and translated strings. */
    unchecked: SourceSite[];
};

type Kind = 'commands' | 'views';

const REGISTRARS: Record<string, Kind> = {
    registerCommand: 'commands',
    registerTextEditorCommand: 'commands',
    registerTreeDataProvider: 'views',
    createTreeView: 'views',
};

/** The API a webview or a translated string goes through. */
const UNCHECKED = new Set([
    'createWebviewPanel',
    'registerWebviewViewProvider',
    'registerWebviewPanelSerializer',
    'registerCustomEditorProvider',
]);

/** @param files Each source file's path from the repository root, and its text. */
export function readExtensionSource(files: { rel: string; text: string }[]): ExtensionSource {
    const found: ExtensionSource = { commands: [], views: [], settings: [], unread: [], unchecked: [] };
    for (const { rel, text } of files) {
        readFile(ts.createSourceFile(rel, text, ts.ScriptTarget.ES2024, true), found);
    }
    return found;
}

/** The names a module exports, `default` included. */
export function exportedNames(rel: string, text: string): string[] {
    const file = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2024, true);
    return file.statements.flatMap((statement): string[] => {
        if (ts.isExportAssignment(statement)) return ['default'];
        if (ts.isExportDeclaration(statement)) {
            const clause = statement.exportClause;
            return clause !== undefined && ts.isNamedExports(clause)
                ? clause.elements.map((el) => el.name.text)
                : ['*'];
        }
        const exported = ts.canHaveModifiers(statement)
            ? (ts.getModifiers(statement) ?? []).some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
            : false;
        if (!exported) return [];
        if (ts.isVariableStatement(statement)) {
            return statement.declarationList.declarations.map((d) => d.name.getText());
        }
        const named =
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isEnumDeclaration(statement);
        return named && statement.name !== undefined ? [statement.name.text] : [];
    });
}

function readFile(file: ts.SourceFile, found: ExtensionSource): void {
    const at = (node: ts.Node): string =>
        `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    /** A parameter an id arrives through, to be read at each call of the helper that has it. */
    const hops: { helper: string; index: number; kind: Kind; site: string }[] = [];
    const calls: ts.CallExpression[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            calls.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);

    for (const call of calls) {
        const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
        if (method === null) continue;
        const kind = REGISTRARS[method];
        const [first] = call.arguments;
        if (kind !== undefined && first !== undefined) {
            const literal = stringOf(first);
            const hop = literal === undefined ? parameterHop(first) : null;
            if (literal !== undefined) {
                found[kind].push({ name: literal, at: at(call) });
            } else if (hop === null) {
                found.unread.push({ name: method, at: at(call) });
            } else {
                hops.push({ ...hop, kind, site: at(call) });
            }
        }
        if (UNCHECKED.has(method)) {
            found.unchecked.push({ name: method, at: at(call) });
        }
        if (isL10nCall(call)) {
            found.unchecked.push({ name: 'l10n.t', at: at(call) });
        }
        if (method === 'get') {
            readSetting(call, file, at, found);
        }
    }

    for (const { helper, index, kind, site } of hops) {
        const ids = calls
            .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === helper)
            .map((call) => ({
                id: call.arguments[index] === undefined ? undefined : stringOf(call.arguments[index]),
                call,
            }));
        if (ids.length === 0 || ids.some(({ id }) => id === undefined)) {
            found.unread.push({ name: helper, at: site });
        }
        for (const { id, call } of ids) {
            if (id !== undefined) {
                found[kind].push({ name: id, at: at(call) });
            }
        }
    }
}

/** `settings.get('key', fallback)`, where `settings` is `getConfiguration('section')`, directly or through a `const`. */
function readSetting(
    call: ts.CallExpression,
    file: ts.SourceFile,
    at: (node: ts.Node) => string,
    found: ExtensionSource,
): void {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    const section = configurationSection(call.expression.expression, file);
    if (section === null) return;
    const [keyArg, fallbackArg] = call.arguments;
    const key = keyArg === undefined ? undefined : literalOf(keyArg);
    if (section === undefined || typeof key !== 'string') {
        found.unread.push({ name: 'get', at: at(call) });
        return;
    }
    const name = section === '' ? key : `${section}.${key}`;
    found.settings.push({
        name,
        at: at(call),
        ...(fallbackArg === undefined ? {} : { fallback: literalOf(fallbackArg) }),
    });
}

/** The section a `getConfiguration` call names: null when the object is not one, undefined when unreadable. */
function configurationSection(object: ts.Expression, file: ts.SourceFile): string | null | undefined {
    let target: ts.Expression = object;
    if (ts.isIdentifier(object)) {
        const declaration = findConst(file, object.text);
        if (declaration?.initializer === undefined) return null;
        target = declaration.initializer;
    }
    if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression)) return null;
    if (target.expression.name.text !== 'getConfiguration') return null;
    const [sectionArg] = target.arguments;
    if (sectionArg === undefined) return '';
    const section = literalOf(sectionArg);
    return typeof section === 'string' ? section : undefined;
}

function findConst(file: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
    let match: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
            match = node;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return match;
}

/** The parameter of the enclosing named function an id arrives through, or null when it does not. */
function parameterHop(argument: ts.Expression): { helper: string; index: number } | null {
    if (!ts.isIdentifier(argument)) return null;
    const scope = ts.findAncestor(argument.parent, ts.isFunctionLike);
    if (scope === undefined) return null;
    const index = scope.parameters.findIndex((param) => param.name.getText() === argument.text);
    const helper = functionName(scope);
    return index === -1 || helper === null ? null : { helper, index };
}

function functionName(fn: ts.SignatureDeclaration): string | null {
    if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
    const { parent } = fn;
    return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

/** `vscode.l10n.t(…)`, and `l10n.t(…)` from a named import. */
function isL10nCall(call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 't') return false;
    const object = callee.expression;
    return (
        (ts.isPropertyAccessExpression(object) && object.name.text === 'l10n') ||
        (ts.isIdentifier(object) && object.text === 'l10n')
    );
}

/** A string literal's text; undefined for anything else. */
function stringOf(node: ts.Expression): string | undefined {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** A string, number, boolean or null literal's value; undefined for anything else. */
function literalOf(node: ts.Expression): unknown {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    return undefined;
}
