/**
 * Response-leak tripwire for an E2E suite that drives the real API and database.
 * Every JSON body the API sends is checked two ways against the fields the project
 * declares server-only, per collection:
 *   key   — a property NAMED like a sensitive field, at any depth.
 *   value — a string EQUAL to what one of those fields holds in the database right
 *           now, under any name. This catches `{ secret: user.totpSecret }`, which
 *           the key check cannot see.
 * Both are denylists and only know what they are given. The real defence is a
 * `toX()` mapper per response; this catches a route that skipped one, on the
 * routes the suite visits.
 */

/** Per collection, the fields that must never appear in an API response. A dotted name reaches into a subdocument. */
export type SensitiveFields = Readonly<Record<string, readonly string[]>>;

/** Where a forbidden key or value sits in a response body, and which declared field it matched. */
export type LeakHit = {
    path: string;
    field: string;
    via: 'key' | 'value';
};

/** The part of a MongoDB `Db` this module uses, so the package does not depend on the driver. */
export type MongoLike = {
    collection: (name: string) => {
        find: (
            filter: object,
            options: { projection: Record<string, 1> },
        ) => { toArray: () => Promise<Record<string, unknown>[]> };
    };
};

/** The part of a Playwright `Response` the recorder reads. */
export type ResponseLike = {
    url: () => string;
    headers: () => Record<string, string>;
    json: () => Promise<unknown>;
    request: () => { method: () => string };
};

/** The part of a Playwright `BrowserContext` (or `Page`) the recorder listens on. */
export type ResponseSource = {
    on: (event: 'response', listener: (response: ResponseLike) => void) => unknown;
};

export type LeakRecorderOptions = {
    sensitive: SensitiveFields;
    /** Where values are read from. Without it only key matching runs. */
    db?: MongoLike;
    /** Only responses whose path starts with this are scanned. Default `/api/`. */
    apiPrefix?: string;
    /** Shorter strings are not value-matched: they collide with ordinary text. Default 8. */
    minValueLength?: number;
};

export type LeakRecorder = {
    /** Start scanning every API response this context or page receives. */
    watch: (source: ResponseSource) => void;
    /** Wait for responses in flight, scan them, and return (then forget) one line per hit. */
    drain: () => Promise<string[]>;
};

type Captured = { route: string; body: unknown };

const DEFAULT_MIN_VALUE_LENGTH = 8;

/** Each forbidden property name, mapped to the declared field it stands for (`Users.password`). */
export function sensitiveKeys(sensitive: SensitiveFields): Map<string, string> {
    const keys = new Map<string, string>();
    for (const [collection, fields] of Object.entries(sensitive)) {
        for (const field of fields) keys.set(field.split('.').at(-1) ?? field, `${collection}.${field}`);
    }
    return keys;
}

/** Every string the declared fields currently hold in `db`, mapped to the field it came from. */
export async function sensitiveValues(
    db: MongoLike,
    sensitive: SensitiveFields,
    minLength = DEFAULT_MIN_VALUE_LENGTH,
): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const [collection, fields] of Object.entries(sensitive)) {
        const projection = Object.fromEntries(fields.map((field) => [field, 1 as const]));
        const docs = await db.collection(collection).find({}, { projection }).toArray();
        for (const doc of docs) {
            for (const field of fields) {
                for (const value of stringsIn(valueAt(doc, field))) {
                    if (value.length >= minLength) values.set(value, `${collection}.${field}`);
                }
            }
        }
    }
    return values;
}

/** Every forbidden key or value inside `body`, with its JSON path (`$.items[0].password`). */
export function findLeaks(
    body: unknown,
    keys: ReadonlyMap<string, string>,
    values: ReadonlyMap<string, string> = new Map(),
    path = '$',
): LeakHit[] {
    if (typeof body === 'string') {
        const field = values.get(body);
        return field === undefined ? [] : [{ path, field, via: 'value' }];
    }
    if (Array.isArray(body)) return body.flatMap((item, i) => findLeaks(item, keys, values, `${path}[${i}]`));
    if (body === null || typeof body !== 'object') return [];

    return Object.entries(body).flatMap(([key, child]) => {
        const here = `${path}.${key}`;
        const field = keys.get(key);
        const byKey: LeakHit[] = field === undefined ? [] : [{ path: here, field, via: 'key' }];
        return [...byKey, ...findLeaks(child, keys, values, here)];
    });
}

/**
 * Record API responses as they arrive and scan them on `drain()`. Values are read
 * from the database at drain time, so a user the test registered is covered.
 */
export function createLeakRecorder(options: LeakRecorderOptions): LeakRecorder {
    const { sensitive, db, apiPrefix = '/api/', minValueLength = DEFAULT_MIN_VALUE_LENGTH } = options;
    const keys = sensitiveKeys(sensitive);
    const captured: Captured[] = [];
    const pending = new Set<Promise<void>>();

    const record = (response: ResponseLike): void => {
        const { pathname } = new URL(response.url());
        if (!pathname.startsWith(apiPrefix)) return;
        if (!(response.headers()['content-type'] ?? '').includes('application/json')) return;

        const route = `${response.request().method()} ${pathname}`;
        const read = response
            .json()
            .then((body) => {
                captured.push({ route, body });
            })
            // The body is gone when the page closed mid-response; there is nothing to scan.
            .catch(() => {})
            .finally(() => pending.delete(read));
        pending.add(read);
    };

    return {
        watch: (source) => {
            source.on('response', record);
        },
        drain: async () => {
            await Promise.all(pending);
            const values =
                db === undefined ? new Map<string, string>() : await sensitiveValues(db, sensitive, minValueLength);
            return captured
                .splice(0)
                .flatMap(({ route, body }) =>
                    findLeaks(body, keys, values).map((hit) => `${route} → ${hit.path} (${hit.via} of ${hit.field})`),
                );
        },
    };
}

/** The value at a dotted path, stepping through objects only. */
function valueAt(doc: Record<string, unknown>, dotted: string): unknown {
    let current: unknown = doc;
    for (const part of dotted.split('.')) {
        if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

/** A string, or the strings in an array (recovery-code hashes). Anything else holds no matchable value. */
function stringsIn(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    return [];
}
