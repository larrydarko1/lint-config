export type ElectronErrorHandlingOptions = {
    /** Repository root. */
    root?: string;
    /** Main-process sources. Defaults to `src/main`. */
    mainDir?: string;
    /** Renderer sources, scanned for swallowed failures. Defaults to `src/renderer`. */
    rendererDir?: string;
    /** Where the app lifecycle is wired. Defaults to `src/main/index.ts`. */
    mainIndex?: string;
    /**
     * Services holding a resource the OS does not reclaim when the window closes; each
     * must be released in `before-quit`. Empty is a legitimate answer — the hook is
     * still required, so the first service that needs releasing has somewhere to go.
     */
    cleanupRequired?: [service: string, why: string][];
};

/** Run the Electron error-handling gate, print the report, and set the exit code. */
export declare function checkElectronErrorHandling(options?: ElectronErrorHandlingOptions): void;
export default checkElectronErrorHandling;
