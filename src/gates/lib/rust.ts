/**
 * Reading Rust by counting brackets, the way source.ts reads TypeScript: enough to find
 * a file's top-level items, their attributes, visibility and bodies, and its doc
 * comments. Not a parser. A macro body is opaque, and an item inside a `mod { … }` or an
 * `impl` is not listed.
 * - `lexRust` blanks comments and the contents of string and char literals, keeping
 * offsets, so a `{` in a string or a `'a` lifetime cannot unbalance a scan. Its own
 * reader, not strip-comments.ts: that one reads `'a` as the start of a string.
 */

/** A string literal: where it sits in the file and what it says. */
export type RustString = {
    /** Offset of the opening quote, or of the `r`/`b` prefix. */
    start: number;
    /** Offset just past the closing quote (and any `#`s). */
    end: number;
    value: string;
};

export type RustLex = {
    /** `source` with comments and literal contents blanked to spaces; the same length. */
    code: string;
    strings: RustString[];
};

export type RustItemKind =
    | 'inner-attribute'
    | 'mod'
    | 'use'
    | 'extern-crate'
    | 'const'
    | 'static'
    | 'struct'
    | 'enum'
    | 'union'
    | 'type'
    | 'trait'
    | 'impl'
    | 'fn'
    | 'macro-rules'
    | 'macro'
    | 'extern-block'
    | 'unknown';

/** One top-level item, attributes included. */
export type RustItem = {
    kind: RustItemKind;
    /** The declared name; an `impl`'s self type; a `use`'s path, whitespace collapsed. */
    name: string;
    /** Any `pub`, including `pub(crate)`. */
    public: boolean;
    /** The outer attributes, as written: `#[cfg(test)]`. */
    attributes: string[];
    /** Offset of the first attribute, or of the item when it has none. */
    start: number;
    /** Offset of the visibility or keyword, after the attributes. */
    keywordStart: number;
    /** Offset just past the item. */
    end: number;
    /** 1-based line of `keywordStart`. */
    line: number;
    /** Code text from the keyword to the body's `{`, or to the closing `;`. */
    head: string;
    /** The offsets just inside the item's `{ … }`, when it has one. */
    body: { start: number; end: number } | null;
    /** An `impl Trait for Type`'s trait, as written. */
    trait?: string;
};

/** A run of `///` or `//!` lines. */
export type RustDocBlock = {
    /** `inner` is `//!`, documenting the file; `outer` is `///`, documenting the item below. */
    kind: 'inner' | 'outer';
    /** 1-based line of the block's first line. */
    line: number;
    /** The text of each line, its marker and one leading space removed. */
    lines: string[];
};

const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Items that end at their body's closing brace, when they have one. */
const BLOCK_KINDS: Set<RustItemKind> = new Set([
    'mod',
    'struct',
    'enum',
    'union',
    'trait',
    'impl',
    'fn',
    'macro-rules',
    'macro',
    'extern-block',
    'unknown',
]);

