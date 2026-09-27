/**
 * Reading structure out of source text by counting brackets, not parsing: gates must
 * survive briefly unparseable files and read `.vue` and nginx config too. Each helper
 * returns an empty result rather than a wrong one.
 * Pass source through `stripComments` first when asking "does the code do X".
 */

export type FunctionParts = {
    /** Parameter names in order — types, defaults and `...` stripped, destructuring flattened. */
    params: string[];
    /** The block's inside, or an expression-bodied arrow's expression. */
    body: string;
};

type CallSite = {
    /** Byte offset of the first character of the call. */
    index: number;
    /** Byte offset of the matching `)`. */
    end: number;
    /** The argument text between the parens. */
    args: string;
};


/**
 * Every `token(…)` call in a file, with its position (for ordering rules) and its
 * bracket-balanced argument text. `token` ends in `(` so `jwt.verify(` does not
 * match `jwt.verifySomething(`.
 *
 * @param token A call prefix ending in `(`.
 * @returns One entry per call, in source order; `[]` when there are none.
 */
export function callSites(source: string, token: string): CallSite[] {
    const sites: CallSite[] = [];
    let i = 0;

    while ((i = source.indexOf(token, i)) !== -1) {
        const open = i + token.length - 1;
        let depth = 0;
        let closed = false;
        for (let j = open; j < source.length; j++) {
            if (source[j] === '(') depth++;
            else if (source[j] === ')') {
                depth -= 1;
                if (depth === 0) {
                    sites.push({ index: i, end: j, args: source.slice(open + 1, j) });
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }
        // Unbalanced from here on: stop rather than rescan the same text forever.
        if (!closed) break;
    }

    return sites;
}

/**
 * The argument text of every `token(…)` call, bracket-balanced, so a nested call
 * or an object literal inside the arguments does not truncate the answer.
 *
 * @param token A call prefix ending in `(`.
 * @returns One entry per call, in source order; `[]` when there are none.
 */
export function callArgs(source: string, token: string): string[] {
    return callSites(source, token).map((site) => site.args);
}

/**
 * The body of the first block whose opening `{` follows a match of `opener`,
 * brace-balanced.
 *
 * @returns The text between the braces, or `''` when there is no match.
 */
export function braceBlock(source: string, opener: RegExp): string {
    const match = opener.exec(source);
    if (match?.index === undefined) return '';

    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) return '';

    let depth = 0;
    for (let j = open; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}' && --depth === 0) return source.slice(open + 1, j);
    }
    return '';
}

/**
 * The source of one object property's value: from after `key:` to the comma or
 * closing bracket that ends it at depth zero. `null` when the key is absent.
 */
export function propertyValue(source: string, key: string): string | null {
    const match = new RegExp(String.raw`(?<![\w$.])${key}\s*:`).exec(source);
    if (match === null) return null;
    const start = match.index + match[0].length;
    let depth = 0;
    for (let j = start; j < source.length; j++) {
        const ch = source[j];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
            if (depth === 0) return source.slice(start, j);
            depth--;
        } else if (ch === ',' && depth === 0) return source.slice(start, j);
    }
    return source.slice(start);
}

/**
 * Split `text` on `separator` wherever it sits at bracket depth zero and
 * outside a string, so `a: Record<string, number>, b` is two parameters and
 * not three, and `'a,b', c` is two arguments.
 *
 * Angle brackets count only where they open a generic.
 *
 * @param separator A single character.
 * @returns The trimmed parts, empty ones dropped.
 */
export function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let j = 0; j < text.length; j++) {
        const ch = text[j];
        if (ch === "'" || ch === '"' || ch === '`') {
            j = skipString(text, j);
            continue;
        }
        if (ch === '=' && text[j + 1] === '>') {
            j++;
            continue;
        }
        if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth++;
        else if (ch === ')' || ch === '}' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === separator && depth === 0) {
            parts.push(text.slice(from, j));
            from = j + 1;
        }
    }
    parts.push(text.slice(from));
    return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The offset of the quote that closes the string opening at `start`. A
 * template literal's `${…}` is skipped as a balanced span, so a backtick
 * inside an interpolation does not end the outer template.
 *
 * @param start The offset of the opening quote.
 */
function skipString(text: string, start: number): number {
    const quote = text[start];
    for (let j = start + 1; j < text.length; j++) {
        const ch = text[j];
        if (ch === '\\') j++;
        else if (ch === quote) return j;
        else if (quote === '`' && ch === '$' && text[j + 1] === '{') {
            let depth = 0;
            for (j += 1; j < text.length; j++) {
                if (text[j] === '`' || text[j] === "'" || text[j] === '"') j = skipString(text, j);
                else if (text[j] === '{') depth++;
                else if (text[j] === '}' && --depth === 0) break;
            }
        }
    }
    return text.length;
}

/**
 * Read the function expression that `text` starts with: an arrow or a
 * `function (…) {…}`, optionally `async`. `null` for anything else; resolve a bare
 * identifier with `declaredFunction`. The body ends where its braces close (or, for
 * an expression body, at the first top-level `,` `;` or unmatched `)`), and an inline
 * return type is skipped.
 */
