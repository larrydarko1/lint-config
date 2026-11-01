/**
 * `larry init`, run as a child process in invented repositories. What it writes must
 * pass the checks it wires up: Prettier, the pipeline gate, and larry.config.ts's own
 * types, for every family.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FAMILIES } from '../src/eslint/presets.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const LARRY = path.join(REPO, 'src/cli/larry.ts');

/** A git repo holding `files`, with a package.json as `npm init -y` writes one unless `files` brings its own. */
const repo = (t, files = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-init-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const manifest = {
        name: 'app',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
    };
    for (const [rel, body] of Object.entries({ 'package.json': JSON.stringify(manifest, null, 2), ...files })) {
        if (body === null) continue;
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const larry = (cwd, ...args) => {
    // Plain, as a pipe sees it: at a terminal, node --test sets FORCE_COLOR for the files it runs.
    const { status, stdout, stderr } = spawnSync(process.execPath, [LARRY, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: undefined },
    });
    return { code: status, out: stdout, err: stderr };
};

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** What init needs besides the distribution: the base family's runtime, which no file says. */
const runtimeFor = (family) => (family === 'base' ? ['--runtime', 'node'] : []);

/** larry.config.ts with its imports pointed at this checkout's source, so Node can load it from a temp repo. */
const loadable = (root) => {
    const file = path.join(root, 'larry.config.ts');
    const source = fs
        .readFileSync(file, 'utf8')
        .replace("'@larrydarko/lint-config/config'", `'${pathToFileURL(path.join(REPO, 'src/config.ts')).href}'`)
        .replace("'@larrydarko/lint-config/knip'", `'${pathToFileURL(path.join(REPO, 'src/knip.ts')).href}'`);
    fs.writeFileSync(file, source);
};

// ── Usage ────────────────────────────────────────────────────────────────────

test('init without a family, with an unknown one, or without a distribution is a usage error that writes nothing', (t) => {
    const root = repo(t);
    const usageErrors = [
        [],
        ['--distribution', 'open'],
        ['cli', '--distribution', 'open'],
        ['spa'],
        ['spa', '--distribution', 'proprietary'],
    ];
    for (const args of usageErrors) {
        const result = larry(root, 'init', ...args);
        assert.equal(result.code, 2, args.join(' '));
    }
    assert.match(larry(root, 'init').err, /init needs a family\. It is one of api, /);
    assert.match(larry(root, 'init', '--distribution', 'open').err, /init needs a family\. It is one of api, /);
    assert.match(larry(root, 'init', 'cli').err, /"cli" is not a family/);
    assert.match(larry(root, 'init', 'spa').err, /init needs --distribution open or --distribution closed/);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'package.json']);
});

test('the base family needs --runtime, no other family takes it, and an unknown option is refused', (t) => {
    const root = repo(t);
    const base = larry(root, 'init', 'base', '--distribution', 'open');
    assert.equal(base.code, 2);
    assert.match(base.err, /the base family needs --runtime node, --runtime browser or --runtime both/);
    assert.equal(larry(root, 'init', 'base', '--distribution', 'open', '--runtime', 'deno').code, 2);

    const spa = larry(root, 'init', 'spa', '--distribution', 'open', '--runtime', 'node');
    assert.equal(spa.code, 2);
    assert.match(spa.err, /--runtime is for the base family; the spa family knows where its code runs/);
    const unnamed = larry(root, 'init', '--distribution', 'open', '--runtime', 'node');
    assert.equal(unnamed.code, 2);
    assert.match(unnamed.err, /--runtime is for the base family: name it, as in `larry init base --runtime node`/);

    const unknown = larry(root, 'init', 'spa', '--distribution', 'open', '--force');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /unknown option --force/);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'package.json']);
});

test('init with no package.json says to run npm init', (t) => {
    const result = larry(repo(t, { 'package.json': null }), 'init', 'library', '--distribution', 'open');
    assert.equal(result.code, 2);
    assert.match(result.err, /there is no package\.json in .*Run `npm init` first/);
});

// ── A fresh project ──────────────────────────────────────────────────────────

