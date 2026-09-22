export type I18nGateOptions = {
    /** Locale folder, relative to `root`. */
    localeDir: string;
    /** The file calling createI18n, relative to `root`. */
    configFile: string;
    /** The locale every other one is compared against. Defaults to `'en'`. */
    reference?: string;
    /** Repository root. Defaults to the calling repo's root. */
    root?: string;
    /** Extra sentence per required option, keyed `escapeParameter` / `legacy` / `fallbackLocale`. */
    configNotes?: Record<string, string>;
};

export type I18nGateResult = {
    errors: string[];
    locales: string[];
    keyCount: number;
    /** Set when the gate could not run at all, as opposed to finding disagreements. */
    fatal: string | null;
};

/** Run the gate and return what it found, without printing or exiting. */
export declare function inspectI18n(options: I18nGateOptions): I18nGateResult;
/** Run the gate, print the report, and set a non-zero exit code on failure. */
export declare function checkI18n(options: I18nGateOptions): void;
export default checkI18n;
