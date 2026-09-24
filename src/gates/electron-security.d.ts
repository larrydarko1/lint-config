/** Electron security gate — the process-model invariants. See electron-security.js. */

export type ElectronSecurityProblem = {
    /** `path` or `path:line`. */
    file: string;
    what: string;
    why: string;
};

/** One `v-html` binding someone has vouched for. */
export type VHtmlEntry = {
    /** The `.vue` file, relative to the repo root. */
    file: string;
    /** The bound expression exactly as written, e.g. `shape.icon`. */
    binding: string;
    /** Why this string cannot carry untrusted markup. */
    why: string;
};

/** A project helper whose output is safe to assign to `innerHTML`. */
export type Sanitizer = {
    /** Called as `name(…)` or `this.name(…)`, e.g. `renderInline`. */
    name: string;
    /** Why its output is escaped. */
    why: string;
};

export type ElectronSecurityInput = {
    root: string;
    /** Default `src/main`. */
    mainDir?: string;
    /** Default `src/preload`. */
    preloadDir?: string;
    /** Default `src/renderer`. */
    rendererDir?: string;
    /** Every `v-html` binding the renderer has, with its reason. Default none. */
    vHtml?: VHtmlEntry[];
    /** Helpers beyond `escapeHtml` and `DOMPurify.sanitize`. Default none. */
    sanitizers?: Sanitizer[];
};

export type ElectronSecurityInspection = {
    problems: ElectronSecurityProblem[];
    counts: { windows: number; schemes: number; innerHtml: number; vHtml: number; regexps: number };
};

export type ElectronSecurityOptions = Omit<ElectronSecurityInput, 'root'> & {
    /** Default: the repo root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

export declare function inspectElectronSecurity(input: ElectronSecurityInput): ElectronSecurityInspection;
export declare function checkElectronSecurity(options: ElectronSecurityOptions): void;
export default checkElectronSecurity;
