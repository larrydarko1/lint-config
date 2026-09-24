/**
 * Database drift gate.
 *
 * Every rule here exists because of a failure that a diff cannot show. A schema
 * doc describing a domain that was never built. An example document carrying a
 * field no type declares. A migration merged without a test, or edited after it
 * had already run somewhere. A collection nothing indexes, so every query
 * against it is a full scan. An index dropped at boot instead of in a
 * migration, so it is rebuilt on every restart of every replica, forever.
 * None of it throws. Most of it is invisible until it is expensive.
 *
 * WHY THIS IS THE LONGEST GATE. It is the cross-file layer of a three-layer
 * rule set the standard sets out deliberately: ESLint sees inside one file, a
 * contract test cannot be waved through with an inline disable, and this gate
 * sees the things that only exist BETWEEN files — a manifest and a migration
 * disagreeing, a doc and a type disagreeing, a checksum file and a directory
 * disagreeing. Those have no other home, so they all live here.
 *
 * WHAT WAS TAKEN FROM WHICH COPY. The two full-stack copies agreed on the
 * middle of the gate and differed at both ends, in opposite directions, so
 * this is the union with each disagreement settled once:
 *   • THE REGISTRY IS IMPORTED, not regex-parsed. One copy matched
 *     `export const COLLECTIONS = [ … ] as const` with a regular expression;
 *     the other ran `await import()` on the module. Importing is better twice
 *     over. It cannot be defeated by reformatting, and it TESTS SOMETHING THE
 *     REGEX CANNOT: the bootstrap migration imports this module through the
 *     migrate-mongo CLI, where there is no bundler and no path aliases, so a
 *     runtime import added here breaks `npm run db:migrate` and nothing else.
 *     Nothing else would catch it.
 *   • AN UNINDEXED COLLECTION IS AN ERROR WITH AN EXEMPTION REGISTER, not a
 *     warning. One copy warned, which is a finding nobody acts on. The other
 *     failed unless the collection appeared in a `noIndexByDesign` map with a
 *     written reason. The register is the better half of the idea: a
 *     collection with no index is either a decision or an oversight, and the
 *     difference is whether someone wrote down which.
 *   • A TYPE MAY BE OPEN. One copy treated any example key the type does not
 *     declare as stale documentation. That is wrong for a document with an
 *     index signature, where fields the type cannot name are the point. The
 *     signature is detected rather than configured.
 *   • THE MIGRATION RULES are the union: exports `up()`, exports no `down()`,
 *     creates no index, and is named so migrate-mongo can order it. Only one
 *     copy had the last three, and the standard states all of them.
 *
 * TWO RULES ARE NEW, and both come from the standard rather than from either
 * copy. Every index entry carries a `why` — the keys are the what, and
 * TypeScript already shows you that; which query it serves is the part that
 * decays. And a TTL index carries `expireAfterSeconds`, because without it a
 * TTL index is an ordinary date index that silently never deletes anything.
 * Both repos already pass both.
 *
 * WHAT IS OPTIONAL, AND WHY THAT IS NOT A COMPROMISE. The backup, restore,
 * wipe and ops-script rules apply to a repo that HAS a backup pipeline. One of
 * the two has none and no host to restore onto, and its copy of this gate said
 * so in a header comment so the absence was a recorded decision rather than an
 * oversight. That is the right instinct and it is preserved: omit the group and
 * the rules do not run, but the omission is written down in the shim, where the
 * next person reads it.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';

export type DbProblem = {
    /** The file the problem is in. */
    file: string;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
};

/** One entry of the index manifest, reduced to what this gate reads. */
export type IndexSpec = {
    collection: string;
    keys?: Record<string, unknown>;
    options?: { expireAfterSeconds?: number };
    /** Which query or constraint the index serves. The standard requires it on every entry. */
    why?: string;
};

/** A deployable process that holds a database connection. */
export type DbService = {
    name: string;
    /** Its entry file, which must handle SIGTERM/SIGINT. */
    entry: string;
    /** Set false for a process that closes its client some other way. Default: true. */
    closes?: boolean;
};

/**
 * An ordered drain. Each stage must appear, and in this order — from the thing
 * that produces work to the thing that stores it.
 */
export type DrainOrder = {
    file: string;
    stages: { what: string; pattern: RegExp }[];
};

export type OpsOptions = {
    /** Destructive scripts that must refuse to run when NODE_ENV=production. */
    productionRefusals?: string[];
    /**
     * The wipe script — the most dangerous file in the repo, so it is defended
     * in depth: a TTY check, and a prompt that makes you type the database name.
     */
    wipe?: {
        file: string;
        /** How the script names the target database, e.g. `cfg.mongoDb`. */
        dbNameExpression: string;
    };
    /** The backup script, which must fail loudly rather than dump nothing. */
    backup?: { file: string };
    /** The restore script, which must flush Redis BEFORE it re-queues. */
    restore?: { file: string };
    /** Scripts that must all read env through one loader, so they cannot target different databases. */
    envLoaderConsumers?: string[];
    /** The loader's module path fragment. Default: `lib/env`. */
    envLoader?: string;
};

