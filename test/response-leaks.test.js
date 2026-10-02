import assert from 'node:assert/strict';
import test from 'node:test';

import { createLeakRecorder, findLeaks, sensitiveKeys, sensitiveValues } from '../src/response-leaks.ts';

const SENSITIVE = {
    Users: ['password', 'totpSecret', 'recoveryCodes', 'billing.customerId'],
    Media: ['rawObjectKey'],
};

/** A `Db` holding `collections`, honouring only the projection's field list. */
const fakeDb = (collections) => ({
    collection: (name) => ({
        find: (_filter, { projection }) => ({
            toArray: async () =>
                (collections[name] ?? []).map((doc) =>
                    Object.fromEntries(
                        Object.keys(projection)
                            .map((field) => field.split('.')[0])
                            .filter((top) => top in doc)
                            .map((top) => [top, doc[top]]),
                    ),
                ),
        }),
    }),
});

const USERS = [
    {
        username: 'alice',
        password: '$argon2id$v=19$hash-of-alice',
        totpSecret: null,
        recoveryCodes: ['code-hash-0001', 'code-hash-0002'],
        billing: { customerId: 'cus_ALICE123' },
    },
];

/** A context that replays `responses` to whoever subscribes. */
const fakeContext = () => {
    const listeners = [];
    return {
        on: (_event, listener) => listeners.push(listener),
        emit: (url, body, { method = 'GET', type = 'application/json; charset=utf-8' } = {}) =>
            listeners.forEach((listener) =>
                listener({
                    url: () => url,
                    headers: () => ({ 'content-type': type }),
                    json: async () => body,
                    request: () => ({ method: () => method }),
                }),
            ),
    };
};

// ─── sensitiveKeys ────────────────────────────────────────────────────────────

test('keys map the last segment of a dotted field to the declared field', () => {
    const keys = sensitiveKeys(SENSITIVE);
    assert.equal(keys.get('password'), 'Users.password');
    assert.equal(keys.get('customerId'), 'Users.billing.customerId');
    assert.equal(keys.get('rawObjectKey'), 'Media.rawObjectKey');
});

// ─── findLeaks ────────────────────────────────────────────────────────────────

test('a forbidden key is found at any depth, with its path', () => {
    const body = { items: [{ user: { username: 'a', password: 'x' } }] };
    assert.deepEqual(findLeaks(body, sensitiveKeys(SENSITIVE)), [
        { path: '$.items[0].user.password', field: 'Users.password', via: 'key' },
    ]);
});

test('a forbidden key is reported even when its value is null', () => {
    assert.deepEqual(findLeaks({ totpSecret: null }, sensitiveKeys(SENSITIVE)), [
        { path: '$.totpSecret', field: 'Users.totpSecret', via: 'key' },
    ]);
});

test('a forbidden value is found under a harmless name', () => {
    const values = new Map([['cus_ALICE123', 'Users.billing.customerId']]);
    assert.deepEqual(findLeaks({ plan: { ref: 'cus_ALICE123' } }, new Map(), values), [
        { path: '$.plan.ref', field: 'Users.billing.customerId', via: 'value' },
    ]);
});

test('a value only matches whole: a string containing it is not a hit', () => {
    const values = new Map([['cus_ALICE123', 'Users.billing.customerId']]);
    assert.deepEqual(findLeaks({ note: 'see cus_ALICE123' }, new Map(), values), []);
});

test('a clean body has no hits', () => {
    assert.deepEqual(findLeaks({ username: 'alice', items: [1, 'two', null] }, sensitiveKeys(SENSITIVE)), []);
});

// ─── sensitiveValues ──────────────────────────────────────────────────────────

test('values come from strings, string arrays and dotted subdocument fields', async () => {
    const values = await sensitiveValues(fakeDb({ Users: USERS }), SENSITIVE);
    assert.deepEqual(Object.fromEntries(values), {
        '$argon2id$v=19$hash-of-alice': 'Users.password',
        'code-hash-0001': 'Users.recoveryCodes',
        'code-hash-0002': 'Users.recoveryCodes',
        'cus_ALICE123': 'Users.billing.customerId',
    });
});

test('short values are skipped, since they collide with ordinary text', async () => {
    const values = await sensitiveValues(fakeDb({ Media: [{ rawObjectKey: 'a/b.mp4' }] }), SENSITIVE);
    assert.equal(values.size, 0);
});

// ─── createLeakRecorder ───────────────────────────────────────────────────────

test('the recorder reports key and value hits with the route', async () => {
    const recorder = createLeakRecorder({ sensitive: SENSITIVE, db: fakeDb({ Users: USERS }) });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/me', { username: 'alice', password: 'x' });
    context.emit('http://localhost:5173/api/premium', { ref: 'cus_ALICE123' }, { method: 'POST' });

    assert.deepEqual(await recorder.drain(), [
        'GET /api/me → $.password (key of Users.password)',
        'POST /api/premium → $.ref (value of Users.billing.customerId)',
    ]);
});

test('the recorder skips non-API paths and non-JSON bodies', async () => {
    const recorder = createLeakRecorder({ sensitive: SENSITIVE });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/assets/app.json', { password: 'x' });
    context.emit('http://localhost:5173/api/file', { password: 'x' }, { type: 'text/plain' });

    assert.deepEqual(await recorder.drain(), []);
});

test('drain forgets what it returned', async () => {
    const recorder = createLeakRecorder({ sensitive: SENSITIVE });
    const context = fakeContext();
    recorder.watch(context);

    context.emit('http://localhost:5173/api/me', { password: 'x' });
    assert.equal((await recorder.drain()).length, 1);
    assert.deepEqual(await recorder.drain(), []);
});

test('a body that cannot be read is skipped, not thrown', async () => {
    const recorder = createLeakRecorder({ sensitive: SENSITIVE });
    recorder.watch({
        on: (_event, listener) =>
            listener({
                url: () => 'http://localhost:5173/api/me',
                headers: () => ({ 'content-type': 'application/json' }),
                json: () => Promise.reject(new Error('Target page, context or browser has been closed')),
                request: () => ({ method: () => 'GET' }),
            }),
    });
    assert.deepEqual(await recorder.drain(), []);
});
