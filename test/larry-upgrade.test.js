/**
 * `larry upgrade`, run as a child process in invented repositories that set this package
 * up the way an older release did: one script per gate in scripts/checks. The renames
 * are tested on the functions, with a table of their own, since no option has been
 * renamed yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { styleText } from 'node:util';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/cli/load-config.ts';
import { applyEdits, importEdits, parseSource } from '../src/cli/migrations/config-source.ts';
import { renameOptions } from '../src/cli/migrations/renamed-options.ts';
import { createTree } from '../src/cli/migrations/tree.ts';
import { renamedOptionProblems } from '../src/cli/renames.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const LARRY = path.join(REPO, 'src/cli/larry.ts');

// eslint-disable-next-line no-control-regex -- the escape codes a terminal colours with are what is stripped.
const ESCAPES = /\u001b\[\d+m/g;

/** `text` as a terminal that shows colour gets it. */
const paint = (format, text) => styleText(format, text, { validateStream: false });

const gateScript = (gate, fn, call) => `import { ${fn} } from '@larrydarko/lint-config/gates/${gate}';\n\n${call}\n`;

/** A spa as an older release set it up: a script per gate, each wired into package.json, ci:check and CI. */
const LEGACY = {
    'package.json': JSON.stringify({
        name: 'app',
        type: 'module',
        scripts: {
            'lint': 'eslint .',
            'i18n:check': 'node scripts/checks/check-i18n.ts',
            'contrast:check': 'node scripts/checks/check-contrast.ts',
            'style:check': 'node scripts/checks/check-code-style.ts',
            'testing:check': 'node scripts/checks/check-testing.ts',
            'ci:check':
                'npm run lint && npm run i18n:check && npm run contrast:check && npm run style:check && npm run testing:check',
        },
    }),
    'eslint.config.js':
        "import { larry } from '@larrydarko/lint-config/eslint';\n\nexport default larry({ preset: 'spa', rootDir: import.meta.dirname });\n",
    'src/themes.ts': "export const THEMES = [{ name: 'light', file: 'src/styles/light.scss' }];\n",
    'scripts/checks/check-i18n.ts': gateScript(
        'i18n',
        'checkI18n',
        "checkI18n({\n    localeDir: 'src/locales', // the shipped ones\n    configFile: 'src/i18n.ts',\n});",
    ),
    'scripts/checks/check-contrast.ts': [
        "import { checkContrast } from '@larrydarko/lint-config/gates/contrast';",
        "import { THEMES } from '../../src/themes.ts';",
        "import path from 'node:path';",
        '',
        '// Both themes, against every surface.',
        "await checkContrast({ themes: THEMES, text: ['--text'], backgrounds: [path.join('src', 'bg')] });",
        '',
    ].join('\n'),
    'scripts/checks/check-code-style.ts': gateScript(
        'code-style',
        'checkCodeStyle',
        [
            '/** Named by the tools that look for them. */',
            'const FRAMEWORK_NAMED = /(^|\\/)index\\.ts$/;',
            '',
            '// Over the cap when the ratchet was set.',
            "const BASELINE: Record<string, number> = { 'src/big.ts': 420 };",
            '',
            "checkCodeStyle({ baseline: BASELINE, casing: [{ files: /\\.ts$/, style: 'kebab', exempt: FRAMEWORK_NAMED }] });",
        ].join('\n'),
    ),
    'scripts/checks/check-testing.ts': gateScript(
        'testing',
        'checkTesting',
        "console.info('testing');\ncheckTesting({ config: 'vitest.config.ts', layout: { unit: 'test' } });",
    ),
    '.github/workflows/ci.yml': [
        'name: CI',
        'on: [push]',
        'jobs:',
        '    check:',
        '        runs-on: ubuntu-24.04',
        '        steps:',
        '            - run: npm ci',
        '            - run: npm run lint',
        '            - name: Locales',
        '              run: npm run i18n:check',
        '            - run: npm run contrast:check',
        '            - run: npm run style:check',
        '            - run: npm run testing:check',
        '',
    ].join('\n'),
};

