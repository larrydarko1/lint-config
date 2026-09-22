/**
 * The shared reporter and the swallowed-error scan. Both are asserted through what
 * they actually emit — the reporter through captured console output and the real
 * exit code, the scan through fixtures that must FAIL as well as ones that must pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGateReport } from '../src/gates/report.js';
import { findSwallowedErrors, countSwallows } from '../src/gates/swallowed-errors.js';

/** Runs `fn` with console captured and process.exitCode restored afterwards. */
const capture = (fn) => {
    const out = [];
    const err = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), err: err.join('\n'), exitCode: process.exitCode };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

test('a clean run prints the summary, the footer, and leaves the exit code alone', () => {
    const { out, err, exitCode } = capture(() => {
        const report = createGateReport({ name: 'Error handling' });
        report.done({ summary: 'Error handling OK — 12 handlers', notMachineChecked: 'whether 401 or 403 is right' });
    });
    assert.match(out, /^✓ Error handling OK — 12 handlers$/m);
    assert.match(out, /^Not machine-checked: whether 401 or 403 is right$/m);
    assert.equal(err, '');
    assert.equal(exitCode, undefined, 'a passing gate must not set a failing exit code');
});

test('NEGATIVE: a failure sets exit code 1 and prints what AND why', () => {
    const { out, err, exitCode } = capture(() => {
        const report = createGateReport({ name: 'Error handling', standard: 'error-handling.instructions.md' });
        report.fail('api/src/a.ts:3', 'swallows a failure', 'Say why it is safe to drop.');
        report.done({ summary: 'never printed' });
    });
    assert.equal(exitCode, 1);
    assert.equal(out, '', 'a failing gate must not also print a pass line');
    assert.match(err, /✗ Error handling check failed — 1 problem\(s\)/);
    assert.match(err, /api\/src\/a\.ts:3/);
    assert.match(err, /• swallows a failure/);
    assert.match(err, /Say why it is safe to drop\./);
    assert.match(err, /See error-handling\.instructions\.md, then re-run\./);
});

test('failures in the same file are printed under one heading', () => {
    const { err } = capture(() => {
        const report = createGateReport({ name: 'X' });
        report.fail('a.ts', 'first', 'because');
        report.fail('a.ts', 'second', 'because');
        report.fail('b.ts', 'third', 'because');
        report.done({ summary: '' });
    });
    assert.equal(err.match(/^ {2}a\.ts$/gm)?.length, 1, 'a.ts should head its group exactly once');
    assert.equal(err.match(/^ {2}b\.ts$/gm)?.length, 1);
});

test('a project-wide failure is labelled rather than printed under a blank heading', () => {
    const { err } = capture(() => {
        const report = createGateReport({ name: 'X' });
        report.fail(null, 'no worker registers a failed handler', 'BullMQ has no middleware.');
        report.done({ summary: '' });
    });
    assert.match(err, /\(project-wide\)/);
});

test('count and failures expose what has been recorded without printing', () => {
    const report = createGateReport({ name: 'X' });
    assert.equal(report.count, 0);
    report.fail('a.ts', 'what', 'why');
    assert.equal(report.count, 1);
    assert.deepEqual(report.failures, [{ file: 'a.ts', what: 'what', why: 'why' }]);
    // A copy, so a caller cannot quietly edit the gate's own record.
    report.failures.push({ file: 'b.ts', what: 'x', why: 'y' });
    assert.equal(report.count, 1);
});

// ── swallowed errors ─────────────────────────────────────────────────────────

/** Writes `code` to a scratch file and scans it. */
const scan = (code) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-swallow-'));
    try {
        writeFileSync(path.join(root, 'a.ts'), code);
        return findSwallowedErrors({ root, files: ['a.ts'] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test('NEGATIVE: an empty catch with no comment is reported', () => {
    const res = scan('try {\n  risky();\n} catch {}\n');
    assert.equal(res.length, 1);
    assert.match(res[0].what, /no comment/);
    assert.equal(res[0].file, 'a.ts:3');
});

test('NEGATIVE: every empty-calorie comment is rejected by name', () => {
    for (const word of ['ignore', 'ignored', 'noop', 'no-op', 'skip', 'cleanup', 'todo', 'FIXME', 'nothing', 'n/a']) {
        const res = scan(`try {\n  risky();\n} catch { /* ${word} */ }\n`);
        assert.equal(res.length, 1, `"${word}" should not count as a reason`);
        assert.match(res[0].what, new RegExp(`"${word.replace('/', '\\/')}"`, 'i'));
    }
});

test('a real reason passes, even when it starts with one of those words', () => {
    // "ignore" alone is empty; "ignore — the socket is already closed" is a reason.
    assert.deepEqual(scan('try {\n  risky();\n} catch { /* ignore — the socket is already closed */ }\n'), []);
    assert.deepEqual(scan('try {\n  risky();\n} catch {\n  // the file was already gone\n}\n'), []);
});

test('a catch that handles the error is not a swallow', () => {
    assert.deepEqual(scan('try {\n  risky();\n} catch (e) {\n  log.error(e);\n}\n'), []);
    assert.deepEqual(scan('try {\n  risky();\n} catch (e) {\n  throw e;\n}\n'), []);
});

test('a catch containing a nested block is not empty, so it is not reported', () => {
    assert.deepEqual(scan('try {\n  risky();\n} catch (e) {\n  if (x) {\n    retry();\n  }\n}\n'), []);
});

test('a trailing `.` does not smuggle a reasonless comment past the check', () => {
    assert.equal(scan('try {\n  a();\n} catch { /* ignore. */ }\n').length, 1);
});

test('countSwallows counts explained and unexplained alike', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-swallow-'));
    try {
        writeFileSync(
            path.join(root, 'a.ts'),
            'try { a(); } catch { /* already gone */ }\ntry { b(); } catch {}\ntry { c(); } catch (e) { log(e); }\n',
        );
        assert.equal(countSwallows({ root, files: ['a.ts'] }), 2);
        assert.equal(findSwallowedErrors({ root, files: ['a.ts'] }).length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
