/**
 * Dependency audit gate with a reviewed allowlist.
 *
 * `npm audit` has no ignore mechanism, so a single upstream-blocked advisory turns
 * CI permanently red — and the usual reaction, dropping `--audit-level` to
 * critical, silently swallows every future high finding too. This wraps the audit
 * instead: high and critical advisories fail unless their GHSA is listed in
 * `allowlist`, with a reason and a review date.
 *
 * THE ALLOWLIST IS DELIBERATELY AWKWARD TO MAINTAIN. An entry must say why the
 * advisory cannot be fixed from here and why it is unreachable in this app's code,
 * and name the date to look again. Three things then fail the build on their own:
 *
 *   - an entry past its review date, so a "temporary" waiver cannot quietly
 *     become permanent while the advisory is still open;
 *   - an entry npm no longer reports at all, because upstream shipped the fix and
 *     the waiver — plus any workaround it describes — is now stale;
 *   - an entry missing any of its four fields, because a waiver nobody can read
 *     is a waiver nobody reviewed.
 *
 * TWO COPIES, TWO DIFFERENT HALVES OF THE SAME IDEA. The full-stack gate had the
 * expiry and only PRINTED a note about a stale entry; the desktop gate dropped the
 * expiry and made the stale entry fail. The two guard different failures — one is
 * "you stopped looking", the other is "you no longer need to" — so the superset
 * keeps both, and both allowlists were empty, so it cost nothing to adopt.
 *
 * TWO CORRECTNESS FIXES TAKEN FROM THE DESKTOP COPY:
 *
 *   - `npm audit` reporting an ERROR is now a gate failure. The other copy parsed
 *     the JSON and carried on with no vulnerabilities, so a registry that was
 *     unreachable printed a clean audit. An audit that did not run has verified
 *     nothing, and must not look identical to one that found nothing.
 *   - A waiver is "still reported" if it appears at ANY severity, not only at
 *     high or critical. Matching against the filtered rows meant a waiver for an
 *     advisory downgraded to moderate was reported as stale while it was still
 *     live.
 */
import { execFileSync } from 'node:child_process';

import { createGateReport, plural } from './report.js';
import { REPO_ROOT } from './repo-root.js';

/**
 * @typedef {object} AllowlistEntry
 * @property {string} id The advisory, as a GHSA id — the last segment of the advisory URL.
 * @property {string} package The package npm reports it against.
 * @property {string} reason Why it cannot be fixed here, AND why it is unreachable in this code.
 * @property {string} expires `YYYY-MM-DD`: when to look again. Past it, the gate fails.
 */

/**
 * @typedef {object} Finding
 * @property {string} package
 * @property {string} id
 * @property {string} title
 * @property {string} severity
 */

/**
 * Flatten npm's vulnerability tree into one row per (package, advisory).
 *
 * `via` holds advisory objects for a direct hit and plain package-name strings
 * where the package is only a carrier for a dependency's advisory. Carriers would
 * double-count, so only the objects are collected.
 *
 * @param {any} report
 * @returns {Finding[]}
 */
function findings(report) {
    /** @type {Finding[]} */
    const rows = [];
    for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
        for (const via of /** @type {any} */ (vuln).via ?? []) {
            if (typeof via !== 'object' || via === null || via.url === undefined) continue;
            const id = String(via.url).split('/').pop() ?? via.url;
            rows.push({
                package: name,
                id,
                title: via.title ?? '',
                severity: via.severity ?? /** @type {any} */ (vuln).severity,
            });
        }
    }
    return rows;
}

/**
 * @param {string} root
 * @param {string[]} omit
 * @returns {string}
 */
function runAudit(root, omit) {
    const args = ['audit', '--json', ...omit.map((o) => `--omit=${o}`)];
    try {
        return execFileSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
        // npm audit exits non-zero whenever it finds anything, and still prints the report.
        const { stdout } = /** @type {{ stdout?: unknown }} */ (err);
        if (typeof stdout === 'string' && stdout.length > 0) return stdout;
        throw err;
    }
}

/**
 * @typedef {object} AuditOptions
 * @property {string} [root] Repository root; `npm audit` runs here.
 * @property {AllowlistEntry[]} [allowlist=[]] Reviewed waivers. Empty is the goal.
 * @property {string[]} [failSeverities=['high','critical']] Which severities block.
 * @property {string[]} [omit=['dev']] What to pass to `--omit`.
 * @property {string} [today] The date to compare `expires` against. For tests.
 */

/**
 * @typedef {object} AuditProblem
 * @property {string | null} file The package the advisory is against, or null for a
 *   finding about the allowlist itself.
 * @property {string} what
 * @property {string} why
 */

/**
 * @typedef {object} AuditInspection
 * @property {AuditProblem[]} problems Everything wrong, in report order.
 * @property {number} waived Advisories covered by a waiver still within its review date.
 * @property {boolean} ran Whether the audit itself completed. False means nothing was verified.
 */

/**
 * The whole decision, separated from running `npm audit` and printing.
 *
 * Split out so the rules can be tested against the JSON npm actually emits,
 * rather than by installing a vulnerable package and hoping the advisory is still
 * open on the day the suite runs.
 *
 * @param {object} input
 * @param {any} [input.report] Parsed `npm audit --json`. Omit it to mean "the audit did not run".
 * @param {string} [input.auditError] Why the audit did not run, when it did not.
 * @param {AllowlistEntry[]} [input.allowlist=[]]
 * @param {string[]} [input.failSeverities=['high','critical']]
 * @param {string} [input.today]
 * @returns {AuditInspection}
 */
export function inspectAudit(input) {
    const {
        report,
        auditError,
        allowlist = [],
        failSeverities = ['high', 'critical'],
        today = new Date().toISOString().slice(0, 10),
    } = input;

    /** @type {AuditProblem[]} */
    const problems = [];
    const blocks = new Set(failSeverities);

    // A malformed waiver is checked first: it is a problem with the gate's own
    // configuration, and saying so needs no audit at all.
    for (const [i, entry] of allowlist.entries()) {
        const missing = ['id', 'package', 'reason', 'expires'].filter(
            (k) => typeof (/** @type {any} */ (entry)[k]) !== 'string' || /** @type {any} */ (entry)[k] === '',
        );
        if (missing.length > 0) {
            problems.push({
                file: null,
                what: `allowlist entry ${i + 1}${typeof entry.id === 'string' ? ` (${entry.id})` : ''} is missing: ${missing.join(', ')}`,
                why: 'A waiver is a decision someone has to be able to review. Without all four fields there is nothing to review, and the entry silently suppresses an advisory.',
            });
        }
    }

    const ran = report !== undefined && report.error === undefined && auditError === undefined;

    if (!ran) {
        const detail = auditError ?? report?.error?.summary ?? report?.error?.code ?? 'unknown error';
        problems.push({
            file: null,
            what: `npm audit could not complete: ${detail}`,
            // An audit that did not RUN has verified nothing, and must not be
            // reportable as an audit that found nothing.
            why: 'This is an audit failure, not an audit finding. Nothing has been verified, so a green tick here would be a lie.',
        });
        return { problems, waived: 0, ran: false };
    }

    const all = findings(report);
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

    // Matched against EVERY finding, not just the blocking ones: an advisory
    // downgraded to moderate is still reported, so its waiver is not stale.
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

/**
 * @param {AuditOptions} [options]
 * @returns {void}
 */
export function checkAudit(options = {}) {
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

export default checkAudit;
