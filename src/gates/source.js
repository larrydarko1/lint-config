/**
 * Reading structure out of source text without parsing it.
 *
 * The two full-stack security gates each carried byte-identical copies of these
 * five helpers, and the api and websocket gates carry three of them again. They
 * are here once because a gate that hand-rolls its own "find the arguments of
 * this call" is a gate that gets the nesting wrong in its own way.
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
 * The argument text of every `token(…)` call, bracket-balanced, so a nested call
 * or an object literal inside the arguments does not truncate the answer.
 *
 * `token` ends in the opening paren — `callArgs(src, 'jwt.verify(')` — which is
 * what keeps `jwt.verifySomething(` from matching.
 *
 * @param {string} source
 * @param {string} token A call prefix ending in `(`.
 * @returns {string[]} One entry per call, in source order; `[]` when there are none.
 */
export function callArgs(source, token) {
    /** @type {string[]} */
    const calls = [];
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
                    calls.push(source.slice(open + 1, j));
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }
        // Unbalanced from here on: stop rather than rescan the same text forever.
        if (!closed) break;
    }

    return calls;
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
