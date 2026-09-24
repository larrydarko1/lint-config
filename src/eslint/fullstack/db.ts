const DOWN_MESSAGE =
    'Migrations are forward-only: no down(). A reversal that loses data is not a rollback (the bootstrap down() dropped all 28 collections). To undo a migration, write a new forward migration. See db/migrations/README.md.';

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

const noCreateIndexInMigration = {
    selector: "CallExpression[callee.property.name='createIndex']",
    message:
        'Do not create indexes in a migration. Every index is declared once in packages/shared/src/db/indexes.ts and applied by ensureIndexes() at API boot. Declaring them here too is what let HashDatabase{source,addedAt} drift. See db/migrations/README.md.',
};

const noCreateIndexInApi = {
    selector: "CallExpression[callee.property.name='createIndex']",
    message:
        'Do not call createIndex here. Add an entry to the index manifest (packages/shared/src/db/indexes.ts) — it is applied by ensureIndexes() in lib/db.ts on the next boot.',
};

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

const noUntypedCollection = {
    selector: "CallExpression[callee.property.name='collection'][arguments.0.type='Literal']:not([typeArguments])",
    message:
        "Give every collection its document type: `db.collection<MediaDoc>('Media')`, with the Doc types from @orchid/shared/db/collections. Untyped, every read is `any`-shaped and a write with a misspelt or wrong-typed field compiles fine — which is how the worker never used MediaDoc.",
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

/** The same list in the shape `no-restricted-imports` takes. */
const noOdm = { paths: dbBannedImports };

export const dbApiWorkerSelectors = [noCreateIndexInApi, noDropIndexInApi, noExtraMongoClient, noUntypedCollection];

/** api/src/lib/db.ts — the manifest applier + singleton (createIndex/new MongoClient are its job). */
export const dbDbTsSelectors = [noDropIndexInApi, noUntypedCollection];

/** worker/src/index.ts — the worker singleton (new MongoClient is its job). */
export const dbWorkerIndexSelectors = [noCreateIndexInApi, noDropIndexInApi, noUntypedCollection];

export default [
    {
        files: ['db/migrations/**/*.js'],
        rules: {
            'no-restricted-syntax': ['error', ...noMigrationDown, noCreateIndexInMigration],
            'no-restricted-imports': ['error', noOdm],
        },
    },
    {
        files: ['api/src/**/*.ts', 'worker/src/**/*.ts'],
        ignores: ['**/__tests__/**', 'api/src/lib/db.ts', 'worker/src/index.ts'],
        rules: {
            'no-restricted-syntax': ['error', ...dbApiWorkerSelectors],
            'no-restricted-imports': ['error', noOdm],
        },
    },
    {
        files: ['api/src/lib/db.ts'],
        rules: {
            'no-restricted-syntax': ['error', ...dbDbTsSelectors],
            'no-restricted-imports': ['error', noOdm],
        },
    },
    {
        files: ['worker/src/index.ts'],
        rules: {
            'no-restricted-syntax': ['error', ...dbWorkerIndexSelectors],
            'no-restricted-imports': ['error', noOdm],
        },
    },
    {
        files: ['scripts/**/*.ts'],
        ignores: ['scripts/download-models.ts'],
        rules: {
            'no-restricted-syntax': ['error', noEnvFallbackInScripts],
        },
    },
];
