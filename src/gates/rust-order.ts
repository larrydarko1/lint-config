/**
 * Declaration order for Rust, rust.instructions.md's table:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *    1. mod              — `mod` declarations
 *    2. use              — then `pub use`, in their own layer
 *    3. const            — `const` and `static`
 *    4. public types     — each followed by its `impl` blocks, inherent first
 *    5. public fns
 *    6. private types    — each followed by its `impl` blocks
 *    7. private fns
 *    8. tests            — `#[cfg(test)] mod tests { … }`
 *
 * - Rust items are order-independent, so unlike the TypeScript table nothing pins an
 * item in place. `macro_rules!` is the exception, scoped by text order, so it and every
 * other macro item is left where it is. So is an inline `mod` that is not the tests.
 * - An `impl` of a type this file does not declare sits with the private types.
 * - Imports get their own pass: std → external crates → this crate, one blank line
 * between groups, none inside one, and this crate's modules through `crate::`. rustfmt
 * sorts inside a group; nothing here rewrites Rust.
 */
import { isTestModule, rustItems, type RustItem } from './lib/rust.ts';
import { inPlace } from './lib/sequence.ts';

type RustMisplaced = {
    cat: string;
    name: string;
    line: number;
    belongsAfter: string;
};

type RustImportProblem = { line: number; message: string };

export const RUST_CATEGORIES: string[] = [
    'mod',
    'use',
    'pub use',
    'const',
    'public types',
    'public fns',
    'private types',
    'private fns',
    'tests',
];

export const RUST_IMPORT_GROUPS: string[] = ['std', 'external crates', 'this crate'];

const TYPE_KINDS = new Set(['struct', 'enum', 'union', 'type', 'trait']);
const STD_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);
const LOCAL_ROOTS = new Set(['crate', 'self', 'super']);

/**
 * The items of one Rust file that are out of the table's order. A type and its `impl`s
 * sort as one unit, so an `impl` stranded below another type is reported on its own.
 */
export function analyzeRust(source: string): { misplaced: RustMisplaced[]; count: number } {
    const all = rustItems(source);
    const checked = all
        .map((item, i) => ({ item, i, cat: categoryOf(item) }))
        .filter((e): e is { item: RustItem; i: number; cat: string } => e.cat !== null);

    const typeAt = new Map<string, { i: number; cat: string }>();
    for (const e of checked) {
        if (TYPE_KINDS.has(e.item.kind) && !typeAt.has(e.item.name)) typeAt.set(e.item.name, e);
    }

    const keyed = checked.map((e) => {
        const owner = e.item.kind === 'impl' ? typeAt.get(e.item.name) : undefined;
        const sub = e.item.kind !== 'impl' ? 0 : e.item.trait === undefined ? 1 : 2;
        return { ...e, cat: owner?.cat ?? e.cat, owner: owner?.i ?? e.i, sub };
    });
    const rank = (cat: string) => RUST_CATEGORIES.indexOf(cat);
    const ideal = [...keyed].sort(
        (a, b) => rank(a.cat) - rank(b.cat) || a.owner - b.owner || a.sub - b.sub || a.i - b.i,
    );

    const keep = inPlace(
        keyed.map((e) => e.i),
        ideal.map((e) => e.i),
    );
    const misplaced: RustMisplaced[] = [];
    for (const [p, e] of ideal.entries()) {
        if (keep.has(e.i)) continue;
        const after = p > 0 ? ideal[p - 1] : undefined;
        misplaced.push({
            cat: e.cat,
            name: label(e.item),
            line: e.item.line,
            belongsAfter: after === undefined ? 'the top of the file' : `${after.cat} "${label(after.item)}"`,
        });
    }
    return { misplaced, count: keyed.length };
}

/** The import pass: the groups, the blank lines between them, and `crate::` on this crate's own paths. */
export function checkRustImports(source: string): { count: number; problems: RustImportProblem[] } {
    const items = rustItems(source);
    const modules = new Set(items.filter((it) => it.kind === 'mod').map((it) => it.name));
    const uses = items
        .filter((it) => (it.kind === 'use' || it.kind === 'extern-crate') && !it.public)
        .map((item) => {
            const first = item.kind === 'extern-crate' ? item.name : (/^(?:::)?([\w]+)/.exec(item.name)?.[1] ?? '');
            const group = STD_CRATES.has(first) ? 0 : LOCAL_ROOTS.has(first) ? 2 : 1;
            return { item, first, group };
        });

    const problems: RustImportProblem[] = [];
    for (const { item, first } of uses) {
        if (!modules.has(first)) continue;
        problems.push({
            line: item.line,
            message: `\`use ${item.name}\` names this crate's \`${first}\` module without \`crate::\` — write \`use crate::${item.name}\``,
        });
    }
    for (const [k, cur] of uses.entries()) {
        const prev = k > 0 ? uses[k - 1] : undefined;
        if (prev === undefined) continue;
        const between = source.slice(prev.item.end, cur.item.start).split('\n').slice(1, -1);
        const blankLines = between.filter((line) => line.trim() === '').length;
        const [was, is] = [RUST_IMPORT_GROUPS[prev.group], RUST_IMPORT_GROUPS[cur.group]];
        if (cur.group < prev.group) {
            problems.push({
                line: cur.item.line,
                message: `\`use ${cur.item.name}\` (${is}) belongs above \`use ${prev.item.name}\` (${was})`,
            });
        } else if (cur.group === prev.group && blankLines > 0) {
            problems.push({
                line: cur.item.line,
                message: `a blank line splits the ${is} group above \`use ${cur.item.name}\``,
            });
        } else if (cur.group > prev.group && blankLines === 0) {
            problems.push({
                line: cur.item.line,
                message: `no blank line between the ${was} group and \`use ${cur.item.name}\` (${is})`,
            });
        }
    }
    return { count: uses.length, problems };
}

/** The layer an item belongs to before impls are matched to their types; `null` for what the table leaves alone. */
function categoryOf(item: RustItem): string | null {
    switch (item.kind) {
        case 'mod':
            if (isTestModule(item)) return 'tests';
            return item.body === null ? 'mod' : null;
        case 'use':
        case 'extern-crate':
            return item.public ? 'pub use' : 'use';
        case 'const':
        case 'static':
            return 'const';
        case 'fn':
            return item.public ? 'public fns' : 'private fns';
        case 'impl':
            return 'private types';
        default:
            return TYPE_KINDS.has(item.kind) ? (item.public ? 'public types' : 'private types') : null;
    }
}

const label = (item: RustItem): string => {
    if (item.kind === 'impl') return `impl ${item.trait === undefined ? '' : `${item.trait} for `}${item.name}`;
    if (item.kind === 'extern-crate') return `extern crate ${item.name}`;
    return `${item.kind} ${item.name}`;
};
