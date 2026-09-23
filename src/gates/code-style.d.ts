export type CaseStyle = 'kebab' | 'camel' | 'pascal';

export type CasingRule = {
    /** Tested against the repo-relative path. First matching rule wins; an unmatched file is unchecked. */
    files: RegExp;
    style: CaseStyle;
    /** Paths this rule does not apply to — an upstream naming convention, or a framework-fixed name. */
    exempt?: RegExp;
};

export type HeaderRule = {
    /** Tested against the repo-relative path. First matching rule wins. */
    files: RegExp;
    /** `jsdoc` a `/** ... *\/` block, `comment` any leading comment, `none` a BAN on one. */
    require: 'jsdoc' | 'comment' | 'none';
};

export type CodeStyleOptions = {
    root?: string;
    /** Source roots to walk. */
    scan: string[];
    lineCap?: number;
    /** Files already over the cap, at the size they were. Lower a number, never raise it. */
    baseline?: Record<string, number>;
    casing?: CasingRule[];
    headers?: HeaderRule[];
    /** Roots where an import alias resolves. Empty means the rule never fires. */
    aliasedRoots?: string[];
    /** SFCs that legitimately own a global style block, such as an app root. */
    globalStyles?: string[];
    standard?: string;
};

export type CodeStyleInput = Omit<CodeStyleOptions, 'root' | 'standard'> & { root: string };

export type CodeStyleProblem = { file: string; what: string; why: string };

export type CodeStyleInspection = {
    problems: CodeStyleProblem[];
    /** Source files examined — `.ts`/`.tsx`/`.vue`, excluding specs and ambient declarations. */
    files: number;
    baselined: number;
};

/** The size of a file in the unit its baseline is written in. */
/** Non-blank lines; an SFC's `<style>` block does not count. */
export declare const measureFile: (source: string, rel: string) => number;

/** The `<script>` block carrying `setup`, plus any companion block. */
export declare const scriptBlocks: (source: string) => { setup: string | null; others: string[] };

export declare const inspectCodeStyle: (input: CodeStyleInput) => CodeStyleInspection;

export declare const checkCodeStyle: (options: CodeStyleOptions) => void;

export default checkCodeStyle;
