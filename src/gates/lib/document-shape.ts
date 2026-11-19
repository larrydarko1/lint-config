/**
 * One collection's document shape, its TypeScript type, held to the two places that
 * describe it in prose: its table in the architecture doc and its example documents.
 * The database drift gate runs it once per collection.
 */
import { toRecord } from './json.ts';
import { collectFailures, type GateFailure } from './report.ts';

/** Where a collection's shape is declared and documented, with each file's text. */
type ShapeSources = {
    /** The registry, blamed when a collection is mapped to no type. */
    manifest: string;
    collectionTypes: Record<string, string>;
    typesFile: string;
    types: string;
    architecture: string;
    doc: string;
};

type Shape = { typeName: string; open: boolean; declared: Set<string>; required: string[] };

/** Rule 6 for one collection: its doc table and every example document list exactly its type's fields. */
export function collectionShapeProblems(
    collection: string,
    sources: ShapeSources,
    examples: { rel: string; source: string }[],
): GateFailure[] {
    const { problems, fail } = collectFailures();
    const typeName = sources.collectionTypes[collection];
    if (typeName === undefined) {
        fail(
            sources.manifest,
            `'${collection}' has no entry in collectionTypes`,
            'Point it at the type that declares its document shape, so its docs and its example can be checked against something rather than trusted.',
        );
        return problems;
    }

    const type = typeFields(sources.types, typeName);
    if (type === null) {
        fail(
            sources.typesFile,
            `has no "type ${typeName} = { … }"`,
            `'${collection}' is mapped to a type that does not exist, so nothing has been checking its docs or its example.`,
        );
        return problems;
    }

    const shape: Shape = {
        typeName,
        open: type.open,
        declared: new Set(type.fields.map((field) => field.name).filter((name) => name !== '_id')),
        required: type.fields.filter((field) => !field.optional && field.name !== '_id').map((field) => field.name),
    };
    const documented = documentedFields(sources.doc, collection);
    if (documented !== null) {
        problems.push(...tableProblems(sources.architecture, collection, shape, documented));
    }
    return [...problems, ...examples.flatMap(({ rel, source }) => exampleProblems(rel, source, shape))];
}

function tableProblems(architecture: string, collection: string, shape: Shape, documented: string[]): GateFailure[] {
    const { problems, fail } = collectFailures();
    const { typeName, declared } = shape;
    for (const field of [...declared].filter((name) => !documented.includes(name))) {
        fail(
            architecture,
            `the '${collection}' table is missing \`${field}\`, which is a field of ${typeName}`,
            'A doc that is missing half a schema is read as if it were the whole of it.',
        );
    }
    for (const field of documented.filter((name) => name !== '_id' && !declared.has(name))) {
        fail(
            architecture,
            `the '${collection}' table documents \`${field}\`, which is not a field of ${typeName}`,
            'This is how a schema doc becomes fiction: nothing removed the row when the field went.',
        );
    }
    for (const field of new Set(documented.filter((f, i) => documented.indexOf(f) !== i))) {
        fail(
            architecture,
            `the '${collection}' table lists \`${field}\` more than once`,
            'Two rows for one field means one of them is stale, and a reader has no way to tell which.',
        );
    }
    return problems;
}

function exampleProblems(rel: string, source: string, shape: Shape): GateFailure[] {
    const { problems, fail } = collectFailures();
    const { typeName, declared } = shape;
    let example: Record<string, unknown>;
    try {
        example = toRecord(JSON.parse(source));
    } catch (err) {
        fail(
            rel,
            `is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
            'An example nothing can parse is an example nothing has checked.',
        );
        return problems;
    }

    const keys = Object.keys(example);
    for (const key of shape.open ? [] : keys.filter((name) => name !== '_id' && !declared.has(name))) {
        fail(
            rel,
            `has \`${key}\`, which is not a field of ${typeName}`,
            'The example documents a schema that does not exist, which is worse than having no example: a reader copies it.',
        );
    }
    for (const field of shape.required.filter((name) => !keys.includes(name))) {
        fail(
            rel,
            `is missing \`${field}\`, which ${typeName} declares as required`,
            'Every real document has it, so an example without it is not an example of a real document.',
        );
    }
    return problems;
}

/** The top-level fields of `type Name = { … }`, brace-counted, ignoring anything nested. */
function typeFields(
    source: string,
    typeName: string,
): { open: boolean; fields: { name: string; optional: boolean }[] } | null {
    const opener = new RegExp(String.raw`^\s*(?:export\s+)?type ${typeName}\s*=\s*\{`, 'm').exec(source);
    if (opener === null) return null;

    let depth = 1;
    let top = '';
    for (let i = opener.index + opener[0].length; i < source.length && depth > 0; i++) {
        const ch = source[i];
        if (ch === '{') {
            if (depth === 1) {
                top += ch;
            }
            depth++;
        } else if (ch === '}') {
            depth--;
        } else if (depth === 1) {
            top += ch;
        }
    }

    const code = top.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return {
        // An index signature allows extra example keys.
        open: /\[\s*\w+\s*:\s*string\s*\]\s*:/.test(code),
        fields: [...code.matchAll(/(?:^|[;\n{])\s*(\w+)(\??)\s*:/g)].map((m) => ({
            name: m[1] ?? '',
            optional: m[2] === '?',
        })),
    };
}

/**
 * The field names listed in the `#### Collection` table of the architecture doc.
 *
 * @returns Null when the collection has no section at all.
 */
function documentedFields(doc: string, collection: string): string[] | null {
    const start = doc.indexOf(`#### ${collection}\n`);
    if (start === -1) return null;
    const rest = doc.slice(start + 1);
    const next = rest.search(/\n#{2,4} /);
    const section = next === -1 ? rest : rest.slice(0, next);
    return [...section.matchAll(/^\| `(\w+)`\s*\|/gm)].map((m) => m[1] ?? '');
}
