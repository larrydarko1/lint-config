/**
 * Blank out comments so a regex scan cannot match commented-out code. Comments become
 * spaces, so offsets, lines and columns still point at the real file; string and
 * template literals are left alone.
 *
 * @returns The same length as `source`, with comment bytes blanked.
 */
export function stripComments(source: string): string {
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
