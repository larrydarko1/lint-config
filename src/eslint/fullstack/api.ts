import type { FullstackLayout } from '../presets.ts';

/** What the messages point the reader at. The API family has the same files at its own root. */
type ApiMessagePaths = {
    /** The module holding AppError. */
    appError: string;
    /** Where a returned shape gets its name, and who compiles against it. */
    namedShapes: string;
};

const FULLSTACK_MESSAGE_PATHS: ApiMessagePaths = {
    appError: 'api/src/lib/app-error.ts',
    namedShapes: 'in packages/shared so the API and the frontend both compile against it',
};

const noParseIntQuery = {
    selector: "CallExpression[callee.name='parseInt'] MemberExpression[object.name='req'][property.name='query']",
    message:
        'Do not parseInt() `req.query` — validate with a Zod schema via `validate({ query })` and read the coerced values from `req.validatedQuery`.',
};

const noOkEnvelope = {
    selector: "CallExpression[callee.property.name='json'] > ObjectExpression > Property[key.name='ok']",
    message:
        'No `{ ok: true }` success envelope — return the resource directly, or `res.status(204).end()` for a pure side-effect.',
};

const noEnglishErrorResponse = {
    selector: "CallExpression[callee.property.name='json'] Property[key.name='error'] > Literal[value=/[a-z]/]",
    message:
        "Error responses must be a machine code, not English — throw `new AppError(...)` or `res.json({ error: 'SOME_CODE' })`. The English text lives in the code's translation (frontend `errors.*`).",
};

const noMessageResponse = {
    selector: "CallExpression[callee.property.name='json'] > ObjectExpression > Property[key.name='message']",
    message:
        'No `message` field on the wire — nothing localises it, so it reaches the UI as raw English. Return the resource, `res.status(204).end()` for a side effect, or `res.json({ error: SOME_CODE })` which the frontend translates via `errors.*`.',
};

const noRawReqQuery = {
    selector: "MemberExpression[object.name='req'][property.name='query']",
    message:
        'Do not read `req.query` in a route — attach `validate({ query })` and read the coerced, capped values from `req.validatedQuery`. Handlers receive clean data or the request never reaches them.',
};

const noUntimedFetch = {
    selector: "CallExpression[callee.name='fetch']:not(:has(ObjectExpression > Property[key.name='signal']))",
    message:
        'Pass a timeout to every outbound fetch: `fetch(url, { signal: AbortSignal.timeout(5000) })`. Node applies no default, so a stalled upstream pins the request slot until the process restarts.',
};

const noApiErrorsFieldType = {
    selector: "TSPropertySignature[key.name='data'] TSPropertySignature[key.name='errors']",
    message:
        "Do not type the API's per-field `errors[]` — those messages are English dev fallbacks, never shown to users. Render the localised `data.error` instead, and validate client-side (utils/validation.ts) for localised field-level feedback.",
};

const noApiErrorsRender = {
    selector: "MemberExpression[property.name='map'][object.property.name='errors']",
    message:
        'Do not map over API `errors[]` — those messages are English dev fallbacks. Render the localised `data.error` instead, and validate client-side (utils/validation.ts) for localised field-level feedback.',
};

/** Fixed-window limiters, banned because the tiers are a token bucket in Redis. */
const fixedWindowLimiters = [
    {
        name: 'express-rate-limit',
        message:
            'Fixed-window counter, not a token bucket — no burst capacity, and up to 2x the limit slips through across a window edge. Use the tiers in lib/rate-limiters.ts (atomic Redis Lua, fails open).',
    },
    {
        name: 'rate-limiter-flexible',
        message: 'Also a fixed-window counter. Use the token-bucket tiers in lib/rate-limiters.ts.',
    },
    {
        name: 'express-slow-down',
        message: 'Same family as express-rate-limit. Use the token-bucket tiers in lib/rate-limiters.ts.',
    },
];

