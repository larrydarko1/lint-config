/**
 * Env drift, per service:
 *
 *   1. The Zod schema and `.env.example` agree, both ways.
 *   2. The local `.env` agrees too, as a warning only: it is gitignored and a fresh
 *      clone must boot without one.
 *   3. dotenv is the entry file's first import.
 *   4. No secret carries a bare `.default()`.
 *   5. A shared key is declared once.
 *   6. The config object carries the canonical groups.
 *   7. No committed `.env.example` holds a real secret.
 *   8. `.env` is git-ignored and `.env.example` is not (asked of `git check-ignore`).
 *   9. `process.env` is read only in the config module and entry file (tests exempt).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport } from './report.ts';

export type EnvProblem = {
    /** `path` or `path:line`. */
    file: string;
    /** The violation. */
    what: string;
    /** Why the rule exists. */
    why: string;
};

/** One deployable process: its schema, its documentation, and the env it boots with. */
export type EnvService = {
    /** How the service is named in output, e.g. `api`. */
    name: string;
    /** The config module holding the Zod schema, e.g. `api/src/lib/config.ts`. */
    config: string;
    /** The committed file documenting its keys, e.g. `api/.env.example`. */
    example: string;
    /** The entry file dotenv must be imported first in, e.g. `api/src/index.ts`. */
    entry: string;
    /** The gitignored env it boots with, if any. Its drift only warns. */
    local?: string;
};

export type EnvDriftInput = {
    /** Repository root; every path below is relative to it. */
    root: string;
    /** Every deployable process in the repo. */
    services: EnvService[];
    /**
     * The module holding the shared Zod fragments the configs spread in
     * (`...mongoEnv`). Omit in a repo where each service declares its own keys.
     */
    sharedEnv?: string;
    /** Config module → the groups its exported `config` object must carry. */
    canonicalGroups?: Record<string, string[]>;
    /** Every committed `.env.example` to sweep for real secrets. */
    exampleFiles?: string[];
    /** Keys the runtime injects, so neither side has to declare them. Default: `['NODE_ENV']`. */
    ignored?: string[];
    /** Set false where git cannot be asked (a vendored tree). Default: true. */
    gitignore?: boolean;
    /**
     * Source directories to sweep for `process.env` read outside the schema.
     * Each service's own config module and entry file are exempt, as are tests.
     */
    businessDirs?: string[];
};

export type EnvDriftInspection = {
    problems: EnvProblem[];
    /** Advisories that must never fail a build — the local `.env`, and a rule that could not run. */
    warnings: string[];
    services: { name: string; keys: number }[];
};