test('a fresh spa gets every config file, the hooks, CI and the scripts, and says what is left', (t) => {
    const root = repo(t, { 'src/main.ts': 'export {};\n', 'test/main.test.ts': 'export {};\n' });
    const result = larry(root, 'init', 'spa', '--distribution=closed');
    assert.equal(result.code, 0, result.err);

    for (const file of [
        'larry.config.ts',
        'eslint.config.js',
        'prettier.config.js',
        'commitlint.config.js',
        'lint-staged.config.js',
        'knip.config.js',
        '.stylelintrc.mjs',
        '.jscpd.json',
        '.prettierignore',
        '.gitignore',
        '.husky/pre-commit',
        '.husky/commit-msg',
        '.github/workflows/ci.yml',
    ]) {
        assert.ok(fs.existsSync(path.join(root, file)), file);
        assert.match(result.out, new RegExp(`^\\+ ${file.replaceAll('.', '\\.')}$`, 'm'));
    }
    assert.equal(fs.statSync(path.join(root, '.husky/pre-commit')).mode & 0o111, 0o111, 'hooks are executable');

    const config = read(root, 'larry.config.ts');
    assert.match(config, /family: 'spa'/);
    assert.match(config, /'code-style': \{ scan: \['src', 'test'\] \}/);
    assert.match(config, /'duplication': \{ scan: \['src'\], ceilings: \{ typescript: 2, vue: 2 \} \}/);
    assert.match(config, /'licenses': \{ distribution: 'closed' \}/);
    assert.match(config, /'i18n': \{ skip: 'Not set up yet: needs `localeDir` and `configFile`\.' \}/);
    assert.match(
        read(root, 'eslint.config.js'),
        /import \{ spaStandards \} from '@larrydarko\/lint-config\/eslint\/spa';/,
    );
    assert.match(read(root, 'lint-staged.config.js'), /lintStaged\(\{ stylelint: true \}\)/);

    const manifest = JSON.parse(read(root, 'package.json'));
    assert.deepEqual(manifest.scripts, {
        'test': 'echo "Error: no test specified" && exit 1',
        'prepare': 'husky',
        'lint': 'eslint .',
        'format:check': 'prettier --check .',
        'check': 'larry check',
        'ci:check': 'npm run lint && npm run format:check && npm run check',
    });
    assert.deepEqual(manifest.engines, { node: '>=26' });
    assert.match(read(root, '.github/workflows/ci.yml'), /node-version: 26\n/);
    assert.deepEqual(
        Object.keys(manifest),
        ['name', 'version', 'type', 'scripts', 'engines'],
        'the canonical field order',
    );

    assert.match(
        result.out,
        /skips 5 gates that need paths only this project knows: contrast, html-standards, i18n, scss-standards, testing\./,
    );
    assert.match(result.out, /Run `npm install`, so `prepare` installs the git hooks, then `npx larry doctor`/);
    assert.doesNotMatch(result.out, /type": "module"/);
});

test('a base project gets the folders init found written out, since the family assumes none', (t) => {
    const root = repo(t, { 'src/index.ts': 'export {};\n', 'tests/index.test.ts': '', 'scripts/release.ts': '' });
    const result = larry(root, 'init', 'base', '--distribution=open', '--runtime=node');
    assert.equal(result.code, 0, result.err);

    const eslint = read(root, 'eslint.config.js');
    assert.match(eslint, /import \{ baseStandards \} from '@larrydarko\/lint-config\/eslint\/base';/);
    assert.match(eslint, /preset: 'base',/);
    assert.match(eslint, /source: \['src\/\*\*\/\*\.ts', 'scripts\/\*\*\/\*\.ts'\],/);
    assert.match(eslint, /tests: \['tests\/\*\*\/\*\.ts'\],/);
    assert.match(eslint, /browser: \[\],/);
    assert.match(eslint, /node: \['src\/\*\*\/\*\.ts', 'scripts\/\*\*\/\*\.ts', 'tests\/\*\*\/\*\.ts'\],/);
    assert.doesNotMatch(eslint, /nodeAndBrowser/);
    assert.match(result.out, /eslint\.config\.js names the folders init found, since the base family assumes none/);

    const config = read(root, 'larry.config.ts');
    assert.match(config, /family: 'base'/);
    assert.doesNotMatch(config, /skip:/, 'the base family runs only gates that need no project paths');
});

test("a base project's runtime decides which globals its source gets, and the scripts and tests stay in Node", (t) => {
    const browser = repo(t, { 'src/index.ts': 'export {};\n' });
    assert.equal(larry(browser, 'init', 'base', '--distribution', 'open', '--runtime', 'browser').code, 0);
    assert.match(read(browser, 'eslint.config.js'), /browser: \['src\/\*\*\/\*\.ts'\],/);
    assert.match(read(browser, 'eslint.config.js'), /node: \['\*\*\/\*\.\{test,spec\}\.ts'\],/);

    const both = repo(t, { 'src/index.ts': 'export {};\n' });
    assert.equal(larry(both, 'init', 'base', '--distribution', 'open', '--runtime', 'both').code, 0);
    assert.match(read(both, 'eslint.config.js'), /browser: \[\],/);
    assert.match(read(both, 'eslint.config.js'), /nodeAndBrowser: \['src\/\*\*\/\*\.ts'\],/);
});

test("the base project's eslint.config.js loads, and holds what it names to the repository", async (t) => {
    const root = repo(t, { 'src/index.ts': 'export {};\n', 'test/index.test.ts': '' });
    assert.equal(larry(root, 'init', 'base', '--distribution', 'open', '--runtime', 'node').code, 0);
    const file = path.join(root, 'eslint.config.js');
    fs.writeFileSync(
        file,
        read(root, 'eslint.config.js')
            .replace(
                "'@larrydarko/lint-config/eslint'",
                `'${pathToFileURL(path.join(REPO, 'src/eslint/index.ts')).href}'`,
            )
            .replace(
                "'@larrydarko/lint-config/eslint/base'",
                `'${pathToFileURL(path.join(REPO, 'src/eslint/base/index.ts')).href}'`,
            ),
    );
    const { default: config } = await import(`${pathToFileURL(file).href}?loaded`);
    assert.ok(Array.isArray(config) && config.length > 10);

    fs.rmSync(path.join(root, 'test'), { recursive: true });
    await assert.rejects(
        import(`${pathToFileURL(file).href}?moved`),
        /names 'test' in tests, node, which does not exist/,
    );
});

test('the scripts CI runs include typecheck and test when the project has them', (t) => {
    const manifest = { name: 'lib', type: 'module', scripts: { typecheck: 'tsc', test: 'node --test' } };
    const root = repo(t, { 'package.json': JSON.stringify(manifest) });
    assert.equal(larry(root, 'init', 'library', '--distribution', 'open').code, 0);
    assert.equal(
        JSON.parse(read(root, 'package.json')).scripts['ci:check'],
        'npm run typecheck && npm run lint && npm run format:check && npm run test && npm run check',
    );
    const workflow = read(root, '.github/workflows/ci.yml');
    assert.match(
        workflow,
        /- run: npm ci\n\s+- run: npm run typecheck\n\s+- run: npm run lint\n\s+- run: npm run format:check\n\s+- run: npm run test\n\s+- run: npm run check\n$/,
    );

    const config = read(root, 'larry.config.ts');
    assert.match(config, /'dead-code': \{ publicApi: packageEntries\(\) \}/);
    assert.doesNotMatch(config, /skip/, 'a library needs nothing only it can name');
    assert.ok(!fs.existsSync(path.join(root, '.stylelintrc.mjs')), 'a library has no styles');
});

test('CI installs the floor of engines.node: the one declared, else the family default', (t) => {
    const nodeOf = (root) => /node-version: (\d+)/.exec(read(root, '.github/workflows/ci.yml'))?.[1];
    const enginesOf = (root) => JSON.parse(read(root, 'package.json')).engines;

    const declared = repo(t, {
        'package.json': JSON.stringify({ name: 'app', type: 'module', engines: { node: '>=25' } }),
    });
    assert.equal(larry(declared, 'init', 'spa', '--distribution', 'closed').code, 0);
    assert.equal(nodeOf(declared), '25');
    assert.deepEqual(enginesOf(declared), { node: '>=25' }, 'a declared range is kept');

    for (const family of ['electron', 'library']) {
        const root = repo(t);
        assert.equal(larry(root, 'init', family, '--distribution', 'open').code, 0, family);
        assert.equal(nodeOf(root), '24', family);
        assert.deepEqual(enginesOf(root), { node: '>=24' }, family);
    }
});

test('a full-stack project scans its workspaces', (t) => {
    const manifest = { name: 'app', type: 'module', workspaces: ['web', 'api', 'packages/*'] };
    const root = repo(t, {
        'package.json': JSON.stringify(manifest),
        'web/src/main.ts': 'export {};\n',
        'api/src/index.ts': 'export {};\n',
    });
    assert.equal(larry(root, 'init', 'fullstack', '--distribution', 'closed').code, 0);
    assert.match(read(root, 'larry.config.ts'), /'code-style': \{ scan: \['web', 'api'\] \}/);
});

test('the package.json without "type": "module" is reported, not changed', (t) => {
    const root = repo(t, { 'package.json': JSON.stringify({ name: 'app' }) });
    const result = larry(root, 'init', 'api', '--distribution', 'closed');
    assert.equal(result.code, 0);
    assert.match(result.out, /package\.json has no `"type": "module"`/);
    assert.equal(JSON.parse(read(root, 'package.json')).type, undefined);
});

// ── What exists is kept ──────────────────────────────────────────────────────

test('a second run writes nothing, and a project file or script is never overwritten', (t) => {
    const ownEslint = "export default [{ rules: { 'no-var': 'error' } }];\n";
    const ownWorkflow = 'name: CI\non: push\njobs: {}\n';
    const manifest = { name: 'app', type: 'module', scripts: { 'lint': 'eslint src', 'ci:check': 'npm run lint' } };
    const root = repo(t, {
        'package.json': JSON.stringify(manifest),
        'eslint.config.js': ownEslint,
        '.github/workflows/ci.yml': ownWorkflow,
    });

    const first = larry(root, 'init', 'electron', '--distribution', 'closed');
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^= eslint\.config\.js \(exists, left as it is\)$/m);
    assert.equal(read(root, 'eslint.config.js'), ownEslint);
    assert.equal(read(root, '.github/workflows/ci.yml'), ownWorkflow);
    const scripts = JSON.parse(read(root, 'package.json')).scripts;
    assert.equal(scripts.lint, 'eslint src');
    assert.equal(scripts['ci:check'], 'npm run lint');
    assert.equal(scripts.check, 'larry check');
    assert.match(first.out, /ci\.yml was there already: give it a step that runs `npm run check`/);
    assert.match(first.out, /had a `ci:check` already: chain `npm run check` into it/);

    const before = read(root, 'package.json');
    const second = larry(root, 'init', 'electron', '--distribution', 'open');
    assert.equal(second.code, 0);
    assert.match(second.out, /✓ larry init: electron, 0 files written\./);
    assert.doesNotMatch(second.out, /^\+/m);
    assert.equal(read(root, 'package.json'), before);
    assert.match(read(root, 'larry.config.ts'), /distribution: 'closed'/);
});

