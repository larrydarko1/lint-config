/**
 * `larry init` at a terminal: it asks for whatever the command line left out, writes the
 * files under a spinner and lists them. Only a person at a terminal gets here. A script
 * or CI gets the usage error from larry.ts instead, so nothing ever waits on a question.
 */
import { styleText } from 'node:util';

import { cancel, intro, isCancel, log, note, outro, select, spinner, type CommonOptions } from '@clack/prompts';

import { FAMILIES, type PresetName } from '../eslint/presets.ts';
import { plural } from '../gates/lib/report.ts';
import { familyFit } from './family-fit.ts';
import { init, readManifest } from './init.ts';
import type { Distribution, Runtime } from './templates.ts';

/** What the command line said. Each one left out is asked for. */
type Given = { family: PresetName | undefined; distribution: Distribution | undefined; runtime: Runtime | undefined };

/** The exit code when the person stops at a question: the shell's for Ctrl+C. */
const CANCELLED = 130;

/** What each family is for, as the README's list puts it. */
const FAMILY_HINTS: Record<PresetName, string> = {
    api: 'an Express API in one package',
    base: 'anything else, with no layout assumed',
    electron: 'a Vue desktop app split into main, preload and renderer',
    fullstack: 'a Vue frontend and an Express API as npm workspaces',
    library: 'a TypeScript package published to npm',
    spa: 'a Vue app built by Vite, with no server of its own',
    tauri: 'a Vue app in a Tauri webview, with a Rust side',
};

/** Base last, since it is for what no other family describes. */
const FAMILY_ORDER: PresetName[] = [...FAMILIES.filter((family) => family !== 'base'), 'base'];

/**
 * @param root The repository root.
 * @param given What the command line said.
 * @param io The terminal to ask at. A test gives its own streams; the process's are the default.
 * @returns The exit code: 0 once set up, 2 when init could not be, 130 when the person stopped it.
 */
export async function initInteractively(
    root: string,
    given: Given,
    io: Pick<CommonOptions, 'input' | 'output'> = {},
): Promise<number> {
    const stopped = (): number => {
        cancel('Stopped. Nothing was written.', io);
        return CANCELLED;
    };
    intro(styleText('inverse', ' larry init '), io);

    let manifest;
    try {
        manifest = readManifest(root);
    } catch (error) {
        cancel(reason(error), io);
        return 2;
    }

    let { family, distribution, runtime } = given;
    if (family === undefined) {
        const fit = familyFit(manifest);
        const answer = await select<PresetName>({
            message: 'What kind of project is this?',
            options: FAMILY_ORDER.map((value) => ({
                value,
                label: value,
                hint: fit?.[0] === value ? `${FAMILY_HINTS[value]}; package.json ${fit[1]}` : FAMILY_HINTS[value],
            })),
            ...(fit === undefined ? {} : { initialValue: fit[0] }),
            ...io,
        });
        if (isCancel(answer)) return stopped();
        family = answer;
    }
    if (distribution === undefined) {
        const answer = await select<Distribution>({
            message: "Is the app's own source published?",
            options: [
                { value: 'closed', label: 'closed', hint: 'no, so the licenses gate allows permissive licences only' },
                { value: 'open', label: 'open', hint: 'yes, so copyleft dependencies pass too' },
            ],
            ...io,
        });
        if (isCancel(answer)) return stopped();
        distribution = answer;
    }
    if (family === 'base' && runtime === undefined) {
        const answer = await select<Runtime>({
            message: 'Where does the source run?',
            options: [
                { value: 'node', label: 'node', hint: 'Node globals' },
                { value: 'browser', label: 'browser', hint: 'browser globals' },
                { value: 'both', label: 'both', hint: 'both sets of globals' },
            ],
            ...io,
        });
        if (isCancel(answer)) return stopped();
        runtime = answer;
    }

    const writing = spinner(io);
    writing.start('Writing the config files');
    let result;
    try {
        result = await init(root, { family, distribution, runtime: runtime ?? null });
    } catch (error) {
        writing.error(reason(error));
        cancel('larry init stopped.', io);
        return 2;
    }
    writing.stop(`${family}: ${plural(result.written.length, 'file')} written`);

    const changes = [
        ...result.written.map((file) => `${styleText('green', '+')} ${file}`),
        ...result.added.map((field) => `${styleText('green', '+')} package.json ${field}`),
        ...result.kept.map((file) => styleText('dim', `= ${file} (exists, left as it is)`)),
    ];
    if (changes.length > 0) log.message(changes, io);
    note(result.next.join('\n\n'), 'Next', io);

    const asked = given.family === undefined || given.distribution === undefined || runtime !== given.runtime;
    const command = `npx larry init ${family} --distribution ${distribution}${runtime === undefined ? '' : ` --runtime ${runtime}`}`;
    outro(asked ? `Done. To skip the questions next time: ${styleText('cyan', command)}` : 'Done.', io);
    return 0;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
