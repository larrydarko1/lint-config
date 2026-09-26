/**
 * `npm audit` with a reviewed allowlist. High and critical advisories fail unless
 * their GHSA is waived with a reason and a review date. The build also fails on:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   - a waiver past its review date;
 *   - a waiver npm no longer reports at any severity (the fix shipped);
 *   - a waiver missing any of its four fields;
 *   - an audit that did not run (e.g. the registry was unreachable).
 */
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type AuditOptions = {
    /** Repository root; `npm audit` runs here. */
    root?: string;
    /** Reviewed waivers. Empty is the goal. */
    allowlist?: AllowlistEntry[];
    /** Which severities block. Defaults to high and critical. */
    failSeverities?: string[];
    /** What to pass to `--omit`. Defaults to `['dev']`. */
    omit?: string[];
    /** The date to compare `expires` against. For tests. */
    today?: string;
};

type AllowlistEntry = {
    /** The advisory, as a GHSA id — the last segment of the advisory URL. */
    id: string;
    /** The package npm reports it against. */
    package: string;
    /** Why it cannot be fixed here, AND why it is unreachable in this code. */
    reason: string;
    /** `YYYY-MM-DD`: when to look again. Past it, the gate fails. */
    expires: string;
};


type AuditInspection = {
    /** Everything wrong, in report order. */
    problems: GateFailure[];
    /** Advisories covered by a waiver still within its review date. */
    waived: number;
    /** Whether the audit itself completed. False means nothing was verified. */
    ran: boolean;
};

/** `npm audit --json`, reduced to what this gate reads. */
type NpmAuditReport = {
    error?: { summary?: string; code?: string };
    vulnerabilities?: Record<
        string,
        {
            severity?: string;
            /** Advisory objects, or the names of dependencies the advisory arrives through. */
            via?: (string | { url?: string; title?: string; severity?: string })[];
        }
    >;
};

type Finding = {
    package: string;
    id: string;
    title: string;
    severity: string;
};

/** One row per (package, advisory). String `via` entries are carriers and would double-count. */
function findings(report: NpmAuditReport): Finding[] {
    const rows: Finding[] = [];
    for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
        for (const via of vuln.via ?? []) {
            if (typeof via !== 'object' || via === null || via.url === undefined) continue;
            const id = String(via.url).split('/').pop() ?? via.url;
            rows.push({
                package: name,
                id,
                title: via.title ?? '',
                severity: via.severity ?? vuln.severity ?? '',
            });
        }
    }
    return rows;
}

function runAudit(root: string, omit: string[]): string {
    const args = ['audit', '--json', ...omit.map((o) => `--omit=${o}`)];
    try {
        return execFileSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
        // npm audit exits non-zero whenever it finds anything, and still prints the report.
        const { stdout } = err as { stdout?: unknown };
        if (typeof stdout === 'string' && stdout.length > 0) return stdout;
        throw err;
    }
}

/**
 * The whole decision, separated from running `npm audit` and printing so it can be
 * tested against recorded JSON.
 * @param [input.report] Parsed `npm audit --json`. Omit it to mean "the audit did not run".
 * @param [input.auditError] Why the audit did not run, when it did not.
 * @param [input.allowlist=[]]
 * @param [input.failSeverities=['high','critical']]
 */
export function inspectAudit(input: {
    /** Parsed `npm audit --json`. Omit it to mean "the audit did not run". */
    report?: unknown;
    /** Why the audit did not run, when it did not. */
    auditError?: string | undefined;
    allowlist?: AllowlistEntry[];
    failSeverities?: string[];
    today?: string | undefined;
}): AuditInspection {
    const {
        report,
        auditError,
        allowlist = [],
        failSeverities = ['high', 'critical'],
        today = new Date().toISOString().slice(0, 10),
    } = input;

    const problems: GateFailure[] = [];
    const blocks = new Set(failSeverities);

    // Malformed waivers need no audit to report.
    for (const [i, entry] of allowlist.entries()) {
        const missing = ['id', 'package', 'reason', 'expires'].filter((k) => {
            const value = (entry as Record<string, unknown>)[k];
            return typeof value !== 'string' || value === '';
        });
        if (missing.length > 0) {
            problems.push({
                file: null,
                what: `allowlist entry ${i + 1}${typeof entry.id === 'string' ? ` (${entry.id})` : ''} is missing: ${missing.join(', ')}`,
                why: 'A waiver is a decision someone has to be able to review. Without all four fields there is nothing to review, and the entry silently suppresses an advisory.',
            });
        }
    }

    // Whatever npm printed. Every field below is optional, and each is checked before use.
    const audit = report as NpmAuditReport | undefined;
    const ran = audit !== undefined && audit.error === undefined && auditError === undefined;

    if (!ran) {
        const detail = auditError ?? audit?.error?.summary ?? audit?.error?.code ?? 'unknown error';
        problems.push({
            file: null,
            what: `npm audit could not complete: ${detail}`,
            why: 'This is an audit failure, not an audit finding. Nothing has been verified, so a green tick here would be a lie.',
        });
        return { problems, waived: 0, ran: false };
    }

    const all = findings(audit);
    const allowed = new Map(allowlist.map((e) => [e.id, e]));
    let waived = 0;

    for (const row of all.filter((r) => blocks.has(r.severity))) {
        const entry = allowed.get(row.id);
        if (entry === undefined) {
            problems.push({
                file: row.package,
                what: `${row.severity.toUpperCase()} ${row.id} — ${row.title}`,
                why: 'Upgrade it. Add it to this gate’s allowlist only if upstream makes that impossible, and say there why it is unreachable in this code.',
            });
        } else if (entry.expires < today) {
            problems.push({
                file: row.package,
                what: `${row.id} was waived until ${entry.expires}, which has passed`,
                why: `Re-check upstream: the reason recorded was "${entry.reason}". Extend the date only with a fresh reason, or remove the entry and fix it.`,
            });
        } else {
            waived += 1;
        }
    }

    // Every finding, not just blocking ones: a downgraded advisory's waiver is not stale.
    const seen = new Set(all.map((r) => r.id));
    for (const entry of allowlist) {
        if (seen.has(entry.id)) continue;
        problems.push({
            file: null,
            what: `${entry.id} (${entry.package}) is allowlisted but npm audit no longer reports it`,
            why: 'Upstream shipped the fix. Delete the entry and any workaround it describes — a waiver nobody needs is one nobody re-reads, and the workaround outlives the reason for it.',
        });
    }

    return { problems, waived, ran: true };
}

export function checkAudit(options: AuditOptions = {}): void {
    const { root = REPO_ROOT, allowlist = [], failSeverities = ['high', 'critical'], omit = ['dev'], today } = options;

    const report = createGateReport({ name: 'Audit' });

    let parsed;
    let auditError;
    try {
        parsed = JSON.parse(runAudit(root, omit));
    } catch (err) {
        auditError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
    }

    const { problems, waived } = inspectAudit({ report: parsed, auditError, allowlist, failSeverities, today });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const severities = failSeverities.join('/');
    report.done({
        summary:
            `Audit clean — no unreviewed ${severities} advisories` +
            `${waived > 0 ? `, ${plural(waived, 'reviewed waiver')} still within its review date` : ''}.`,
        notMachineChecked:
            `whether a waiver’s reasoning is still true, whether an advisory below ${severities} matters in ` +
            `this app’s context, or anything under \`--omit=${omit.join(', --omit=')}\` — a compromised build ` +
            'tool ships whatever it likes, and this gate never looked at it.',
    });
}