// ── What it writes passes what it wires up ───────────────────────────────────

test('every family: the files are formatted, the pipeline gate passes, and larry.config.ts loads', (t) => {
    const prettier = path.join(REPO, 'node_modules/prettier/bin/prettier.cjs');
    for (const family of FAMILIES) {
        const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' } } });
        const root = repo(t, { 'src/index.ts': 'export {};\n', 'package-lock.json': lockfile });
        assert.equal(larry(root, 'init', family, '--distribution', 'open', ...runtimeFor(family)).code, 0, family);

        const format = spawnSync(
            process.execPath,
            [prettier, '--check', '.', '--config', path.join(REPO, 'prettier.config.js')],
            { cwd: root, encoding: 'utf8' },
        );
        assert.equal(format.status, 0, `${family}: ${format.stdout}${format.stderr}`);

        loadable(root);
        const result = larry(root, 'check', 'pipeline', 'licenses');
        assert.equal(result.code, 0, `${family}:\n${result.out}${result.err}`);
        assert.match(result.out, /`larry check` wired/);
    }
});

test('every family: the larry.config.ts init writes type-checks, with no required gate left out', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-init-types-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const family of FAMILIES) {
        const root = repo(t, { 'src/index.ts': 'export {};\n' });
        assert.equal(larry(root, 'init', family, '--distribution', 'closed', ...runtimeFor(family)).code, 0, family);
        fs.copyFileSync(path.join(root, 'larry.config.ts'), path.join(dir, `${family}.ts`));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
            extends: path.join(REPO, 'tsconfig.json'),
            compilerOptions: {
                typeRoots: [path.join(REPO, 'node_modules/@types')],
                paths: {
                    '@larrydarko/lint-config/config': [path.join(REPO, 'src/config.ts')],
                    '@larrydarko/lint-config/knip': [path.join(REPO, 'src/knip.ts')],
                },
            },
            include: FAMILIES.map((family) => `${family}.ts`),
        }),
    );
    const tsc = spawnSync(process.execPath, [path.join(REPO, 'node_modules/typescript/bin/tsc'), '-p', dir], {
        encoding: 'utf8',
    });
    assert.equal(tsc.status, 0, tsc.stdout);
});
