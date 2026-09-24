/**
 * The audit gate's decision, against the JSON `npm audit --json` actually emits.
 *
 * Driven through `inspectAudit` rather than by shelling out: a test that installs
 * a vulnerable package passes or fails depending on what upstream did that week,
 * which is the opposite of what a gate's own suite should depend on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectAudit } from '../src/gates/audit.ts';

/** An `npm audit --json` payload with one advisory per entry. */
const report = (...advisories) => ({
    vulnerabilities: Object.fromEntries(
        advisories.map(({ pkg, id, severity, title = 'something bad', carriers = [] }) => [
            pkg,
            {
                severity,
                via: [...carriers, { url: `https://github.com/advisories/${id}`, title, severity }],
            },
        ]),
    ),
});

const WAIVER = {
    id: 'GHSA-1111-1111-1111',
    package: 'tar',
    reason: 'the fix is in a major nothing has released yet, and this app never extracts an untrusted archive',
    expires: '2027-01-01',
};

const whats = (result) => result.problems.map((p) => p.what).join('\n');

// ── The baseline ─────────────────────────────────────────────────────────────

test('a clean audit with an empty allowlist has nothing to say', () => {
    const result = inspectAudit({ report: { vulnerabilities: {} } });
    assert.deepEqual(result.problems, []);
    assert.equal(result.waived, 0);
    assert.equal(result.ran, true);
});

// ── Severity ─────────────────────────────────────────────────────────────────

test('a high or critical advisory with no waiver blocks; a moderate one does not', () => {
    const result = inspectAudit({
        report: report(
            { pkg: 'tar', id: 'GHSA-1111-1111-1111', severity: 'high' },
            { pkg: 'semver', id: 'GHSA-2222-2222-2222', severity: 'critical' },
            { pkg: 'debug', id: 'GHSA-3333-3333-3333', severity: 'moderate' },
        ),
    });
    assert.equal(result.problems.length, 2);
    assert.match(whats(result), /HIGH GHSA-1111-1111-1111/);
    assert.match(whats(result), /CRITICAL GHSA-2222-2222-2222/);
    assert.doesNotMatch(whats(result), /GHSA-3333/);
});

test('failSeverities is configurable, and widening it catches the moderate one', () => {
    const result = inspectAudit({
        report: report({ pkg: 'debug', id: 'GHSA-3333-3333-3333', severity: 'moderate' }),
        failSeverities: ['moderate', 'high', 'critical'],
    });
    assert.match(whats(result), /MODERATE GHSA-3333-3333-3333/);
});

test('a carrier package does not double-count the advisory it carries', () => {
    // npm puts a plain package-name string in `via` where the package is only a
    // route to a dependency's advisory. Counting those reports one problem twice.
    const result = inspectAudit({
        report: report({
            pkg: 'tar',
            id: 'GHSA-1111-1111-1111',
            severity: 'high',
            carriers: ['minizlib', 'fs-minipass'],
        }),
    });
    assert.equal(result.problems.length, 1);
});

test('an advisory with no severity of its own inherits the package level', () => {
    const raw = {
        vulnerabilities: {
            tar: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-1111-1111-1111', title: 'x' }] },
        },
    };
    assert.match(whats(inspectAudit({ report: raw })), /HIGH GHSA-1111-1111-1111/);
});

// ── The allowlist ────────────────────────────────────────────────────────────

test('a waiver within its review date silences the advisory and is counted', () => {
    const result = inspectAudit({
        report: report({ pkg: 'tar', id: WAIVER.id, severity: 'high' }),
        allowlist: [WAIVER],
        today: '2026-09-23',
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.waived, 1);
});

test('a waiver past its review date fails, and quotes the reason back', () => {
    const result = inspectAudit({
        report: report({ pkg: 'tar', id: WAIVER.id, severity: 'high' }),
        allowlist: [WAIVER],
        today: '2027-01-02',
    });
    assert.equal(result.waived, 0);
    assert.match(whats(result), /was waived until 2027-01-01, which has passed/);
    assert.match(result.problems[0].why, /never extracts an untrusted archive/);
});

test('the expiry boundary is the day itself: a waiver is live ON its date', () => {
    const live = inspectAudit({
        report: report({ pkg: 'tar', id: WAIVER.id, severity: 'high' }),
        allowlist: [WAIVER],
        today: WAIVER.expires,
    });
    assert.deepEqual(live.problems, []);
});

test('a waiver npm no longer reports fails: upstream shipped the fix', () => {
    const result = inspectAudit({ report: { vulnerabilities: {} }, allowlist: [WAIVER], today: '2026-09-23' });
    assert.match(whats(result), /is allowlisted but npm audit no longer reports it/);
});

test('a waiver for an advisory downgraded below the fail level is NOT stale', () => {
    // The full-stack copy matched waivers against the filtered rows, so a high
    // advisory that upstream re-scored as moderate was reported as "no longer
    // reported" while it was still live and still waived.
    const result = inspectAudit({
        report: report({ pkg: 'tar', id: WAIVER.id, severity: 'moderate' }),
        allowlist: [WAIVER],
        today: '2026-09-23',
    });
    assert.deepEqual(result.problems, []);
    // It is not counted as waived either — nothing was blocked.
    assert.equal(result.waived, 0);
});

test('a waiver missing any of its four fields fails before anything else', () => {
    const result = inspectAudit({
        report: report({ pkg: 'tar', id: WAIVER.id, severity: 'high' }),
        allowlist: [{ id: WAIVER.id, package: 'tar' }],
        today: '2026-09-23',
    });
    assert.match(whats(result), /allowlist entry 1 \(GHSA-1111-1111-1111\) is missing: reason, expires/);
});

test('an empty string is not a reason', () => {
    const result = inspectAudit({
        report: { vulnerabilities: {} },
        allowlist: [{ ...WAIVER, reason: '' }],
        today: '2026-09-23',
    });
    assert.match(whats(result), /is missing: reason/);
});

// ── An audit that did not run ────────────────────────────────────────────────

test('an npm audit ERROR is a gate failure, not a clean audit', () => {
    // The full-stack copy parsed this payload, found no `vulnerabilities` key and
    // reported a clean audit — so an unreachable registry looked like a green tick.
    const result = inspectAudit({
        report: { error: { code: 'ENETUNREACH', summary: 'request to https://registry.npmjs.org failed' } },
    });
    assert.equal(result.ran, false);
    assert.match(whats(result), /npm audit could not complete: request to https:\/\/registry\.npmjs\.org failed/);
    assert.match(result.problems[0].why, /Nothing has been verified/);
});

test('npm failing to run at all is the same failure', () => {
    const result = inspectAudit({ auditError: 'spawn npm ENOENT' });
    assert.equal(result.ran, false);
    assert.match(whats(result), /spawn npm ENOENT/);
});

test('when the audit did not run, waivers are not ALSO reported as stale', () => {
    // Every waiver would look stale at once, burying the one failure that matters.
    const result = inspectAudit({ auditError: 'spawn npm ENOENT', allowlist: [WAIVER] });
    assert.equal(result.problems.length, 1);
    assert.doesNotMatch(whats(result), /no longer reports it/);
});

test('a malformed waiver is still reported when the audit did not run', () => {
    // It is a problem with this file, and saying so needs no network.
    const result = inspectAudit({ auditError: 'offline', allowlist: [{ id: 'GHSA-x' }] });
    assert.equal(result.problems.length, 2);
    assert.match(whats(result), /is missing: package, reason, expires/);
});
