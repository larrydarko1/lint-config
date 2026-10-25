import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CANONICAL_ORDER, inspectPackageJson } from '../src/gates/package-json.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
};

/** Keys written in canonical order, so a case only breaks what it means to. */
const manifest = (fields) => {
    const out = {};
    for (const key of CANONICAL_ORDER) if (Object.hasOwn(fields, key)) out[key] = fields[key];
    for (const key of Object.keys(fields)) if (!Object.hasOwn(out, key)) out[key] = fields[key];
    return out;
};

const GOOD = { name: 'app', version: '1.2.3', description: 'a thing', license: 'MIT', type: 'module', private: true };
const REQUIRED = ['name', 'version', 'description', 'license', 'private', 'type'];

const run = (t, files, options = {}) =>
    inspectPackageJson({ root: tree(t, files), rootRequired: REQUIRED, ...options });
const whats = (result) => result.problems.map((p) => p.what).join(' | ');

test('a clean manifest has no problems', (t) => {
    const result = run(t, { 'package.json': manifest(GOOD) });
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.manifests, ['package.json']);
});

// ── 1. Required metadata ────────────────────────────────────────────────────
test('a missing required field fails', (t) => {
    const { description: _description, ...rest } = GOOD;
    const result = run(t, { 'package.json': manifest(rest) });
    assert.match(whats(result), /is missing the required field `description`/);
});

test('an empty string counts as missing', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, description: '' }) });
    assert.match(whats(result), /is missing the required field `description`/);
});

test('an empty array counts as missing', (t) => {
    const result = run(
        t,
        { 'package.json': manifest({ ...GOOD, keywords: [] }) },
        { rootRequired: [...REQUIRED, 'keywords'] },
    );
    assert.match(whats(result), /is missing the required field `keywords`/);
});

test('`private: false` fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, private: false }) });
    assert.match(whats(result), /`private` is not `true`/);
});

test('a non-semver version fails on the root manifest', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, version: '2026.8' }) });
    assert.match(whats(result), /`version` \("2026\.8"\) is not semver/);
});

test('a prerelease version is semver', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, version: '1.2.3-rc.1' }) });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── workspaces ──────────────────────────────────────────────────────────────
test('workspace manifests are read, with their own required set', (t) => {
    const result = run(
        t,
        {
            'package.json': manifest({ ...GOOD, workspaces: ['api'] }),
            'api/package.json': manifest({
                name: 'api',
                version: '1.2.3',
                license: 'MIT',
                type: 'module',
                private: true,
            }),
        },
        { workspaceRequired: REQUIRED },
    );
    assert.equal(result.manifests.length, 2);
    assert.match(whats(result), /is missing the required field `description`/);
    assert.equal(result.problems[0].file, 'api/package.json');
});

test('a workspace is not held to the root required set', (t) => {
    const result = run(
        t,
        {
            'package.json': manifest({ ...GOOD, homepage: 'https://x.dev', workspaces: ['api'] }),
            'api/package.json': manifest({
                name: 'api',
                version: '1.2.3',
                description: 'x',
                license: 'MIT',
                type: 'module',
                private: true,
            }),
        },
        { rootRequired: [...REQUIRED, 'homepage'], workspaceRequired: REQUIRED },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a declared workspace with no manifest is skipped, not a crash', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, workspaces: ['ghost'] }) });
    assert.equal(result.problems.length, 0, whats(result));
    assert.deepEqual(result.manifests, ['package.json']);
});

test('a repo with no workspaces field reads one manifest', (t) => {
    const result = run(t, { 'package.json': manifest(GOOD) });
    assert.deepEqual(result.manifests, ['package.json']);
});

// ── 2. Semver prefixes ──────────────────────────────────────────────────────
test('an exact pin fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, dependencies: { vue: '3.5.0' } }) });
    assert.match(whats(result), /dependencies\.vue is pinned exactly to "3\.5\.0"/);
});

test('a `~` range not on the allowlist fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, dependencies: { vue: '~3.5.0' } }) });
    assert.match(whats(result), /a `~` range is not on the allowlist/);
});

test('a `~` range on the allowlist passes', (t) => {
    const result = run(
        t,
        { 'package.json': manifest({ ...GOOD, devDependencies: { typescript: '~5.6.0' } }) },
        { tildeAllowed: { typescript: 'minors introduce type errors' } },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('an allowlisted package on `^` fails, and the reason is the message', (t) => {
    const result = run(
        t,
        { 'package.json': manifest({ ...GOOD, devDependencies: { typescript: '^5.6.0' } }) },
        { tildeAllowed: { typescript: 'minors introduce type errors' } },
    );
    assert.match(whats(result), /it is on the `~` allowlist/);
    assert.equal(result.problems[0].why, 'minors introduce type errors');
});

test('in a field pinned exactly, an exact version passes and anything looser fails with the reason', (t) => {
    const why = 'the lockfile never reaches the projects';
    const dependencies = { eslint: '10.13.0', prettier: '^3.9.10', knip: '6.x', typescript: '~6.0.2' };
    const result = run(
        t,
        { 'package.json': manifest({ ...GOOD, dependencies, devDependencies: { vue: '^3.5.0' } }) },
        { exactFields: { dependencies: why }, tildeAllowed: { typescript: 'the compiler' } },
    );
    assert.deepEqual(
        result.problems.map(({ what }) => what),
        [
            'dependencies.prettier is "^3.9.10", in a field pinned exactly',
            'dependencies.knip is "6.x", in a field pinned exactly',
        ],
    );
    assert.ok(result.problems.every((p) => p.why === why));
});

test('a `^` range passes', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, dependencies: { vue: '^3.5.0' } }) });
    assert.equal(result.problems.length, 0, whats(result));
});

