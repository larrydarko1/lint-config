export const wsGatewaySelectors = [
    {
        selector: "MemberExpression[object.property.name='handshake'][property.name='query']",
        message:
            'Read the handshake credential from `socket.handshake.auth.token`, not the query string — query strings are written verbatim into proxy and access logs.',
    },
    {
        selector: 'ThrowStatement',
        message:
            "Never throw across a socket boundary — Socket.IO will not route it to the Express error handler. Catch it here, `logger.error({ err, op, userId }, ...)` once, and emit a coded `error` event. To reject a handshake, call `next(new Error('...'))`.",
    },
    {
        selector:
            "CallExpression[callee.property.name='emit'][arguments.0.value='error'] > ObjectExpression > Property[key.name='message']",
        message:
            "A socket error payload carries a machine code, not English: `emit('error', { code: 'RATE_LIMITED' })`. The user-facing text lives in the frontend translation, exactly as for REST error codes.",
    },
];

export const wsEventNameSelectors = [
    {
        selector: `CallExpression[callee.property.name='emit'] > Literal:first-child[value!=/^(?:connect|connection|disconnect|disconnecting|connect_error|error)$|^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/]`,
        message:
            "Socket events are named `resource:action` — lowercase and colon-namespaced (`notification:new`, `badge:awarded`). Add it to the event contract in the gateway's file header too; `npm run ws:check` checks the two agree.",
    },
    {
        selector: `CallExpression[callee.object.name=/^(?:socket|sock)$/][callee.property.name='on'] > Literal:first-child[value!=/^(?:connect|connection|disconnect|disconnecting|connect_error|error)$|^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/]`,
        message:
            "Socket events are named `resource:action` — lowercase and colon-namespaced (`notification:new`, `badge:awarded`). Add it to the event contract in the gateway's file header too; `npm run ws:check` checks the two agree.",
    },
];

export const wsGatewayBannedImports = [
    {
        name: '@/lib/app-error.js',
        message:
            'AppError is an HTTP concept (status code + Express error handler) and does not cross the socket boundary. Emit a coded `error` event instead.',
    },
];

export const wsSocketClientBannedImports = [
    {
        name: 'socket.io-client',
        message:
            'Import the shared socket from `@/api/socket` — `socket.io-client` is imported in exactly one module. A second io() client means a second connection with its own token lifecycle, which stops authenticating the first time the access token rotates.',
    },
];
