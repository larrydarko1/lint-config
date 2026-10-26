/**
 * Reading and editing larry.config.ts as source, with the TypeScript compiler. A migration
 * changes only the spans it means to, so the rest of the file, its comments included,
 * stays as the project wrote it.
 */
import ts from 'typescript';

/** Replace `start` to `end` with `text`. */
export type Edit = { start: number; end: number; text: string };

/** An import binding: `imported` is `default` for a default import and `*` for a namespace one. */
export type Binding = { local: string; imported: string; module: string; typeOnly: boolean };

type ConfigSource = {
    source: ts.SourceFile;
    /** The `gates` object of the default export, or null when the file is not `defineConfig({ …, gates: { … } })`. */
    gates: ts.ObjectLiteralExpression | null;
    /** The `family` the file names, when it is a string. */
    family: string | undefined;
};

export function parseSource(file: string, text: string): ts.SourceFile {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function parseConfig(file: string, text: string): ConfigSource {
    const source = parseSource(file, text);
    const exported = source.statements.find(ts.isExportAssignment)?.expression;
    let config = exported === undefined ? undefined : unwrap(exported);
    if (config !== undefined && ts.isCallExpression(config) && config.arguments[0] !== undefined) {
        config = unwrap(config.arguments[0]);
    }
    if (config === undefined || !ts.isObjectLiteralExpression(config))
        return { source, gates: null, family: undefined };
    const gates = valueOf(config, 'gates');
    const family = valueOf(config, 'family');
    return {
        source,
        gates: gates !== undefined && ts.isObjectLiteralExpression(gates) ? gates : null,
        family: family !== undefined && ts.isStringLiteralLike(family) ? family.text : undefined,
    };
}

/** A property's name, when it is written as a name or a string. */
export function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
    const { name } = property;
    if (name === undefined) return undefined;
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** The value of the property called `name`, without any `as` or `satisfies` around it. */
export function valueOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const property = object.properties.find((p) => propertyName(p) === name);
    return property !== undefined && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
}

/** Each import binding in `source`, keyed by its local name. */
export function importsOf(source: ts.SourceFile): Map<string, Binding> {
    const bindings = new Map<string, Binding>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        for (const binding of bindingsOf(statement, statement.moduleSpecifier.text))
            bindings.set(binding.local, binding);
    }
    return bindings;
}

/** What an import declaration binds, with `module` as the specifier to record. */
export function bindingsOf(declaration: ts.ImportDeclaration, module: string): Binding[] {
    const clause = declaration.importClause;
    if (clause === undefined) return [];
    const typeOnly = isTypeOnly(clause);
    const bindings: Binding[] = [];
    if (clause.name !== undefined) bindings.push({ local: clause.name.text, imported: 'default', module, typeOnly });
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) {
        bindings.push({ local: named.name.text, imported: '*', module, typeOnly });
    } else if (named !== undefined) {
        for (const element of named.elements) {
            bindings.push({
                local: element.name.text,
                imported: (element.propertyName ?? element.name).text,
                module,
                typeOnly: typeOnly || element.isTypeOnly,
            });
        }
    }
    return bindings;
}

/**
 * Edits that import `bindings` into `source`. A named binding joins the file's import
 * from the same module when it has one, so the result has one import per module. A new
 * import goes in its group: Node's built-ins first, then packages, then relative paths.
 */
export function importEdits(source: ts.SourceFile, bindings: Binding[]): Edit[] {
    const declarations = source.statements.filter(ts.isImportDeclaration);
    const edits: Edit[] = [];
    const statements: [module: string, text: string][] = [];

    for (const module of new Set(bindings.map((binding) => binding.module))) {
        const own = bindings.filter((binding) => binding.module === module);
        const named = own.filter(({ imported }) => imported !== 'default' && imported !== '*');
        const last = declarations
            .map(({ moduleSpecifier, importClause }) =>
                ts.isStringLiteral(moduleSpecifier) &&
                moduleSpecifier.text === module &&
                importClause !== undefined &&
                !isTypeOnly(importClause) &&
                importClause.namedBindings !== undefined &&
                ts.isNamedImports(importClause.namedBindings)
                    ? importClause.namedBindings.elements.at(-1)
                    : undefined,
            )
            .find((element) => element !== undefined);
        if (last !== undefined && named.length > 0) {
            edits.push({ start: last.end, end: last.end, text: named.map((b) => `, ${specifier(b)}`).join('') });
        } else if (named.length > 0) {
            statements.push([module, `import { ${named.map(specifier).join(', ')} } from '${module}';`]);
        }
        for (const binding of own.filter(({ imported }) => imported === 'default' || imported === '*')) {
            const type = binding.typeOnly ? 'type ' : '';
            const name = binding.imported === '*' ? `* as ${binding.local}` : binding.local;
            statements.push([module, `import ${type}${name} from '${module}';`]);
        }
    }
    const group = (module: string): number => {
        if (module.startsWith('node:')) return 0;
        return module.startsWith('.') ? 2 : 1;
    };
    const ordered = statements.sort(([a], [b]) => group(a) - group(b));
    const builtins = ordered.filter(([module]) => group(module) === 0).map(([, text]) => text);
    const others = ordered.filter(([module]) => group(module) > 0).map(([, text]) => text);
    const first = declarations[0]?.getStart() ?? 0;
    const after = declarations.at(-1)?.end ?? 0;
    if (builtins.length > 0) edits.push({ start: first, end: first, text: `${builtins.join('\n')}\n\n` });
    if (others.length > 0) edits.push({ start: after, end: after, text: `\n${others.join('\n')}\n` });
    return edits;
}

/** `text` with each edit made. The edits must not overlap. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
    return [...edits]
        .sort((a, b) => b.start - a.start)
        .reduce(
            (result, { start, end, text: replacement }) => result.slice(0, start) + replacement + result.slice(end),
            text,
        );
}

/** The names a statement declares at a module's top level, imports aside. */
export function topLevelNames(statement: ts.Statement): string[] {
    if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.flatMap(({ name }) => (ts.isIdentifier(name) ? [name.text] : []));
    }
    const named =
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement);
    return named && statement.name !== undefined ? [statement.name.text] : [];
}

/** `name` as an object key: bare when it can be, quoted when not. */
export const asKey = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);

function specifier({ local, imported, typeOnly }: Binding): string {
    return `${typeOnly ? 'type ' : ''}${imported === local ? local : `${imported} as ${local}`}`;
}

/** `import type …` as a whole, as against `type` on one name inside the braces. */
const isTypeOnly = (clause: ts.ImportClause): boolean => clause.phaseModifier === ts.SyntaxKind.TypeKeyword;

function unwrap(expression: ts.Expression): ts.Expression {
    let inner = expression;
    while (ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
    }
    return inner;
}