/** A git repo holding LEGACY with `files` merged over it. A value of null leaves that file out. */
const project = (t, files = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-upgrade-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const [rel, body] of Object.entries({ ...LEGACY, ...files })) {
        if (body === null) continue;
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

/** Runs larry plain, as a pipe sees it: at a terminal, node --test sets FORCE_COLOR for the files it runs. */
const larry = (cwd, ...args) => run(cwd, args, {});

/** Runs larry as a terminal that shows colour sees it. */
const coloured = (cwd, ...args) => run(cwd, args, { FORCE_COLOR: '1' });

const run = (cwd, args, env) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [LARRY, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: undefined, ...env },
    });
    return { code: status, out: stdout, err: stderr };
};

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Every file under `root` but .git, with its content. */
const snapshot = (root) =>
    Object.fromEntries(
        fs
            .readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && !path.relative(root, entry.parentPath).startsWith('.git'))
            .map((entry) => {
                const file = path.join(entry.parentPath, entry.name);
                return [path.relative(root, file), fs.readFileSync(file, 'utf8')];
            }),
    );

// ── Usage ────────────────────────────────────────────────────────────────────

test('upgrade takes only --dry-run', (t) => {
    const result = larry(project(t), 'upgrade', '--force');
    assert.equal(result.code, 2);
    assert.match(result.err, /upgrade takes only --dry-run, not --force/);
});

test('a project with nothing from an older release has nothing to upgrade', (t) => {
    const root = project(t, {
        'scripts/checks/check-i18n.ts': null,
        'scripts/checks/check-contrast.ts': null,
        'scripts/checks/check-code-style.ts': null,
        'scripts/checks/check-testing.ts': null,
        'larry.config.ts': "export default { family: 'spa', gates: {} };\n",
    });
    const before = snapshot(root);
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^✓ larry upgrade: nothing to upgrade\.$/m);
    assert.deepEqual(snapshot(root), before);
});

// ── Gate scripts → larry.config.ts ───────────────────────────────────────────

test('each gate script that only calls its gate moves into a new larry.config.ts, and what ran it runs larry check', (t) => {
    const root = project(t);
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    for (const line of [
        '+ larry.config.ts',
        '~ package.json',
        '~ .github/workflows/ci.yml',
        '- scripts/checks/check-i18n.ts',
        '- scripts/checks/check-contrast.ts',
        '- scripts/checks/check-code-style.ts',
    ]) {
        assert.ok(result.out.split('\n').includes(line), `${line}\n${result.out}`);
    }
    assert.match(result.out, /✓ larry upgrade: 6 files changed\. Read the diff, then run `npm run ci:check`\./);

    // The options as written, comments included; imports rebased on the root and grouped.
    const config = read(root, 'larry.config.ts');
    assert.match(
        config,
        /^import path from 'node:path';\n\nimport \{ defineConfig \} from '@larrydarko\/lint-config\/config';\nimport \{ THEMES \} from '\.\/src\/themes\.ts';$/m,
    );
    assert.match(config, /family: 'spa'/);
    // The constants its options use, with their comments, between the imports and the export.
    assert.match(
        config,
        /from '\.\/src\/themes\.ts';\n\n\/\*\* Named by the tools that look for them\. \*\/\nconst FRAMEWORK_NAMED = .*\n\n\/\/ Over the cap when the ratchet was set\.\nconst BASELINE: Record<string, number> = \{ 'src\/big\.ts': 420 \};\n\nexport default defineConfig\(/,
    );
    assert.match(
        config,
        /'code-style': \{ baseline: BASELINE, casing: \[\{ files: \/\\\.ts\$\/, style: 'kebab', exempt: FRAMEWORK_NAMED \}\] \},/,
    );
    assert.match(
        config,
        /\/\/ Both themes, against every surface\.\n {8}'contrast': \{ themes: THEMES, text: \['--text'\], backgrounds: \[path\.join\('src', 'bg'\)\] \},/,
    );
    assert.match(config, /localeDir: 'src\/locales', \/\/ the shipped ones/);
    assert.match(config, /'secrets': \{ skip: 'No script ran it before larry upgrade\.' \},/);
    assert.match(
        config,
        /'testing': \{ skip: 'Still runs from scripts\/checks\/check-testing\.ts until its options move here\.' \},/,
    );
    // In the order larry check runs them.
    const order = [...config.matchAll(/^ {8}'([\w/-]+)':/gm)].map((match) => match[1]);
    assert.deepEqual(order, [
        'audit',
        'code-style',
        'contrast',
        'dead-code',
        'declaration-order',
        'duplication',
        'html-standards',
        'i18n',
        'licenses',
        'package-json',
        'pipeline',
        'refactoring',
        'scss-standards',
        'secrets',
        'testing',
        'tsconfigs',
    ]);

    // The script that does more than call its gate stays, and is still wired.
    assert.match(
        result.out,
        /^- scripts\/checks\/check-testing\.ts stays: line 3 does more than import a gate and call it\. Move its options into larry\.config\.ts by hand/m,
    );
    assert.match(result.out, /^- larry\.config\.ts skips 12 gates no script ran before: audit, dead-code, /m);
    assert.deepEqual(fs.readdirSync(path.join(root, 'scripts/checks')), ['check-testing.ts']);

    const { scripts } = JSON.parse(read(root, 'package.json'));
    assert.deepEqual(scripts, {
        'lint': 'eslint .',
        'testing:check': 'node scripts/checks/check-testing.ts',
        'ci:check': 'npm run lint && npm run check && npm run testing:check',
        'check': 'larry check',
    });
    assert.equal(
        read(root, '.github/workflows/ci.yml'),
        // The step it replaces was named, so it is too.
        LEGACY['.github/workflows/ci.yml'].replace(
            /( {12})- name: Locales\n( {14})run: .*\n.*contrast:check\n.*style:check\n/,
            '$1- name: larry check\n$2run: npm run check\n',
        ),
    );

    // It loads, and names every gate a spa runs.
    const file = path.join(root, 'larry.config.ts');
    fs.writeFileSync(
        file,
        read(root, 'larry.config.ts').replace(
            "'@larrydarko/lint-config/config'",
            `'${pathToFileURL(path.join(REPO, 'src/config.ts')).href}'`,
        ),
    );
    return loadConfig(root).then((loaded) => {
        assert.equal(loaded.options.size + loaded.skipped.size, order.length);
    });
});

test('a second run changes nothing, and still names the script that stays', (t) => {
    const root = project(t);
    larry(root, 'upgrade');
    const before = snapshot(root);
    const again = larry(root, 'upgrade');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /check-testing\.ts stays/);
    assert.match(again.out, /^✓ larry upgrade: nothing changed\.$/m);
    assert.deepEqual(snapshot(root), before);
});

