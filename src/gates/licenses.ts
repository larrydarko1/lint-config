/**
 * The licences of what a project ships, read from npm's lockfile. Every package in the
 * production tree needs a licence the project's `distribution` allows:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   - `closed`, a proprietary app: permissive licences only, so any copyleft fails.
 *   - `open`, an app whose source is published: copyleft passes too, and the pass names
 *     each copyleft package, because its terms then reach the whole app.
 *   - Either way, a licence that is missing, unrecognised, `UNLICENSED` or not open
 *     source (non-commercial, source-available) fails.
 *
 * A failing package can be waived with a reason and a review date, as in `audit`. A waiver
 * fails once it expires, once the package is gone, or once its licence changes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from './lib/json.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type LicensesOptions = {
    /** Repository root, where `package-lock.json` and `node_modules` are. */
    root?: string;
    /**
     * `closed` when the app's source is private, `open` when it is published under an
     * open-source licence. There is no default: it decides what the gate allows.
     */
    distribution: Distribution;
    /** Licence ids accepted for every package that carries them, each with the reason. */
    allowLicenses?: Record<string, string>;
    /** Reviewed waivers, one per package. Empty is the goal. */
    allowlist?: LicenseWaiver[];
    /** Read devDependencies too. Defaults to false: a build tool's licence does not ship. */
    includeDev?: boolean;
    /** The date to compare `expires` against. For tests. */
    today?: string;
};

type Distribution = 'open' | 'closed';

type LicenseWaiver = {
    /** The package name, as npm installs it. */
    package: string;
    /** The licence as this gate reports it (`none` when the package names none). */
    license: string;
    /** Why it is acceptable here: what the licence requires, and how this app meets it. */
    reason: string;
    /** `YYYY-MM-DD`: when to look again. Past it, the gate fails. */
    expires: string;
};

type LicensesInspection = {
    /** Everything wrong, in report order. */
    problems: GateFailure[];
    /** Distinct packages read, by name. */
    packages: number;
    /** Packages passed by a waiver still within its review date. */
    waived: number;
    /** Copyleft packages an `open` distribution allowed, for the notice on a pass. */
    copyleft: { package: string; license: string }[];
};

/** Best first: an `OR` keeps the best of its options, an `AND` the worst of its terms. */
type Kind = 'permissive' | 'copyleft' | 'not-open' | 'unknown';

type Verdict = { kind: Kind; ids: string[] };

/** A `packages` entry of `package-lock.json`, reduced to what this gate reads. */
type LockEntry = {
    name?: string;
    license?: unknown;
    dev?: boolean;
    optional?: boolean;
    link?: boolean;
};

/** One installed package, as this gate reads it. */
type Installed = { name: string; license: string; optional: boolean; read: boolean };

const RANK: Kind[] = ['permissive', 'copyleft', 'not-open', 'unknown'];

/** SPDX ids, upper-cased. Each lets the work be used, changed and shipped closed, keeping the notice. */
const PERMISSIVE = new Set([
    '0BSD',
    'APACHE-2.0',
    'ARTISTIC-2.0',
    'BLUEOAK-1.0.0',
    'BSD-2-CLAUSE',
    'BSD-3-CLAUSE',
    'BSL-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'CC0-1.0',
    'ISC',
    'MIT',
    'MIT-0',
    'PSF-2.0',
    'PYTHON-2.0',
    'UNLICENSE',
    'UPL-1.0',
    'WTFPL',
    'X11',
    'ZLIB',
]);

/** What each copyleft family asks of the work that ships it. */
const COPYLEFT: [RegExp, string][] = [
    [/^AGPL-/, 'anyone who uses the app over a network is owed its complete source, not only those who get a copy'],
    [/^(GPL|EUPL|OSL)-/, 'a work that includes it must be released as a whole under the same licence, with its source'],
    [
        /^LGPL-/,
        'users must be able to swap in their own build of it, which a bundler that inlines it into your code rules out',
    ],
    [/^(MPL|EPL|CDDL|CPL)-/, 'its own files, changed or not, ship with their source under the same licence'],
    [/^CC-BY-SA-/, 'an adaptation must be shared under the same licence'],
];

