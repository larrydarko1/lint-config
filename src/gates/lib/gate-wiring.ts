/**
 * The pipeline gate's rule 17: every gate runs from one local command and on every push.
 * A gate is either a `check-*.ts` script, wired through a package.json script into
 * `ci:check` and ci.yml, or one of the set larry.config.ts configures, which
 * `larry check` runs and which must be wired the same way.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILES } from '../../config.ts';
import type { GateFailure } from './report.ts';

type GateWiringInput = {
    root: string;
    /** Where the `check-*.ts` gate scripts live. */
    checksDir: string;
    /** The workflow that must run every gate. */
    ciWorkflow: string;
    /** The root manifest's `scripts`. */
    scripts: Record<string, unknown>;
    /** Every `run:` in the CI workflow, one per line. Null when there is no CI workflow. */
    ciRuns: string | null;
};

type GateWiring = {
    problems: GateFailure[];
    /** How many `check-*.ts` scripts there are. */
    gateScripts: number;
    /** Whether a larry.config.ts holds the gates, so `larry check` runs them. */
    larry: boolean;
};

/** `larry check` with no gate named, so every gate runs. The CLI run from its own source (`larry.ts`) counts too. */
const LARRY_CHECK = /\blarry(?:\.[jt]s)?[^\S\n]+check(?:[^\S\n]+--[\w-]+)*[^\S\n]*(?:$|&&|\|\||;)/m;

export function inspectGateWiring(input: GateWiringInput): GateWiring {
    const { root, checksDir, ciWorkflow, scripts, ciRuns } = input;
    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string): void => {
        problems.push({ file, what, why });
    };

    const checksDirPath = path.join(root, checksDir);
    const gateScripts = fs.existsSync(checksDirPath)
        ? fs
              .readdirSync(checksDirPath)
              .filter((f) => f.startsWith('check-') && f.endsWith('.ts'))
              .sort()
              .map((f) => `${checksDir}/${f}`)
        : [];

    const larryConfig = CONFIG_FILES.find((file) => fs.existsSync(path.join(root, file)));
    if (gateScripts.length === 0 && larryConfig === undefined) {
        fail(
            checksDir,
            'contains no check-*.ts scripts, and there is no larry.config.ts',
            'This section would pass vacuously. Did the directory move?',
        );
    }

    const ciCheck = typeof scripts['ci:check'] === 'string' ? scripts['ci:check'] : '';
    if (ciCheck === '') {
        fail(
            'package.json',
            'has no `ci:check` script',
            'It is the one command that runs every gate locally. Without it each gate has to be remembered individually, which is the same as not having them.',
        );
    }
    if (ciRuns === null) fail(ciWorkflow, 'missing', 'Nothing runs the gates on push, so all of them are advisory.');

    for (const gate of gateScripts) {
        const entry = Object.entries(scripts).find(([, cmd]) => String(cmd).includes(gate));
        if (entry === undefined) {
            fail(
                gate,
                'is not invoked by any package.json script',
                'Nothing can run it, so the standard it encodes is enforced by nobody. Add a `<domain>:check` script for it.',
            );
            continue;
        }
        const [scriptName] = entry;
        if (!npmRuns(scriptName).test(ciCheck)) {
            fail(
                'package.json',
                `\`ci:check\` does not run \`${scriptName}\` (${gate})`,
                'The gate exists and is skipped locally. Chain it into ci:check so one command still means "everything".',
            );
        }
        if (ciRuns !== null && !npmRuns(scriptName).test(ciRuns)) {
            fail(
                ciWorkflow,
                `has no step running \`${scriptName}\` (${gate})`,
                'The gate exists and is skipped on push, so a violation reaches main and is only caught by whoever happens to run ci:check locally.',
            );
        }
    }

    if (larryConfig !== undefined) {
        const larryScript = Object.entries(scripts).find(([, cmd]) => LARRY_CHECK.test(String(cmd)))?.[0];
        const runsLarry = (text: string): boolean =>
            LARRY_CHECK.test(text) || (larryScript !== undefined && npmRuns(larryScript).test(text));
        if (!runsLarry(ciCheck)) {
            fail(
                'package.json',
                '`ci:check` does not run `larry check`',
                `${larryConfig} holds this project's gates, and \`larry check\` with no gate named runs them all. Chain it into ci:check, directly or through a script, so one command still means "everything".`,
            );
        }
        if (ciRuns !== null && !runsLarry(ciRuns)) {
            fail(
                ciWorkflow,
                'has no step running `larry check`',
                `${larryConfig} holds this project's gates and nothing runs them on push, so a violation reaches main and is only caught by whoever happens to run ci:check locally.`,
            );
        }
    }

    return { problems, gateScripts: gateScripts.length, larry: larryConfig !== undefined };
}

/** Matches `npm run <script>` and not a longer name it begins: `npm run check` is not `npm run check:package`. */
const npmRuns = (script: string): RegExp =>
    new RegExp(`\\bnpm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:.-])`);
