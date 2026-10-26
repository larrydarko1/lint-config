/**
 * `larry doctor`, run as a child process in invented repositories. Each starts from a
 * project installed the way the tools need, with node_modules written by hand, and
 * breaks one thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SELF_NAME, SELF_VERSION, providedPackages } from '../src/toolchain.ts';

const LARRY = path.resolve(import.meta.dirname, '../src/cli/larry.ts');
const CLIS = ['eslint', 'prettier', 'stylelint', '@commitlint/cli', 'lint-staged', 'husky'];

/** Every file a healthy library project has. A value of null leaves that file out. */
const HEALTHY = {
    'package.json': JSON.stringify({
        name: 'app',
        type: 'module',
        scripts: { prepare: 'husky' },
        devDependencies: { [SELF_NAME]: `^${SELF_VERSION}` },
    }),
    'larry.config.js': "export default { family: 'library', gates: { publish: { skip: 'not published' } } };\n",
    'eslint.config.js': 'export default [];\n',
    'prettier.config.js': 'export default {};\n',
    'commitlint.config.js': 'export default {};\n',
    'lint-staged.config.js': 'export default {};\n',
    'knip.config.js': 'export default {};\n',
    '.husky/pre-commit': 'npx --no -- lint-staged\n',
    '.husky/commit-msg': 'npx --no -- commitlint --edit "$1"\n',
    [`node_modules/${SELF_NAME}/package.json`]: JSON.stringify({ name: SELF_NAME, version: SELF_VERSION }),
    ...Object.fromEntries(
        CLIS.map((name) => [
            `node_modules/${name}/package.json`,
            JSON.stringify({ name, version: providedPackages()[name] }),
        ]),
    ),
};

/** A git repo with git pointed at .husky, holding HEALTHY with `files` merged over it. */
const project = (t, files = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-doctor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    for (const [rel, body] of Object.entries({ ...HEALTHY, ...files })) {
        if (body === null) continue;
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const doctor = (cwd) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [LARRY, 'doctor'], { cwd, encoding: 'utf8' });
    return { code: status, out: stdout, err: stderr };
};

/** package.json with `change` merged over the healthy one. */
const manifest = (change) => JSON.stringify({ ...JSON.parse(HEALTHY['package.json']), ...change });

test('a project installed as the tools need passes every check', (t) => {
    const result = doctor(project(t));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^✓ Node \d+/m);
    assert.match(result.out, /^✓ package\.json is an ES module$/m);
    assert.match(result.out, /^✓ larry\.config\.js loads: the library family, with 1 gate skipped$/m);
    assert.match(
        result.out,
        new RegExp(`^✓ ${SELF_NAME} \\^${SELF_VERSION.replaceAll('.', '\\.')} is a dependency$`, 'm'),
    );
    assert.match(
        result.out,
        /^✓ eslint, prettier, stylelint, commitlint, lint-staged, husky are at the top of node_modules/m,
    );
    assert.match(result.out, /^✓ the git hooks are installed$/m);
    assert.match(result.out, /^✓ every tool has its config file$/m);
    assert.match(result.out, /✓ larry doctor: nothing wrong in /);
});

test('doctor takes no arguments', (t) => {
    const { status, stderr } = spawnSync(process.execPath, [LARRY, 'doctor', '--fix'], {
        cwd: project(t),
        encoding: 'utf8',
    });
    assert.equal(status, 2);
    assert.match(stderr, /doctor takes no arguments/);
});

// ── The project ──────────────────────────────────────────────────────────────

test('NEGATIVE: no "type": "module", no config, and a config that does not load', (t) => {
    const result = doctor(project(t, { 'package.json': manifest({ type: undefined }), 'larry.config.js': null }));
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ package\.json has no `"type": "module"`$/m);
    assert.match(result.out, /^✗ no larry\.config\.ts or larry\.config\.js in /m);
    assert.match(result.out, /✗ larry doctor: 2 problems in /);

    const broken = doctor(project(t, { 'larry.config.js': "import './missing.js';\nexport default {};\n" }));
    assert.match(broken.out, /^✗ larry\.config\.js does not load: Cannot find module /m);
});

test('NEGATIVE: a missing config file is named, and a UI family needs a Stylelint one', (t) => {
    const library = doctor(project(t, { 'knip.config.js': null }));
    assert.match(library.out, /^✗ no config file for knip$/m);

    const spa = doctor(
        project(t, {
            'larry.config.js': "export default { family: 'spa', gates: {} };\n",
            'commitlint.config.js': null,
        }),
    );
    assert.match(spa.out, /^✗ no config file for commitlint, Stylelint$/m);
    assert.match(spa.out, /`npx larry init <family>` writes each one that is missing/);
});

// ── The install ──────────────────────────────────────────────────────────────

