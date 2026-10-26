/**
 * Finds larry.config.ts at the repository root, imports it, and checks what it holds
 * against the registry. The types catch most mistakes in the editor, but a config in
 * plain JavaScript has none, and a typo in a gate's name must not quietly skip it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONFIG_FILES } from '../config.ts';
import { PRESETS, type PresetName } from '../eslint/presets.ts';
import { GATES, gatesFor, type GateName } from '../gates/registry.ts';

/** A config that loaded, reduced to what the runner needs. */
export type LoadedConfig = {
    /** The config's file name, relative to the root. */
    file: string;
    family: PresetName;
    /** The options for each configured gate. A gate the family runs that is not here runs on its defaults. */
    options: Map<GateName, Record<string, unknown>>;
    /** Each skipped gate, with its reason. */
    skipped: Map<GateName, string>;
};

/**
 * @param root The repository root, where the config sits.
 * @returns The config, validated.
 * @throws When there is no config, or it does not validate. The message lists every problem.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
    const file = CONFIG_FILES.find((name) => fs.existsSync(path.join(root, name)));
    if (file === undefined) {
        throw new Error(
            `no ${CONFIG_FILES.join(' or ')} in ${root}. Create one that default-exports defineConfig({ family, gates }) from @larrydarko/lint-config/config.`,
        );
    }
    const mod: unknown = await import(pathToFileURL(path.join(root, file)).href);
    return { file, ...validateConfig(isRecord(mod) ? mod['default'] : undefined, file) };
}

/**
 * @param config What the config file default-exports.
 * @param file The file's name, for the messages.
 * @returns The family, and each gate's options or reason for skipping it.
 * @throws When anything is wrong, listing every problem rather than the first.
 */
function validateConfig(config: unknown, file: string): Omit<LoadedConfig, 'file'> {
    if (!isRecord(config)) {
        throw new Error(`${file} must default-export the config: \`export default defineConfig({ family, gates })\`.`);
    }
    const { family, gates = {} } = config;
    if (!isFamily(family)) {
        throw new Error(`${file}: family is ${JSON.stringify(family)}, not one of ${Object.keys(PRESETS).join(', ')}.`);
    }
    if (!isRecord(gates)) throw new Error(`${file}: gates must be an object keyed by gate name.`);

    const runs: readonly string[] = gatesFor(family);
    const problems: string[] = [];
    const options = new Map<GateName, Record<string, unknown>>();
    const skipped = new Map<GateName, string>();

    for (const [name, value] of Object.entries(gates)) {
        if (!isGate(name)) {
            problems.push(`"${name}" is not a gate. ${family} projects run: ${runs.join(', ')}.`);
        } else if (!runs.includes(name)) {
            problems.push(`"${name}" is not a gate ${family} projects run, so its options would never be read.`);
        } else if (!isRecord(value)) {
            problems.push(`"${name}" must be the gate's options, or { skip: 'why this project does not run it' }.`);
        } else if (!('skip' in value)) {
            options.set(name, value);
        } else if (typeof value['skip'] !== 'string' || value['skip'].trim() === '') {
            problems.push(`"${name}" is skipped without a reason. Say why this project does not run it.`);
        } else if (Object.keys(value).length > 1) {
            problems.push(`"${name}" is skipped and given options. Keep one or the other.`);
        } else {
            skipped.set(name, value['skip']);
        }
    }

    if (problems.length > 0) throw new Error(`${file}:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
    return { family, options, skipped };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFamily = (value: unknown): value is PresetName => typeof value === 'string' && Object.hasOwn(PRESETS, value);

const isGate = (name: string): name is GateName => Object.hasOwn(GATES, name);