/** Licences that restrict commercial use, changes or redistribution, so are not open source. */
const NOT_OPEN = /^(UNLICENSED$|BUSL-|SSPL-|ELASTIC-|POLYFORM-|CC-BY-NC|CC-BY-ND|COMMONS-CLAUSE)/;

const NONE = 'none';

/**
 * The whole decision, from the lockfile and the installed manifests under `root`.
 * @param input.root Repository root.
 * @param input.distribution `open` or `closed`.
 */
export function inspectLicenses(input: LicensesOptions & { root: string }): LicensesInspection {
    const {
        root,
        distribution,
        allowLicenses = {},
        allowlist = [],
        includeDev = false,
        today = new Date().toISOString().slice(0, 10),
    } = input;
    const problems: GateFailure[] = [];
    const empty = { problems, packages: 0, waived: 0, copyleft: [] };

    // Typed, but a plain-JS config can pass anything.
    const mode: unknown = distribution;
    if (mode !== 'open' && mode !== 'closed') {
        problems.push({
            file: null,
            what: `distribution is ${JSON.stringify(mode)}, not "open" or "closed"`,
            why: 'Which licences an app may ship depends on whether its own source is published, so the gate needs to be told. Nothing was checked.',
        });
        return empty;
    }
    problems.push(...malformedWaivers(allowlist));

    const installed = readInstalled(root, includeDev);
    if (installed === null) {
        problems.push({
            file: 'package-lock.json',
            what: 'there is no npm lockfile to read',
            why: 'The gate reads the dependency tree npm resolved. Run `npm install` and commit package-lock.json. Nothing was checked.',
        });
        return empty;
    }

    const accepted = new Set(Object.keys(allowLicenses).map((id) => id.toUpperCase()));
    const waivers = new Map(allowlist.map((w) => [w.package, w]));
    const used = new Set<LicenseWaiver>();
    const copyleft = new Map<string, string>();
    let waived = 0;

    const rows = [...installed].flatMap(([name, licenses]) => [...licenses].map((license) => ({ name, license })));
    for (const { name, license } of rows) {
        const verdict = classify(license, accepted);
        if (verdict.kind === 'permissive') continue;
        if (verdict.kind === 'copyleft' && distribution === 'open') {
            copyleft.set(name, license);
            continue;
        }
        const waiver = waivers.get(name);
        if (waiver?.license !== license) {
            problems.push({ file: name, what: describe(license, verdict), why: whyItFails(verdict, distribution) });
            continue;
        }
        used.add(waiver);
        if (waiver.expires >= today) {
            waived += 1;
            continue;
        }
        problems.push({
            file: name,
            what: `the waiver for ${license} expired on ${waiver.expires}`,
            why: `Read the licence again: the reason recorded was "${waiver.reason}". Extend the date only with a fresh reason, or replace the package.`,
        });
    }

    for (const waiver of allowlist) {
        if (used.has(waiver)) continue;
        problems.push({ file: null, ...staleWaiver(waiver, installed.get(waiver.package)) });
    }

    return {
        problems,
        packages: installed.size,
        waived,
        copyleft: [...copyleft].map(([name, license]) => ({ package: name, license })).sort(byPackage),
    };
}

export function checkLicenses(options: LicensesOptions): void {
    const { root = REPO_ROOT, distribution, includeDev = false } = options;
    const report = createGateReport({ name: 'Licences' });

    const { problems, packages, waived, copyleft } = inspectLicenses({ ...options, root });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const tree = includeDev ? 'installed' : 'production';
    const app = distribution === 'open' ? 'an open-source app' : 'a closed-source app';
    report.done({
        summary:
            `Licences clean — ${plural(packages, `${tree} package`)}, each allowed in ${app}` +
            `${waived > 0 ? `, ${plural(waived, 'reviewed waiver')} still within its review date` : ''}.`,
        warnings: copyleft.map(
            (c) =>
                `${c.package} is ${c.license}: copyleft, so its terms cover the app that ships it. An app under a ` +
                'permissive licence that bundles it is distributed under the copyleft licence as a whole.',
        ),
        notMachineChecked:
            'whether a package’s LICENSE file says what its manifest does; code copied in rather than installed ' +
            '(vendored files, fonts, icons, images); whether two copyleft licences are compatible with each other; ' +
            'the notices permissive licences still require you to ship' +
            `${includeDev ? '' : '; and devDependencies, which a bundler can still inline into what ships'}.`,
    });
}

