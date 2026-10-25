/**
 * The licences gate, against invented lockfiles and installed manifests in a temp repo.
 * Every package here is made up; only the licence ids are real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectLicenses } from '../src/gates/licenses.ts';

/**
 * A temp repo whose lockfile lists `packages` (lockfile key → entry). An entry with
 * `manifest` also gets an installed package.json, and keeps no `license` of its own.
 */
const repo = (t, packages) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const lock = { '': { name: 'app' } };
    for (const [key, { manifest, ...entry }] of Object.entries(packages)) {
        lock[key] = { version: '1.0.0', ...entry };
        if (manifest === undefined) continue;
        fs.mkdirSync(path.join(root, key), { recursive: true });
        fs.writeFileSync(path.join(root, key, 'package.json'), JSON.stringify(manifest));
    }
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lock }));
    return root;
};

const run = (t, packages, options = {}) =>
    inspectLicenses({ root: repo(t, packages), distribution: 'closed', ...options });
const whats = (result) => result.problems.map((p) => `${p.file ?? '-'}: ${p.what}`).join('\n');

const WAIVER = {
    package: 'left-pad-gpl',
    license: 'GPL-3.0-only',
    reason: 'runs as a separate CLI the installer downloads, never bundled into the app',
    expires: '2027-01-01',
};

// ── The baseline ─────────────────────────────────────────────────────────────

test('permissive licences pass, and each name counts once', (t) => {
    const result = run(t, {
        'node_modules/widget': { license: 'MIT' },
        'node_modules/gadget': { license: 'Apache-2.0' },
        'node_modules/gadget/node_modules/widget': { license: 'MIT', version: '2.0.0' },
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.packages, 2);
});

test('the project, its workspaces and its links are its own code, and are not read', (t) => {
    const result = run(t, {
        'frontend': { name: 'frontend', license: 'UNLICENSED' },
        'node_modules/frontend': { link: true, resolved: 'frontend' },
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.packages, 0);
});

test('a missing lockfile fails rather than passing on nothing', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = inspectLicenses({ root, distribution: 'open' });
    assert.match(whats(result), /no npm lockfile/);
});

test('a distribution other than open or closed fails', (t) => {
    const result = run(t, {}, { distribution: 'proprietary' });
    assert.match(whats(result), /not "open" or "closed"/);
});

// ── Dev dependencies ─────────────────────────────────────────────────────────

test('devDependencies are skipped unless includeDev is on', (t) => {
    const packages = { 'node_modules/test-runner': { license: 'GPL-3.0-only', dev: true } };
    assert.deepEqual(run(t, packages).problems, []);
    assert.match(whats(run(t, packages, { includeDev: true })), /GPL-3.0-only is copyleft/);
});

// ── Closed and open ──────────────────────────────────────────────────────────

test('closed: every copyleft family fails, weak or strong', (t) => {
    const result = run(t, {
        'node_modules/a': { license: 'GPL-2.0-or-later' },
        'node_modules/b': { license: 'AGPL-3.0-only' },
        'node_modules/c': { license: 'LGPL-2.1-only' },
        'node_modules/d': { license: 'MPL-2.0' },
        'node_modules/e': { license: 'GPL-2.0+' },
    });
    assert.equal(result.problems.length, 5, whats(result));
    assert.match(result.problems[1].why, /over a network/);
});

test('open: copyleft passes, and comes back for the notice', (t) => {
    const result = run(
        t,
        {
            'node_modules/zeta': { license: 'GPL-3.0-only' },
            'node_modules/alpha': { license: 'MPL-2.0' },
        },
        { distribution: 'open' },
    );
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.copyleft, [
        { package: 'alpha', license: 'MPL-2.0' },
        { package: 'zeta', license: 'GPL-3.0-only' },
    ]);
});

test('open or closed, a licence that is not open source fails', (t) => {
    for (const distribution of ['open', 'closed']) {
        const result = run(
            t,
            {
                'node_modules/a': { license: 'BUSL-1.1' },
                'node_modules/b': { license: 'CC-BY-NC-4.0' },
                'node_modules/c': { license: 'UNLICENSED' },
            },
            { distribution },
        );
        assert.equal(result.problems.length, 3, `${distribution}: ${whats(result)}`);
        assert.match(whats(result), /BUSL-1.1 is not an open-source licence/);
    }
});

test('open or closed, a missing or custom licence fails', (t) => {
    const result = run(
        t,
        {
            'node_modules/a': { manifest: { name: 'a' } },
            'node_modules/b': { license: 'SEE LICENSE IN LICENSE.md' },
            'node_modules/c': { license: 'Apache 2' },
        },
        { distribution: 'open' },
    );
    assert.match(whats(result), /a: names no licence/);
    assert.match(whats(result), /b: SEE LICENSE IN LICENSE.md is not a licence this gate recognises/);
    assert.match(whats(result), /c: Apache 2 is not a licence/);
});

