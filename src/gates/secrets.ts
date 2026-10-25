/**
 * No credentials in what git would commit: every tracked file, and every untracked file
 * git does not ignore. It fails on:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   - a file that only ever holds secrets: a `.env` other than an example, a keystore,
 *     an SSH private key, `.netrc`;
 *   - a token whose shape names its issuer (AWS, GitHub, Stripe, …) or a private key block;
 *   - a password in a connection URL, or a registry token in `.npmrc`;
 *   - a random-looking string assigned to a name like `password` or `apiKey`.
 *
 * A finding prints its first characters only: a CI log is not a place to repeat a secret.
 * A false positive is waived by file and rule, with a reason; a waiver that matches
 * nothing fails.
 */
import fs from 'node:fs';
import path from 'node:path';

import { repoFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type SecretsOptions = {
    /** Repository root. */
    root?: string;
    /** Reviewed false positives. Empty is the goal. */
    allowlist?: SecretWaiver[];
};

type SecretRule =
    | 'secret-file'
    | 'private-key'
    | 'aws-access-key'
    | 'github-token'
    | 'gitlab-token'
    | 'slack-token'
    | 'slack-webhook'
    | 'stripe-key'
    | 'google-api-key'
    | 'npm-token'
    | 'anthropic-key'
    | 'openai-key'
    | 'sendgrid-key'
    | 'url-credentials'
    | 'registry-token'
    | 'hardcoded-credential';

type SecretWaiver = {
    /** The file, as a path from the root or a glob (`test/fixtures/**`). */
    file: string;
    /** The rule it trips. */
    rule: SecretRule;
    /** Why what it matches is not a secret: a fake for a test, a documented example. */
    reason: string;
};

type SecretsInspection = {
    /** Everything wrong, in report order. */
    problems: GateFailure[];
    /** Files read. */
    files: number;
    /** Findings passed by a waiver. */
    waived: number;
    /** Files not read: binary, or over the size cap. */
    skipped: number;
};

type ContentRule = {
    id: SecretRule;
    /** What a match is, for the report. */
    label: string;
    pattern: RegExp;
    /** Only files whose path matches this. */
    files?: RegExp;
    /** Whether the match is a real finding, for rules whose shape alone is not enough. */
    accept?: (match: RegExpExecArray) => boolean;
    /** What the report shows of the match. Defaults to its first four characters. */
    show?: (match: RegExpExecArray) => string;
};

type Finding = { file: string; line: number | null; rule: SecretRule; what: string };

/** Generated, and full of hashes that read as random. */
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock']);
const LOCKFILE_NAMES = new Set([...LOCKFILES, 'Cargo.lock']);
/** Past this a file is a build output or an asset, and is not read. */
const MAX_BYTES = 1024 * 1024;

/** Files whose only job is holding a secret, whatever they contain. */
const SECRET_FILES: [RegExp, string][] = [
    [/(^|\/)\.env(\.[^/]+)?$/, 'an env file'],
    [/\.(p12|pfx|jks|keystore|key)$/i, 'a key or keystore file'],
    [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'an SSH private key'],
    [/(^|\/)\.(netrc|pgpass|htpasswd)$/, 'a credentials file'],
];
/** The env files a project commits on purpose: names and dummy values, never the real ones. */
const ENV_EXAMPLE = /\.(example|sample|template|defaults|dist)$/;

/** Values that stand in for a secret rather than being one. */
const PLACEHOLDER =
    /^(\*+|x+|\.+|…)$|\$\{|\{\{|<|%|example|changeme|placeholder|your|dummy|fake|test|sample|redacted|secret|password|pass$|root$|admin$|user$|postgres$|dev$/i;

const CONTENT_RULES: ContentRule[] = [
    {
        id: 'private-key',
        label: 'a private key',
        pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
        show: (): string => '-----BEGIN … PRIVATE KEY-----',
    },
    {
        id: 'aws-access-key',
        label: 'an AWS access key id',
        pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
        // AWS documents its examples with ids ending in EXAMPLE.
        accept: (m): boolean => !m[0].endsWith('EXAMPLE'),
    },
    {
        id: 'github-token',
        label: 'a GitHub token',
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/,
    },
    { id: 'gitlab-token', label: 'a GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
    { id: 'slack-token', label: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
    {
        id: 'slack-webhook',
        label: 'a Slack webhook URL',
        pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
        show: (): string => 'https://hooks.slack.com/services/…',
    },
    { id: 'stripe-key', label: 'a live Stripe key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}/ },
    { id: 'google-api-key', label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
    { id: 'npm-token', label: 'an npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
    { id: 'anthropic-key', label: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
    {
        id: 'openai-key',
        label: 'an OpenAI API key',
        pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/,
    },
    { id: 'sendgrid-key', label: 'a SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/ },
    {
        id: 'url-credentials',
        label: 'a password in a URL',
        pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+):([^\s/@'"`]+)@([^\s/:?#'"`]+)/i,
        accept: (m): boolean =>
            !PLACEHOLDER.test(m[2] ?? '') && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(m[3] ?? ''),
        show: (m): string => `${m[1] ?? ''}:…@${m[3] ?? ''}`,
    },
    {
        id: 'registry-token',
        label: 'a registry token',
        pattern: /(?:_authToken|_auth|_password|npmAuthToken)\s*[=:]\s*["']?(?!["']?\$\{)([^\s"']+)/,
        files: /(^|\/)\.(npmrc|yarnrc\.yml)$/,
        show: (m): string => `${m[0].slice(0, m[0].length - (m[1]?.length ?? 0))}…`,
    },
    {
        id: 'hardcoded-credential',
        label: 'a credential assigned in code',
        pattern:
            /([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[A-Za-z0-9_]*)["']?\s*(?:=|:|:=|=>)\s*["'`]([^"'`\s]{16,})["'`]/i,
        accept: (m): boolean => looksRandom(m[2] ?? ''),
        show: (m): string => `${m[1] ?? ''} = "${(m[2] ?? '').slice(0, 4)}…"`,
    },
];

const RULE_IDS = new Set<string>(['secret-file', ...CONTENT_RULES.map((r) => r.id)]);

/**
 * The whole decision, over the files git would commit under `root`.
 * @param input.root Repository root.
 * @param [input.files] The files to read, relative to `root`. Defaults to what git would commit.
 * @param [input.allowlist=[]]
 */
export function inspectSecrets(input: {
    root: string;
    files?: string[];
    allowlist?: SecretWaiver[];
}): SecretsInspection {
    const { root, files = repoFiles(root), allowlist = [] } = input;
    const problems: GateFailure[] = [...malformedWaivers(allowlist)];

    const findings: Finding[] = [];
    let read = 0;
    let skipped = 0;
    for (const file of [...files].sort()) {
        findings.push(...fileFindings(file));
        if (LOCKFILE_NAMES.has(path.posix.basename(file))) continue;
        const text = readText(path.join(root, file));
        if (text === null) {
            skipped += 1;
            continue;
        }
        read += 1;
        findings.push(...contentFindings(file, text));
    }

    const used = new Set<SecretWaiver>();
    let waived = 0;
    for (const finding of findings) {
        const waiver = allowlist.find((w) => w.rule === finding.rule && matchesFile(w.file, finding.file));
        if (waiver !== undefined) {
            used.add(waiver);
            waived += 1;
            continue;
        }
        problems.push({
            file: finding.line === null ? finding.file : `${finding.file}:${finding.line}`,
            what: finding.what,
            why: whyItFails(finding.rule),
        });
    }

    for (const waiver of allowlist) {
        if (used.has(waiver) || !RULE_IDS.has(waiver.rule)) continue;
        problems.push({
            file: null,
            what: `the waiver for ${waiver.rule} in ${waiver.file} matches nothing`,
            why: 'Delete it: a waiver nobody needs is one nobody re-reads, and it would pass the next real secret in that file.',
        });
    }

    return { problems, files: read, waived, skipped };
}

export function checkSecrets(options: SecretsOptions = {}): void {
    const { root = REPO_ROOT, allowlist = [] } = options;
    const report = createGateReport({ name: 'Secrets' });

    const { problems, files, waived, skipped } = inspectSecrets({ root, allowlist });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const waivedNote = waived > 0 ? `, ${plural(waived, 'reviewed false positive')}` : '';
    const skippedNote = skipped > 0 ? ` (${plural(skipped, 'binary or oversized file')} not read)` : '';
    report.done({
        summary: `No secrets in ${plural(files, 'file')} git would commit${waivedNote}${skippedNote}.`,
        notMachineChecked:
            'git history — a secret deleted from the tree is still in every clone, so rotate it rather than ' +
            'removing it; a secret with no recognisable shape, such as a plain password in a config file; ' +
            'anything encoded (base64, hex); files git ignores; and binary files or files over 1 MB.',
    });
}

/** A file whose name alone says it holds a secret. */
function fileFindings(file: string): Finding[] {
    if (ENV_EXAMPLE.test(file)) return [];
    const kind = SECRET_FILES.find(([pattern]) => pattern.test(file))?.[1];
    return kind === undefined ? [] : [{ file, line: null, rule: 'secret-file', what: `${kind} git would commit` }];
}

function contentFindings(file: string, text: string): Finding[] {
    const rules = CONTENT_RULES.filter((rule) => rule.files === undefined || rule.files.test(file));
    const out: Finding[] = [];
    for (const [i, line] of text.split('\n').entries()) {
        for (const rule of rules) {
            const match = rule.pattern.exec(line);
            if (match === null || rule.accept?.(match) === false) continue;
            const shown = rule.show?.(match) ?? `${match[0].slice(0, 4)}…`;
            out.push({ file, line: i + 1, rule: rule.id, what: `${rule.label}: ${shown}` });
        }
    }
    return out;
}

/** The file as text, or null for one that is binary or too large to be source. */
function readText(absolute: string): string | null {
    if (fs.statSync(absolute).size > MAX_BYTES) return null;
    const buffer = fs.readFileSync(absolute);
    if (buffer.subarray(0, 8000).includes(0)) return null;
    return buffer.toString('utf8');
}

/** A value with no placeholder in it, mixing letters and digits with high entropy. */
function looksRandom(value: string): boolean {
    // An env var's name, or a password hash in modular crypt format (`$argon2id$…`, `$2b$…`).
    if (PLACEHOLDER.test(value) || /^[A-Z0-9_]+$/.test(value) || /^\$[a-z0-9-]+\$/.test(value)) return false;
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
    const counts = new Map<string, number>();
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy >= 3.5;
}

const matchesFile = (pattern: string, file: string): boolean => pattern === file || path.matchesGlob(file, pattern);

function whyItFails(rule: SecretRule): string {
    if (rule === 'secret-file') {
        return 'Untrack it (`git rm --cached`) and gitignore it. Commit an `.example` copy with dummy values instead, and if it was ever pushed, rotate what it held.';
    }
    if (rule === 'url-credentials' || rule === 'registry-token') {
        return 'Read it from the environment instead (an `NPM_TOKEN` variable that .npmrc reads, a `DATABASE_URL` the deploy sets). If it was ever pushed, rotate it: a deleted line is still in the history.';
    }
    return 'Move it to the environment or a secret store, and rotate it: once committed, it is in every clone and every fork. If it is a fake made for a test, waive the file for this rule with that reason.';
}

/** Waivers missing a field, or naming a rule that does not exist. */
function malformedWaivers(allowlist: SecretWaiver[]): GateFailure[] {
    return allowlist.flatMap((entry, i) => {
        const missing = ['file', 'rule', 'reason'].filter((k) => {
            const value = (entry as Record<string, unknown>)[k];
            return typeof value !== 'string' || value === '';
        });
        const label = typeof entry.file === 'string' ? ` (${entry.file})` : '';
        if (missing.length > 0) {
            return [
                {
                    file: null,
                    what: `allowlist entry ${i + 1}${label} is missing: ${missing.join(', ')}`,
                    why: 'A waiver is a decision someone has to be able to review. Without its file, rule and reason there is nothing to review.',
                },
            ];
        }
        if (RULE_IDS.has(entry.rule)) return [];
        return [
            {
                file: null,
                what: `allowlist entry ${i + 1}${label} names the rule "${entry.rule}", which does not exist`,
                why: `The rules are: ${[...RULE_IDS].join(', ')}.`,
            },
        ];
    });
}
