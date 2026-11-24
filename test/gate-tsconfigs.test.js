import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BASE_FLAGS, ENVIRONMENTAL, SECTIONS, inspectTsconfigs } from '../src/gates/tsconfigs.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
};

const strictBase = () => ({ compilerOptions: { ...BASE_FLAGS } });

// Written out, not imported: moving the year or the floor has to change these too.
const ES_YEAR = 'ES2025';
const BROWSER_FLOOR = [
    'chrome >= 136',
    'edge >= 136',
    'firefox >= 134',
    'safari >= 26',
    'ios_saf >= 26',
    'and_chr >= 136',
    'and_ff >= 134',
];

/** A project's own options: on the year, with `types` scoped. */
const own = (extra = {}) => ({ target: ES_YEAR, lib: [ES_YEAR], types: [], ...extra });

/** A repo that passes everything, so a case only has to break one thing. */
const good = (overrides = {}) => ({
    'package.json': { scripts: { typecheck: 'tsc -p app/tsconfig.json' } },
    'tsconfig.base.json': strictBase(),
    'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: own() },
    ...overrides,
});

const run = (t, files, options = {}) => inspectTsconfigs({ root: tree(t, files), ...options });
const whats = (result) => result.problems.map((p) => p.what).join(' | ');

test('a clean repo has no problems', (t) => {
    const result = run(t, good());
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.projects, ['app/tsconfig.json']);
});

test('a missing base is the one fatal problem', (t) => {
    const files = good();
    delete files['tsconfig.base.json'];
    const result = run(t, files);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].what, /is missing/);
});

// ── 1. extends ──────────────────────────────────────────────────────────────
test('a project that does not extend the base fails', (t) => {
    const result = run(t, good({ 'app/tsconfig.json': { compilerOptions: own() } }));
    assert.match(whats(result), /does not extend tsconfig\.base\.json/);
});

test('the base listed before a preset fails, because later entries win', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: ['../tsconfig.base.json', './preset.json'],
                compilerOptions: own(),
            },
            'app/preset.json': { compilerOptions: {} },
        }),
    );
    assert.match(whats(result), /extends tsconfig\.base\.json at position 1 of 2/);
});

test('the base listed last is fine', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: ['./preset.json', '../tsconfig.base.json'],
                compilerOptions: own(),
            },
            'app/preset.json': { compilerOptions: {} },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('an `extends` that resolves to nothing is reported as unresolved, not as absent', (t) => {
    const result = run(
        t,
        good({ 'app/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: own() } }),
    );
    assert.match(whats(result), /does not resolve to tsconfig\.base\.json/);
});

// ── 2. the base owns the flags ──────────────────────────────────────────────
test('a checking flag missing from the base fails', (t) => {
    const base = strictBase();
    delete base.compilerOptions.strict;
    const result = run(t, good({ 'tsconfig.base.json': base }));
    assert.match(whats(result), /does not set `strict`/);
});

test('a checking flag at the lax value in the base fails', (t) => {
    const base = strictBase();
    base.compilerOptions.noUnusedLocals = false;
    const result = run(t, good({ 'tsconfig.base.json': base }));
    assert.match(whats(result), /sets `noUnusedLocals: false`/);
});

test('an environmental setting in the base fails', (t) => {
    const base = strictBase();
    base.compilerOptions.target = 'ES2023';
    const result = run(t, good({ 'tsconfig.base.json': base }));
    assert.match(whats(result), /sets `target`/);
});

test('a tsconfig tsc cannot read is reported, not walked into a crash', (t) => {
    for (const project of [
        { extends: 5, compilerOptions: own() },
        { extends: '../tsconfig.base.json', compilerOptions: 'x' },
    ]) {
        const result = run(t, good({ 'app/tsconfig.json': project }));
        assert.ok(
            result.problems.some((p) => p.file === 'app/tsconfig.json' && p.what === 'is not a tsconfig tsc can read'),
            JSON.stringify(project),
        );
    }
});

test('every environmental setting is rejected in the base', (t) => {
    for (const setting of ENVIRONMENTAL) {
        const base = strictBase();
        base.compilerOptions[setting] = setting === 'lib' ? ['ES2023'] : 'x';
        const result = run(t, good({ 'tsconfig.base.json': base }));
        assert.match(whats(result), new RegExp(`sets \`${setting}\``), setting);
    }
});

// ── 3. an override needs a reason ───────────────────────────────────────────
test('weakening a base flag with no reason fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        "types": [],\n        "noUnusedLocals": false\n    }\n}\n',
        }),
    );
    assert.match(whats(result), /overrides `noUnusedLocals: false` with no reason/);
});