const byPackage = (a: { package: string }, b: { package: string }): number => a.package.localeCompare(b.package);

/** Waivers missing any of their four fields. */
function malformedWaivers(allowlist: LicenseWaiver[]): GateFailure[] {
    return allowlist.flatMap((entry, i) => {
        const missing = ['package', 'license', 'reason', 'expires'].filter((k) => {
            const value = (entry as Record<string, unknown>)[k];
            return typeof value !== 'string' || value === '';
        });
        if (missing.length === 0) return [];
        const label = typeof entry.package === 'string' ? ` (${entry.package})` : '';
        return [
            {
                file: null,
                what: `allowlist entry ${i + 1}${label} is missing: ${missing.join(', ')}`,
                why: 'A waiver is a decision someone has to be able to review. Without all four fields there is nothing to review, and the entry silently passes a licence.',
            },
        ];
    });
}

/** A waiver nothing used: the package is gone, its licence changed, or the licence now passes. */
function staleWaiver(waiver: LicenseWaiver, now: Set<string> | undefined): { what: string; why: string } {
    const remove = 'Delete the waiver: one nobody needs is one nobody re-reads.';
    if (now === undefined) return { what: `${waiver.package} is waived but no longer installed`, why: remove };
    if (now.has(waiver.license)) {
        return { what: `${waiver.package} is waived for ${waiver.license}, which now passes without it`, why: remove };
    }
    return {
        what: `${waiver.package} is waived for ${waiver.license}, but it now reads ${[...now].join(', ')}`,
        why: 'A changed licence is a new decision. Delete the waiver, and add a new one only if the new licence fails too.',
    };
}

/**
 * Package name → every licence its installed copies carry. The project's own entries
 * (the root, workspaces, `file:` links) are its own code and are skipped.
 * @returns Null when there is no lockfile.
 */