test('--dry-run lists the changes and writes nothing', (t) => {
    const root = project(t);
    const before = snapshot(root);
    const result = larry(root, 'upgrade', '--dry-run');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^\+ larry\.config\.ts$/m);
    assert.match(result.out, /✓ larry upgrade --dry-run: 6 files would change\. Nothing was written\./);
    assert.deepEqual(snapshot(root), before);
});

test('at a terminal each kind of change has its colour, and the text is what a pipe gets', (t) => {
    const root = project(t);
    const plain = larry(root, 'upgrade', '--dry-run');
    const result = coloured(root, 'upgrade', '--dry-run');
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out.replace(ESCAPES, ''), plain.out, 'colour is all that differs');
    const lines = result.out.split('\n');
    for (const line of [
        `${paint('dim', '──')} ${paint('bold', 'Gate scripts → larry.config.ts')}`,
        `${paint('green', '+')} larry.config.ts`,
        `${paint('blue', '~')} package.json`,
        `${paint('red', '-')} scripts/checks/check-i18n.ts`,
        `${paint('green', '✓')} ${paint('bold', 'larry upgrade --dry-run: 6 files would change. Nothing was written.')}`,
    ]) {
        assert.ok(lines.includes(line), `${line}\n${result.out}`);
    }
    const note = `${paint('yellow', '-')} scripts/checks/check-testing.ts stays: `;
    assert.ok(
        lines.some((line) => line.startsWith(note)),
        'a note',
    );

    const unnamed = project(t, { 'eslint.config.js': 'export default [];\n' });
    const failing = coloured(unnamed, 'upgrade');
    assert.equal(failing.code, 2);
    assert.ok(failing.err.startsWith(`${paint('red', '✗')} larry: The project has gate scripts, `), failing.err);
    assert.ok(
        failing.err.includes(`(${paint('cyan', '`npx larry init <family>`')} writes one)`),
        'stderr colours its commands',
    );
    assert.equal(failing.err.replace(ESCAPES, ''), larry(unnamed, 'upgrade').err);
});