export type EnvDriftOptions = Omit<EnvDriftInput, 'root'> & {
    /** Defaults to the repository root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

/** A key whose name says it holds a secret, by suffix: `SMTP_PASS`, `JWT_SECRET`. */
const SECRET_KEY_RE = /_(SECRET|KEY|PASS|PASSWORD|TOKEN)$/;

/** Declarations already safe beside a `.default()`: no default, production-armed, or `.optional()`. */
const SAFE_SECRET_FORMS = /requiredSecret\(|hexSecret\(|infraDefault\(|\.optional\(\)/;

/** Values shaped like real secrets rather than placeholders. */
const REAL_SECRET_SHAPES = [
    { what: 'a 64-char hex string (a real AES/HMAC key)', re: /=\s*[0-9a-fA-F]{64}\s*$/m },
    { what: 'a live Stripe key', re: /=\s*sk_live_\w+/m },
    { what: 'a Stripe webhook secret', re: /=\s*whsec_[A-Za-z0-9]{16,}/m },
    { what: 'an AWS access key id', re: /=\s*AKIA[0-9A-Z]{16}/m },
    { what: 'a private key block', re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
];

/** A `VITE_*` key whose name claims it holds a secret. Vite ships all of them. */
const VITE_SECRET_RE = /^#?\s*(VITE_[A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN))\s*=/gm;

/** UPPER_SNAKE object keys: a Zod schema's env fields, declared as `KEY:` at the start of a line. */
function schemaFieldKeys(source: string): Set<string> {
    return new Set([...source.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] ?? ''));
}

/** Each `export const NAME = { … }` fragment in the shared env module, mapped to its keys. */
function sharedFragments(source: string): Record<string, Set<string>> {
    const fragments: Record<string, Set<string>> = {};
    for (const [, name = '', body = ''] of source.matchAll(/export const (\w+) = \{([\s\S]*?)\n\};/g)) {
        fragments[name] = schemaFieldKeys(body);
    }
    return fragments;
}

/**
 * The env keys a config module reads: its own schema fields plus the keys of
 * every shared fragment it spreads.
 */
function configKeys(source: string, fragments: Record<string, Set<string>>, ignored: Set<string>): Set<string> {
    const keys = schemaFieldKeys(source);
    for (const [, name = ''] of source.matchAll(/\.\.\.(\w+)/g)) {
        for (const key of fragments[name] ?? []) keys.add(key);
    }
    for (const key of ignored) keys.delete(key);
    return keys;
}

/**
 * The keys declared in a dotenv-style file. `commentedCounts`: in `.env.example` a
 * commented `# KEY=` documents an optional var; in `.env` it is unset.
 */
function dotenvKeys(
    source: string,
    { commentedCounts }: { commentedCounts: boolean },
    ignored: Set<string>,
): Set<string> {
    const keys: Set<string> = new Set();
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        const isComment = line.startsWith('#');
        if (isComment && !commentedCounts) continue;
        const key = /^([A-Z0-9_]+)=/.exec(isComment ? line.replace(/^#\s*/, '') : line)?.[1];
        if (key !== undefined && !ignored.has(key)) keys.add(key);
    }
    return keys;
}

/**
 * Whether git ignores a path, asked of `git check-ignore`.
 *
 * @returns Null when git could not answer (no repository, no git).
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

/** Read the gate's findings without printing them. */
export function inspectEnvDrift(input: EnvDriftInput): EnvDriftInspection {
    const {
        root,
        services,
        sharedEnv,
        canonicalGroups = {},
        exampleFiles = [],
        ignored: ignoredKeys = ['NODE_ENV'],
        gitignore = true,
        businessDirs,
    } = input;

    const ignored = new Set(ignoredKeys);
    const problems: EnvProblem[] = [];
    const warnings: string[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string) => fs.existsSync(path.join(root, rel));

    // A missing anchor stops the gate, so no rule passes on nothing.
    for (const rel of [sharedEnv, ...services.flatMap((s) => [s.config, s.example, s.entry])]) {
        if (rel !== undefined && !exists(rel)) {
            fail(
                rel,
                'does not exist',
                'Every rule below reads it, so a wrong path turns this gate into a no-op that reports success. Re-point it.',
            );
        }
    }
    if (problems.length > 0) return { problems, warnings, services: [] };

    const fragments = sharedEnv === undefined ? {} : sharedFragments(read(sharedEnv));

    const summary: { name: string; keys: number }[] = [];

    for (const service of services) {
        const inConfig = configKeys(read(service.config), fragments, ignored);
        const inExample = dotenvKeys(read(service.example), { commentedCounts: true }, ignored);
        summary.push({ name: service.name, keys: inConfig.size });

        // ── 1. The schema and its documentation agree, both directions ───────
        for (const key of [...inConfig].filter((k) => !inExample.has(k)).sort()) {
            fail(
                service.example,
                `does not document ${key}, which ${service.config} reads`,
                'An undocumented key is one the next deploy is handed without. If it has a default the service boots on the placeholder; if it does not, the deploy dies on a key nobody knew existed.',
            );
        }
        for (const key of [...inExample].filter((k) => !inConfig.has(k)).sort()) {
            fail(
                service.example,
                `documents ${key}, which ${service.config} does not read`,
                'A dead example key is worse than a missing one: someone sets it carefully in production and it does nothing. Usually the leftover of a rename.',
            );
        }

        // ── 2. Advisory: the .env you actually boot with ─────────────────────
        if (service.local === undefined || !exists(service.local)) continue;

        const inLocal = dotenvKeys(read(service.local), { commentedCounts: false }, ignored);
        const expected = dotenvKeys(read(service.example), { commentedCounts: false }, ignored);

        const missing = [...expected].filter((k) => !inLocal.has(k)).sort();
        if (missing.length > 0) {
            warnings.push(
                `${service.local} is missing ${missing.length} key(s) that ${service.example} sets: ${missing.join(', ')}.\n` +
                    '  Each falls back to its Zod default, so the service still starts — which is exactly why this\n' +
                    '  drifts unnoticed. A prod-only required key will fail at deploy rather than here.',
            );
        }

        const unknown = [...inLocal].filter((k) => !inConfig.has(k)).sort();
        if (unknown.length > 0) {
            warnings.push(
                `${service.local} sets ${unknown.length} key(s) no config reads (dead, usually a missed rename): ${unknown.join(', ')}.`,
            );
        }
    }

    // ── 3. dotenv is the first import ────────────────────────────────────────
    for (const service of services) {
        const source = read(service.entry);
        const imports = [...source.matchAll(/^import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);

        if (imports.length === 0) {
            fail(
                service.entry,
                'has no import statements, so this check proves nothing',
                'It exists to show dotenv runs before anything reads env. A version of it that finds nothing to look at needs re-pointing, not passing.',
            );
        } else if (imports[0] !== 'dotenv/config') {
            fail(
                service.entry,
                `imports '${imports[0]}' before 'dotenv/config'`,
                'Imports are hoisted and run in order. Anything above dotenv that reads process.env at module load — a config singleton especially — sees an empty env and silently takes every default. Nothing fails; the service just runs on the wrong values.',
            );
        }
    }

    // ── 4. A secret never carries a bare .default() ──────────────────────────
    for (const rel of [...services.map((s) => s.config), ...(sharedEnv === undefined ? [] : [sharedEnv])]) {
        const source = read(rel);
        // Cross-field requirements live in a superRefine, so a key named there
        // is required in production even though it carries a default.
        const guard = /\.superRefine\(([\s\S]*?)\n {4}\}\);/.exec(source)?.[1] ?? '';

        for (const [, key = '', declaration = ''] of source.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(.+?),?\s*$/gm)) {
            if (!SECRET_KEY_RE.test(key)) continue;
            if (SAFE_SECRET_FORMS.test(declaration)) continue;
            if (!/\.default\(/.test(declaration)) continue;
            if (guard.includes(key)) continue;

            fail(
                rel,
                `${key} is a secret with a bare .default() and no superRefine guard`,
                'A defaulted key is exempt from fail-fast permanently: Zod cannot complain about something absent when the schema hands it a value, so a deploy that forgets it boots on the placeholder. Use requiredSecret()/hexSecret() (no default), infraDefault() (re-arms in prod), .optional() (typed as absent), or name it in the superRefine.',
            );
        }
    }

    // ── 5. A shared key is declared once ─────────────────────────────────────
    for (const service of services) {
        const source = read(service.config);
        const own = schemaFieldKeys(source);

        for (const [, name = ''] of source.matchAll(/\.\.\.(\w+)/g)) {
            for (const key of fragments[name] ?? []) {
                if (!own.has(key)) continue;
                fail(
                    service.config,
                    `redeclares ${key}, which it already gets from \`...${name}\``,
                    `The local field silently wins and ${String(sharedEnv)} stops being the source of truth for it. That is how two services end up validating the same variable differently — and the one that is wrong is the one nobody reads.`,
                );
            }
        }
    }

    // ── 6. The canonical config tree ─────────────────────────────────────────
    for (const [rel, groups] of Object.entries(canonicalGroups)) {
        const source = read(rel);
        // `as const` is optional; both spellings appear across the repos.
        const body = /export const config = \{([\s\S]*)\n\}(?: as const)?;/.exec(source)?.[1];
        if (body === undefined) {
            fail(
                rel,
                'has no `export const config = { … }`',
                'The config module shape is a cross-standard interface — if it moved, every rule that reads it stopped checking and this one has to be re-pointed.',
            );
            continue;
        }
        for (const group of groups) {
            if (new RegExp(String.raw`^ {4}${group}\b`, 'm').test(body)) continue;
            fail(
                rel,
                `does not export config.${group}`,
                'The canonical config tree is read by more than this service: the database standard reads config.mongo, the api standard reads config.corsOrigin and config.jwt, observability reads config.redis. Renaming a group breaks every consumer at once, and none of them at compile time.',
            );
        }
    }

    // ── 7. A committed .env.example holds no real secret ─────────────────────
    for (const rel of exampleFiles) {
        if (!exists(rel)) continue;
        const source = read(rel);

        for (const { what, re } of REAL_SECRET_SHAPES) {
            if (!re.test(source)) continue;
            fail(
                rel,
                `contains what looks like ${what}`,
                'A committed secret is in the git history forever — deleting the line does not remove it. Rotate the value first, then replace it here with an obvious placeholder.',
            );
        }

        for (const [, key] of source.matchAll(VITE_SECRET_RE)) {
            fail(
                rel,
                `declares ${String(key)}`,
                'Only VITE_*-prefixed vars reach the browser, and ALL of them do — Vite inlines them into the bundle at build time. A secret named VITE_* is a secret published to every visitor. API URLs and public feature flags only.',
            );
        }
    }

    // ── 8. .env is ignored, .env.example is not ──────────────────────────────
    if (gitignore) {
        for (const service of services) {
            if (service.local !== undefined) {
                const ignoredLocal = gitIgnores(root, service.local);
                if (ignoredLocal === null) {
                    warnings.push(
                        `Could not ask git whether ${service.local} is ignored (no repository here?), so that rule did not run.`,
                    );
                } else if (!ignoredLocal) {
                    fail(
                        '.gitignore',
                        `does not ignore \`${service.local}\``,
                        'The real env holds live secrets. Committing one publishes every key at once, and deleting the line later does not remove it from the history.',
                    );
                }
            }

            const ignoredExample = gitIgnores(root, service.example);
            if (ignoredExample === true) {
                fail(
                    '.gitignore',
                    `ignores \`${service.example}\``,
                    'A broad `*.env` rule swallows the example too, so the file each service documents its keys in stops being committed — and the drift check above silently has nothing left to compare against.',
                );
            }
        }
    }

    // ── 9. process.env is read only where the schema is ──────────────────────
    const allowed = new Set([...services.map((s) => s.config), ...services.map((s) => s.entry)]);
    for (const dir of businessDirs ?? []) {
        for (const rel of walk(root, dir)) {
            if (allowed.has(rel)) continue;
            if (/(^|[\\/])__tests__[\\/]|\.test\.ts$|\.spec\.ts$/.test(rel)) continue;

            const line = read(rel)
                .split('\n')
                .findIndex((text) => /process\.env\b/.test(text.replace(/\/\/.*$/, '')));
            if (line === -1) continue;

            fail(
                `${rel}:${line + 1}`,
                'reads process.env directly',
                'Env has one validated boundary, and it is the Zod schema in the config module. A key read here is coerced by hand, defaulted by hand, typed `string | undefined`, and invisible to the drift check above — which is why it is the one that will be missing in production.',
            );
        }
    }

    return { problems, warnings, services: summary };
}

/** Run the gate and print. */
export function checkEnvDrift({ root = REPO_ROOT, standard, ...rest }: EnvDriftOptions): void {
    const report = createGateReport({ name: 'Env drift', ...(standard === undefined ? {} : { standard }) });
    const { problems, warnings, services } = inspectEnvDrift({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    const keys = services.reduce((total, service) => total + service.keys, 0);
    report.done({
        summary:
            `${services.length} service(s) documenting all ${keys} env keys, dotenv loaded first, ` +
            'no secret on a bare default, no shared key redeclared, the canonical config tree intact, ' +
            'no real secret in a committed example and no process.env read outside the schema.',
        notMachineChecked:
            'Whether a value is the RIGHT value, whether a default is sensible, whether a key that should be a secret is named like one, and whether the production env actually has every key this repo says it needs.',
    });

    // After the report; warnings never set an exit code.
    if (report.count === 0) for (const warning of warnings) console.warn(`\n⚠ ${warning}`);
}