export type BackupOptions = {
    /** The restore-drill log. An untested backup is not a backup. */
    drills: string;
    /** The fixed-path manifest of the most recent backup. */
    latest?: string;
    /** The dump directory, which git must ignore. */
    dir?: string;
    /** How stale a drill may be before it warns. Default: 90. */
    maxAgeDays?: number;
};

export type DbDriftInput = {
    /** Repository root; every path below is relative to it. */
    root: string;
    /** The index manifest — the one definition site. Imported, not parsed. */
    manifest: string;
    /** How the bootstrap migration imports it, e.g. `@orchid/shared/db/indexes`. */
    manifestSpecifier: string;
    /** The export holding the collection list. Default: `COLLECTIONS`. */
    collectionsExport?: string;
    /** The exports holding index specs. Default: `['INDEXES']`. */
    indexExports?: string[];
    /** The module declaring the document types. */
    typesFile: string;
    /** Collection name → the type that declares its document shape. */
    collectionTypes: Record<string, string>;
    /** Collections that deliberately carry no index, mapped to the reason. */
    noIndexByDesign?: Record<string, string>;
    /** Field names that mean an index is meant to expire documents. */
    ttlFields?: string[];
    /** The migration that creates the collections on a fresh database. */
    bootstrap: string;
    /** The schema reference doc. */
    architecture: string;
    examplesDir: string;
    migrationsDir: string;
    testsDir: string;
    /** The committed checksum file that makes a merged migration immutable. */
    checksums: string;
    /** Source directories to sweep for an index dropped outside a migration. */
    appDirs?: string[];
    /** Every process that holds a connection. */
    services?: DbService[];
    /** A queue worker's ordered shutdown. */
    drainOrder?: DrainOrder;
    /**
     * Where the manifest is applied at boot. A list, because splitting it
     * across the processes that write those collections is legitimate — but an
     * index export no applier names is one nothing ever creates.
     */
    indexAppliers?: { file: string; applies: string[]; fn?: string }[];
    /** Manifests to check for a migrate-down script. */
    packageManifests?: string[];
    /** Operational script safety. Omit in a repo with no ops scripts. */
    ops?: OpsOptions;
    /** Backup health. Omit in a repo with no backup pipeline — and say so in the shim. */
    backups?: BackupOptions;
};

export type DbDriftInspection = {
    problems: DbProblem[];
    /** Advisories that must never fail a build — a stale drill, a late backup. */
    warnings: string[];
    collections: string[];
    indexes: number;
    migrations: number;
};

export type DbDriftOptions = Omit<DbDriftInput, 'root'> & {
    /** Defaults to the repository root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

/** Fields whose name says the index is meant to expire documents, not just sort them. */
const DEFAULT_TTL_FIELDS = ['expiresAt', 'expireAt', 'expiresOn'];

/** `Users` → `users`, `HashDatabase` → `hash-database`, `AssetInfo` → `asset-info`. */
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * The top-level fields of `type Name = { … }`, ignoring anything nested.
 *
 * Brace-counted rather than matched: a document type holds nested objects, and
 * a regex that stops at the first `}` reports half a schema as the whole of it.
 */
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
            if (depth === 1) top += ch;
            depth++;
        } else if (ch === '}') {
            depth--;
        } else if (depth === 1) {
            top += ch;
        }
    }

    const code = top.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return {
        // An index signature means the document carries fields the type cannot
        // name, so an example with extra keys is correct rather than stale.
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

/**
 * Whether git ignores a path, asked of git itself rather than read out of
 * `.gitignore`: the answer depends on pattern order, negations and every nested
 * ignore file in the tree. Null when git could not answer at all, which must not
 * read as "not ignored".
 */
function gitIgnores(root: string, rel: string): boolean | null {
    const { status, error } = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], {
        cwd: root,
        stdio: 'ignore',
    });
    if (error !== undefined || status === null || status > 1) return null;
    return status === 0;
}

/** Every `.ts` file under a directory, recursively. */
function walk(root: string, dir: string): string[] {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(root, rel);
        return entry.name.endsWith('.ts') ? [rel] : [];
    });
}

/**
 * Read the gate's findings without printing them.
 */