test('into an existing larry.config.ts: a skipped gate takes the options, a new one is added, a configured one stays', (t) => {
    const root = project(t, {
        'larry.config.ts': [
            "import { defineConfig } from '@larrydarko/lint-config/config';",
            '',
            'export default defineConfig({',
            "    family: 'spa',",
            '    gates: {',
            "        'i18n': { skip: 'later' },",
            "        'code-style': { scan: ['src'] },",
            '    },',
            '});',
            '',
        ].join('\n'),
        'package.json': JSON.stringify({
            name: 'app',
            type: 'module',
            scripts: {
                'gates': 'larry check',
                'i18n:check': 'node scripts/checks/check-i18n.ts',
                'contrast:check': 'node scripts/checks/check-contrast.ts',
                'style:check': 'node scripts/checks/check-code-style.ts',
                'ci:check': 'npm run gates && npm run i18n:check && npm run contrast:check && npm run style:check',
            },
        }),
        'scripts/checks/check-testing.ts': null,
        '.github/workflows/ci.yml': [
            'jobs:',
            '    check:',
            '        steps:',
            '            - run: npm run gates',
            '            - run: npm run i18n:check',
            '            - run: npm run contrast:check',
            '            - run: npm run style:check',
            '',
        ].join('\n'),
    });
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    assert.match(
        result.out,
        /^- scripts\/checks\/check-code-style\.ts stays: larry\.config\.ts already configures code-style\./m,
    );

    const config = read(root, 'larry.config.ts');
    assert.match(config, /'i18n': \{\n\s+localeDir: 'src\/locales', \/\/ the shipped ones/);
    assert.match(
        config,
        /'code-style': \{ scan: \['src'\] \},\n\s+\/\/ Both themes, against every surface\.\n\s+'contrast': \{ themes: THEMES/,
    );
    assert.doesNotMatch(config, /skip/);

    const { scripts } = JSON.parse(read(root, 'package.json'));
    assert.equal(scripts['ci:check'], 'npm run gates && npm run style:check');
    assert.equal(scripts['check'], undefined);
    assert.equal(
        read(root, '.github/workflows/ci.yml'),
        'jobs:\n    check:\n        steps:\n            - run: npm run gates\n            - run: npm run style:check\n',
    );
});

test('a script stays, with the reason, when moving it would change what it does', (t) => {
    const root = project(t, {
        'package.json': JSON.stringify({
            name: 'app',
            type: 'module',
            scripts: {
                'audit:check': 'node scripts/checks/check-audit.ts && echo done',
                'dup:check': 'node scripts/checks/check-duplication.ts --all',
                'pipeline:check': 'node ./scripts/checks/check-pipeline.ts  ',
                'ci:check': 'npm run audit:check',
            },
        }),
        'scripts/checks/check-i18n.ts': null,
        'scripts/checks/check-contrast.ts': null,
        'scripts/checks/check-code-style.ts': null,
        'scripts/checks/check-testing.ts': null,
        'scripts/checks/check-audit.ts': gateScript('audit', 'checkAudit', 'checkAudit();'),
        'scripts/checks/check-html.ts': gateScript(
            'html-standards',
            'checkHtmlStandards',
            'checkHtmlStandards({ indexHtml: `${import.meta.dirname}/../../index.html` });',
        ),
        'scripts/checks/check-i18n-root.ts': gateScript('i18n', 'checkI18n', "checkI18n({ root: '.' });"),
        'scripts/checks/check-env.ts': gateScript('env-drift', 'checkEnvDrift', 'checkEnvDrift();'),
        'scripts/checks/check-refactoring.ts': gateScript(
            'refactoring',
            'inspectRefactoring',
            'console.log(inspectRefactoring());',
        ),
        'scripts/checks/check-secrets.ts': `import './setup.ts';\n${gateScript('secrets', 'checkSecrets', 'checkSecrets();')}`,
        'scripts/checks/check-tsconfigs.ts': gateScript(
            'tsconfigs',
            'checkTsconfigs',
            "const UNUSED = 1;\nconst PROJECTS = ['tsconfig.app.json'];\ncheckTsconfigs({ browserProjects: PROJECTS });",
        ),
        'scripts/checks/check-duplication.ts': gateScript('duplication', 'checkDuplication', 'checkDuplication();'),
        'scripts/checks/check-pipeline.ts': gateScript('pipeline', 'checkPipeline', 'checkPipeline();'),
    });
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    for (const [file, reason] of [
        ['check-audit', "package\\.json's `audit:check` runs it along with other commands"],
        ['check-html', 'its options use import\\.meta, which would mean larry\\.config\\.ts instead'],
        ['check-i18n-root', 'it passes `root`, and `larry check` runs every gate from the repository root'],
        ['check-env', 'env-drift is not a gate spa projects run'],
        ['check-refactoring', 'line 3 does more than import a gate and call it'],
        ['check-secrets', 'it imports \\./setup\\.ts for what that runs'],
        ['check-tsconfigs', 'line 3 declares `UNUSED`, which its options do not use'],
        [
            'check-duplication',
            "package\\.json's `dup:check` runs it with `--all`, which `larry check` does not pass on",
        ],
    ]) {
        assert.match(result.out, new RegExp(`^- scripts/checks/${file}\\.ts stays: ${reason}\\.`, 'm'));
    }
    // A run of the file alone moves, trailing spaces and `./` aside.
    assert.match(result.out, /^- scripts\/checks\/check-pipeline\.ts$/m);
    assert.equal(JSON.parse(read(root, 'package.json')).scripts['pipeline:check'], undefined);
});

test('gate scripts kept outside scripts/checks are found by the package.json scripts that run them', (t) => {
    const root = project(t, {
        'package.json': JSON.stringify({
            name: 'app',
            type: 'module',
            scripts: {
                'build': 'node scripts/build.ts',
                'sums': 'node scripts/sums.ts',
                'audit:check': 'node scripts/check/check-audit.ts',
                'ci:check': 'npm run audit:check && npm run build',
            },
        }),
        'scripts/checks/check-i18n.ts': null,
        'scripts/checks/check-contrast.ts': null,
        'scripts/checks/check-code-style.ts': null,
        'scripts/checks/check-testing.ts': null,
        'scripts/build.ts': "console.log('built');\n",
        // A helper from gates/lib is not a gate, so this is not a gate script.
        'scripts/sums.ts':
            "import { REPO_ROOT } from '@larrydarko/lint-config/gates/lib/repo-root';\n\nconsole.log(REPO_ROOT);\n",
        'scripts/check/check-audit.ts': gateScript('audit', 'checkAudit', 'checkAudit();'),
        '.github/workflows/ci.yml': null,
    });
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^- scripts\/check\/check-audit\.ts$/m);
    assert.doesNotMatch(result.out, /build\.ts|sums\.ts/);
    assert.equal(fs.existsSync(path.join(root, 'scripts/check')), false);
    assert.equal(read(root, 'scripts/build.ts'), "console.log('built');\n");
    assert.deepEqual(JSON.parse(read(root, 'package.json')).scripts, {
        'build': 'node scripts/build.ts',
        'sums': 'node scripts/sums.ts',
        'ci:check': 'npm run check && npm run build',
        'check': 'larry check',
    });
    assert.match(read(root, 'larry.config.ts'), /'audit': \{\},/);
});

test('two scripts declaring the same constant: the second in path order stays, since one config cannot hold both', (t) => {
    const root = project(t, {
        'scripts/checks/check-i18n.ts': gateScript(
            'i18n',
            'checkI18n',
            "const DIR = 'src/locales';\ncheckI18n({ localeDir: DIR });",
        ),
        'scripts/checks/check-contrast.ts': gateScript(
            'contrast',
            'checkContrast',
            "const DIR = 'src';\ncheckContrast({ backgrounds: [DIR] });",
        ),
    });
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^- scripts\/checks\/check-contrast\.ts$/m);
    assert.match(
        result.out,
        /^- scripts\/checks\/check-i18n\.ts stays: its `DIR` would clash with another of the same name\./m,
    );
});