/** Work that belongs to the proxy in front of Node, Redis or not. */
export const proxyWorkBannedImports = [
    {
        name: 'compression',
        message:
            'Compress at the proxy (`gzip on` in nginx), not in Node. nginx is C and compresses far faster than a JS middleware doing identical work on the event loop.',
    },
];

/** In-process caches, banned because Redis is the one cache every replica shares. */
const inProcessCaches = [
    {
        name: 'lru-cache',
        message:
            'In-process cache. Every pod gets its own copy, so the same request returns different data depending on which pod answers, and an invalidation reaches exactly one of them. Redis is the only application cache.',
    },
    {
        name: 'node-cache',
        message: 'In-process cache — see lru-cache. Redis is the only application cache.',
    },
    {
        name: 'memory-cache',
        message: 'In-process cache — see lru-cache. Redis is the only application cache.',
    },
    {
        name: 'quick-lru',
        message: 'In-process cache — see lru-cache. Redis is the only application cache.',
    },
];

/** Additional selectors for api routes only (success envelope, raw query). */
export const apiRoutesOnlySelectors = [noOkEnvelope, noRawReqQuery];

/** The outbound-timeout rule on its own, for the worker, which makes outbound calls but serves no HTTP. */
export const outboundCallSelectors = [noUntimedFetch];

export const apiBannedImports = [...fixedWindowLimiters, ...proxyWorkBannedImports, ...inProcessCaches];

/** Frontend selectors — the client side of the same wire contract. */
export const frontendSelectors = [noApiErrorsFieldType, noApiErrorsRender];

/** The selectors for an HTTP service's source, with the messages pointing at `paths`. */
export const httpServiceSelectors = ({ appError, namedShapes }: ApiMessagePaths) => [
    noThrowObject(appError),
    noParseIntQuery,
    noEnglishErrorResponse,
    noMessageResponse,
    noUntimedFetch,
    ...noLooseReturnShape(namedShapes),
];

export const apiStandards = (layout: FullstackLayout) => [
    {
        files: layout.api,
        ignores: ['**/__tests__/**', '**/lib/config.ts'],
        rules: {
            'no-restricted-syntax': ['error', ...apiSourceSelectors],
        },
    },
    {
        files: layout.services,
        ignores: ['**/__tests__/**', '**/lib/config.ts'],
        rules: {
            'no-restricted-syntax': ['error', ...outboundCallSelectors],
        },
    },
    {
        files: layout.backend,
        rules: {
            'no-restricted-imports': ['error', { paths: apiBannedImports }],
        },
    },
    {
        files: [`${layout.workspaces.api}/src/routes/**/*.ts`],
        ignores: ['**/__tests__/**'],
        rules: {
            'no-restricted-syntax': ['error', ...apiSourceSelectors, ...apiRoutesOnlySelectors],
        },
    },
    {
        files: layout.frontend,
        ignores: ['**/__tests__/**'],
        rules: {
            'no-restricted-syntax': ['error', ...frontendSelectors],
        },
    },
];

const noThrowObject = (appError: string) => ({
    selector: 'ThrowStatement > ObjectExpression',
    message: `Throw \`new AppError(status, code, message)\` — not a bare \`{ status, message }\` object. Client-facing errors must carry a machine code (see ${appError}).`,
});

const noLooseReturnShape = (namedShapes: string) => {
    const message = `Do not return \`Record<string, unknown>\` from an exported function — it switches type checking off for everything the caller receives, which is how the API and frontend drifted apart on VideoMeta. Name the shape (e.g. \`VideoMeta\`) ${namedShapes}.`;
    return [
        {
            selector:
                "ExportNamedDeclaration > FunctionDeclaration > TSTypeAnnotation TSTypeReference[typeName.name='Record'][typeArguments.params.1.type='TSUnknownKeyword']",
            message,
        },
        {
            selector:
                "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression > TSTypeAnnotation TSTypeReference[typeName.name='Record'][typeArguments.params.1.type='TSUnknownKeyword']",
            message,
        },
    ];
};

export const apiSourceSelectors = httpServiceSelectors(FULLSTACK_MESSAGE_PATHS);
