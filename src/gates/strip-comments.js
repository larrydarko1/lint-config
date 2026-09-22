/**
 * Blank out comments before scanning source for structure.
 *
 * Gates that look for a shape — a function declaration, an `ipcMain.handle` call —
 * must not find it inside a comment. A commented-out handler, or an example in a
 * JSDoc block, reads identically to the real thing under a regex, and that false
 * positive is the kind that gets a gate switched off.
 *
 * Comments are replaced by spaces rather than removed, so every byte offset, line
 * and column survives: a gate can report the position it matched at and have it
 * point at the real file. String and template literals are left alone — a `//`
 * inside a URL is not a comment, and dropping it would corrupt the very line a
 * gate is reading.
 *
 * @param {string} source
 * @returns {string} The same length as `source`, with comment bytes blanked.
 */
export function stripComments(source) {
    let out = '';
    let i = 0;

    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];

        if (ch === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end === -1 ? source.length : end + 2;
            // Keep the newlines: blanking them would merge the lines either side.
            out += source.slice(i, stop).replace(/[^\n]/g, ' ');
            i = stop;
        } else if (ch === '/' && next === '/') {
            const end = source.indexOf('\n', i);
            const stop = end === -1 ? source.length : end;
            out += ' '.repeat(stop - i);
            i = stop;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            const start = i;
            i += 1;
            while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
            i += 1;
            out += source.slice(start, i);
        } else {
            out += ch;
            i += 1;
        }
    }

    return out;
}

export default stripComments;