export function functionParts(text: string): FunctionParts | null {
    const head = /^\s*(?:async\s+)?(?:function\b\s*\*?\s*[\w$]*\s*(?:<[^>(]*>)?\s*(?=\()|(?=\())/.exec(text);
    let params;
    let cursor;
    if (head !== null) {
        const open = head.index + head[0].length;
        const close = matching(text, open);
        if (close === -1) return null;
        params = text.slice(open + 1, close);
        cursor = close + 1;
    } else {
        const single = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
        if (single === null) return null;
        params = single[1] ?? '';
        cursor = single.index + single[0].length - 2;
    }

    // Past an optional return-type annotation to the `=>` or the `{` that opens the body.
    let j = cursor;
    let angle = 0;
    for (; j < text.length; j++) {
        const ch = text[j];
        if (ch === '=' && text[j + 1] === '>') {
            if (angle === 0) break;
            j++;
        } else if (ch === '<') angle++;
        else if (ch === '>') angle = Math.max(0, angle - 1);
        else if (ch === '(' || ch === '[') j = matching(text, j);
        else if (ch === '{') {
            const before = text.slice(cursor, j).trimEnd();
            const inType = angle > 0 || /[:|&,<]$/.test(before);
            if (!inType) break;
            j = matching(text, j);
        } else if (ch === ';') return null;
        if (j === -1) return null;
    }
    if (j >= text.length) return null;

    let bodyStart = j;
    if (text[j] === '=') {
        bodyStart = j + 2;
        while (/\s/.test(text[bodyStart] ?? '')) bodyStart++;
    }
    let body;
    if (text[bodyStart] === '{') {
        const close = matching(text, bodyStart);
        body = text.slice(bodyStart + 1, close === -1 ? text.length : close);
    } else {
        body = expressionAt(text, bodyStart);
    }

    return { params: paramNames(params), body };
}

/**
 * The function `name` is declared as in this file — `function name(…)`, or a
 * `const`/`let`/`var` bound to a function. `null` means "cannot confirm", never "fine".
 */
export function declaredFunction(source: string, name: string): FunctionParts | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    const declaration = new RegExp(
        String.raw`(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*${name}\s*(?:<[^>(]*>)?\s*(?=\()`,
    ).exec(source);
    if (declaration !== null) {
        const at = source.indexOf('function', declaration.index);
        return functionParts(source.slice(at));
    }
    const binding = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*(?::[^=]+)?=(?!=)\s*`).exec(source);
    if (binding === null) return null;
    return functionParts(source.slice(binding.index + binding[0].length));
}

/** The body of whatever declares `name` in this file, `''` when nothing does. */
export function declaredBody(source: string, name: string): string {
    return declaredFunction(source, name)?.body ?? '';
}

/**
 * The offset of the bracket that closes the one opening at `open`, skipping
 * strings. `-1` when it never closes.
 */
function matching(text: string, open: number): number {
    let depth = 0;
    for (let j = open; j < text.length; j++) {
        const ch = text[j];
        if (ch === "'" || ch === '"' || ch === '`') j = skipString(text, j);
        else if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if ((ch === ')' || ch === '}' || ch === ']') && --depth === 0) return j;
    }
    return -1;
}

/**
 * The expression starting at `start`, ended by the first `,` `;` or unmatched
 * closing bracket at depth zero.
 */
function expressionAt(text: string, start: number): string {
    let depth = 0;
    for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (ch === "'" || ch === '"' || ch === '`') j = skipString(text, j);
        else if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
            if (depth === 0) return text.slice(start, j).trim();
            depth--;
        } else if ((ch === ',' || ch === ';') && depth === 0) return text.slice(start, j).trim();
    }
    return text.slice(start).trim();
}

/** `_event, ...args: unknown[], { a, b }: T = {}` → `['_event', 'args', 'a', 'b']`. */
function paramNames(list: string): string[] {
    return splitTopLevel(list, ',').flatMap((param) => {
        const bare = param.replace(/^\.\.\./, '');
        if (bare.startsWith('{') || bare.startsWith('[')) {
            const close = matching(bare, 0);
            const inner = bare.slice(1, close === -1 ? bare.length : close);
            return splitTopLevel(inner, ',').map((part) => {
                const name = part.replace(/^\.\.\./, '').split(/[:=]/);
                return (name.length > 1 && part.includes(':') ? name[1] : name[0])?.trim() ?? '';
            });
        }
        return [bare.split(/[?:=]/)[0]?.trim() ?? ''];
    });
}

/**
 * A source file sliced from a function header to the next top-level `export`.
 * `''` when the header is absent; callers must treat that as a failure.
 *
 * @param header The exact text the function starts with.
 */
export function fnBody(source: string, header: string): string {
    const start = source.indexOf(header);
    if (start === -1) return '';
    const next = source.indexOf('\nexport ', start + header.length);
    return source.slice(start, next === -1 ? source.length : next);
}

/** The body text of every `catch (…) { … }` block, brace-balanced, for fail-open checks. */
export function catchBodies(source: string): string[] {
    const bodies: string[] = [];
    const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(source)) !== null) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let j = open; j < source.length; j++) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}') {
                depth -= 1;
                if (depth === 0) {
                    bodies.push(source.slice(open + 1, j));
                    re.lastIndex = j;
                    break;
                }
            }
        }
    }

    return bodies;
}

/**
 * Evaluate a literal product like `2 * 60 * 60 * 1000`, with `_` separators allowed.
 *
 * @returns `0` (read as "not set") for anything that is not a literal product.
 */
export function evalProduct(expression: string | undefined): number {
    if (expression === undefined) return 0;
    const parts = expression.replace(/_/g, '').split('*');
    let total = 1;
    for (const part of parts) {
        const value = Number(part.trim());
        if (!Number.isFinite(value)) return 0;
        total *= value;
    }
    return total;
}