const ITEM_HEAD =
    /^(pub(?:\s*\((?:crate|self|super|in\s+[\w:]+)\))?\s+)?((?:(?:const|async|unsafe|safe|default|auto)\s+|extern\s+"[^"]*"\s+)*)(fn|struct|enum|union|trait|impl|type|const|static|mod|use|extern\s+crate|macro_rules\s*!)(?![\w])/;

const ESCAPES: Record<string, string> = { 'n': '\n', 't': '\t', 'r': '\r', '0': '\0' };

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** The value of a non-raw literal's contents: the common escapes, enough for names and codes. */
function unescape(text: string): string {
    return text.replace(/\\(u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|\n\s*|.)/g, (_, esc: string) => {
        if (esc.startsWith('u{')) return String.fromCodePoint(Number.parseInt(esc.slice(2, -1), 16));
        if (esc.startsWith('x')) return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
        if (esc.startsWith('\n')) return '';
        return ESCAPES[esc] ?? esc;
    });
}

/** Whether the identifier character at `i - 1` makes `source[i]` part of a longer word. */
const continuesWord = (source: string, i: number): boolean => i > 0 && IDENT_CHAR.test(source.charAt(i - 1));

/**
 * The offset just past a char literal opening at `i`, or `-1` when the `'` starts a
 * lifetime or a label instead.
 */
function charLiteralEnd(source: string, i: number): number {
    if (source[i + 1] === '\\') {
        let j = i + 2;
        if (source[j] === 'u' && source[j + 1] === '{') j = source.indexOf('}', j) + 1;
        else if (source[j] === 'x') j += 3;
        else j += 1;
        return source[j] === "'" ? j + 1 : -1;
    }
    const point = source.codePointAt(i + 1);
    if (point === undefined || source[i + 1] === "'" || source[i + 1] === '\n') return -1;
    const width = point > 0xffff ? 2 : 1;
    return source[i + 1 + width] === "'" ? i + 2 + width : -1;
}

/**
 * Blank `source`'s comments, and the contents of its string and char literals.
 * Block comments nest, as Rust's do. Every offset in `code` is the same offset in `source`.
 */
export function lexRust(source: string): RustLex {
    const out: string[] = [];
    const strings: RustString[] = [];
    let i = 0;

    while (i < source.length) {
        const ch = source.charAt(i);
        const next = source[i + 1];

        if (ch === '/' && next === '/') {
            const newline = source.indexOf('\n', i);
            const stop = newline === -1 ? source.length : newline;
            out.push(' '.repeat(stop - i));
            i = stop;
            continue;
        }
        if (ch === '/' && next === '*') {
            let depth = 0;
            let j = i;
            while (j < source.length) {
                if (source[j] === '/' && source[j + 1] === '*') {
                    depth += 1;
                    j += 2;
                } else if (source[j] === '*' && source[j + 1] === '/') {
                    depth -= 1;
                    j += 2;
                    if (depth === 0) break;
                } else j += 1;
            }
            out.push(blank(source.slice(i, j)));
            i = j;
            continue;
        }

        // r"…", r#"…"#, br"…", cr"…": the prefix must start a token, or `bar"` would read as raw.
        const raw = ch === 'r' ? /^r(#*)"/.exec(source.slice(i, i + 64)) : null;
        const prefixed = raw !== null && /[bc]/.test(source.charAt(i - 1)) && !continuesWord(source, i - 1);
        if (raw !== null && (!continuesWord(source, i) || prefixed)) {
            const hashes = raw[1] ?? '';
            const open = i + raw[0].length;
            const close = source.indexOf(`"${hashes}`, open);
            const stop = close === -1 ? source.length : close + 1 + hashes.length;
            out.push(source.slice(i, open), blank(source.slice(open, Math.max(open, stop - 1 - hashes.length))));
            out.push(source.slice(Math.max(open, stop - 1 - hashes.length), stop));
            strings.push({
                start: prefixed ? i - 1 : i,
                end: stop,
                value: source.slice(open, stop - 1 - hashes.length),
            });
            i = stop;
            continue;
        }

        if (ch === '"') {
            let j = i + 1;
            while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
            const stop = Math.min(j + 1, source.length);
            out.push('"', blank(source.slice(i + 1, stop - 1)), stop - 1 > i ? '"' : '');
            const prefix = /[bc]/.test(source.charAt(i - 1)) && !continuesWord(source, i - 1);
            strings.push({ start: prefix ? i - 1 : i, end: stop, value: unescape(source.slice(i + 1, stop - 1)) });
            i = stop;
            continue;
        }

        if (ch === "'") {
            const stop = charLiteralEnd(source, i);
            if (stop !== -1) {
                out.push("'", ' '.repeat(stop - i - 2), "'");
                i = stop;
                continue;
            }
        }

        out.push(ch);
        i += 1;
    }

    return { code: out.join(''), strings };
}

/**
 * The offset of the bracket closing the one at `open` in lexed code, counting
 * `()`, `[]` and `{}` together. `-1` when it never closes.
 */
export function closingBracket(code: string, open: number): number {
    let depth = 0;
    for (let j = open; j < code.length; j++) {
        const ch = code[j];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) return j;
            if (depth < 0) return -1;
        }
    }
    return -1;
}

/** Split lexed `text` on `,` at bracket and angle depth zero; `->` and `=>` are not angles. */
export function splitRustList(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let j = 0; j < text.length; j++) {
        const ch = text[j];
        if (ch === '(' || ch === '[' || ch === '{' || (ch === '<' && text[j - 1] !== '<')) depth++;
        else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && text[j - 1] !== '-' && text[j - 1] !== '='))
            depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(text.slice(from, j).trim());
            from = j + 1;
        }
    }
    parts.push(text.slice(from).trim());
    return parts.filter((p) => p !== '');
}