test('NEGATIVE: not a dependency, or not installed', (t) => {
    const undeclared = doctor(project(t, { 'package.json': manifest({ devDependencies: {} }) }));
    assert.match(
        undeclared.out,
        new RegExp(`^✗ ${SELF_NAME} is not a dependency\\n {2}Run \`npm i -D ${SELF_NAME}@beta\`\\.$`, 'm'),
    );

    const uninstalled = doctor(project(t, { [`node_modules/${SELF_NAME}/package.json`]: null }));
    assert.match(
        uninstalled.out,
        new RegExp(`^✗ ${SELF_NAME} is not in node_modules\\n {2}Run \`npm install\`\\.$`, 'm'),
    );
});

test('NEGATIVE: a project that lists a tool, a CLI not at the top of node_modules, and one at another version', (t) => {
    const result = doctor(
        project(t, {
            'package.json': manifest({ devDependencies: { [SELF_NAME]: `^${SELF_VERSION}`, prettier: '^3.0.0' } }),
            'node_modules/eslint/package.json': null,
            'node_modules/husky/package.json': JSON.stringify({ name: 'husky', version: '8.0.0' }),
        }),
    );
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`^✗ devDependencies\\.prettier is installed by ${SELF_NAME}$`, 'm'));
    assert.match(result.out, /^✗ `eslint` is not installed at the top of node_modules$/m);
    assert.match(result.out, new RegExp(`^✗ \`husky\` resolves to 8\\.0\\.0, but ${SELF_NAME} pins `, 'm'));
});

test('NEGATIVE: a folder install that is a link, so nothing hoists, is a problem; the folder install itself is a note', (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-doctor-checkout-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: SELF_NAME, version: SELF_VERSION }));

    const root = project(t, {
        'package.json': manifest({ devDependencies: { [SELF_NAME]: 'file:../lint-config' } }),
        [`node_modules/${SELF_NAME}/package.json`]: null,
    });
    fs.mkdirSync(path.dirname(path.join(root, 'node_modules', SELF_NAME)), { recursive: true });
    fs.symlinkSync(folder, path.join(root, 'node_modules', SELF_NAME));

    const linked = doctor(root);
    assert.equal(linked.code, 1);
    assert.match(
        linked.out,
        new RegExp(`^– ${SELF_NAME} is installed from a local path \\(file:\\.\\./lint-config\\)$`, 'm'),
    );
    assert.match(
        linked.out,
        /is a link to a folder, so the tools it installs stay inside that folder\n {2}Set `install-links=true`/,
    );

    fs.rmSync(path.join(root, 'node_modules', SELF_NAME));
    fs.mkdirSync(path.join(root, 'node_modules', SELF_NAME));
    fs.copyFileSync(path.join(folder, 'package.json'), path.join(root, 'node_modules', SELF_NAME, 'package.json'));
    fs.writeFileSync(path.join(root, '.npmrc'), 'install-links=true\n');
    const copied = doctor(root);
    assert.equal(copied.code, 0, copied.out);
    assert.match(copied.out, /^– .* is installed from a local path/m);
});

test('NEGATIVE: install-links left in .npmrc after switching back to the published version', (t) => {
    const result = doctor(project(t, { '.npmrc': 'save-exact=true\ninstall-links=true\n' }));
    assert.equal(result.code, 1);
    assert.match(
        result.out,
        /^✗ \.npmrc still sets `install-links=true`\n {2}It was there to install .* from a local path/m,
    );
});

test('NEGATIVE: a larry from another install, at another version than the project has', (t) => {
    const result = doctor(
        project(t, {
            [`node_modules/${SELF_NAME}/package.json`]: JSON.stringify({ name: SELF_NAME, version: '0.0.1' }),
        }),
    );
    assert.equal(result.code, 1);
    assert.match(
        result.out,
        new RegExp(
            `^✗ this larry is ${SELF_VERSION.replaceAll('.', '\\.')}, from .*, but the project has 0\\.0\\.1$`,
            'm',
        ),
    );
});

// ── The git hooks ────────────────────────────────────────────────────────────

test('NEGATIVE: hooks git does not run, a missing hook, and a prepare that does not run husky', (t) => {
    const root = project(t, { 'package.json': manifest({ scripts: {} }), '.husky/commit-msg': null });
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: root });
    const result = doctor(root);
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ `prepare` does not run husky$/m);
    assert.match(result.out, /^✗ \.husky\/commit-msg is missing$/m);
    assert.match(result.out, /^✗ git does not run the hooks in \.husky\n {2}Run `npm install`/m);
    assert.doesNotMatch(result.out, /the git hooks are installed/);
});

test('this package itself is a note, and its install is not checked', () => {
    const result = doctor(path.resolve(import.meta.dirname, '..'));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp(`^– this is ${SELF_NAME} itself$`, 'm'));
    assert.doesNotMatch(result.out, /node_modules|git hooks/);
});
