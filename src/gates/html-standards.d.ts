/** A presence check over the document shell. */
export type HeadCheck = {
    /** The tag, as it appears in the failure message. */
    what: string;
    re: RegExp;
    why: string;
};

/** Every head requirement any of the shells had. A project passes the keys it owes. */
export type HeadRequirement =
    | 'lang'
    | 'charset'
    | 'appMount'
    | 'viewport'
    | 'title'
    | 'description'
    | 'ogTitle'
    | 'ogDescription'
    | 'ogImage'
    | 'canonical'
    | 'twitterCard'
    | 'themeColor'
    | 'icon';

export type HtmlStandardsOptions = {
    root?: string;
    /** The document shell, relative to the repo root. */
    indexHtml: string;
    /** The stylesheet that owns the global reduced-motion override. Omit to skip that check. */
    baseScss?: string;
    /** The head requirements this document owes. */
    require?: HeadRequirement[];
    /** True where the meta tag IS the policy — a renderer loading over `file://`. */
    csp?: boolean;
    /** A pre-launch origin that should be replaced before shipping. Warns, never fails. */
    placeholderOrigin?: string;
    /** The document to point at on failure. */
    standard?: string;
};

export type HtmlStandardsInput = Omit<HtmlStandardsOptions, 'standard'> & { root: string };

export type HtmlStandardsProblem = {
    file: string;
    what: string;
    why: string;
};

export type HtmlStandardsInspection = {
    problems: HtmlStandardsProblem[];
    /** Non-failing notes, printed after the report. */
    warnings: string[];
    /** How many head requirements were asked for. */
    required: number;
};

export declare const HEAD_CHECKS: Record<HeadRequirement, HeadCheck>;
export declare const CSP_REQUIRED: HeadCheck[];
export declare const CSP_BANNED: HeadCheck[];

/** Where a `<script type="module" src>` points, resolved against the document's directory. */
export declare const entryPath: (src: string, indexHtml: string) => string;
export declare const inspectHtmlStandards: (input: HtmlStandardsInput) => HtmlStandardsInspection;
export declare const checkHtmlStandards: (options: HtmlStandardsOptions) => void;
export default checkHtmlStandards;