test('a removed CI step takes the blank line that set it apart along', (t) => {
    const workflow = [
        'jobs:',
        '    check:',
        '        steps:',
        '            - run: npm ci',
        '',
        '            - name: Locales',
        '              run: npm run i18n:check',
        '',
        '            - name: Lint',
        '              run: npm run lint',
        '',
        '            - name: Contrast',
        '              run: npm run contrast:check',
        '',
        '            - name: Style',
        '              run: npm run style:check',
        '',
    ].join('\n');
    const root = project(t, { '.github/workflows/ci.yml': workflow });
    assert.equal(larry(root, 'upgrade').code, 0);
    assert.equal(
        read(root, '.github/workflows/ci.yml'),
        [
            'jobs:',
            '    check:',
            '        steps:',
            '            - run: npm ci',
            '',
            '            - name: larry check',
            '              run: npm run check',
            '',
            '            - name: Lint',
            '              run: npm run lint',
            '',
        ].join('\n'),
    );
});

test('a carried import joins the import from the same module, and a new one goes in its group', () => {
    const text = "// Header.\nimport { a } from 'pkg';\n\nexport default {};\n";
    const bindings = [
        { local: 'b', imported: 'b', module: 'pkg', typeOnly: false },
        { local: 'T', imported: 'T', module: 'pkg', typeOnly: true },
        { local: 'fs', imported: 'default', module: 'node:fs', typeOnly: false },
        { local: 'x', imported: 'y', module: './x.ts', typeOnly: false },
        { local: 'other', imported: '*', module: 'other', typeOnly: false },
    ];
    assert.equal(
        applyEdits(text, importEdits(parseSource('larry.config.ts', text), bindings)),
        [
            '// Header.',
            "import fs from 'node:fs';",
            '',
            "import { a, b, type T } from 'pkg';",
            "import * as other from 'other';",
            "import { y as x } from './x.ts';",
            '',
            '',
            'export default {};',
            '',
        ].join('\n'),
    );
});