/** Where an item starting at `from` ends: past its `;`, or past the `}` closing a depth-zero block. */
function itemEnd(code: string, from: number, block: boolean): { end: number; body: RustItem['body'] } {
    let depth = 0;
    for (let j = from; j < code.length; j++) {
        const ch = code[j];
        if (ch === ';' && depth === 0) return { end: j + 1, body: null };
        if (ch === '{' && depth === 0 && block) {
            const close = closingBracket(code, j);
            if (close === -1) return { end: code.length, body: { start: j + 1, end: code.length } };
            return { end: close + 1, body: { start: j + 1, end: close } };
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    return { end: code.length, body: null };
}

/** The text after a generic parameter list that `text` starts with, or `text` itself. */
function skipGenerics(text: string): string {
    if (!text.startsWith('<')) return text;
    let depth = 0;
    for (let j = 0; j < text.length; j++) {
        if (text[j] === '<') depth++;
        else if (text[j] === '>' && text[j - 1] !== '-' && text[j - 1] !== '=' && --depth === 0) {
            return text.slice(j + 1);
        }
    }
    return '';
}

/** `impl<T> Trait<T> for Wrapper<T> where …` → the trait as written, and `Wrapper`. */
function implTarget(head: string): { name: string; trait?: string } {
    const afterImpl = skipGenerics(head.replace(/^(?:unsafe\s+)?impl\s*/, '').trimStart());
    const signature = afterImpl.split(/\bwhere\b/)[0] ?? '';
    let depth = 0;
    let forAt = -1;
    for (let j = 0; j < signature.length; j++) {
        if (signature[j] === '<') depth++;
        else if (signature[j] === '>' && signature[j - 1] !== '-') depth--;
        else if (depth === 0 && /\sfor\s/.test(signature.slice(j - 1, j + 4)) && signature.startsWith('for', j)) {
            forAt = j;
            break;
        }
    }
    const selfType = (forAt === -1 ? signature : signature.slice(forAt + 3)).trim();
    const base = selfType
        .replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '')
        .replace(/^dyn\s+/, '')
        .split('<')[0]
        ?.split('::')
        .pop()
        ?.trim();
    const trait = forAt === -1 ? undefined : signature.slice(0, forAt).trim();
    return trait === undefined ? { name: base ?? '' } : { name: base ?? '', trait };
}

const declaredName = (rest: string): string => /^(?:mut\s+)?(?:r#)?([A-Za-z_][\w]*)/.exec(rest.trimStart())?.[1] ?? '';

/**
 * Every top-level item in a Rust file, in source order. A stray `;` after a block
 * item is skipped; anything unrecognised is `unknown` and still ends where it should.
 */
export function rustItems(source: string, lexed: RustLex = lexRust(source)): RustItem[] {
    const { code } = lexed;
    const items: RustItem[] = [];
    let i = 0;

    const skipSpace = (from: number) => {
        let j = from;
        while (j < code.length && /\s|;/.test(code.charAt(j))) j++;
        return j;
    };

    for (;;) {
        i = skipSpace(i);
        if (i >= code.length) break;
        const start = i;

        if (/^#\s*!\s*\[/.test(code.slice(i, i + 8))) {
            const close = closingBracket(code, code.indexOf('[', i));
            const end = close === -1 ? code.length : close + 1;
            items.push({
                kind: 'inner-attribute',
                name: source.slice(i, end),
                public: false,
                attributes: [],
                start,
                keywordStart: i,
                end,
                line: lineAt(code, i),
                head: code.slice(i, end),
                body: null,
            });
            i = end;
            continue;
        }

        const attributes: string[] = [];
        while (code[i] === '#') {
            const open = code.indexOf('[', i);
            const close = open === -1 ? -1 : closingBracket(code, open);
            if (close === -1) break;
            attributes.push(source.slice(i, close + 1));
            i = close + 1;
            while (i < code.length && /\s/.test(code.charAt(i))) i++;
        }

        const keywordStart = i;
        const rest = code.slice(i, i + 400);
        const m = ITEM_HEAD.exec(rest);
        const macro = m === null ? /^((?:::)?[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)\s*!/.exec(rest) : null;
        const keyword = m?.[3]?.replace(/\s+/g, ' ') ?? '';
        let kind: RustItemKind = 'unknown';
        if (keyword === 'extern crate') kind = 'extern-crate';
        else if (keyword.startsWith('macro_rules')) kind = 'macro-rules';
        else if (keyword !== '') kind = keyword as RustItemKind;
        else if (macro !== null) kind = 'macro';
        else if (/^(?:unsafe\s+)?extern\s+"[^"]*"\s*\{/.test(rest)) kind = 'extern-block';

        const { end, body } = itemEnd(code, keywordStart, BLOCK_KINDS.has(kind));
        const head = code.slice(keywordStart, body === null ? end : body.start - 1).trim();
        const afterKeyword = m === null ? '' : rest.slice(m[0].length);

        let name = '';
        let trait: string | undefined;
        if (kind === 'impl') ({ name, trait } = implTarget(head.slice((m?.[1] ?? '').length + (m?.[2] ?? '').length)));
        else if (kind === 'use')
            name = head
                .replace(/^(?:pub\S*\s+)?use\s+/, '')
                .replace(/;$/, '')
                .replace(/\s+/g, ' ');
        else if (kind === 'macro') name = macro?.[1] ?? '';
        else if (kind === 'extern-block' || kind === 'unknown')
            name = (code.slice(keywordStart).split('\n')[0] ?? '').trim().slice(0, 40);
        else name = declaredName(afterKeyword);

        items.push({
            kind,
            name,
            public: m?.[1] !== undefined,
            attributes,
            start,
            keywordStart,
            end,
            line: lineAt(code, keywordStart),
            head,
            body,
            ...(trait === undefined ? {} : { trait }),
        });
        i = end;
    }

    return items;
}

/** The string literals between two offsets, in order: a `const`'s value, a list's entries. */
export function stringsIn(lexed: RustLex, start: number, end: number): string[] {
    return lexed.strings.filter((s) => s.start >= start && s.end <= end).map((s) => s.value);
}

/** Every `///` and `//!` block, outside string literals. `////` is a plain comment, as rustdoc reads it. */
export function rustDocBlocks(source: string, lexed: RustLex = lexRust(source)): RustDocBlock[] {
    const blocks: RustDocBlock[] = [];
    const lines = source.split('\n');
    let offset = 0;
    let current = null as RustDocBlock | null;
    const inString = (at: number) => lexed.strings.some((s) => at > s.start && at < s.end);

    for (const [index, text] of lines.entries()) {
        const trimmed = text.trimStart();
        const at = offset + (text.length - trimmed.length);
        offset += text.length + 1;
        const kind = trimmed.startsWith('//!') ? 'inner' : /^\/\/\/(?!\/)/.test(trimmed) ? 'outer' : null;
        if (kind === null || inString(at)) {
            current = null;
            continue;
        }
        const line = trimmed.slice(3).replace(/^ /, '');
        if (current?.kind === kind) current.lines.push(line);
        else {
            current = { kind, line: index + 1, lines: [line] };
            blocks.push(current);
        }
    }

    return blocks;
}

/**
 * How many sentences a doc block's first paragraph holds: the part rustdoc shows alone
 * in a module listing and an editor's hover. Code spans and link targets are read as
 * words, so `` `a.b` `` and `[x](a.b)` end nothing.
 */
export function summarySentences(lines: string[]): number {
    const paragraph: string[] = [];
    for (const line of lines) {
        if (line.trim() === '' || line.startsWith('#') || line.startsWith('```')) break;
        paragraph.push(line.trim());
    }
    const text = paragraph
        .join(' ')
        .replace(/`[^`]*`/g, 'x')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
    if (text.trim() === '') return 0;
    return (text.match(/[.!?]["')\]]*\s+(?=[A-Z])/g)?.length ?? 0) + 1;
}

/** Whether an item is `#[cfg(test)] mod tests { … }`: Rust's own place for unit tests. */
export const isTestModule = (item: RustItem): boolean =>
    item.kind === 'mod' && item.body !== null && item.attributes.some((a) => /\bcfg\s*\(\s*test\s*\)/.test(a));
