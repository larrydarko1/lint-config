/**
 * Which family a package.json looks like: a dependency only one kind of project has, or
 * `exports` on a package that is not private. `larry doctor` says so on a base project,
 * and `larry init` starts its family question there.
 */
import type { PresetName } from '../eslint/presets.ts';
import { isRecord } from '../gates/lib/json.ts';

/**
 * A dependency only one kind of project has, and the family for it. In this order, since
 * an Electron or Tauri app depends on Vue too.
 */
const FAMILY_DEPENDENCIES: [family: PresetName, dependency: string][] = [
    ['electron', 'electron'],
    ['tauri', '@tauri-apps/api'],
    ['spa', 'vue'],
    ['api', 'express'],
];

/** The family package.json first has a sign of, and the sign. Undefined when it has none. */
export function familyFit(manifest: Record<string, unknown>): [family: PresetName, sign: string] | undefined {
    const dependencies = [manifest['dependencies'], manifest['devDependencies']].flatMap((field) =>
        isRecord(field) ? Object.keys(field) : [],
    );
    const published = manifest['private'] !== true && manifest['exports'] !== undefined;
    const signs: [family: PresetName, sign: string][] = [
        ...FAMILY_DEPENDENCIES.filter(([, dependency]) => dependencies.includes(dependency)).map(
            ([family, dependency]): [PresetName, string] => [family, `depends on ${dependency}`],
        ),
        ...(published ? [['library', 'publishes `exports`'] as [PresetName, string]] : []),
    ];
    return signs[0];
}