export async function inspectDbDrift(input: DbDriftInput): Promise<DbDriftInspection> {
    const {
        root,
        manifest,
        manifestSpecifier,
        collectionsExport = 'COLLECTIONS',
        indexExports = ['INDEXES'],
        typesFile,
        collectionTypes,
        noIndexByDesign = {},
        ttlFields = DEFAULT_TTL_FIELDS,
        bootstrap,
        architecture,
        examplesDir,
        migrationsDir,
        testsDir,
        checksums,
        appDirs = [],
        services = [],
        drainOrder,
        indexAppliers,
        packageManifests = [],
        ops,
        backups,
    } = input;

    const problems: DbProblem[] = [];
    const warnings: string[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));

    // ── 0. Anchors ───────────────────────────────────────────────────────────
    // A moved file has to stop the gate. Every rule below reads one of these,
    // and a rule that finds nothing to check reports a pass it never proved.
    for (const rel of [manifest, typesFile, bootstrap, architecture, examplesDir, migrationsDir, testsDir]) {
        if (!exists(rel)) {
            fail(
                rel,
                'does not exist',
                'Every rule in this gate reads it, so a wrong path turns the gate into a no-op that reports success. Re-point it before anything else.',
            );
        }
    }
    if (problems.length > 0) return { problems, warnings, collections: [], indexes: 0, migrations: 0 };

    // ── 1. The registry loads under plain Node ───────────────────────────────
    // Not a formality. The bootstrap migration imports this module through the
    // migrate-mongo CLI, where there is no bundler and no alias resolution, so
    // a runtime import added here breaks `npm run db:migrate` and nothing else.
    let registry: Record<string, unknown>;
    try {
        registry = (await import(pathToFileURL(path.join(root, manifest)).href)) as Record<string, unknown>;
    } catch (err) {
        fail(
            manifest,
            `does not load under plain Node: ${String((err as Error).message).split('\n')[0]}`,
            'The bootstrap migration imports it through the migrate-mongo CLI, where there is no bundler and no path aliases. Every import in this file has to be type-only.',
        );
        return { problems, warnings, collections: [], indexes: 0, migrations: 0 };
    }

    for (const name of [collectionsExport, ...indexExports]) {
        if (registry[name] === undefined) {
            fail(
                manifest,
                `no longer exports ${name}`,
                'This gate and the migrations both read it by name, so the export is an interface rather than an implementation detail.',
            );
        }
    }
    if (problems.length > 0) return { problems, warnings, collections: [], indexes: 0, migrations: 0 };

    const collections = [...(registry[collectionsExport] as string[])];
    const indexes = indexExports.flatMap((name) => [...(registry[name] as IndexSpec[])]);
    const indexed = new Set(indexes.map((index) => index.collection));

    const migrationFiles = fs
        .readdirSync(path.join(root, migrationsDir))
        .filter((file) => file.endsWith('.js'))
        .sort();

    // ── 2. The bootstrap migration tracks the registry ───────────────────────
    {
        const source = read(bootstrap);
        if (/const [A-Z_]*COLLECTIONS\s*=\s*\[/.test(source)) {
            fail(
                bootstrap,
                'declares its own collection list',
                `A fresh database gets its collections from this migration. A second copy of the list is exactly the drift this gate exists for — import ${collectionsExport} from ${manifest} instead.`,
            );
        } else if (!new RegExp(`${collectionsExport}[\\s\\S]*?from '${manifestSpecifier}'`).test(source)) {
            fail(
                bootstrap,
                `does not import ${collectionsExport} from '${manifestSpecifier}'`,
                'A fresh database gets its collections from this migration, so it has to read the same list the running app does rather than a list of its own.',
            );
        }
    }

    // ── 3. Every collection is indexed, or says why not ──────────────────────
    for (const collection of collections) {
        if (indexed.has(collection) || collection in noIndexByDesign) continue;
        fail(
            manifest,
            `'${collection}' has no index and no recorded reason for having none`,
            'Every query against it is a collection scan. That is sometimes correct — a handful of singleton documents addressed by _id needs nothing — but the difference between a decision and an oversight is whether someone wrote it down. Declare an index, or add it to noIndexByDesign with a reason.',
        );
    }
    for (const collection of Object.keys(noIndexByDesign)) {
        if (!indexed.has(collection)) continue;
        fail(
            manifest,
            `'${collection}' is exempted from needing an index, but now has one`,
            'A stale exemption is a rule that has quietly stopped applying to the thing it names. Remove it.',
        );
    }

    // ── 4. Every index entry explains itself, and a TTL index expires ────────
    for (const index of indexes) {
        const keys = Object.keys(index.keys ?? {});
        if (index.why === undefined || index.why === '') {
            fail(
                manifest,
                `the index on ${index.collection} (${keys.join(', ')}) carries no \`why\``,
                'The keys are the what, and TypeScript already shows you that. Which query or constraint the index serves is the part that decays, and the part a reviewer needs in order to know whether it is still earning its place.',
            );
        }
        if (keys.length === 1 && ttlFields.includes(keys[0] ?? '') && index.options?.expireAfterSeconds === undefined) {
            fail(
                manifest,
                `the index on ${index.collection}.${keys[0]} looks like a TTL index but has no expireAfterSeconds`,
                'Without it this is an ordinary date index that silently never deletes anything. The collection grows forever and nothing reports it — the documents are simply still there.',
            );
        }
    }

    // ── 5. Every collection has an example document ──────────────────────────
    const exampleCollection = (file: string) => file.replace(/\.json$/, '').split('.')[0] ?? '';
    const exampleFiles = fs.readdirSync(path.join(root, examplesDir)).filter((file) => file.endsWith('.json'));
    {
        const present = new Set(exampleFiles.map((file) => file.replace(/\.json$/, '')));
        for (const collection of collections) {
            if (present.has(kebab(collection))) continue;
            fail(
                `${examplesDir}/${kebab(collection)}.json`,
                'is missing',
                'Every collection needs one realistic (but fake) example document. A type says what a field is called; an example is the only place a reader sees what one actually looks like.',
            );
        }
        for (const file of exampleFiles) {
            if (collections.some((collection) => kebab(collection) === exampleCollection(file))) continue;
            fail(
                `${examplesDir}/${file}`,
                'documents a collection that is not in the registry',
                'The docs describe software that does not exist. Delete it, or add the collection.',
            );
        }
    }

    // ── 6. Docs and examples describe the REAL document shape ────────────────
    {
        const doc = read(architecture);
        const types = read(typesFile);

        for (const collection of collections) {
            const typeName = collectionTypes[collection];
            if (typeName === undefined) {
                fail(
                    manifest,
                    `'${collection}' has no entry in collectionTypes`,
                    'Point it at the type that declares its document shape, so its docs and its example can be checked against something rather than trusted.',
                );
                continue;
            }

            const type = typeFields(types, typeName);
            if (type === null) {
                fail(
                    typesFile,
                    `has no "type ${typeName} = { … }"`,
                    `'${collection}' is mapped to a type that does not exist, so nothing has been checking its docs or its example.`,
                );
                continue;
            }

            const declared = new Set(type.fields.map((field) => field.name).filter((name) => name !== '_id'));
            const required = type.fields
                .filter((field) => !field.optional && field.name !== '_id')
                .map((field) => field.name);

            const documented = documentedFields(doc, collection);
            if (documented !== null) {
                for (const field of declared) {
                    if (documented.includes(field)) continue;
                    fail(
                        architecture,
                        `the '${collection}' table is missing \`${field}\`, which is a field of ${typeName}`,
                        'A doc that is missing half a schema is read as if it were the whole of it.',
                    );
                }
                for (const field of documented) {
                    if (field === '_id' || declared.has(field)) continue;
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
            }

            for (const file of exampleFiles.filter((f) => exampleCollection(f) === kebab(collection))) {
                const rel = `${examplesDir}/${file}`;
                let example: Record<string, unknown>;
                try {
                    example = JSON.parse(read(rel)) as Record<string, unknown>;
                } catch (err) {
                    fail(
                        rel,
                        `is not valid JSON (${(err as Error).message})`,
                        'An example nothing can parse is an example nothing has checked.',
                    );
                    continue;
                }

                const keys = Object.keys(example);
                if (!type.open) {
                    for (const key of keys) {
                        if (key === '_id' || declared.has(key)) continue;
                        fail(
                            rel,
                            `has \`${key}\`, which is not a field of ${typeName}`,
                            'The example documents a schema that does not exist, which is worse than having no example: a reader copies it.',
                        );
                    }
                }
                for (const field of required) {
                    if (keys.includes(field)) continue;
                    fail(
                        rel,
                        `is missing \`${field}\`, which ${typeName} declares as required`,
                        'Every real document has it, so an example without it is not an example of a real document.',
                    );
                }
            }
        }
    }

    // ── 7. architecture.md ↔ the registry ────────────────────────────────────
    {
        const doc = read(architecture);
        const documented = [...doc.matchAll(/^#### (\w+)$/gm)].map((m) => m[1] ?? '');

        for (const collection of collections) {
            if (documented.includes(collection)) continue;
            fail(
                architecture,
                `'${collection}' is not documented (expected a "#### ${collection}" heading)`,
                'A collection nobody documented is a collection nobody reviewed the shape of.',
            );
        }
        for (const heading of documented) {
            if (collections.includes(heading)) continue;
            fail(
                architecture,
                `documents '${heading}', which is not in the registry`,
                'The docs describe software that does not exist. This is the failure that makes a whole schema doc untrustworthy — once one section is fiction, a reader cannot rely on any of it.',
            );
        }

        const stated = /contains \*\*(\d+) collections\*\*/.exec(doc);
        if (stated === null) {
            fail(
                architecture,
                'has no overview line of the form "contains **N collections**"',
                'The stated count is the cheapest possible check that the document was updated with the code, and it is the first thing a reader believes.',
            );
        } else if (Number(stated[1]) !== collections.length) {
            fail(
                architecture,
                `says ${String(stated[1])} collections; the registry has ${collections.length}`,
                'One of the two was edited without the other.',
            );
        }

        const listed = [...doc.matchAll(/^\| `(\d{14}-[a-z0-9-]+)`/gm)].map((m) => m[1] ?? '');
        const onDisk = migrationFiles.map((file) => file.replace(/\.js$/, ''));

        for (const name of listed) {
            if (onDisk.includes(name)) continue;
            fail(
                architecture,
                `the migration history lists \`${name}\`, which is not in ${migrationsDir}/`,
                'A history naming a migration that does not exist is a history nobody can replay or audit.',
            );
        }
        for (const name of onDisk) {
            if (listed.includes(name)) continue;
            fail(
                architecture,
                `migration \`${name}\` is missing from the migration history table`,
                'The table is the record of what has been done to the database. A migration absent from it happened invisibly.',
            );
        }
    }

    // ── 8. Every migration has a test ────────────────────────────────────────
    for (const file of migrationFiles) {
        const testName = `${file.replace(/^\d{14}-/, '').replace(/\.js$/, '')}.test.ts`;
        if (exists(path.join(testsDir, testName))) continue;
        fail(
            `${testsDir}/${testName}`,
            'is missing',
            'Migrations run once, against real data, usually under pressure, and are close to impossible to debug afterwards. The test has to prove up() does the thing AND that running it twice changes nothing.',
        );
    }

    // ── 9. Every migration loads, exports up(), and nothing else ─────────────
    for (const file of migrationFiles) {
        const rel = `${migrationsDir}/${file}`;
        const source = read(rel);

        if (!/^\d{14}-[a-z0-9-]+\.js$/.test(file)) {
            fail(
                rel,
                'is not named <14-digit timestamp>-<kebab-name>.js',
                'migrate-mongo orders migrations by filename. One that does not sort runs in an order nobody chose.',
            );
        }
        if (/\.createIndex\s*\(/.test(source)) {
            fail(
                rel,
                'creates an index',
                `Indexes have one definition site — ${manifest} — and are applied at boot, where createIndex is a no-op if the index exists. Creating one here as well is a second source of truth, and the two will drift.`,
            );
        }

        try {
            const mod = (await import(pathToFileURL(path.join(root, rel)).href)) as { up?: unknown; down?: unknown };
            if (typeof mod.up !== 'function') {
                fail(
                    rel,
                    'does not export an up() function',
                    'migrate-mongo has nothing to run, and will say so only when someone deploys.',
                );
            }
            if (mod.down !== undefined) {
                fail(
                    rel,
                    'exports a down()',
                    'Migrations are forward-only. A reversal that loses data is not a rollback — it is a second, unreviewed, untested migration that runs during an incident. To undo a migration, write a new forward one that corrects the state.',
                );
            }
        } catch (err) {
            const { code, message } = err as NodeJS.ErrnoException;
            fail(
                rel,
                `fails to import under plain Node (${code ?? 'error'})`,
                `migrate-mongo would fail the same way, at deploy time. ${String(message).split('\n')[0]}`,
            );
        }
    }

    // ── 10. A merged migration is immutable ──────────────────────────────────
    {
        const hash = (file: string) =>
            crypto
                .createHash('sha256')
                .update(read(path.join(migrationsDir, file)))
                .digest('hex');

        if (!exists(checksums)) {
            fail(
                checksums,
                'is missing',
                'It is the record of what each migration looked like when it was committed. Without it, an edit to an already-applied migration is undetectable.',
            );
        } else {
            const recorded = JSON.parse(read(checksums)) as Record<string, string>;

            for (const file of migrationFiles) {
                if (!(file in recorded)) {
                    fail(
                        `${migrationsDir}/${file}`,
                        'has no recorded checksum',
                        'If it is new, re-baseline the checksum file in the same commit that adds it.',
                    );
                } else if (recorded[file] !== hash(file)) {
                    fail(
                        `${migrationsDir}/${file}`,
                        'has been modified since it was committed',
                        'A migration that has already run in an environment cannot be changed: editing it does nothing there, while desynchronising it from every environment that has not run it yet. Write a new forward migration. (If it has genuinely never been applied anywhere, re-baseline it.)',
                    );
                }
            }
            for (const file of Object.keys(recorded)) {
                if (migrationFiles.includes(file)) continue;
                fail(
                    checksums,
                    `records ${file}, which no longer exists`,
                    'A merged migration must never be deleted — an environment that has not run it yet now never will, and its schema silently diverges.',
                );
            }
        }
    }

    // ── 11. Only a migration drops an index ──────────────────────────────────
    // A drop applied at boot re-runs on every restart of every replica. If the
    // replacement index has the same auto-generated name, that is a
    // drop-and-rebuild loop that reindexes the collection on every start.
    for (const rel of appDirs.flatMap((dir) => walk(root, dir))) {
        if (!/\.dropIndexe?s?\s*\(/.test(read(rel))) continue;
        fail(
            rel,
            'drops an index',
            'A drop has to happen exactly once, which is the definition of a migration. Applied at startup it runs on every restart of every replica, forever.',
        );
    }

    // ── 12. Every service drains before it exits ─────────────────────────────
    for (const service of services) {
        const source = read(service.entry);
        for (const signal of ['SIGTERM', 'SIGINT']) {
            // Quoted, not merely mentioned. `process.on(signal, …)` always
            // spells it as a string literal, while a comment explaining WHY the
            // handler matters names it too — and a comment is not a handler.
            if (new RegExp(`['"]${signal}['"]`).test(source)) continue;
            fail(
                service.entry,
                `has no ${signal} handler`,
                'Every rolling deploy and pod eviction sends it. Without a handler, in-flight queries are severed mid-write rather than drained — and an HTTP server without one fails loudly on the next deploy, while a worker without one just silently corrupts whatever job was running.',
            );
        }
        if (service.closes !== false && !/closeDb\(\)/.test(source)) {
            fail(
                service.entry,
                'does not call closeDb() on shutdown',
                'Closing the server alone leaves the Mongo client open with its in-flight writes unfinished. The process exits; the writes do not land.',
            );
        }
    }

    // ── 13. A queue worker drains in dependency order ────────────────────────
    // "Close the client" understates it for a worker. The active jobs ARE the
    // in-flight writes, so the consumers stop first; closing Mongo while a job
    // is mid-write is the same severed write with extra steps.
    if (drainOrder !== undefined) {
        const source = read(drainOrder.file);
        const found = drainOrder.stages.map((stage) => ({ ...stage, at: source.search(stage.pattern) }));
        const missing = found.filter((stage) => stage.at === -1);

        if (missing.length > 0) {
            fail(
                drainOrder.file,
                `the shutdown is missing ${missing.map((stage) => stage.what).join(', ')}`,
                'Either the shutdown was restructured — in which case re-point this rule — or a stage was dropped. Both need a human, because neither shows up until a deploy.',
            );
        } else {
            for (let i = 1; i < found.length; i++) {
                const previous = found[i - 1];
                const current = found[i];
                if (previous === undefined || current === undefined || previous.at < current.at) continue;
                fail(
                    drainOrder.file,
                    `${current.what} happens before ${previous.what}`,
                    'The drain has to run in dependency order, from the thing that produces work to the thing that stores it. Any other order severs a write that was already in progress.',
                );
            }
        }
    }

    // ── 14. Every index export is actually applied by someone ────────────────
    // A list rather than one file, because splitting the manifest across the
    // processes that write those collections is a legitimate design: the api
    // applies what the api writes, the worker applies what the worker writes.
    // What is NOT legitimate is an index array nobody applies at all, which
    // looks exactly like a declared index and creates nothing.
    if (indexAppliers !== undefined) {
        for (const name of indexExports) {
            if (indexAppliers.some((applier) => applier.applies.includes(name))) continue;
            fail(
                manifest,
                `exports ${name}, which no process applies`,
                'It reads as a declared index and creates nothing. Every environment runs without it, and the first sign is a slow query in production.',
            );
        }

        for (const applier of indexAppliers) {
            const source = read(applier.file);
            const fn = applier.fn ?? 'ensureIndexes';

            // A DECLARATION IS NOT A CALL. `async function ensureIndexes(db)`
            // must not satisfy the rule that something reaches it — that was
            // the whole failure, an applier that defines the function and never
            // runs it. So the declaration is blanked before looking for a call.
            // `await fn(`, `fn(` and `.then(fn)` are all real spellings here;
            // what matters is that it is reached, not how.
            const calls = source.replace(new RegExp(String.raw`function\s+${fn}\s*\(`, 'g'), 'x(');
            if (!new RegExp(String.raw`\b${fn}\s*\(|\.then\(\s*${fn}\s*[),]`).test(calls)) {
                fail(
                    applier.file,
                    `never calls ${fn}()`,
                    'The manifest becomes a document nothing reads, and every fresh environment boots with no indexes at all — fast in development, and a table scan per request on real data.',
                );
            }
            for (const name of applier.applies) {
                if (source.includes(name)) continue;
                fail(
                    applier.file,
                    `does not reference ${name} from ${manifest}`,
                    'It is applying something, but not the manifest this gate checks — so the two are free to disagree.',
                );
            }
        }
    }

    // ── 15. No migrate-down script, and no migrating at startup ──────────────
    for (const rel of packageManifests) {
        if (!exists(rel)) continue;
        const scripts = (JSON.parse(read(rel)) as { scripts?: Record<string, string> }).scripts ?? {};
        const down = Object.keys(scripts).filter((name) => /migrate.*down|down.*migrate/i.test(name));
        if (down.length === 0) continue;
        fail(
            rel,
            `exposes ${down.map((name) => `\`${name}\``).join(', ')}`,
            'It puts an unreviewed, untested, data-losing migration one keystroke away from the migrate script — reachable during an incident, which is the only time anyone would reach for it.',
        );
    }
    for (const service of services) {
        if (!/migrate-mongo/.test(read(service.entry))) continue;
        fail(
            service.entry,
            'runs migrations at startup',
            'Migrations belong in the deploy pipeline. At boot they slow startup and, across replicas, run partially and concurrently against the same database.',
        );
    }

    // ── 16. Ops script safety ────────────────────────────────────────────────
    if (ops !== undefined) {
        for (const rel of ops.productionRefusals ?? []) {
            if (!exists(rel)) continue;
            if (/process\.env(?:\.NODE_ENV|\['NODE_ENV'\]) === 'production'/.test(read(rel))) continue;
            fail(
                rel,
                'has no NODE_ENV=production refusal',
                'It is destructive and not reversible by a script. The refusal is the last thing standing between a mistyped command and real data.',
            );
        }

        if (ops.wipe !== undefined) {
            const source = read(ops.wipe.file);
            const dbName = ops.wipe.dbNameExpression;
            if (!/\bisTTY\b/.test(source)) {
                fail(
                    ops.wipe.file,
                    'has no TTY check',
                    'This is the guard that actually keeps it out of CI. A misconfigured CI variable pointing at a real database is exactly how this ends badly, and "we just will not add it to the workflow" is not a control.',
                );
            }
            if (
                !new RegExp(
                    String.raw`confirm\(\x60[^\x60]*\$\{${dbName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`,
                ).test(source)
            ) {
                fail(
                    ops.wipe.file,
                    'no longer names the database in its confirmation prompt',
                    'A prompt you answer with "yes" is one you can muscle-memory through without ever reading which database you are pointed at.',
                );
            }
            if (
                !new RegExp(String.raw`answer !== ${dbName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`).test(
                    source,
                )
            ) {
                fail(
                    ops.wipe.file,
                    'no longer compares the typed answer to the database name',
                    'Any input proceeds, so the prompt has become a keystroke rather than a check.',
                );
            }
        }

        if (ops.backup !== undefined) {
            const source = read(ops.backup.file);
            if (!/manifest\.json/.test(source) || !/latest\.json/.test(source)) {
                fail(
                    ops.backup.file,
                    'no longer writes manifest.json and latest.json',
                    'They are the cheapest possible "is this dump real?" check, and latest.json is what the staleness and zero-document checks read.',
                );
            }

            const zero = source.search(/totalDocs === 0/);
            const manifestWrite = source.search(/latest\.json/);
            const success = source.search(/console\.log\(`Backup complete/);

            if (zero === -1) {
                fail(
                    ops.backup.file,
                    'has no zero-document check',
                    'mongodump exiting 0 proves a file was written, not that it held anything. A backup of nothing must exit 1, not report success.',
                );
            } else {
                if (manifestWrite !== -1 && zero < manifestWrite) {
                    fail(
                        ops.backup.file,
                        'checks for zero documents before writing the manifest',
                        'Write the manifest first so the failed run leaves a record of itself, then exit 1. A failure with no paper trail is indistinguishable from a run that never happened.',
                    );
                }
                if (success !== -1 && success < zero) {
                    fail(
                        ops.backup.file,
                        'prints "Backup complete" before the zero-document check',
                        'That is the silent empty dump, with a paper trail saying it worked.',
                    );
                }
            }
        }

        if (ops.restore !== undefined) {
            const source = read(ops.restore.file);
            // `.flushdb()` with the dot: one of these repos types its Redis
            // client inline (`{ flushdb(): Promise<unknown> }`), and that
            // declaration would otherwise count as the flush — and, being near
            // the top of the file, would pass the ordering check every time.
            const flush = source.search(/\.flushdb\s*\(\s*\)/);
            const enqueue = source.search(/queue\.add\(/);

            if (flush === -1) {
                fail(
                    ops.restore.file,
                    'does not flush Redis',
                    'Stale cache entries point at pre-restore rows, so the restored database is served through a cache describing the old one.',
                );
            } else if (enqueue !== -1 && flush > enqueue) {
                fail(
                    ops.restore.file,
                    'flushes Redis after queueing jobs',
                    'The job queue lives in Redis too, so the flush deletes the jobs it just queued. The restore reports success and every item waiting on derived state stays unprocessed forever. Flush first.',
                );
            }
        }

        for (const rel of ops.envLoaderConsumers ?? []) {
            if (!exists(rel)) continue;
            if (new RegExp(`from\\s*['"][^'"]*${ops.envLoader ?? 'lib/env'}`).test(read(rel))) continue;
            fail(
                rel,
                `does not load env through ${String(ops.envLoader ?? 'the shared loader')}`,
                'Two loaders means two .env precedence rules, and then the migrate script and the backup script can quietly target two different databases. That is not a hypothetical: it is the failure the shared loader was written for.',
            );
        }
    }

    // ── 17. Backup health ────────────────────────────────────────────────────
    // Warnings, not failures: a stale drill is a thing to schedule, not a
    // reason to block a commit that has nothing to do with it. An empty dump
    // is different, and fails.
    if (backups !== undefined) {
        const maxAgeDays = backups.maxAgeDays ?? 90;

        if (!exists(backups.drills)) {
            fail(
                backups.drills,
                'is missing — there is no restore-drill log',
                'mongodump exiting 0 proves a file was written. It does not prove the file can be read back, that it was a dump of the right database, or that the app boots against the result. Only a restore proves that, and a backup nobody has restored is not a backup.',
            );
        } else {
            const doc = read(backups.drills).replace(/<!--[\s\S]*?-->/g, '');
            const dates = [...doc.matchAll(/^\| (\d{4}-\d{2}-\d{2}) \|/gm)].map((m) => m[1]).sort();
            const last = dates.at(-1);

            if (last === undefined) {
                warnings.push(
                    `${backups.drills}: no drill has ever been logged. Run one — restore yesterday's backup onto a fresh staging instance and smoke-test the critical flows.`,
                );
            } else {
                const ageDays = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
                if (ageDays > maxAgeDays) {
                    warnings.push(
                        `${backups.drills}: the last restore drill was ${ageDays} days ago (${last}). The standard says quarterly, so this is ${ageDays - maxAgeDays} days overdue.`,
                    );
                }
            }
        }

        if (backups.dir !== undefined) {
            const ignored = gitIgnores(root, backups.dir);
            if (ignored === null) {
                warnings.push(
                    `Could not ask git whether ${backups.dir} is ignored (no repository here?), so that rule did not run.`,
                );
            } else if (!ignored) {
                fail(
                    '.gitignore',
                    `does not ignore \`${backups.dir}\``,
                    'A dump committed to git is every user record in the repository history, permanently — and deleting it later does not remove it.',
                );
            }
        }

        if (backups.latest !== undefined && exists(backups.latest)) {
            const latest = JSON.parse(read(backups.latest)) as { completedAt?: string; totalDocuments?: number };
            const ageDays = Math.floor((Date.now() - Date.parse(latest.completedAt ?? '')) / 86_400_000);
            if (ageDays > 1) {
                warnings.push(
                    `${backups.latest}: the last backup completed ${ageDays} days ago. Nightly backups are not running.`,
                );
            }
            if (latest.totalDocuments === 0) {
                fail(
                    backups.latest,
                    'records a backup that contained zero documents',
                    'It almost certainly dumped the wrong database — an empty localhost, usually. The file exists and the exit code was 0, which is why nothing else noticed.',
                );
            }
        }
    }

    return { problems, warnings, collections, indexes: indexes.length, migrations: migrationFiles.length };
}

/**
 * Run the gate and print.
 */
export async function checkDbDrift({ root = REPO_ROOT, standard, ...rest }: DbDriftOptions): Promise<void> {
    const report = createGateReport({ name: 'Database drift', ...(standard === undefined ? {} : { standard }) });
    const { problems, warnings, collections, indexes, migrations } = await inspectDbDrift({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `${plural(collections.length, 'collection')}, each indexed or exempted, documented and exampled against its real type; ` +
            `${plural(indexes, 'index', 'indexes')} each explaining itself; ` +
            `${plural(migrations, 'migration')} each tested, forward-only and unchanged since commit.`,
        notMachineChecked:
            'Whether an index is the RIGHT index for the queries that run, whether a migration is genuinely idempotent against real data, whether a `why` is true, and whether the restore actually works — only running one proves that.',
    });

    if (report.count === 0) for (const warning of warnings) console.warn(`\n⚠ ${warning}`);
}

export default checkDbDrift;
