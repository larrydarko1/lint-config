import type { SyntaxBan } from '../rules/code-style.ts';

/** What the messages point the reader at: each family's own files. */
type DbMessagePaths = {
    /** The index manifest ensureIndexes() applies. */
    indexManifest: string;
    /** Where each collection's document type is declared. */
    documentTypes: string;
};

type MongoArea = 'migration' | 'application' | 'dbModule' | 'serviceEntry';

const DOWN_MESSAGE =
    'Migrations are forward-only: no down(). A reversal that loses data is not a rollback (the bootstrap down() dropped all 28 collections). To undo a migration, write a new forward migration. See db/migrations/README.md.';

const noDropIndexInApi = {
    selector: "CallExpression[callee.property.name='dropIndex']",
    message:
        'Never drop an index from application code. It re-runs on every boot of every replica — the old connectDb() dropped and rebuilt both Views indexes on every single restart. Dropping is one-shot work: write a migration in db/migrations/, where dropIndex is allowed.',
};

const noEnvFallbackInScripts = {
    selector:
        "LogicalExpression[operator=/^(\\|\\||\\?\\?)$/] > MemberExpression[object.object.name='process'][object.property.name='env']",
    message:
        "No silent env fallback. Use getRequiredEnv('X') from scripts/lib/env.ts — it throws on a missing variable instead of guessing localhost. If a wrong value genuinely cannot destroy or mis-target data, use optionalEnv('X', default) and say why.",
};

const noExtraMongoClient = {
    selector: "NewExpression[callee.name='MongoClient']",
    message:
        'One MongoDB connection per process. Use getDb() from lib/db.ts — the singleton is created once by connectDb() at startup.',
};

export const dbBannedImports = [
    {
        name: 'mongoose',
        message:
            'No ODM. Use the native mongodb driver — TypeScript types give compile-time safety and the index manifest gives explicit control.',
    },
    { name: 'typeorm', message: 'No ORM/ODM. Use the native mongodb driver.' },
    {
        name: '@prisma/client',
        message: 'No ORM/ODM. Use the native mongodb driver.',
    },
    {
        name: 'uuid',
        message:
            'Do not add a `uuid` dependency — `crypto.randomUUID()` is in the Node standard library and is what the ID strategy specifies for URL-facing identifiers.',
    },
];

const noMigrationDown = [
    {
        selector: "ExportNamedDeclaration > FunctionDeclaration[id.name='down']",
        message: DOWN_MESSAGE,
    },
    {
        selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='down']",
        message: DOWN_MESSAGE,
    },
    { selector: "Property[key.name='down']", message: DOWN_MESSAGE },
];

/** Ops scripts: no guessed default for a variable that picks what they touch. */
export const scriptEnvSelectors = [noEnvFallbackInScripts];

/** Each area's selectors, with the messages pointing at `paths`. */
export const mongoSelectors = ({ indexManifest, documentTypes }: DbMessagePaths): Record<MongoArea, SyntaxBan[]> => ({
    /** A migration: forward-only, and no indexes of its own. */
    migration: [...noMigrationDown, noCreateIndexInMigration(indexManifest)],
    /** Application code: the manifest owns indexes, lib/db.ts owns the client. */
    application: [
        noCreateIndexInApi(indexManifest),
        noDropIndexInApi,
        noExtraMongoClient,
        noUntypedCollection(documentTypes),
    ],
    /** lib/db.ts, which applies the manifest and holds the client. */
    dbModule: [noDropIndexInApi, noUntypedCollection(documentTypes)],
    /** A service's lib/db.ts, which holds that process's client but applies no indexes. */
    serviceEntry: [noCreateIndexInApi(indexManifest), noDropIndexInApi, noUntypedCollection(documentTypes)],
});

const noCreateIndexInMigration = (indexManifest: string): SyntaxBan => ({
    selector: "CallExpression[callee.property.name='createIndex']",
    message: `Do not create indexes in a migration. Every index is declared once in ${indexManifest} and applied by ensureIndexes() at API boot. Declaring them here too is what let HashDatabase{source,addedAt} drift. See db/migrations/README.md.`,
});

const noCreateIndexInApi = (indexManifest: string): SyntaxBan => ({
    selector: "CallExpression[callee.property.name='createIndex']",
    message: `Do not call createIndex here. Add an entry to the index manifest (${indexManifest}) — it is applied by ensureIndexes() in lib/db.ts on the next boot.`,
});

const noUntypedCollection = (documentTypes: string): SyntaxBan => ({
    selector: "CallExpression[callee.property.name='collection'][arguments.0.type='Literal']:not([typeArguments])",
    message: `Give every collection its document type: \`db.collection<MediaDoc>('Media')\`, with the Doc types from ${documentTypes}. Untyped, every read is \`any\`-shaped and a write with a misspelt or wrong-typed field compiles fine — which is how the worker never used MediaDoc.`,
});
