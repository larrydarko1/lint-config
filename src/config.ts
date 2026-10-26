/**
 * The shape of `larry.config.ts`: a project's family, and the options for each gate it
 * runs, in one file `larry check` reads. The types come from the gates themselves, so
 * the editor offers each gate's own options, a gate the family does not run is an
 * error, and a gate with a required option cannot be left out.
 */
import type { PresetName } from './eslint/presets.ts';
import type { FamilyGate, GateName, GateOptions } from './gates/registry.ts';

/** A gate the project does not run, and why. The reason prints each time `larry check` skips it. */
export type SkippedGate = { skip: string };

/** `root` is where the config sits; a gate is never pointed somewhere else from it. */
type ConfiguredOptions<TName extends GateName> = Omit<GateOptions<TName>, 'root'>;

/** A gate with no required option may be left out, and then runs on its defaults. */
type Optional<TName extends GateName> =
    Partial<ConfiguredOptions<TName>> extends ConfiguredOptions<TName> ? TName : never;

export type GatesConfig<TFamily extends PresetName> = {
    [TName in FamilyGate<TFamily> as TName extends Optional<TName> ? never : TName]:
        ConfiguredOptions<TName> | SkippedGate;
} & {
    [TName in FamilyGate<TFamily> as TName extends Optional<TName> ? TName : never]?:
        ConfiguredOptions<TName> | SkippedGate;
};

export type LarryConfig<TFamily extends PresetName = PresetName> = {
    /** Which family's gates `larry check` runs: the same name as the ESLint preset. */
    family: TFamily;
    /** Each gate's options, keyed by its name in the README's gate table. */
    gates: GatesConfig<TFamily>;
};

/** Where `larry` looks for the config, in this order, at the repository root. Node strips a `.ts` config's types itself. */
export const CONFIG_FILES = ['larry.config.ts', 'larry.config.js'];

/** Types `larry.config.ts`. It returns the config as given; `larry check` validates it again when it runs. */
export function defineConfig<TFamily extends PresetName>(config: LarryConfig<TFamily>): LarryConfig<TFamily> {
    return config;
}
