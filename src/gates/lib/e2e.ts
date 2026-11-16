/**
 * The testing gate's E2E rules: a `.spec` file belongs to the E2E suite (rule 2), which
 * lives where the project said or nowhere (rule 3), and a run fails on a server error
 * (rule 10). For the tripwire, the fixtures record every 5xx with the API's log, the
 * teardown reads the log for every error, the Playwright config wires both, and every
 * spec takes `test` from the fixtures.
 */
import path from 'node:path';

import { dependencyNames } from './json.ts';
import { callArgs } from './source.ts';
import { stripComments } from './strip-comments.ts';

/** Where the E2E tripwire for server errors is wired. */
export type ServerErrorWiring = {
    /**
     * The fixtures module every spec imports `test` from. It must create the
     * recorder with the API's `logFile`, watch the browser context, and drain it.
     */
    fixtures: string;
    /** The Playwright global teardown. It must read the API's log with `logErrors`. */
    teardown: string;
};

/** Where the E2E suite lives, or `false` where there deliberately is none. */
export type E2eLayout = false | { dir: string; config: string };

type FileAccess = {
    read: (rel: string) => string;
    exists: (rel: string) => boolean;
    fail: (file: string, what: string, why: string) => void;
};

/** A named import from Playwright itself: `import { test, expect } from '@playwright/test'`. */
const PLAYWRIGHT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]/g;

/** Rules 2 and 3: every `.spec` file is in the E2E suite, and the suite is where `e2e` says. */
export function inspectE2eLayout(e2e: E2eLayout, found: { files: string[]; specs: string[] }, io: FileAccess): void {
    const { read, exists, fail } = io;
    const { files, specs } = found;
    // ── 2. A `.spec` file belongs to the E2E runner ─────────────────────────
    for (const rel of specs) {
        if (e2e === false) {
            fail(
                rel,
                'a .spec file',
                'Every test file ends in `.test.ts`. Vitest matches that suffix and nothing else, so a `.spec` file is run by nothing at all while still reading as a test — rename it.',
            );
        } else if (!rel.startsWith(`${e2e.dir}/`)) {
            fail(
                rel,
                `a .spec file outside \`${e2e.dir}/\``,
                `Playwright specs live in \`${e2e.dir}/\`. Anywhere else, no runner picks the file up: Vitest matches \`*.test.ts\`, Playwright only looks under its own testDir — so the suite silently stops running while still looking like a test.`,
            );
        }
    }

    // ── 3. E2E lives where this project said, which may be nowhere ──────────
    if (e2e === false) {
        for (const rel of files.filter((f) => f.startsWith('e2e/') || f.startsWith('playwright.config.'))) {
            fail(
                rel,
                'an E2E suite appearing without discussion',
                'There is deliberately no E2E suite here. The standard asks that adding one back be raised first — so raise it, then turn `e2e` on in this gate along with the paragraph in the contributing guide.',
            );
        }
        for (const dep of dependencyNames(JSON.parse(read('package.json')))) {
            if (/^(@playwright\/|playwright)/.test(dep)) {
                fail(
                    'package.json',
                    `\`${dep}\` is installed`,
                    'The same decision arriving through the manifest instead of a config file. An E2E dependency nothing runs is a CI install cost and an unread intent.',
                );
            }
        }
    } else if (specs.length > 0 && !exists(e2e.config)) {
        fail(
            e2e.config,
            'missing',
            'E2E tests get their own Playwright config, separate from the Vitest projects. Without it the specs under `e2e/` are run by nothing.',
        );
    }
}