test('a reason on the line above clears the override', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        "types": [],\n        // generated code trips this; remove once the generator is replaced\n        "noUnusedLocals": false\n    }\n}\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a trailing reason on the same line clears the override', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        "types": [],\n        "noUnusedLocals": false // generated code trips this\n    }\n}\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a section divider above the flag is a label, not a reason', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        "types": [],\n        /* ${SECTIONS[3]} */\n        "noUnusedLocals": false\n    }\n}\n`,
        }),
    );
    assert.match(whats(result), /overrides `noUnusedLocals: false` with no reason/);
});

test('matching the base value is not an override', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: own({ noUnusedLocals: true }),
            },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 4. one ES year, stated in the repo ──────────────────────────────────────
const project = (compilerOptions, extendsFrom = '../tsconfig.base.json') =>
    good({ 'app/tsconfig.json': { extends: extendsFrom, compilerOptions } });

test('a project with no target or lib fails on each', (t) => {
    const result = run(t, project({ types: [] }));
    assert.match(whats(result), /does not set `target`/);
    assert.match(whats(result), /does not set `lib`/);
});

test("a published preset's year does not count: it moves on the preset's upgrade", (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: ['@vue/tsconfig/tsconfig.dom.json', '../tsconfig.base.json'],
                compilerOptions: { types: [] },
            },
            'node_modules/@vue/tsconfig/tsconfig.dom.json': { compilerOptions: { target: 'ESNext', lib: ['ES2022'] } },
        }),
    );
    assert.match(whats(result), /does not set `target`/);
    assert.match(whats(result), /does not set `lib`/);
});

test('a year inherited from a local config counts', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': { extends: ['./env.json', '../tsconfig.base.json'], compilerOptions: { types: [] } },
            'app/env.json': { compilerOptions: { target: ES_YEAR, lib: [ES_YEAR, 'DOM'] } },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('an earlier year fails on target and on lib', (t) => {
    const result = run(t, project(own({ target: 'ES2024', lib: ['ES2024'] })));
    assert.match(whats(result), new RegExp(`targets ES2024, not ${ES_YEAR}`));
    assert.match(whats(result), new RegExp(`has a lib starting at ES2024, not ${ES_YEAR}`));
});

test('a target and lib of different years fail, whichever is off', (t) => {
    assert.match(whats(run(t, project(own({ lib: ['ES2022', 'DOM'] })))), /has a lib starting at ES2022/);
    assert.match(whats(run(t, project(own({ target: 'ESNext' })))), /targets ESNext/);
    assert.match(whats(run(t, project(own({ target: 5 })))), /targets 5/);
    assert.match(whats(run(t, project(own({ lib: [] })))), /has a lib starting at nothing/);
});

test('a lib entry past the year fails, a smaller one passes', (t) => {
    assert.match(
        whats(run(t, project(own({ lib: [ES_YEAR, 'ESNext.Disposable'] })))),
        /has the lib entry ESNext\.Disposable/,
    );
    assert.match(whats(run(t, project(own({ lib: [ES_YEAR, 'ES2099.Array'] })))), /has the lib entry ES2099\.Array/);
    const result = run(t, project(own({ lib: [ES_YEAR, 'ES2020.Intl', 'DOM', 'DOM.Iterable'] })));
    assert.equal(result.problems.length, 0, whats(result));
});

test('the year passes in either casing', (t) => {
    const result = run(t, project(own({ target: ES_YEAR.toLowerCase(), lib: [ES_YEAR.toLowerCase(), 'dom'] })));
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 5. types ────────────────────────────────────────────────────────────────
test('a project with no `types` fails', (t) => {
    const result = run(t, good({ 'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: {} } }));
    assert.match(whats(result), /does not declare `types`/);
});

test('a nodeTyped project must declare exactly ["node"]', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: { types: ['node', 'vitest/globals'] },
            },
        }),
        { nodeTyped: ['app/tsconfig.json'] },
    );
    assert.match(whats(result), /declares types \["node","vitest\/globals"\]/);
});

test('a nodeTyped project declaring exactly ["node"] passes', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: own({ types: ['node'] }) },
        }),
        { nodeTyped: ['app/tsconfig.json'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 6a. a browser project is not typed against Node ─────────────────────────
test("`node` in a browser project's types fails", (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        "types": ["node"]\n    }\n}\n',
        }),
        { browserProjects: ['app/tsconfig.json'] },
    );
    assert.match(whats(result), /declares `node` in `types` with no reason/);
});