function readInstalled(root: string, includeDev: boolean): Map<string, Set<string>> | null {
    const lockfile = path.join(root, 'package-lock.json');
    if (!fs.existsSync(lockfile)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
    const entries = isRecord(parsed) && isRecord(parsed['packages']) ? parsed['packages'] : {};

    const out = new Map<string, Set<string>>();
    for (const [key, value] of Object.entries(entries)) {
        if (!key.includes('node_modules/') || !isRecord(value)) continue;
        const entry = value as LockEntry;
        if (entry.link === true || (entry.dev === true && !includeDev)) continue;
        const one = readOne(root, key, entry);
        // An optional package for another platform is in the lockfile but not on disk.
        if (one.license === NONE && one.optional && !one.read) continue;
        const licenses = out.get(one.name) ?? new Set<string>();
        licenses.add(one.license);
        out.set(one.name, licenses);
    }
    return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** The lockfile's `license`, else the installed manifest's, which may use the older `licenses` array. */
function readOne(root: string, key: string, entry: LockEntry): Installed {
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const optional = entry.optional === true;
    if (typeof entry.license === 'string' && entry.license !== '') {
        return { name, license: entry.license, optional, read: true };
    }
    const manifestPath = path.join(root, key, 'package.json');
    if (!fs.existsSync(manifestPath)) return { name, license: NONE, optional, read: false };
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { name, license: isRecord(manifest) ? manifestLicense(manifest) : NONE, optional, read: true };
}

/** `"MIT"`, `{ type: "MIT" }`, or `licenses: [{ type }, …]`, an old way to offer a choice. */
function manifestLicense(manifest: Record<string, unknown>): string {
    const typeOf = (value: unknown): string | null => {
        if (typeof value === 'string' && value !== '') return value;
        if (isRecord(value) && typeof value['type'] === 'string' && value['type'] !== '') return value['type'];
        return null;
    };
    const single = typeOf(manifest['license']);
    if (single !== null) return single;
    const list = Array.isArray(manifest['licenses']) ? manifest['licenses'].map(typeOf).filter((t) => t !== null) : [];
    if (list.length === 0) return NONE;
    return list.length === 1 ? (list[0] ?? NONE) : `(${list.join(' OR ')})`;
}

/** An SPDX expression's verdict: what it allows at best, and the ids that decided it. */
function classify(license: string, accepted: Set<string>): Verdict {
    if (license === NONE || /^SEE LICEN[CS]E IN /i.test(license)) return { kind: 'unknown', ids: [license] };
    const tokens = license.match(/\(|\)|[^\s()]+/g) ?? [];
    let at = 0;
    const peek = (): string | undefined => tokens[at]?.toUpperCase();

    const atom = (): Verdict | null => {
        const token = tokens[at];
        at += 1;
        if (token === '(') {
            const inner = or();
            if (tokens[at] !== ')') return null;
            at += 1;
            return inner;
        }
        if (token === undefined || /^(AND|OR|WITH|\))$/i.test(token)) return null;
        // An exception (`WITH LLVM-exception`) only ever adds a permission, so the base decides.
        if (peek() === 'WITH') at += 2;
        return { kind: kindOf(token, accepted), ids: [token] };
    };
    const join = (operator: string, next: () => Verdict | null, pick: 'best' | 'worst') => (): Verdict | null => {
        let left = next();
        while (left !== null && peek() === operator) {
            at += 1;
            const right = next();
            if (right === null) return null;
            left = combine(left, right, pick);
        }
        return left;
    };
    const and = join('AND', atom, 'worst');
    const or = join('OR', and, 'best');

    const verdict = or();
    if (verdict === null || at !== tokens.length) return { kind: 'unknown', ids: [license] };
    return verdict;
}

function combine(left: Verdict, right: Verdict, pick: 'best' | 'worst'): Verdict {
    const order = RANK.indexOf(left.kind) - RANK.indexOf(right.kind);
    if (order === 0) return { kind: left.kind, ids: [...left.ids, ...right.ids] };
    const leftWins = pick === 'best' ? order < 0 : order > 0;
    return leftWins ? left : right;
}

function kindOf(id: string, accepted: Set<string>): Kind {
    // `GPL-2.0+` is the deprecated spelling of `GPL-2.0-or-later`.
    const upper = id.toUpperCase().replace(/\+$/, '');
    if (PERMISSIVE.has(upper) || accepted.has(upper) || accepted.has(id.toUpperCase())) return 'permissive';
    if (NOT_OPEN.test(upper)) return 'not-open';
    if (COPYLEFT.some(([pattern]) => pattern.test(upper))) return 'copyleft';
    return 'unknown';
}

function describe(license: string, verdict: Verdict): string {
    if (license === NONE) return 'names no licence';
    const named = verdict.ids.join(', ');
    switch (verdict.kind) {
        case 'copyleft':
            return `${license} is copyleft (${named})`;
        case 'not-open':
            return `${license} is not an open-source licence`;
        default:
            return `${license} is not a licence this gate recognises`;
    }
}

function whyItFails(verdict: Verdict, distribution: Distribution): string {
    switch (verdict.kind) {
        case 'copyleft': {
            const upper = (verdict.ids[0] ?? '').toUpperCase();
            const asks = COPYLEFT.find(([pattern]) => pattern.test(upper))?.[1] ?? 'it asks for the same licence';
            return `Copyleft: ${asks}. A ${distribution} app cannot meet that. Replace the package, buy a commercial licence if its author sells one, or waive it with the reason this app is not bound (it runs as a separate program you do not ship, say).`;
        }
        case 'not-open':
            return 'It restricts commercial use, changes or redistribution. Read its terms before shipping it: replace the package, or waive it with what the terms allow and how this app keeps to them.';
        default:
            return 'Read the package’s LICENSE file. A licence id the gate does not know goes in `allowLicenses` with a reason; a package with no usable id gets a waiver that says what its LICENSE file grants.';
    }
}