/** Rule 10: the recorder, the teardown, the config that wires them, and specs that use them. */
export function inspectServerErrors(wiring: ServerErrorWiring, e2e: E2eLayout, specs: string[], io: FileAccess): void {
    const { read, exists, fail } = io;
    const { fixtures, teardown } = wiring;

    if (e2e === false) {
        fail(
            fixtures,
            '`serverErrors` is stated but there is no E2E suite',
            'The tripwire runs inside the E2E suite: it needs the real API serving the browser. State `e2e` first, or drop `serverErrors`.',
        );
        return;
    }

    if (!exists(fixtures)) {
        fail(
            fixtures,
            'missing',
            'It is the fixtures module every spec imports `test` from, where the recorder lives.',
        );
    } else {
        const source = stripComments(read(fixtures));
        const created = callArgs(source, 'createServerErrorRecorder(');
        if (created.length === 0) {
            fail(
                fixtures,
                'never creates a server-error recorder',
                'A test that checks what it came to check walks straight past a 500 on the side: the page still renders, a spinner just never stops. The recorder watches every API response and fails the test that received a 5xx.',
            );
        }
        if (created.length > 0 && !created.some((args) => /\blogFile\b/.test(args))) {
            fail(
                fixtures,
                "creates the server-error recorder without the API's `logFile`",
                'Without the log, a failure says that a request failed but not why. With it, the failure carries what the API logged for that request id: the error, its message and the line it came from.',
            );
        }
        const name = recorderName(source);
        for (const [method, what] of [
            ['watch', 'never watches a browser context'],
            ['drain', 'never drains the recorder'],
        ] as const) {
            if (created.length > 0 && !new RegExp(`\\b${name}\\s*\\.\\s*${method}\\s*\\(`).test(source)) {
                fail(
                    fixtures,
                    `${what} for server errors`,
                    'The recorder sees only the contexts it watches, and fails a test only when it is drained after it. Watch the context every test gets, and drain in an `auto` fixture.',
                );
            }
        }
    }

    if (!exists(teardown)) {
        fail(teardown, 'missing', 'It is where the run reads the API log for errors no test saw as a 5xx.');
    } else if (!/\blogErrors\s*\(/.test(stripComments(read(teardown)))) {
        fail(
            teardown,
            'never reads the API log with `logErrors`',
            'Some failures never become a 5xx: a socket push its schema refused, a job that died in the background, an error logged inside a request that still answered 2xx. The teardown is the net for those — read every error-level line of the run and fail on any.',
        );
    }

    const config = stripComments(read(e2e.config));
    const teardownName = path.basename(teardown).replace(/\.[cm]?[jt]s$/, '');
    if (!new RegExp(`globalTeardown\\s*:\\s*['"][^'"]*${teardownName}`).test(config)) {
        fail(
            e2e.config,
            `does not run \`${teardown}\` as its globalTeardown`,
            'A teardown nothing registers never runs, and the run passes over every error the API logged.',
        );
    }
    if (!/\bLOG_FILE\b/.test(config)) {
        fail(
            e2e.config,
            'does not hand the API a `LOG_FILE`',
            'The API writes the JSON log the recorder and the teardown read only when `LOG_FILE` is set. Set it in the `webServer` env the suite boots the API with.',
        );
    }

    for (const rel of specs.filter((spec) => spec.startsWith(`${e2e.dir}/`))) {
        const source = stripComments(read(rel));
        for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
            const names = (match[1] ?? '').split(',').map((name) => name.trim());
            if (!names.includes('test')) continue;
            fail(
                `${rel}:${source.slice(0, match.index).split('\n').length}`,
                'imports `test` from @playwright/test, not from the fixtures',
                `Playwright's own \`test\` runs none of the project's fixtures, so this spec is watched by no tripwire: a 5xx, a leaked field, anything the \`auto\` fixtures check passes unseen. Import \`test\` from ${fixtures}.`,
            );
        }
    }
}

/**
 * The name the recorder is reached by: the fixture key or the variable its
 * `createServerErrorRecorder(` call sits under. Another recorder's `.watch(` —
 * the response-leak one, say — must not answer for this one.
 */
function recorderName(source: string): string {
    const before = source.slice(0, source.indexOf('createServerErrorRecorder('));
    const bindings = [...before.matchAll(/(\w+)\s*(?::\s*\[|:\s*async\b|=(?![=>]))/g)];
    return bindings.at(-1)?.[1] ?? '\\w+';
}
