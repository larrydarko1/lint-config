/**
 * Reading JSON a project wrote. What a file holds is unknown until it is checked, so it is
 * read as `unknown` and narrowed where a field is read.
 */
import fs from 'node:fs';

/** A JSON object, not an array or null. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parsed contents of a JSON file. */
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** `value[key]` when `value` is an object and that field is a string. */
export const stringAt = (value: unknown, key: string): string | undefined => {
    const field = isRecord(value) ? value[key] : undefined;
    return typeof field === 'string' ? field : undefined;
};
