import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BASE_FLAGS, ENVIRONMENTAL, SECTIONS, inspectTsconfigs } from '../src/gates/tsconfigs.js';

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

/** A repo that passes everything, so a case only has to break one thing. */
const good = (overrides = {}) => ({
    'package.json': { scripts: { typecheck: 'tsc -p app/tsconfig.json' } },
    'tsconfig.base.json': strictBase(),
    'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [] } },
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
    const result = run(t, good({ 'app/tsconfig.json': { compilerOptions: { types: [] } } }));
    assert.match(whats(result), /does not extend tsconfig\.base\.json/);
});

test('the base listed before a preset fails, because later entries win', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: ['../tsconfig.base.json', './preset.json'],
                compilerOptions: { types: [] },
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
                compilerOptions: { types: [] },
            },
            'app/preset.json': { compilerOptions: {} },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('an `extends` that resolves to nothing is reported as unresolved, not as absent', (t) => {
    const result = run(
        t,
        good({ 'app/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: { types: [] } } }),
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
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "types": [],\n        "noUnusedLocals": false\n    }\n}\n',
        }),
    );
    assert.match(whats(result), /overrides `noUnusedLocals: false` with no reason/);
});

test('a reason on the line above clears the override', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "types": [],\n        // generated code trips this; remove once the generator is replaced\n        "noUnusedLocals": false\n    }\n}\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a trailing reason on the same line clears the override', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "types": [],\n        "noUnusedLocals": false // generated code trips this\n    }\n}\n',
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a section divider above the flag is a label, not a reason', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "types": [],\n        /* ${SECTIONS[3]} */\n        "noUnusedLocals": false\n    }\n}\n`,
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
                compilerOptions: { types: [], noUnusedLocals: true },
            },
        }),
    );
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 4. target and lib agree ─────────────────────────────────────────────────
test('a target with no lib fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [], target: 'ES2023' } },
        }),
    );
    assert.match(whats(result), /sets `target: "ES2023"` with no `lib`/);
});

test('a target and lib naming different ES years fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: { types: [], target: 'ES2023', lib: ['ES2020'] },
            },
        }),
    );
    assert.match(whats(result), /targets ES2023 but its lib starts at ES2020/);
});

test('a target and lib that agree pass, whatever the casing', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': {
                extends: '../tsconfig.base.json',
                compilerOptions: { types: [], target: 'ES2023', lib: ['es2023', 'DOM'] },
            },
        }),
    );
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
            'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: { types: ['node'] } },
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
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        "types": ["node"]\n    }\n}\n',
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
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        // the shared package is consumed as source and its env config reads process.env\n        "types": ["node"]\n    }\n}\n',
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
                compilerOptions: { types: [], target: 'ES2023', lib: ['ES2023', 'WebWorker', 'ScriptHost'] },
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
                compilerOptions: { types: [], target: 'ES2023', lib: ['ES2023', 'DOM', 'DOM.Iterable'] },
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
            'orphan/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [] } },
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
        'app/tsconfig.app.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [] } },
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('a bare `tsc` reaches the tsconfig.json beside its manifest', (t) => {
    const result = run(t, {
        'package.json': { scripts: { typecheck: 'tsc --noEmit' } },
        'tsconfig.base.json': strictBase(),
        'tsconfig.json': { extends: './tsconfig.base.json', compilerOptions: { types: [] } },
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
        'app/tsconfig.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [] } },
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
        'app/tsconfig.app.json': { extends: '../tsconfig.base.json', compilerOptions: { types: [] } },
    });
    assert.match(whats(result), /is a solution file run without `-b`/);
});

// ── 9. section dividers ─────────────────────────────────────────────────────
test('an unknown section divider fails', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json':
                '{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        /* Miscellaneous */\n        "types": []\n    }\n}\n',
        }),
    );
    assert.match(whats(result), /unknown section divider "Miscellaneous"/);
});

test('section dividers out of order fail', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        /* ${SECTIONS[2]} */\n        "types": [],\n        /* ${SECTIONS[0]} */\n        "tsBuildInfoFile": "x"\n    }\n}\n`,
        }),
    );
    assert.match(whats(result), /is out of order/);
});

test('section dividers in order pass, and a trailing reason is allowed', (t) => {
    const result = run(
        t,
        good({
            'app/tsconfig.json': `{\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": {\n        /* ${SECTIONS[0]} — where the build info goes */\n        "tsBuildInfoFile": "x",\n        /* ${SECTIONS[2]} */\n        "types": []\n    }\n}\n`,
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
                '{\n    // the app\n    "extends": "../tsconfig.base.json",\n    "compilerOptions": { "types": [] }\n}\n',
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