test('ranges that are not versions are left alone', (t) => {
    const result = run(t, {
        'package.json': manifest({
            ...GOOD,
            dependencies: {
                a: 'workspace:*',
                b: 'file:../b',
                c: 'link:../c',
                d: 'npm:e@^1',
                e: 'git+https://x/y.git',
                f: '*',
                g: 'github:x/y',
            },
        }),
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('devDependencies are checked too', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, devDependencies: { vitest: '2.0.0' } }) });
    assert.match(whats(result), /devDependencies\.vitest is pinned exactly/);
});

// ── 3. Field order ──────────────────────────────────────────────────────────
test('fields out of canonical order fail', (t) => {
    const result = run(t, {
        'package.json':
            '{\n"name":"app",\n"description":"a thing",\n"version":"1.2.3",\n"license":"MIT",\n"type":"module",\n"private":true\n}\n',
    });
    assert.match(whats(result), /field order diverges at `description` \(expected `version`\)/);
});

test('`packageManager` sorts immediately before `engines`, per sort-package-json', (t) => {
    const at = CANONICAL_ORDER.indexOf('packageManager');
    assert.equal(CANONICAL_ORDER[at + 1], 'engines');
    const result = run(t, {
        'package.json':
            '{\n"name":"app",\n"version":"1.2.3",\n"description":"a thing",\n"license":"MIT",\n"type":"module",\n"engines":{"node":">=24"},\n"private":true,\n"packageManager":"npm@10.0.0"\n}\n',
    });
    assert.match(whats(result), /field order diverges at `engines` \(expected `packageManager`\)/);
});

test('a field the order list does not know fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, wibble: 1 }) });
    assert.match(whats(result), /does not know where to sort: wibble/);
});

test('an absent field costs nothing', (t) => {
    const result = run(t, {
        'package.json': manifest({
            name: 'app',
            version: '1.2.3',
            description: 'a thing',
            license: 'MIT',
            type: 'module',
            private: true,
        }),
    });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 4/5/6. Electron rules fire only on an Electron shape ────────────────────
test('the Electron rules are silent with no electron-vite config and no build block', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, os: ['darwin'] }) });
    assert.equal(result.problems.length, 0, whats(result));
});

test('reading a missing electron-vite config is not a crash', (t) => {
    const result = run(t, { 'package.json': manifest(GOOD) }, { electronViteConfig: 'nope.config.ts' });
    assert.equal(result.problems.length, 0, whats(result));
});

const VITE =
    "export default { main: { build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } } } };\n";

test('`main` not under out/ fails', (t) => {
    const result = run(t, {
        'package.json': manifest({ ...GOOD, main: 'src/main/index.ts' }),
        'electron.vite.config.ts': VITE,
    });
    assert.match(whats(result), /which is not under `out\/`/);
});

test('`main` disagreeing with what electron-vite emits fails', (t) => {
    const result = run(t, {
        'package.json': manifest({ ...GOOD, main: 'out/main/other.js' }),
        'electron.vite.config.ts': VITE,
    });
    assert.match(whats(result), /but electron-vite emits "out\/main\/index\.js"/);
});

