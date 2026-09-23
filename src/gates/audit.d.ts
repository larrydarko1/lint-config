export type AllowlistEntry = {
    /** The advisory, as a GHSA id — the last segment of the advisory URL. */
    id: string;
    /** The package npm reports it against. */
    package: string;
    /** Why it cannot be fixed here, AND why it is unreachable in this code. */
    reason: string;
    /** `YYYY-MM-DD`: when to look again. Past it, the gate fails. */
    expires: string;
};

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

export type AuditProblem = {
    /** The package the advisory is against, or null for a finding about the allowlist itself. */
    file: string | null;
    what: string;
    why: string;
};

export type AuditInspection = {
    /** Everything wrong, in report order. */
    problems: AuditProblem[];
    /** Advisories covered by a waiver still within its review date. */
    waived: number;
    /** Whether the audit itself completed. False means nothing was verified. */
    ran: boolean;
};

/** The whole decision, separated from running `npm audit` and printing. */
export declare function inspectAudit(input: {
    /** Parsed `npm audit --json`. Omit it to mean "the audit did not run". */
    report?: unknown;
    /** Why the audit did not run, when it did not. */
    auditError?: string;
    allowlist?: AllowlistEntry[];
    failSeverities?: string[];
    today?: string;
}): AuditInspection;

export declare function checkAudit(options?: AuditOptions): void;
export default checkAudit;
