/**
 * Reading structure out of source text without parsing it.
 *
 * The two full-stack security gates each carried byte-identical copies of five
 * of these, and the api and websocket gates carried their own span finders on
 * top. They are here once because a gate that hand-rolls its own "find the
 * arguments of this call" is a gate that gets the nesting wrong in its own way —
 * and each of those copies did, differently: one stopped at the first `}` inside
 * a `try`, another ended a middleware on `\n    });` and so encoded that day's
 * indentation as the contract.
 *
 * WHY NOT A REAL PARSER. Everything here is asked of source that is TypeScript,
 * sometimes a `.vue` SFC, sometimes nginx configuration. A gate must keep
 * working when a file it reads is briefly unparseable, and must not pull a
 * TypeScript compiler into a check that runs on every commit. What these do
 * instead is count brackets, which is enough for "what is inside this call" and
 * honest about the cases it cannot answer: each returns an empty result rather
 * than a wrong one, and every caller here treats empty as a failure.
 *
 * THE ONE RULE FOR CALLERS. Pass source that has been through `stripComments`
 * whenever the question is "does the code do X", or the prose explaining why X
 * matters will answer for it. See the security gate's header: a comment naming
 * `SIGTERM` once satisfied a rule about handling it.
 */

/**
 * @typedef {object} CallSite
 * @property {number} index Byte offset of the first character of `token`.
 * @property {number} end Byte offset of the matching `)`.
 * @property {string} args The argument text between the parens.
 */

/**
 * Every `token(…)` call in a file, with its position and its bracket-balanced
 * argument text.
 *
 * `token` ends in the opening paren — `callSites(src, 'jwt.verify(')` — which is
 * what keeps `jwt.verifySomething(` from matching.
 *
 * THE POSITION IS THE POINT. Half the rules in the api and websocket gates are
 * about ORDER — helmet before the first route, the rate limit before the JWT
 * verify — and order is a byte offset. Both gates had grown their own span
 * finder for it, and the websocket one carried a comment explaining that its
 * first attempt anchored on a closing `\n    });` and so encoded that day's
 * indentation as the contract. Counting brackets is the only version of this
 * that survives a reformat.
 *
 * @param {string} source
 * @param {string} token A call prefix ending in `(`.
 * @returns {CallSite[]} One entry per call, in source order; `[]` when there are none.
 */