test('`main` matching what electron-vite emits passes', (t) => {
    const result = run(t, {
        'package.json': manifest({ ...GOOD, main: 'out/main/index.js' }),
        'electron.vite.config.ts': VITE,
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('a missing `main` with an electron-vite config fails', (t) => {
    const result = run(t, { 'package.json': manifest(GOOD), 'electron.vite.config.ts': VITE });
    assert.match(whats(result), /`main` is not a string/);
});

test('`build.files` that forgets out/ fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, build: { files: ['package.json'] } }) });
    assert.match(whats(result), /does not include the `out` directory/);
});

test('`build.files` that forgets package.json fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, build: { files: ['out/**'] } }) });
    assert.match(whats(result), /does not include `package\.json`/);
});

test('`build.files` given as a from-mapping counts as shipping out/', (t) => {
    const result = run(t, {
        'package.json': manifest({ ...GOOD, build: { files: [{ from: 'out' }, 'package.json'] } }),
    });
    assert.equal(result.problems.length, 0, whats(result));
});

test('`build.files` that is not an array fails', (t) => {
    const result = run(t, { 'package.json': manifest({ ...GOOD, build: { files: 'out/**' } }) });
    assert.match(whats(result), /`build\.files` is not an array/);
});

test('an `os` entry with no matching build target fails', (t) => {
    const result = run(t, {
        'package.json': manifest({
            ...GOOD,
            os: ['darwin', 'linux'],
            build: { files: ['out/**', 'package.json'], mac: {} },
        }),
    });
    assert.match(whats(result), /`os` lists "linux" but `build\.linux` has no target/);
});

test('a build target absent from `os` fails', (t) => {
    const result = run(t, {
        'package.json': manifest({
            ...GOOD,
            os: ['darwin'],
            build: { files: ['out/**', 'package.json'], mac: {}, win: {} },
        }),
    });
    assert.match(whats(result), /`build\.win` builds an installer but `os` does not list "win32"/);
});

test('os and build targets in agreement pass', (t) => {
    const result = run(t, {
        'package.json': manifest({
            ...GOOD,
            os: ['darwin', 'linux'],
            build: { files: ['out/**', 'package.json'], mac: {}, linux: {} },
        }),
    });
    assert.equal(result.problems.length, 0, whats(result));
});

// ── 7. The lint toolchain comes from this package ───────────────────────────
const SELF = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PROVIDED = { 'eslint': '10.11.0', 'eslint-plugin-vue': '10.11.0' };
const USES_SELF = { ...GOOD, devDependencies: { [SELF.name]: 'file:../lint-config' } };
const hoisted = (name, version) => ({ [`node_modules/${name}/package.json`]: { name, version } });

test('a project that does not depend on this package is not held to rule 7', (t) => {
    const result = run(
        t,
        { 'package.json': manifest({ ...GOOD, devDependencies: { eslint: '^10.0.0' } }) },
        { provided: PROVIDED },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('a CLI at the pinned version at the top of node_modules passes', (t) => {
    const result = run(
        t,
        { 'package.json': manifest(USES_SELF), ...hoisted('eslint', '10.11.0') },
        { provided: PROVIDED },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('listing a package this one installs fails, in a workspace too', (t) => {
    const result = run(
        t,
        {
            'package.json': manifest({
                ...USES_SELF,
                devDependencies: { ...USES_SELF.devDependencies, eslint: '^10.0.0' },
                workspaces: ['web'],
            }),
            'web/package.json': manifest({
                name: 'web',
                private: true,
                devDependencies: { 'eslint-plugin-vue': '^10.0.0' },
            }),
            ...hoisted('eslint', '10.11.0'),
        },
        { provided: PROVIDED },
    );
    assert.match(whats(result), /devDependencies\.eslint is installed by @larrydarko\/lint-config/);
    assert.equal(result.problems.find((p) => /eslint-plugin-vue/.test(p.what))?.file, 'web/package.json');
});

test('a CLI missing from the top of node_modules fails and names install-links', (t) => {
    const result = run(t, { 'package.json': manifest(USES_SELF) }, { provided: PROVIDED });
    assert.match(whats(result), /`eslint` is not installed at the top of node_modules/);
    assert.match(result.problems[0].why, /install-links=true/);
});

test('a CLI at a different version from the pin fails', (t) => {
    const result = run(
        t,
        { 'package.json': manifest(USES_SELF), ...hoisted('eslint', '10.0.3') },
        { provided: PROVIDED },
    );
    assert.match(whats(result), /`eslint` resolves to 10\.0\.3, but @larrydarko\/lint-config pins 10\.11\.0/);
});

test('a provided package that is not a CLI need not be at the top level', (t) => {
    const result = run(
        t,
        { 'package.json': manifest(USES_SELF), ...hoisted('eslint', '10.11.0') },
        { provided: { ...PROVIDED, 'stylelint-scss': '7.3.0' } },
    );
    assert.equal(result.problems.length, 0, whats(result));
});

test('by default, what is provided is read from this package: typescript stays the project’s', (t) => {
    const clis = ['eslint', 'prettier', 'stylelint', '@commitlint/cli', 'lint-staged', 'husky'];
    const tree = Object.assign({}, ...clis.map((name) => hoisted(name, SELF.dependencies[name])));
    const pkg = { ...GOOD, devDependencies: { ...USES_SELF.devDependencies, typescript: '~6.0.2' } };
    const tildeAllowed = { typescript: 'the compiler' };
    const clean = run(t, { 'package.json': manifest(pkg), ...tree }, { tildeAllowed });
    assert.equal(clean.problems.length, 0, whats(clean));

    pkg.devDependencies.prettier = '^3.0.0';
    const listed = run(t, { 'package.json': manifest(pkg), ...tree }, { tildeAllowed });
    assert.match(whats(listed), /devDependencies\.prettier is installed by/);
});
