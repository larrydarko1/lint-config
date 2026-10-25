import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServerErrorRecorder, describe, logErrors } from '../src/server-errors.ts';

/** A context that replays responses to whoever subscribes. */
const fakeContext = () => {
    const listeners = [];
    return {
        on: (_event, listener) => listeners.push(listener),
        emit: (url, status, { method = 'GET', requestId } = {}) =>
            listeners.forEach((listener) =>
                listener({
                    url: () => url,
                    status: () => status,
                    headers: () => (requestId === undefined ? {} : { 'x-request-id': requestId }),
                    request: () => ({ method: () => method }),
                }),
            ),
    };
};

const logFile = (lines) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'server-errors-')), 'api.log');
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return file;
};

const BASE = { time: 1, pid: 7, hostname: 'h', name: 'api' };

// ─── createServerErrorRecorder ────────────────────────────────────────────────

test('a 5xx is reported with what the API logged for its request', async () => {
    const file = logFile([
        { ...BASE, level: 30, requestId: 'r-1', msg: 'incoming' },
        {
            ...BASE,
            level: 50,
            requestId: 'r-1',
            msg: 'Response did not match its schema',
            issues: 'items.0.title: expected string',
        },
        { ...BASE, level: 50, requestId: 'r-2', msg: 'someone else' },
    ]);
    const recorder = createServerErrorRecorder({ logFile: file });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/videos/1', 500, { requestId: 'r-1' });

    assert.deepEqual(await recorder.drain(), [
        [
            'GET /api/videos/1 → 500 (request r-1)',
            '    info: incoming {"requestId":"r-1"}',
            '    error: Response did not match its schema {"requestId":"r-1","issues":"items.0.title: expected string"}',
        ].join('\n'),
    ]);
});

test('anything below 500, and anything outside the API, is not a server error', async () => {
    const recorder = createServerErrorRecorder();
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/videos/1', 404);
    context.emit('http://localhost:5173/api/videos/1', 422, { method: 'POST' });
    context.emit('http://localhost:5173/assets/app.js', 503);

    assert.deepEqual(await recorder.drain(), []);
});

test('without a log file, an entry still names the route, the status and the request id', async () => {
    const recorder = createServerErrorRecorder();
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/premium/status', 503, { requestId: 'r-9' });
    context.emit('http://localhost:5173/api/premium/config', 500);

    assert.deepEqual(await recorder.drain(), [
        'GET /api/premium/status → 503 (request r-9)',
        'GET /api/premium/config → 500 (request id not sent)',
    ]);
});

test('a request the log never mentions says so instead of passing silently', async () => {
    const file = logFile([{ ...BASE, level: 30, requestId: 'other', msg: 'x' }]);
    const recorder = createServerErrorRecorder({ logFile: file, logWaitMs: 0 });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/me', 500, { requestId: 'r-1' });

    assert.deepEqual(await recorder.drain(), [
        `GET /api/me → 500 (request r-1)\n    nothing in ${file} for this request`,
    ]);
});

test('a log line written after the response is still found', async () => {
    const file = logFile([]);
    const recorder = createServerErrorRecorder({ logFile: file, logWaitMs: 1000 });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/me', 500, { requestId: 'late' });
    setTimeout(
        () => appendFileSync(file, `${JSON.stringify({ ...BASE, level: 50, requestId: 'late', msg: 'boom' })}\n`),
        150,
    );

    const [entry] = await recorder.drain();
    assert.match(entry, /error: boom/);
});

test('drain forgets what it returned', async () => {
    const recorder = createServerErrorRecorder();
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/me', 500);
    assert.equal((await recorder.drain()).length, 1);
    assert.deepEqual(await recorder.drain(), []);
});

// ─── logErrors / describe ─────────────────────────────────────────────────────

test('logErrors lists every error-level line, request or not, and skips what is not JSON', () => {
    const file = logFile([
        { ...BASE, level: 40, msg: 'slow' },
        { ...BASE, level: 50, msg: 'Socket payload did not match its schema; not sent', event: 'notification:new' },
        { ...BASE, level: 60, requestId: 'r-1', msg: 'fatal thing' },
    ]);
    appendFileSync(file, '[12:00:00] ERROR (api): a pretty line\n');

    assert.deepEqual(logErrors(file), [
        'error: Socket payload did not match its schema; not sent {"event":"notification:new"}',
        'fatal: fatal thing {"requestId":"r-1"}',
    ]);
});

test('logErrors on a missing file finds nothing', () => {
    assert.deepEqual(logErrors(path.join(tmpdir(), 'no-such-dir', 'api.log')), []);
});

test('an error is cut to its type, message and first frame', () => {
    const err = {
        type: 'TypeError',
        message: 'x is undefined',
        stack: 'TypeError: x is undefined\n    at load (/app/src/a.ts:3:1)\n    at next (/app/b.ts:9:9)',
    };
    assert.equal(
        describe({ ...BASE, level: 50, msg: 'Unhandled error', err }),
        'error: Unhandled error {"err":"TypeError: x is undefined (at load (/app/src/a.ts:3:1))"}',
    );
});