// ── SPDX expressions ─────────────────────────────────────────────────────────

test('OR keeps the best option and AND the worst term', (t) => {
    const result = run(t, {
        'node_modules/dual': { license: '(MIT OR GPL-3.0-only)' },
        'node_modules/both': { license: 'MIT AND LGPL-3.0-only' },
        'node_modules/nested': { license: '(Apache-2.0 AND (MIT OR GPL-2.0-only))' },
        'node_modules/exception': { license: 'Apache-2.0 WITH LLVM-exception' },
    });
    assert.equal(whats(result), 'both: MIT AND LGPL-3.0-only is copyleft (LGPL-3.0-only)');
});

test('an expression that does not parse is unrecognised, not guessed at', (t) => {
    const result = run(t, { 'node_modules/broken': { license: '(MIT OR' } });
    assert.match(whats(result), /\(MIT OR is not a licence this gate recognises/);
});

// ── Where the licence is read from ───────────────────────────────────────────

test('a lockfile entry without a licence is read from the installed manifest, old fields included', (t) => {
    const result = run(t, {
        'node_modules/modern': { manifest: { license: 'ISC' } },
        'node_modules/object': { manifest: { license: { type: 'BSD-3-Clause' } } },
        'node_modules/legacy': { manifest: { licenses: [{ type: 'MIT', url: 'https://example.com' }] } },
        'node_modules/choice': { manifest: { licenses: [{ type: 'GPL-2.0-only' }, { type: 'MIT' }] } },
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.packages, 4);
});

test('an optional package for another platform, never installed, is skipped', (t) => {
    const result = run(t, {
        'node_modules/@native/binding-other-os': { optional: true },
        'node_modules/not-optional': {},
    });
    assert.equal(whats(result), 'not-optional: names no licence');
});

test('an aliased install is read under the name it was published as', (t) => {
    const result = run(t, { 'node_modules/alias': { name: 'real-name', license: 'GPL-3.0-only' } });
    assert.match(whats(result), /^real-name:/);
});

// ── allowLicenses ────────────────────────────────────────────────────────────

test('allowLicenses accepts an id for every package that carries it, in any case', (t) => {
    const result = run(
        t,
        {
            'node_modules/a': { license: 'MPL-2.0' },
            'node_modules/b': { license: 'Unicode-3.0' },
        },
        {
            allowLicenses: {
                'mpl-2.0': 'reviewed: the app ships these files unmodified, with their source linked in the notices',
                'Unicode-3.0': 'permissive; not in the built-in list',
            },
        },
    );
    assert.deepEqual(result.problems, []);
});

// ── Waivers ──────────────────────────────────────────────────────────────────

test('a waiver within its review date passes the package', (t) => {
    const result = run(
        t,
        { 'node_modules/left-pad-gpl': { license: 'GPL-3.0-only' } },
        { allowlist: [WAIVER], today: '2026-10-25' },
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.waived, 1);
});

test('a waiver past its review date fails', (t) => {
    const result = run(
        t,
        { 'node_modules/left-pad-gpl': { license: 'GPL-3.0-only' } },
        { allowlist: [WAIVER], today: '2027-02-01' },
    );
    assert.match(whats(result), /expired on 2027-01-01/);
});

test('a waiver for a package that is gone, or now passes, is stale', (t) => {
    assert.match(whats(run(t, {}, { allowlist: [WAIVER] })), /waived but no longer installed/);
    const now = run(
        t,
        { 'node_modules/left-pad-gpl': { license: 'GPL-3.0-only' } },
        { allowlist: [WAIVER], distribution: 'open' },
    );
    assert.match(whats(now), /which now passes without it/);
});

test('a licence change fails the package and the waiver both', (t) => {
    const result = run(t, { 'node_modules/left-pad-gpl': { license: 'AGPL-3.0-only' } }, { allowlist: [WAIVER] });
    assert.match(whats(result), /left-pad-gpl: AGPL-3.0-only is copyleft/);
    assert.match(whats(result), /waived for GPL-3.0-only, but it now reads AGPL-3.0-only/);
});

test('a waiver missing a field fails', (t) => {
    const { reason: _reason, ...partial } = WAIVER;
    const result = run(t, { 'node_modules/left-pad-gpl': { license: 'GPL-3.0-only' } }, { allowlist: [partial] });
    assert.match(whats(result), /allowlist entry 1 \(left-pad-gpl\) is missing: reason/);
});
