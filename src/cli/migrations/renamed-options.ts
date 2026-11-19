/**
 * Renames each option larry.config.ts still sets under a name a release changed, which
 * `larry check` stops on. Only the key changes: its value and comments stay.
 */
import ts from 'typescript';

import { CONFIG_FILES } from '../../config.ts';
import { prettify } from '../format.ts';
import { RENAMED_OPTIONS, type RenamedOption } from '../renames.ts';
import { applyEdits, asKey, parseConfig, propertyName, valueOf, type Edit } from './config-source.ts';
import type { Tree } from './tree.ts';

/**
 * @param tree The project.
 * @param renames The renames to make.
 * @returns A note for each rename it could not make.
 */
export async function renameOptions(
    tree: Tree,
    renames: readonly RenamedOption[] = RENAMED_OPTIONS,
): Promise<string[]> {
    const file = CONFIG_FILES.find((name) => tree.exists(name));
    const text = file === undefined ? undefined : tree.read(file);
    if (file === undefined || text === undefined || renames.length === 0) return [];
    const { gates } = parseConfig(file, text);
    if (gates === null) return [];

    const edits: Edit[] = [];
    const notes: string[] = [];
    for (const { gate, from, to } of renames) {
        const options = valueOf(gates, gate);
        if (options === undefined || !ts.isObjectLiteralExpression(options)) continue;
        const old = options.properties.find((property) => propertyName(property) === from);
        if (old?.name === undefined) continue;
        if (options.properties.some((property) => propertyName(property) === to)) {
            notes.push(
                `${file}: "${gate}" sets both \`${from}\` and \`${to}\`. Keep the value you want under \`${to}\`.`,
            );
            continue;
        }
        edits.push(
            ts.isShorthandPropertyAssignment(old)
                ? { start: old.getStart(), end: old.end, text: `${asKey(to)}: ${from}` }
                : { start: old.name.getStart(), end: old.name.end, text: asKey(to) },
        );
    }
    if (edits.length > 0) tree.write(file, await prettify(file, applyEdits(text, edits)));
    return notes;
}
