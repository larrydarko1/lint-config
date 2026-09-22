export type FullstackErrorHandlingOptions = {
    /** Repository root. */
    root?: string;
    /** The HTTP service's sources. Defaults to `api/src`. */
    apiDir?: string;
    /**
     * This app's own services that run outside the request cycle. Scanned for swallowed
     * failures like the API, and barred from the HTTP error type. Defaults to `worker/src`.
     */
    serviceDirs?: string[];
    /** Further directories barred from AppError but not scanned for swallows — a shared package. */
    appErrorBanDirs?: string[];
    /** Defaults to `frontend/src`. */
    frontendDir?: string;
    /** Defaults to `api/src/lib/app-error.ts`. */
    appError?: string;
    /** Defaults to `api/src/middleware/error-handler.ts`. */
    handler?: string;
    /** The shared ERROR_CODES module. Defaults to `packages/shared/src/errors.ts`. */
    codes?: string;
    /** Where the Express app is assembled. Defaults to `api/src/index.ts`. */
    entry?: string;
    /** The HTTP client holding the response interceptor. Defaults to `frontend/src/api/client.ts`. */
    client?: string;
    /** Defaults to `frontend/src/i18n/locales`. */
    localeDir?: string;
    /** The status policy table. */
    allowedStatus?: number[];
    /** Codes that legitimately answer 400 — a request that never parsed. */
    parseLevel400?: string[];
    /** The typed failures the handler must map, in order, before 500. */
    handlerBranches?: string[];
    /** Security events whose names carry no signal, so no pattern reaches them. */
    securityEventCodes?: string[];
    /** Codes matching a security pattern that are genuinely routine. */
    notSecurityEvents?: string[];
    /** Files allowed to emit a code without throwing AppError; the handler is added automatically. */
    directCodeEmitters?: string[];
};

/** Run the full-stack error-handling gate, print the report, and set the exit code. */
export declare function checkFullstackErrorHandling(options?: FullstackErrorHandlingOptions): void;
export default checkFullstackErrorHandling;
