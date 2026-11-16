/** A tsconfig as JSON: the keys the gates read, typed only once they have the shape tsc reads. */
import { isRecord, toRecord } from './json.ts';

/** compilerOptions, naming only the settings a gate reads by name. */
export type CompilerOptions = Record<string, unknown>;

export type TsconfigJson = {
    extends?: string | string[];
    compilerOptions?: CompilerOptions;
    files?: string[];
    references?: { path: string }[];
};

/** The keys a gate reads, each in the shape tsc reads it. */
export function isTsconfigJson(value: unknown): value is TsconfigJson {
    if (!isRecord(value)) return false;
    const { extends: parent, compilerOptions: options, files, references } = value;
    return (
        (parent === undefined || typeof parent === 'string' || isStringList(parent)) &&
        (options === undefined || isRecord(options)) &&
        (files === undefined || isStringList(files)) &&
        (references === undefined ||
            (Array.isArray(references) && references.every((ref) => typeof toRecord(ref)['path'] === 'string')))
    );
}

const isStringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