export function callSites(source, token) {
    /** @type {CallSite[]} */
    const sites = [];
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
 * @param {string} source
 * @param {string} token A call prefix ending in `(`.
 * @returns {string[]} One entry per call, in source order; `[]` when there are none.
 */
export function callArgs(source, token) {
    return callSites(source, token).map((site) => site.args);
}

/**
 * The body of the first block whose opening `{` follows a match of `opener`,
 * brace-balanced.
 *
 * Both copies of the security gate reached for `/…\{([^}]*)\}/` instead, which
 * stops at the first `}` — so a block holding one nested object is read
 * truncated, and whatever came after the nesting is invisible to the rule.
 *
 * @param {string} source
 * @param {RegExp} opener
 * @returns {string} The text between the braces, or `''` when there is no match.
 */
export function braceBlock(source, opener) {
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
 *
 * Bracket counting rather than a fixed window. The websocket gate used to
 * accept `config.corsOrigin` anywhere in the 400 characters after
 * `allowRequest:`, and the option that most often FOLLOWS it is
 * `cors: { origin: config.corsOrigin }` — so a check that let every origin
 * through passed on its neighbour's value. The Electron gate read
 * webPreferences out of a window block that ended on `\n    })`, four spaces of
 * that day's indentation.
 *
 * @param {string} source
 * @param {string} key
 * @returns {string | null}
 */
export function propertyValue(source, key) {
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
 * Angle brackets count as brackets only where they open a generic, which is
 * the one place a comma can hide inside a type: `x < y, z` in an expression is
 * rare enough in parameter lists that the simpler rule wins.
 *
 * @param {string} text
 * @param {string} separator A single character.
 * @returns {string[]} The trimmed parts, empty ones dropped.
 */
export function splitTopLevel(text, separator) {
    /** @type {string[]} */
    const parts = [];
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
 * @param {string} text
 * @param {number} start The offset of the opening quote.
 * @returns {number}
 */
function skipString(text, start) {
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
 * @typedef {object} FunctionParts
 * @property {string[]} params The parameter NAMES, in order — types, defaults
 *   and a rest `...` stripped; a destructured parameter contributes each name
 *   it binds.
 * @property {string} body The block's inside, or the expression of an
 *   expression-bodied arrow.
 */

/**
 * Read the function expression that `text` STARTS with: an arrow, a
 * `function (…) {…}`, either optionally `async`. `null` when `text` starts with
 * anything else — a bare identifier naming a function declared elsewhere is the
 * caller's to resolve, with `declaredFunction`.
 *
 * WHY THE BODY IS BOUNDED. Every rule that asks "does this handler validate its
 * argument" used to read a fixed 2500 characters from the handler's start, and
 * a handler that validated nothing passed on the `typeof` check of the next
 * handler down. The body ends where its own braces close, or — for an
 * expression-bodied arrow — at the first top-level `,` `;` or unmatched `)`.
 *
 * THE RETURN TYPE IS SKIPPED, not read as the body. Handlers are annotated
 * `): Promise<{ success: boolean }> => {` and `): { action: 'deny' } => {`, so
 * "the first `{` after the parameters" is a type literal in both.
 *
 * @param {string} text
 * @returns {FunctionParts | null}
 */
export function functionParts(text) {
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
 * `const`/`let`/`var` bound to an arrow or function expression. `null` when
 * nothing here declares it, which every caller reads as "cannot confirm",
 * never as "fine".
 *
 * @param {string} source
 * @param {string} name
 * @returns {FunctionParts | null}
 */
export function declaredFunction(source, name) {
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

/**
 * The body of whatever declares `name` in this file, `''` when nothing does.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
export function declaredBody(source, name) {
    return declaredFunction(source, name)?.body ?? '';
}

/**
 * The offset of the bracket that closes the one opening at `open`, skipping
 * strings. `-1` when it never closes.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function matching(text, open) {
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
 *
 * @param {string} text
 * @param {number} start
 * @returns {string}
 */
function expressionAt(text, start) {
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

/**
 * `_event, ...args: unknown[], { a, b }: T = {}` → `['_event', 'args', 'a', 'b']`.
 *
 * @param {string} list
 * @returns {string[]}
 */
function paramNames(list) {
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
 *
 * Deliberately coarse: it is used to ask "does THIS function do X" of files
 * whose functions are separated by exports, which is every service module in
 * both families. `''` when the header is absent — a rule that silently examined
 * an empty string would pass for the one reason that should fail it loudest,
 * the function having been renamed out from under the gate.
 *
 * @param {string} source
 * @param {string} header The exact text the function starts with.
 * @returns {string}
 */
export function fnBody(source, header) {
    const start = source.indexOf(header);
    if (start === -1) return '';
    const next = source.indexOf('\nexport ', start + header.length);
    return source.slice(start, next === -1 ? source.length : next);
}

/**
 * The body text of every `catch (…) { … }` block, brace-balanced.
 *
 * The distinction this exists for: whether a control fails open is a property of
 * its CATCH, not of its function. A throttle legitimately throws 429 after the
 * catch, on a lock it really read, so "does this function throw" cannot tell a
 * working control from one that denies every request the moment Redis blinks.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function catchBodies(source) {
    /** @type {string[]} */
    const bodies = [];
    const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
    /** @type {RegExpExecArray | null} */
    let match;

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
 * Evaluate a literal product like `2 * 60 * 60 * 1000`, the way durations are
 * written in config so the units stay readable. Underscore separators are
 * stripped first: `60_000` is sixty thousand, and `Number('60_000')` is NaN.
 *
 * @param {string | undefined} expression
 * @returns {number} `0` for anything that is not a literal product, which every
 *   caller reads as "not set" — the same verdict as an absent value.
 */
export function evalProduct(expression) {
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
