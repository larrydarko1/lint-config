import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packageBin } from '../src/gates/lib/bin.ts';
import { knip, packageEntries } from '../src/knip.ts';

/**
 * A project that lists none of the linters — what every project looks like once
 * this package installs them — run through the knip this package pins. `config` is
 * the knip config, or a function from the project's root to it; `extra` adds files.
 */
const run = (t, config, extra = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knip-cfg-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = {
        'package.json': JSON.stringify({
            name: 'app',
            type: 'module',
            scripts: { lint: 'eslint .', format: 'prettier --check .', prepare: 'husky' },
            devDependencies: { '@larrydarko/lint-config': '^0.1.0' },
        }),
        'src/index.ts': 'export const answer = 42;\n',
        'eslint.config.js': 'export default [];\n',
        'prettier.config.js': 'export default {};\n',
        'lint-staged.config.js': "export default { '*.ts': ['eslint --fix'] };\n",
        '.husky/commit-msg': 'npx --no -- commitlint --edit "$1"\n',
        ...extra,
    };
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    fs.writeFileSync(
        path.join(root, 'knip.json'),
        JSON.stringify(typeof config === 'function' ? config(root) : config),
    );
    let out;
    try {
        out = execFileSync(
            process.execPath,
            [packageBin('knip'), '--no-progress', '--reporter', 'json', '--include', 'files,binaries'],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
    } catch (error) {
        out = error.stdout;
    }
    const issues = JSON.parse(out).issues ?? [];
    return {
        files: issues.filter((i) => i.files?.length).map((i) => i.file),
        binaries: issues.flatMap((i) => (i.binaries ?? []).map((b) => b.name)),
    };
};

const OWN = { entry: ['src/index.ts'], project: ['src/**/*.ts', '*.js'] };

test('without it, knip reports the lint configs as unused files and the CLIs as unlisted', (t) => {
    const { files, binaries } = run(t, OWN);
    assert.deepEqual(files.sort(), ['eslint.config.js', 'lint-staged.config.js', 'prettier.config.js']);
    assert.ok(binaries.includes('eslint'), binaries.join(', '));
});

test('with it, the configs are reached and the CLIs are known', (t) => {
    const { files, binaries } = run(t, (root) => knip(OWN, root));
    assert.deepEqual(files, []);
    assert.deepEqual(binaries, []);
});

test("the project's own ignores and plugin settings are kept, and win", () => {
    const config = knip({ ...OWN, ignoreBinaries: ['ffprobe'], ignoreDependencies: ['pino-pretty'], eslint: false });
    assert.ok(config.ignoreBinaries?.includes('ffprobe'));
    assert.ok(config.ignoreBinaries?.includes('eslint'));
    assert.ok(config.ignoreDependencies?.includes('pino-pretty'));
    assert.equal(config.eslint, false);
    assert.equal(config.prettier, true);
});

const LARRY_CONFIG = {
    'larry.config.ts':
        "import { defineConfig } from '@larrydarko/lint-config/config';\n\nexport default defineConfig({ family: 'spa', gates: {} });\n",
};

test('larry.config.ts, which nothing imports, is an entry point, so knip does not report it unused', (t) => {
    // The project's root files are in scope, as in the family projects.
    const own = { ...OWN, project: ['src/**/*.ts', '*.{js,ts}'] };
    assert.deepEqual(run(t, own, LARRY_CONFIG).files.sort(), [
        'eslint.config.js',
        'larry.config.ts',
        'lint-staged.config.js',
        'prettier.config.js',
    ]);
    assert.deepEqual(run(t, (root) => knip(own, root), LARRY_CONFIG).files, []);
});

test('larry.config.ts joins the entries the root workspace names, or the ones knip would take when it names none', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knip-larry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(knip(OWN, root).entry, OWN.entry, 'no larry.config.ts, no entry added');

    fs.writeFileSync(path.join(root, 'larry.config.ts'), LARRY_CONFIG['larry.config.ts']);
    assert.deepEqual(knip(OWN, root).entry, ['src/index.ts', 'larry.config.ts!']);
    assert.deepEqual(knip({}, root).entry, [
        '{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!',
        'src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!',
        'larry.config.ts!',
    ]);
    const workspaces = knip({ workspaces: { '.': { entry: 'scripts/*.ts!' }, 'web': { entry: ['main.ts'] } } }, root);
    assert.equal(workspaces.entry, undefined);
    assert.deepEqual(workspaces.workspaces, {
        '.': { entry: ['scripts/*.ts!', 'larry.config.ts!'] },
        'web': { entry: ['main.ts'] },
    });
});

test('packageEntries reads the sources back from every entry point the manifest names', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knip-entries-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
            name: '@example/widgets',
            main: './dist/index.js',
            bin: './dist/cli.mjs',
            exports: {
                '.': { types: './dist/index.d.ts', default: './dist/index.js' },
                './sizes': { import: './dist/sizes.js', require: './dist/sizes.cjs' },
                './icons/*': './dist/icons/*.js',
                './package.json': './package.json',
            },
        }),
    );
    assert.deepEqual(packageEntries({ root }).sort(), [
        'src/cli.mts',
        'src/icons/*.ts',
        'src/index.ts',
        'src/sizes.cts',
        'src/sizes.ts',
    ]);
    assert.deepEqual(packageEntries({ root, outDir: 'lib', rootDir: 'source' }), []);
});
