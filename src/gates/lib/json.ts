/**
 * Reading JSON a project wrote. What a file holds is unknown until it is checked, so it is
 * read as `unknown` and narrowed where a field is read.
 */
import fs from 'node:fs';

/** A JSON object, not an array or null. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` when it is an object; otherwise empty. */
export const toRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** The parsed contents of a JSON file. */
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** `value[key]` when `value` is an object and that field is a string. */
export const stringAt = (value: unknown, key: string): string | undefined => {
    const field = isRecord(value) ? value[key] : undefined;
    return typeof field === 'string' ? field : undefined;
};

/** `value[key]` when `value` is an object and that field is an object too; otherwise empty. */
export const recordAt = (value: unknown, key: string): Record<string, unknown> => {
    const field = isRecord(value) ? value[key] : undefined;
    return isRecord(field) ? field : {};
};

/** The strings in `value[key]` when `value` is an object and that field is a list; otherwise none. */
export const stringsAt = (value: unknown, key: string): string[] => {
    const field = isRecord(value) ? value[key] : undefined;
    return Array.isArray(field) ? field.filter((item) => typeof item === 'string') : [];
};

/** `value[key]` when `value` is an object and that field is a list; otherwise none. */
export const listAt = (value: unknown, key: string): unknown[] => {
    const field = isRecord(value) ? value[key] : undefined;
    return Array.isArray(field) ? field : [];
};

/** Every package a package.json names in `dependencies` or `devDependencies`. */
export const dependencyNames = (manifest: unknown): string[] => [
    ...Object.keys(recordAt(manifest, 'dependencies')),
    ...Object.keys(recordAt(manifest, 'devDependencies')),
];
