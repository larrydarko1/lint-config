import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packageBin } from '../src/gates/bin.ts';
import { knip } from '../src/knip.ts';

/**
 * A project that lists none of the linters — what every project looks like once
 * this package installs them — run through the knip this package pins.
 */
const run = (t, config) => {
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
        'knip.json': JSON.stringify(config),
    };
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
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
    const { files, binaries } = run(t, knip(OWN));
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
