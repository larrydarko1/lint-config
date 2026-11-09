/**
 * What a code-style `headers` rule can demand of a file's opening comment, read the
 * TypeScript way and the Rust way. Each check returns the violation, or null.
 */

/**
 * `jsdoc` a `/** ... *\/` block, `rustdoc` a `//!` header, `comment` any leading
 * comment, `none` a BAN on one. A Rust file's `none` bans a `//!` header.
 */
type HeaderRequirement = 'jsdoc' | 'rustdoc' | 'comment' | 'none';

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

export const HEADER_RULE: Record<HeaderRequirement, HeaderCheck> = {
    jsdoc: {
        problem: (source): string | null => (/^\s*\/\*\*/.test(source) ? null : 'no JSDoc file header'),
        why: 'This module owns an external concern — a filesystem, a model handle, a config file, a domain — and which one, plus what it guarantees callers, is not derivable from its exports.',
    },
    comment: {
        problem: (source): string | null => (/^\s*(\/\*|\/\/)/.test(source) ? null : 'no file header'),
        why: 'A module here states what it owns in at least one line — a JSDoc block for a domain owner, a single `//` line for a narrow sub-module. That is the thing its signature cannot say.',
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
};
