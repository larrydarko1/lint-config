/**
 * Cross-locale consistency, which the @intlify ESLint rules cannot see:
 *
 *   1. Plural-segment parity — the same number of `|` segments in every locale.
 *   2. Placeholder parity    — the same set of {named} tokens (order may differ).
 *   3. Array-length parity   — the same length, and never an array in one locale
 *                              and a string in another.
 *   4. createI18n options    — `escapeParameter`, `legacy` and `fallbackLocale`.
 *
 * Missing keys are left to no-missing-keys-in-other-locales.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './repo-root.ts';

export type I18nGateOptions = {
    /** Locale folder, relative to `root`. */
    localeDir: string;
    /** The file calling createI18n, relative to `root`. */
    configFile: string;
    /** The locale every other one is compared against. Defaults to `'en'`. */
    reference?: string;
    /** Repository root. Defaults to the calling repo's root. */
    root?: string;
    /** Extra sentence per required option, keyed `escapeParameter` / `legacy` / `fallbackLocale`. */
    configNotes?: Record<string, string>;
};

export type I18nGateResult = {
    errors: string[];
    locales: string[];
    keyCount: number;
    /** Set when the gate could not run at all, as opposed to finding disagreements. */
    fatal: string | null;
};

/**
 * The createI18n options every project must set, with the reason each one matters.
 * A project adds its own specifics through `configNotes` rather than restating these.
 */
const REQUIRED_OPTIONS = [
    {
        key: 'escapeParameter',
        what: 'escapeParameter: true',
        re: /escapeParameter:\s*true/,
        why:
            'SECURITY. Interpolation params are values from outside the dictionary — usernames, file paths, ' +
            'error text. With escapeParameter off, a param containing markup is interpolated unescaped, so any ' +
            'message rendered with v-html becomes an XSS sink.',
    },
    {
        key: 'legacy',
        what: 'legacy: false',
        re: /legacy:\s*false/,
        why:
            'Composition API mode. The legacy (Options API) mode installs a different, global `$t` and silently ' +
            'changes how `useI18n()` resolves scope.',
    },
    {
        key: 'fallbackLocale',
        what: 'fallbackLocale',
        re: /fallbackLocale:/,
        why: 'Without a fallback, a key missing from the active locale renders as the raw key path to the user.',
    },
];

/** One locale file as a flat map of key path → value. Arrays also get a `key[]` entry holding their length. */
function flatten(root: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (node: unknown, prefix: string): void => {
        if (Array.isArray(node)) {
            out[`${prefix}[]`] = `__array:${node.length}`;
            node.forEach((v, i) => {
                visit(v, `${prefix}[${i}]`);
            });
        } else if (node !== null && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) {
                visit(v, prefix === '' ? k : `${prefix}.${k}`);
            }
        } else if (typeof node === 'string') {
            out[prefix] = node;
        }
    };
    visit(root, '');
    return out;
}

/**
 * The set of {named} tokens in a message, sorted so order differences don't register.
 * `{'@'}` is vue-i18n's escape for a literal @, not an interpolation.
 */
function placeholders(str: string): string[] {
    return [...new Set((str.match(/\{[^}]+\}/g) ?? []).filter((t) => t !== "{'@'}"))].sort();
}

function pluralSegments(str: string): number {
    return str.split('|').length;
}

/**
 * Run the gate and return what it found, without printing or exiting.
 *
 * @param options.localeDir Locale folder, relative to `root`.
 * @param options.configFile The file calling createI18n, relative to `root`.
 * @param [options.reference='en'] The locale every other one is compared against.
 * @param [options.root] Repository root. Defaults to the caller's repo.
 * @param [options.configNotes] Extra sentence per required option
 *   (keyed `escapeParameter` / `legacy` / `fallbackLocale`), appended to the shared reason.
 * @returns `fatal` is set when the gate could not run at all (missing folder, unparseable file).
 */