test('a reason next to `types` clears it — the rule-3 idiom', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        // the shared package is consumed as source and its env config reads process.env\n        "types": ["node"]\n    }\n}\n',
        }),
        { browserProjects: ['app/tsconfig.json'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a non-browser lib in a browser project fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: own({ lib: [ES_YEAR, 'WebWorker', 'ScriptHost'] }),
            },
        }),
        { browserProjects: ['app/tsconfig.json'] },
    );
    assert.match(whats(result), /declares lib .*ScriptHost/);
});

test('ES and DOM libs pass', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: own({ lib: [ES_YEAR, 'DOM', 'DOM.Iterable'] }),
            },
        }),
        { browserProjects: ['app/tsconfig.json'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a browserProjects entry naming a config that does not exist is silent', (t) => {
    const result = run(t, good(), { browserProjects: ['nope/tsconfig.json'] });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 6b. browser SOURCE does not touch Node ──────────────────────────────────
test('a Node builtin imported in a browser tree fails', (t) => {
    const result = run(t, good({ 'app/src/loader.ts': "import fs from 'node:fs';\nexport const x = fs;\n" }), {
        browserSources: ['app/src'],
    });
    assert.match(whats(result), /imports the Node builtin "node:fs"/);
});

test('the bare spelling of a builtin is caught too', (t) => {
    const result = run(t, good({ 'app/src/loader.ts': "import { join } from 'path';\nexport const x = join;\n" }), {
        browserSources: ['app/src'],
    });
    assert.match(whats(result), /imports the Node builtin "path"/);
});

test('a Node global used in a browser tree fails', (t) => {
    const result = run(t, good({ 'app/src/config.ts': "export const mode = process.env['NODE_ENV'];\n" }), {
        browserSources: ['app/src'],
    });
    assert.match(whats(result), /uses the Node global `process\s*\.\s*env`/);
});

test('`audioBuffer.` is not a `Buffer.` hit', (t) => {
    const result = run(
        t,
        good({ 'app/src/audio.ts': 'export const f = (audioBuffer) => audioBuffer.getChannelData(0);\n' }),
        { browserSources: ['app/src'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a test file in a browser tree may use Node', (t) => {
    const result = run(
        t,
        good({
            'app/src/__tests__/theme.test.ts':
                "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
            'app/src/other.spec.ts': "export const mode = process.env['NODE_ENV'];\n",
        }),
        { browserSources: ['app/src'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a Node builtin named only inside a comment is not a hit', (t) => {
    const result = run(
        t,
        good({ 'app/src/note.ts': "// we deliberately avoid import fs from 'node:fs' here\nexport const x = 1;\n" }),
        { browserSources: ['app/src'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a browser-safe module with a similar name is not a hit', (t) => {
    const result = run(
        t,
        good({
            'app/src/ok.ts':
                "import { format } from 'date-fns';\nimport p from 'path-browserify';\nexport const x = [format, p];\n",
        }),
        { browserSources: ['app/src'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 6c. a source-only package never emits ───────────────────────────────────
test('an emit setting on a source-only package fails', (t) => {
    for (const setting of ['outDir', 'declaration', 'composite', 'declarationDir', 'emitDeclarationOnly']) {
        const result = run(
            t,
            good({
                'app/tsconfig.json': {
                    extends: '../tsconfig.base.json',
                    compilerOptions: {
                        types: [],
                        [setting]: setting === 'outDir' || setting === 'declarationDir' ? 'dist' : true,
                    },
                },
            }),
            { nonEmitting: ['app/tsconfig.json'] },
        );
        assert.match(whats(result), new RegExp(`sets \\\`${setting}\\\``), setting);
    }
});

test('a source-only package with no emit setting passes', (t) => {
    const result = run(t, good(), { nonEmitting: ['app/tsconfig.json'] });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 7. reachability ─────────────────────────────────────────────────────────
test('a project no script points a compiler at fails', (t) => {
    const result = run(
        t,
        good({
            'package.json': { scripts: { typecheck: 'tsc -p app/tsconfig.json' } },
            'orphan/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: own() },
        }),
    );
    assert.match(whats(result), /orphan\/tsconfig\.json.*|is not reached by any typecheck script/);
    assert.ok(
        result.problems.some((p) => p.file === 'orphan/tsconfig.json' && /not reached/.test(p.what)),
        whats(result),
    );
});

test('build mode follows references, so a referenced project is reached', (t) => {
    const result = run(t, {
        'package.json': { scripts: { typecheck: 'tsc -b app/tsconfig.json' } },
        'tsconfig.base.json': strictBase(),
        'app/tsconfig.json': { files: [], references: [{ path: './tsconfig.app.json' }] },
        'app/tsconfig.app.json': { extends: '../tsconfig.base.json', compilerOptions: own() },
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('a bare `tsc` reaches the tsconfig.json beside its manifest', (t) => {
    const result = run(t, {
        'package.json': { scripts: { typecheck: 'tsc --noEmit' } },
        'tsconfig.base.json': strictBase(),
        'tsconfig.json': { extends: './tsconfig.base.json', compilerOptions: own() },
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('`tsc-alias` is not a compiler run', (t) => {
    const result = run(t, good({ 'package.json': { scripts: { build: 'tsc-alias -p app/tsconfig.json' } } }));
    assert.match(whats(result), /is not reached by any typecheck script/);
});

test('a workspace script is read too', (t) => {
    const result = run(t, {
        'package.json': { workspaces: ['app'], scripts: {} },
        'tsconfig.base.json': strictBase(),
        'app/package.json': { scripts: { typecheck: 'tsc -p tsconfig.json' } },
        'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: own() },
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('a repo with no `workspaces` field does not crash', (t) => {
    const result = run(t, good());
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 8. a solution file is only run in build mode ────────────────────────────
test('a solution file named with -p fails', (t) => {
    const result = run(t, {
        'package.json': { scripts: { typecheck: 'tsc -p app/tsconfig.json' } },
        'tsconfig.base.json': strictBase(),
        'app/tsconfig.json': { files: [], references: [{ path: './tsconfig.app.json' }] },
        'app/tsconfig.app.json': { extends: '../tsconfig.base.json', compilerOptions: own() },
    });
    assert.match(whats(result), /is a solution file run without `-b`/);
});

// ── 9. section dividers ─────────────────────────────────────────────────────
test('an unknown section divider fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        /* Miscellaneous */\n        "types": []\n    }\n}\n',
        }),
    );
    assert.match(whats(result), /unknown section divider "Miscellaneous"/);
});

test('section dividers out of order fail', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        /* ${SECTIONS[2]} */\n        "types": [],\n        /* ${SECTIONS[0]} */\n        "tsBuildInfoFile": "x"\n    }\n}\n`,
        }),
    );
    assert.match(whats(result), /is out of order/);
});

test('section dividers in order pass, and a trailing reason is allowed', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "target": "ES2025", "lib": ["ES2025"],\n        /* ${SECTIONS[0]} — where the build info goes */\n        "tsBuildInfoFile": "x",\n        /* ${SECTIONS[2]} */\n        "types": []\n    }\n}\n`,
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── parsing and walking ─────────────────────────────────────────────────────
test('a config that is not parseable JSON is reported, not thrown', (t) => {
    const result = run(t, good({ 'app/tsconfig.json': '{ "extends": "../tsconfig.base.json",, }' }));
    assert.match(whats(result), /is not parseable JSON/);
});

test('comments in a config are fine', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    // the app\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": { "target": "ES2025", "lib": ["ES2025"], "types": [] }\n}\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('build output is not walked', (t) => {
    const result = run(
        t,
        good({
            'out/tsconfig.json': { compilerOptions: { strict: false } },
            'dist/tsconfig.json': { compilerOptions: {} },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('`ignore` adds to the skipped directories rather than replacing them', (t) => {
    const result = run(
        t,
        good({ 'android/tsconfig.json': { compilerOptions: {} }, 'out/tsconfig.json': { compilerOptions: {} } }),
        { ignore: ['android'] },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 10. a Vite build ships the year, to the floor ───────────────────────────
const year = ES_YEAR.toLowerCase();
const viteApp = (config, manifest = { browserslist: BROWSER_FLOOR }) =>
    good({ 'web/vite.config.ts': config, 'web/package.json': manifest });

test('a Vite build on the year, with the floor beside it, passes', (t) => {
    for (const config of [
        `import { defineConfig } from 'vite';\nexport default defineConfig({ build: { target: '${year}' } });\n`,
        `export default defineConfig(({ mode }) => ({ build: { target: '${year}' }, oxc: { target: '${year}' } }));\n`,
        `export default defineConfig(() => {\n    const port = 1;\n    return { server: { port }, build: { target: "${year}" } };\n});\n`,
        `const config = { build: { target: '${year}' } } satisfies UserConfig;\nexport default config;\n`,
        `export default { 'build': { 'target': '${year}' } };\n`,
    ]) {
        const result = run(t, viteApp(config));
        assert.equal(result.problems.length, 0, `${config}\n${whats(result)}`);
        assert.deepEqual(result.viteBuilds, ['web/vite.config.ts']);
    }
});

test('a Vite build with no build.target fails: the default moves with Vite', (t) => {
    const result = run(t, viteApp(`export default defineConfig({ plugins: [] });\n`));
    assert.match(whats(result), /does not set `build\.target`/);
});

test('a target in a comment or a variable named for it does not count', (t) => {
    const result = run(
        t,
        viteApp(
            `const target = '${year}';\n// build: { target: '${year}' }\nexport default defineConfig({ build: {} });\n`,
        ),
    );
    assert.match(whats(result), /does not set `build\.target`/);
});

test('a build.target off the year fails, a browser list included', (t) => {
    for (const target of [`'es2020'`, `'esnext'`, `['${year}', 'safari14']`, `'baseline-widely-available'`]) {
        const result = run(t, viteApp(`export default defineConfig({ build: { target: ${target} } });\n`));
        assert.match(whats(result), /sets `build\.target` to/, target);
    }
});

test('an oxc.target off the year fails', (t) => {
    const result = run(
        t,
        viteApp(`export default defineConfig({ oxc: { target: 'es2020' }, build: { target: '${year}' } });\n`),
    );
    assert.match(whats(result), /sets `oxc\.target` to 'es2020'/);
});

test('a config the gate cannot find an object in fails rather than passing', (t) => {
    const result = run(t, viteApp(`export default mergeConfig;\n`));
    assert.match(whats(result), /exports no config object/);
});

test('the browser floor is read from the nearest package.json', (t) => {
    const config = `export default defineConfig({ build: { target: '${year}' } });\n`;
    const missing = run(t, viteApp(config, {}));
    assert.match(whats(missing), /declares no `browserslist` for the build in web\/vite\.config\.ts/);
    assert.equal(missing.problems[0]?.file, 'web/package.json');

    const old = run(t, viteApp(config, { browserslist: ['defaults', 'Safari >= 14'] }));
    assert.match(whats(old), /declares `browserslist` \["defaults","Safari >= 14"\], not the floor/);

    const files = viteApp(config);
    delete files['web/package.json'];
    files['package.json'] = { ...files['package.json'], browserslist: BROWSER_FLOOR };
    const atRoot = run(t, files);
    assert.equal(atRoot.problems.length, 0, whats(atRoot));
});

test('an electron-vite config is not a browser build', (t) => {
    const result = run(t, good({ 'electron.vite.config.ts': 'export default defineConfig({});\n' }));
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.viteBuilds, []);
});
