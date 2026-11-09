/**
 * What a code-style `headers` rule can demand of a file's opening comment, read the
 * TypeScript way and the Rust way. Each check returns the violation, or null.
 */

/**
 * `jsdoc` a `/** ... *\/` block, `owns` one carrying `Owns:` and `Does NOT own:` lines,
 * `rustdoc` a `//!` header, `comment` any leading comment, `none` a BAN on one. In a Rust
 * file, `owns` reads the `//!` header and `none` bans one.
 */
type HeaderRequirement = 'jsdoc' | 'owns' | 'rustdoc' | 'comment' | 'none';

export type HeaderRule = {
    /** Tested against the repo-relative path. First matching rule wins. */
    files: RegExp;
    require: HeaderRequirement;
};

type HeaderCheck = {
    /** The violation in `source`, or null when the header is what the rule asks for. */
    problem: (source: string) => string | null;
    why: string;
};

/** The labels a business-logic header carries, spelled exactly, each at the start of a line. */
const OWNERSHIP_LABELS = ['Owns:', 'Does NOT own:'];
const OPENING_JSDOC = /^\s*\/\*\*([\s\S]*?)\*\//;
const OPENING_RUST_BLOCK = /^\s*\/\*!([\s\S]*?)\*\//;

export const HEADER_RULE: Record<HeaderRequirement, HeaderCheck> = {
    jsdoc: {
        problem: (source): string | null => (/^\s*\/\*\*/.test(source) ? null : 'no JSDoc file header'),
        why: 'This module owns an external concern — a filesystem, a model handle, a config file, a domain — and which one, plus what it guarantees callers, is not derivable from its exports.',
    },
    owns: {
        problem: ownershipProblem,
        why: 'This is business logic, and its header draws its edge: `Owns:` what it is responsible for, `Does NOT own:` the neighbouring concern a reader would look for here, and the module that has it. Both labels open a line of the file’s first `/** */` block, spelled exactly so, with text after them on the same line. A narrow sub-module names its siblings under `Does NOT own:`.',
    },
    comment: {
        problem: (source): string | null => (/^\s*(\/\*|\/\/)/.test(source) ? null : 'no file header'),
        why: 'A module here states what it owns in at least one line. That is the thing its signature cannot say.',
    },
    rustdoc: {
        problem: (): string => 'is matched by a `rustdoc` header rule',
        why: '`//!` is a Rust header. A TypeScript file’s is a JSDoc block — write the rule as `jsdoc`, or narrow its `files` to `.rs`.',
    },
    none: {
        problem: (source): string | null => (/^\s*(<!--|\/\*)/.test(source) ? 'has a file-level header comment' : null),
        why: 'An SFC takes no file header — `defineProps`/`defineEmits` are the contract, and a prose header above them is the one part nothing checks, so it is the part that goes stale. Put the "why" next to the code it explains.',
    },
};

/** The same demands, read the way Rust writes a header. */
export const RUST_HEADER_RULE: Record<HeaderRequirement, HeaderCheck> = {
    rustdoc: {
        problem: (source): string | null => (/^\s*(\/\/!|\/\*!)/.test(source) ? null : 'no `//!` file header'),
        why: 'This module owns a concern its name does not spell out, and `//!` is where Rust says which: rustdoc renders it as the module page, and the editor shows it on hover.',
    },
    comment: HEADER_RULE.comment,
    none: {
        problem: (source): string | null => (/^\s*(\/\/!|\/\*!)/.test(source) ? 'has a `//!` file header' : null),
        why: 'Files here take no header. The name and the items are the whole story, and a header nothing checks is the part that goes stale.',
    },
    jsdoc: {
        problem: (): string => 'is matched by a `jsdoc` header rule',
        why: 'Rust has no JSDoc. Its file header is `//!` — write the rule as `rustdoc`.',
    },
    owns: {
        problem: rustOwnershipProblem,
        why: 'This is business logic, and its header draws its edge: `Owns:` what it is responsible for, `Does NOT own:` the neighbouring concern a reader would look for here, and the module that has it. Both labels open a line of the file’s opening `//!` header, spelled exactly so, with text after them on the same line. Put them after the one-sentence summary and a blank `//!`, so they are the body. A narrow sub-module names its siblings under `Does NOT own:`.',
    },
};

/** Only the opening block counts: an `Owns:` further down documents a function, not the file. */
function ownershipProblem(source: string): string | null {
    const block = OPENING_JSDOC.exec(source)?.[1];
    if (block === undefined) return 'no JSDoc file header';
    return missingLabels('JSDoc header', blockLines(block));
}

/** The opening run of `//!` lines, or an opening `/*! *\/` block, the two forms `rustdoc` accepts. */
function rustOwnershipProblem(source: string): string | null {
    const block = OPENING_RUST_BLOCK.exec(source)?.[1];
    if (block !== undefined) return missingLabels('`//!` header', blockLines(block));

    const lines = source.trimStart().split('\n');
    const end = lines.findIndex((line) => !line.trimStart().startsWith('//!'));
    const header = lines.slice(0, end === -1 ? lines.length : end);
    if (header.length === 0) return 'no `//!` file header';
    return missingLabels(
        '`//!` header',
        header.map((line) => line.trimStart().slice('//!'.length).trim()),
    );
}

function blockLines(block: string): string[] {
    return block.split('\n').map((line) => line.trim().replace(/^\*\s*/, ''));
}

function missingLabels(header: string, lines: string[]): string | null {
    const missing = OWNERSHIP_LABELS.filter(
        (label) => !lines.some((line) => line.startsWith(label) && line.slice(label.length).trim() !== ''),
    );
    if (missing.length === 0) return null;
    return `${header} has no ${missing.map((label) => `\`${label}\``).join(' or ')} line with text after it`;
}