export function inspectI18n(options: I18nGateOptions): I18nGateResult {
    const { localeDir, configFile, reference = 'en', root = REPO_ROOT, configNotes = {} } = options;

    const localePath = path.resolve(root, localeDir);
    const configPath = path.resolve(root, configFile);
    const fatal = (message: string) => ({ errors: [], locales: [], keyCount: 0, fatal: message });

    if (!fs.existsSync(localePath)) {
        return fatal(`Locale directory not found at ${localeDir} — update the gate's localeDir.`);
    }

    const locales = fs
        .readdirSync(localePath)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));

    if (!locales.includes(reference)) {
        return fatal(`Reference locale "${reference}.json" not found in ${localeDir}`);
    }

    const flat: Record<string, Record<string, string>> = {};
    for (const loc of locales) {
        try {
            flat[loc] = flatten(JSON.parse(fs.readFileSync(path.join(localePath, `${loc}.json`), 'utf8')));
        } catch (err) {
            return fatal(`${loc}.json could not be read as JSON — ${(err as Error).message}`);
        }
    }

    const ref = flat[reference] ?? {};
    const errors: string[] = [];

    // ── 1–3. Cross-locale value-shape parity against the reference locale ────────
    for (const loc of locales.filter((l) => l !== reference)) {
        const cur = flat[loc] ?? {};
        for (const [key, refVal] of Object.entries(ref)) {
            const curVal = cur[key];

            if (refVal.startsWith('__array:')) {
                const base = key.slice(0, -2);
                if (curVal === undefined) {
                    if (typeof cur[base] === 'string') {
                        errors.push(
                            `[${loc}] ${base}: string where ${reference} has an array of ${refVal.split(':')[1]}`,
                        );
                    }
                    continue;
                }
                if (curVal !== refVal) {
                    errors.push(
                        `[${loc}] ${base}: array length ${curVal.split(':')[1]} ≠ ${reference} ${refVal.split(':')[1]}`,
                    );
                }
                continue;
            }

            if (curVal === undefined) {
                // Absent keys are ESLint's; an array/string mismatch is not caught anywhere else.
                if (cur[`${key}[]`] !== undefined) {
                    errors.push(`[${loc}] ${key}: array where ${reference} has a string`);
                }
                continue;
            }

            const rp = pluralSegments(refVal);
            const cp = pluralSegments(curVal);
            if (rp !== cp) {
                errors.push(`[${loc}] ${key}: ${cp} plural segment(s) ≠ ${reference} ${rp} — "${curVal}"`);
            }

            const rph = placeholders(refVal).join(',');
            const cph = placeholders(curVal).join(',');
            if (rph !== cph) {
                errors.push(`[${loc}] ${key}: placeholders [${cph}] ≠ ${reference} [${rph}]`);
            }
        }
    }

    // ── 4. createI18n options ───────────────────────────────────────────────────
    if (!fs.existsSync(configPath)) {
        return fatal(`createI18n config not found at ${configFile} — update the gate's configFile.`);
    }
    const source = fs.readFileSync(configPath, 'utf8');
    for (const { key, what, re, why } of REQUIRED_OPTIONS) {
        if (!re.test(source)) {
            const note = configNotes[key];
            errors.push(
                `[${configFile}] createI18n is missing \`${what}\` — ${why}${note === undefined ? '' : ` ${note}`}`,
            );
        }
    }

    const keyCount = Object.keys(ref).filter((k) => !k.endsWith('[]')).length;
    return { errors, locales, keyCount, fatal: null };
}

/** The gate as a project runs it: inspect, print, and set the exit code. */
export function checkI18n(options: I18nGateOptions): void {
    const { errors, locales, keyCount, fatal } = inspectI18n(options);

    if (fatal !== null) {
        console.error(`✗ ${fatal}`);
        process.exitCode = 1;
        return;
    }

    if (errors.length > 0) {
        console.error(`✗ i18n check failed — ${errors.length} problem(s):\n`);
        for (const e of errors) console.error(`  ${e}`);
        console.error(
            `\nLocales checked: ${locales.join(', ')} (${keyCount} keys, ${options.reference ?? 'en'} = reference)`,
        );
        process.exitCode = 1;
        return;
    }

    console.log(
        `✓ i18n check passed — ${locales.length} locales, ${keyCount} keys, ` +
            `plural/placeholder/array shapes consistent, createI18n options intact.`,
    );
}
