/**
 * i18n locale consistency gate — the cross-locale half of "correct", which the
 * @intlify ESLint rules cannot see. Those check that each file is well-formed and
 * that no key is missing (valid-message-syntax, no-missing-keys-in-other-locales);
 * only this can check the locales AGREE with one another.
 *
 *   1. Plural-segment parity   — "a | b" must have the same number of `|` segments
 *                                in every locale, or vue-i18n selects the wrong
 *                                branch (or none) for that language.
 *   2. Placeholder parity      — the set of {named} interpolation tokens must match
 *                                across locales. Order may differ (word order is
 *                                language-specific), the set may not: a translator
 *                                dropping `{count}` yields a message that renders
 *                                fine and silently loses the number.
 *   3. Array-length parity     — array-valued keys must have the same length in
 *                                every locale, or the UI renders a different number
 *                                of options per language. A key that is an array in
 *                                one locale and a string in another is reported too:
 *                                `v-for` over a string iterates its characters.
 *   4. createI18n options      — `escapeParameter`, `legacy` and `fallbackLocale`.
 *                                No lint rule reads that file, and escapeParameter
 *                                is a security control, not a preference.
 *
 * A key present in the reference locale and absent elsewhere is NOT reported here:
 * that is no-missing-keys-in-other-locales' job, and two gates reporting the same
 * problem is how a gate earns a --no-verify.
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

/**
 * One locale file as a flat map of key path → value.
 *
 * Arrays get a synthetic `key[]` entry holding their length alongside their elements,
 * so a length difference is visible without walking the tree twice.
 */
function flatten(root: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    /** @param node @param {string} prefix @returns {void} */
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

/** @param str @returns {number} */
function pluralSegments(str: string): number {
    return str.split('|').length;
}

/**
 * Run the gate and report what it found, without printing or exiting — so the
 * behaviour can be tested directly instead of by shelling out and reading stdout.
 *
 * @param options.localeDir Locale folder, relative to `root`.
 * @param options.configFile The file calling createI18n, relative to `root`.
 * @param [options.reference='en'] The locale every other one is compared against.
 * @param [options.root] Repository root. Defaults to the caller's repo.
 * @param [options.configNotes] Extra sentence per required option
 *   (keyed `escapeParameter` / `legacy` / `fallbackLocale`), appended to the shared reason.
 * @returns
 *   `fatal` is set when the gate could not run at all — a missing locale folder, an
 *   unparseable file — which is a different failure from "the locales disagree".
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
                // An absent key belongs to no-missing-keys-in-other-locales. A key that is
                // present but an ARRAY here and a string in the reference does not — nothing
                // else would catch it, because both files are individually well-formed.
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

/**
 * The gate as a project runs it: inspect, print, and set the exit code.
 */
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