test('gate scripts with no family named anywhere is an error that writes nothing', (t) => {
    const root = project(t, { 'eslint.config.js': 'export default [];\n' });
    const before = snapshot(root);
    const result = larry(root, 'upgrade');
    assert.equal(result.code, 2);
    assert.match(result.err, /neither larry\.config\.ts nor eslint\.config\.js names the project's family/);
    assert.deepEqual(snapshot(root), before);
});

// ── Renamed options ──────────────────────────────────────────────────────────

const RENAMES = [
    { gate: 'code-style', from: 'scanDirs', to: 'scan', since: '9.1.0' },
    { gate: 'duplication', from: 'tokens', to: 'minTokens', since: '9.1.0' },
    { gate: 'audit', from: 'ignore', to: 'allowlist', since: '9.1.0' },
];

test('larry check stops on an old option name and points at upgrade', () => {
    assert.deepEqual(renamedOptionProblems('code-style', { scanDirs: ['src'], casing: [] }, RENAMES), [
        '"code-style".scanDirs is called `scan` since 9.1.0. `npx larry upgrade` renames it.',
    ]);
    assert.deepEqual(renamedOptionProblems('code-style', { scanDirs: ['a'], scan: ['b'] }, RENAMES), [
        '"code-style" sets both `scanDirs` and `scan`. `scanDirs` is its name from before 9.1.0: remove it.',
    ]);
    assert.deepEqual(renamedOptionProblems('code-style', { scan: ['src'] }, RENAMES), []);
    assert.deepEqual(renamedOptionProblems('secrets', { scanDirs: ['src'] }, RENAMES), []);
});

test('upgrade renames an old option in larry.config.ts, keeping its value and comments', async (t) => {
    const root = project(t, {
        'larry.config.ts': [
            "import { defineConfig } from '@larrydarko/lint-config/config';",
            '',
            'const tokens = 60;',
            '',
            'export default defineConfig({',
            "    family: 'spa',",
            '    gates: {',
            "        'code-style': {",
            '            // Tests too.',
            "            scanDirs: ['src', 'test'],",
            '        },',
            '        duplication: { tokens },',
            '        audit: { ignore: [], allowlist: [] },',
            '    },',
            '});',
            '',
        ].join('\n'),
    });
    const tree = createTree(root);
    const notes = await renameOptions(tree, RENAMES);
    assert.deepEqual(notes, [
        'larry.config.ts: "audit" sets both `ignore` and `allowlist`. Keep the value you want under `allowlist`.',
    ]);
    const config = tree.changes().get('larry.config.ts');
    assert.match(config, /\/\/ Tests too\.\n\s+scan: \['src', 'test'\],/);
    assert.match(config, /'duplication': \{ minTokens: tokens \},/);
    assert.match(config, /'audit': \{ ignore: \[\], allowlist: \[\] \},/);
});
