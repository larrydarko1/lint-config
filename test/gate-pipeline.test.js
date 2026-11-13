/**
 * The pipeline gate, against minimal fixture repositories.
 * - This gate cannot be proved the way the others were. The two families' copies
 * both PASS on their own repos, so running the merged version against all four
 * projects only shows it still passes — it says nothing about whether a rule
 * survived the merge. The negatives below are the proof: each starts from
 * a repository that passes and breaks exactly one thing.
 * - Five of those rules existed only in the full-stack copy and three only in the
 * desktop copy, so eight of these tests are asserting coverage one family did not
 * have at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkPipeline } from '../src/gates/pipeline.ts';

/** Runs `fn` with console captured and the exit code restored afterwards. */
const capture = (fn) => {
    const out = [];
    const err = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), err: err.join('\n'), failed: process.exitCode === 1 };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

const SHA = 'a'.repeat(40);

/** A CI workflow that satisfies every rule. */
const CI_YML = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${SHA} # v5
      - uses: actions/setup-node@${SHA} # v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint:check
`;

const PKG = {
    name: 'fixture',
    engines: { node: '>=24' },
    scripts: {
        'lint:check': 'node scripts/checks/check-lint.ts',
        'ci:check': 'npm run lint:check',
    },
};

/**
 * A repository that passes. `files` is merged over it, and a value of null removes
 * a file — which is how a test deletes ci.yml.
 */
const project = (t, files = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-pipe-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const all = {
        '.github/workflows/ci.yml': CI_YML,
        'package.json': JSON.stringify(PKG, null, 4),
        'scripts/checks/check-lint.ts': '// a gate\n',
        ...files,
    };
    for (const [rel, body] of Object.entries(all)) {
        if (body === null) continue;
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
};

const run = (root) => capture(() => checkPipeline({ root }));

/** The baseline with one line of ci.yml rewritten. */
const patched = (t, from, to, extra = {}) => {
    assert.ok(CI_YML.includes(from), `fixture does not contain: ${from}`);
    return project(t, { '.github/workflows/ci.yml': CI_YML.replace(from, to), ...extra });
};

// ── The baseline ─────────────────────────────────────────────────────────────

test('a workflow that satisfies every rule passes', (t) => {
    const { out, err, failed } = run(project(t));
    assert.equal(failed, false, err);
    assert.match(out, /✓ Pipeline OK — 1 workflow, 1 job/);
    // With no image push the summary does not claim to have checked image tags.
    assert.doesNotMatch(out, /pushed image/);
});

// ── 1-4: the rules both families already had ────────────────────────────────

test('1. a job with no timeout-minutes is reported', (t) => {
    const { err, failed } = run(patched(t, '    timeout-minutes: 10\n', ''));
    assert.equal(failed, true);
    assert.match(err, /job `check` has no timeout-minutes/);
});

test('2. concurrency without an explicit cancel-in-progress is reported', (t) => {
    const { err } = run(patched(t, '  cancel-in-progress: true\n', ''));
    assert.match(err, /`concurrency` does not set `cancel-in-progress`/);
    // And declaring none at all is a different, louder finding.
    const missing = run(patched(t, 'concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n', ''));
    assert.match(missing.err, /declares no `concurrency`/);
});

test('3. write-all permissions are reported, as is declaring none', (t) => {
    assert.match(run(patched(t, 'permissions:\n  contents: read', 'permissions: write-all')).err, /write-all/);
    assert.match(run(patched(t, 'permissions:\n  contents: read\n', '')).err, /declares no top-level `permissions`/);
});

test('4. a tag-pinned action is reported, and a SHA with no version comment', (t) => {
    assert.match(
        run(patched(t, `actions/checkout@${SHA} # v5`, 'actions/checkout@v5')).err,
        /`actions\/checkout@v5` is pinned to the tag `v5`/,
    );
    assert.match(
        run(patched(t, `actions/checkout@${SHA} # v5`, `actions/checkout@${SHA}`)).err,
        /is SHA-pinned but has no version comment/,
    );
});

// ── 5: the matrix resolution the full-stack copy did not have ───────────────

test('5. `-latest` is reported, and THROUGH a matrix the literal-only check missed', (t) => {
    assert.match(run(patched(t, 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest')).err, /runs on `ubuntu-latest`/);

    const matrix = patched(
        t,
        '    runs-on: ubuntu-24.04\n',
        '    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-24.04, macos-latest]\n',
    );
    const { err, failed } = run(matrix);
    assert.equal(failed, true);
    assert.match(err, /runs on `macos-latest`/);
});

test('5. a computed runs-on the gate cannot resolve is reported rather than skipped', (t) => {
    const { err, failed } = run(patched(t, 'runs-on: ubuntu-24.04', 'runs-on: ${{ inputs.runner }}'));
    assert.equal(failed, true);
    assert.match(err, /has a computed `runs-on` this gate cannot resolve/);
});

// ── 6-7 ──────────────────────────────────────────────────────────────────────

test('6. npm install is reported; a global install is not', (t) => {
    assert.match(run(patched(t, '      - run: npm ci', '      - run: npm install')).err, /runs `npm install`/);
    assert.equal(
        run(patched(t, '      - run: npm ci', '      - run: npm i -g corepack\n      - run: npm ci')).failed,
        false,
    );
});

test('7. setup-node without `cache: npm` is reported', (t) => {
    const { err } = run(patched(t, '          cache: npm\n', ''));
    assert.match(err, /sets up Node without `cache: npm`/);
});

// ── 8-9: workflow_run ────────────────────────────────────────────────────────

const WORKFLOW_RUN = `name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  gate:
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: echo ok
  ship:
    needs: gate
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA} # v5
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
`;

test('8. a workflow_run job inherits its gate through `needs`, which the other copy could not see', (t) => {
    // `ship` carries no `if:` of its own. It is gated only because `gate` is.
    const { err, failed } = run(project(t, { '.github/workflows/deploy.yml': WORKFLOW_RUN }));
    assert.equal(failed, false, err);
});

test('8. detaching that job from its gatekeeper fails loudly', (t) => {
    const { err, failed } = run(
        project(t, { '.github/workflows/deploy.yml': WORKFLOW_RUN.replace('    needs: gate\n', '') }),
    );
    assert.equal(failed, true);
    assert.match(err, /job `ship` does not gate on `workflow_run\.conclusion == 'success'`/);
    assert.match(err, /checks out code without gating on `workflow_run\.event == 'push'`/);
});

test('9. a workflow_run checkout that is not pinned to head_sha is reported', (t) => {
    const { err, failed } = run(
        project(t, {
            '.github/workflows/deploy.yml': WORKFLOW_RUN.replace(
                '        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n',
                '',
            ),
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /job `ship` checks out the default ref/);
});

// ── 19: workflow_run names resolve ───────────────────────────────────────────

test('19. a workflow_run naming a workflow by its declared name passes', (t) => {
    const { err, failed } = run(project(t, { '.github/workflows/deploy.yml': WORKFLOW_RUN }));
    assert.equal(failed, false, err);
});

test('19. a workflow_run naming a workflow that does not exist is reported', (t) => {
    const { err, failed } = run(
        project(t, {
            '.github/workflows/deploy.yml': WORKFLOW_RUN.replace(
                'workflows: [CI]',
                "workflows: ['Build & Push images']",
            ),
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /waits on a workflow named 'Build & Push images', which does not exist/);
    assert.match(err, /Declared names: 'CI', 'Deploy'/);
});

test('19. the FILENAME is not the name GitHub matches', (t) => {
    // ci.yml declares `name: CI`; waiting on `ci` never fires.
    const { err, failed } = run(
        project(t, { '.github/workflows/deploy.yml': WORKFLOW_RUN.replace('workflows: [CI]', 'workflows: [ci]') }),
    );
    assert.equal(failed, true);
    assert.match(err, /waits on a workflow named 'ci'/);
});

test('19. an unnamed workflow is named by its path, not its filename', (t) => {
    const unnamed = CI_YML.replace('name: CI\n', '');
    const byPath = run(
        project(t, {
            '.github/workflows/ci.yml': unnamed,
            '.github/workflows/deploy.yml': WORKFLOW_RUN.replace(
                'workflows: [CI]',
                'workflows: [.github/workflows/ci.yml]',
            ),
        }),
    );
    assert.equal(byPath.failed, false, byPath.err);
    const byStem = run(
        project(t, {
            '.github/workflows/ci.yml': unnamed,
            '.github/workflows/deploy.yml': WORKFLOW_RUN.replace('workflows: [CI]', 'workflows: [ci]'),
        }),
    );
    assert.equal(byStem.failed, true);
    assert.match(byStem.err, /waits on a workflow named 'ci'/);
});

test('19. a parked workflow declares no name, because it never runs', (t) => {
    const parkedCi = CI_YML.split('\n')
        .map((line) => `# ${line}`)
        .join('\n');
    const { err, failed } = run(
        project(t, {
            '.github/workflows/ci.yml': parkedCi,
            '.github/workflows/lint.yml': CI_YML.replace('name: CI', 'name: Lint'),
            '.github/workflows/deploy.yml': WORKFLOW_RUN,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /waits on a workflow named 'CI', which does not exist/);
});

// ── 10-13, 15: the five rules only the full-stack copy had ──────────────────

/** A job that builds and pushes an image, correct in every respect. */
const DOCKER = `name: Image
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: image
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    permissions:
      packages: write
    steps:
      - uses: docker/build-push-action@${SHA} # v6
        with:
          push: true
          tags: ghcr.io/me/app:\${{ github.sha }}
          cache-from: type=gha,scope=app
          cache-to: type=gha,scope=app
`;

test('10. a `:latest` image tag is reported, and so is one with no commit SHA', (t) => {
    assert.equal(run(project(t, { '.github/workflows/image.yml': DOCKER })).failed, false);
    assert.match(
        run(project(t, { '.github/workflows/image.yml': DOCKER.replace('app:${{ github.sha }}', 'app:latest') })).err,
        /pushes `ghcr\.io\/me\/app:latest`/,
    );
    assert.match(
        run(project(t, { '.github/workflows/image.yml': DOCKER.replace('app:${{ github.sha }}', 'app:v2') })).err,
        /which does not contain a commit SHA/,
    );
});

test('11. a build with no cache, an unscoped cache, or a mismatched one is reported', (t) => {
    assert.match(
        run(project(t, { '.github/workflows/image.yml': DOCKER.replace(/ {10}cache-to:.*\n/, '') })).err,
        /builds without `cache-to`/,
    );
    assert.match(
        run(
            project(t, {
                '.github/workflows/image.yml': DOCKER.replace('cache-to: type=gha,scope=app', 'cache-to: type=gha'),
            }),
        ).err,
        /sets `cache-to` without a `scope=`/,
    );
    assert.match(
        run(
            project(t, {
                '.github/workflows/image.yml': DOCKER.replace(
                    'cache-from: type=gha,scope=app',
                    'cache-from: type=gha,scope=other',
                ),
            }),
        ).err,
        /reads cache scope `other` but writes `app`/,
    );
});

test('11. two images sharing one cache scope are reported', (t) => {
    const second = DOCKER.replace('name: Image', 'name: Image2').replace('  build:', '  build2:');
    const { err, failed } = run(
        project(t, { '.github/workflows/image.yml': DOCKER, '.github/workflows/image2.yml': second }),
    );
    assert.equal(failed, true);
    assert.match(err, /reuses cache scope `app`/);
});

test('12. pushing to the registry without `packages: write` is reported', (t) => {
    const { err, failed } = run(
        project(t, { '.github/workflows/image.yml': DOCKER.replace('    permissions:\n      packages: write\n', '') }),
    );
    assert.equal(failed, true);
    assert.match(err, /writes to the package registry without `packages: write`/);
});

test('13. a secret written to a file with no `if: always()` cleanup is reported', (t) => {
    const deploy = CI_YML.replace(
        '      - run: npm run lint:check\n',
        '      - run: echo "${{ secrets.KUBECONFIG }}" > kubeconfig\n',
    );
    const { err, failed } = run(project(t, { '.github/workflows/deploy.yml': deploy }));
    assert.equal(failed, true);
    assert.match(err, /writes a secret to a file with no `if: always\(\)` cleanup/);
});

test('15. a release asset downloaded unpinned, or installed unverified, is reported', (t) => {
    const curl = CI_YML.replace(
        '      - run: npm run lint:check\n',
        '      - run: curl -L https://github.com/org/tool/releases/download/latest/tool -o /usr/local/bin/tool\n',
    );
    const { err, failed } = run(project(t, { '.github/workflows/tools.yml': curl }));
    assert.equal(failed, true);
    assert.match(err, /downloads a release asset from an unpinned URL/);
    assert.match(err, /installs a downloaded binary without verifying a checksum/);
});

// ── 14 ───────────────────────────────────────────────────────────────────────

test('14. an untrusted event field interpolated into a run: block is reported', (t) => {
    const { err, failed } = run(
        patched(t, '      - run: npm run lint:check', '      - run: echo "${{ github.event.pull_request.title }}"'),
    );
    assert.equal(failed, true);
    assert.match(err, /interpolates `github\.event\.pull_request\.title` into a `run:` script/);
});

// ── 16: the workspace resolution the desktop copy did not have ──────────────

test('16. an `npm run` naming a script that does not exist is reported', (t) => {
    const { err, failed } = run(patched(t, 'npm run lint:check', 'npm run lint:chekc'));
    assert.equal(failed, true);
    assert.match(err, /runs `npm run lint:chekc`, which is not a script there/);
});

test('16. `npm -w <ws> run` is resolved in that workspace, by folder or by package name', (t) => {
    const files = {
        'package.json': JSON.stringify({ ...PKG, workspaces: ['api'] }, null, 4),
        'api/package.json': JSON.stringify({ name: '@app/api', scripts: { build: 'tsc' } }, null, 4),
    };
    const ok = patched(t, '      - run: npm ci', '      - run: npm ci\n      - run: npm -w api run build', files);
    assert.equal(run(ok).failed, false);

    const byName = patched(
        t,
        '      - run: npm ci',
        '      - run: npm ci\n      - run: npm -w @app/api run build',
        files,
    );
    assert.equal(run(byName).failed, false);

    const wrongScript = patched(
        t,
        '      - run: npm ci',
        '      - run: npm ci\n      - run: npm -w api run test',
        files,
    );
    assert.match(run(wrongScript).err, /runs `npm run test` in `api`, which is not a script there/);

    const noSuchWs = patched(
        t,
        '      - run: npm ci',
        '      - run: npm ci\n      - run: npm -w worker run build',
        files,
    );
    assert.match(run(noSuchWs).err, /there is no `worker` workspace/);
});

// ── 17 ───────────────────────────────────────────────────────────────────────

test('17. a gate script wired to nothing is reported at each of the three levels', (t) => {
    // Level 1: no package.json script runs it.
    const orphan = run(project(t, { 'scripts/checks/check-orphan.ts': '// nothing runs me\n' }));
    assert.match(orphan.err, /scripts\/checks\/check-orphan\.ts/);
    assert.match(orphan.err, /is not invoked by any package\.json script/);

    // Level 2: it has a script, but ci:check does not chain it.
    const notChained = run(
        project(t, {
            'scripts/checks/check-orphan.ts': '// \n',
            'package.json': JSON.stringify(
                { ...PKG, scripts: { ...PKG.scripts, 'orphan:check': 'node scripts/checks/check-orphan.ts' } },
                null,
                4,
            ),
        }),
    );
    assert.match(notChained.err, /`ci:check` does not run `orphan:check`/);

    // Level 3: chained locally, absent from ci.yml.
    const notInCi = run(
        project(t, {
            'scripts/checks/check-orphan.ts': '// \n',
            'package.json': JSON.stringify(
                {
                    ...PKG,
                    scripts: {
                        ...PKG.scripts,
                        'orphan:check': 'node scripts/checks/check-orphan.ts',
                        'ci:check': 'npm run lint:check && npm run orphan:check',
                    },
                },
                null,
                4,
            ),
        }),
    );
    assert.match(notInCi.err, /has no step running `orphan:check`/);
});

test('17. a missing ci.yml, an empty checks dir and a missing ci:check are each reported', (t) => {
    assert.match(run(project(t, { '.github/workflows/ci.yml': null })).err, /no workflow files found/);
    assert.match(
        run(project(t, { 'package.json': JSON.stringify({ ...PKG, scripts: { 'lint:check': 'x' } }, null, 4) })).err,
        /has no `ci:check` script/,
    );
});

/** A project whose gates are in larry.config.ts, run by `larry check` through `scripts`. */
const larryProject = (t, scripts, ciRun = 'npm run check') =>
    project(t, {
        'larry.config.ts': 'export default {};\n',
        'scripts/checks/check-lint.ts': null,
        'package.json': JSON.stringify({ ...PKG, scripts }, null, 4),
        '.github/workflows/ci.yml': CI_YML.replace('npm run lint:check', ciRun),
    });

test('17. with larry.config.ts, `larry check` in ci:check and ci.yml covers every gate', (t) => {
    const viaScript = run(larryProject(t, { 'check': 'larry check', 'ci:check': 'npm run check' }));
    assert.equal(viaScript.failed, false, viaScript.err);
    assert.match(viaScript.out, /`larry check` wired into ci:check and ci\.yml/);

    // Directly in both, with a flag, and from the CLI's own source in this package.
    const direct = run(larryProject(t, { 'ci:check': 'npm test && larry check --all' }, 'npx larry check'));
    assert.equal(direct.failed, false, direct.err);
    const fromSource = run(larryProject(t, { 'check': 'node src/cli/larry.ts check', 'ci:check': 'npm run check' }));
    assert.equal(fromSource.failed, false, fromSource.err);
});

test('17. NEGATIVE: with larry.config.ts, a missing or partial `larry check` is reported at each level', (t) => {
    const notChained = run(larryProject(t, { 'check': 'larry check', 'ci:check': 'npm test' }));
    assert.match(notChained.err, /`ci:check` does not run `larry check`/);

    const notInCi = run(larryProject(t, { 'check': 'larry check', 'ci:check': 'npm run check' }, 'npm test'));
    assert.match(notInCi.err, /has no step running `larry check`/);

    // Naming a gate runs only that one, so it does not cover the rest.
    const partial = run(larryProject(t, { 'check': 'larry check audit', 'ci:check': 'npm run check' }));
    assert.match(partial.err, /`ci:check` does not run `larry check`/);
});

test('17. NEGATIVE: `npm run check` is not `npm run check:package`', (t) => {
    const result = run(
        larryProject(
            t,
            { 'check': 'larry check', 'check:package': 'echo', 'ci:check': 'npm run check:package' },
            'npm run check:package',
        ),
    );
    assert.match(result.err, /`ci:check` does not run `larry check`/);
    assert.match(result.err, /has no step running `larry check`/);
});

test('17. gate scripts beside a larry.config.ts are still held to all three levels', (t) => {
    const result = run(
        project(t, {
            'larry.config.ts': 'export default {};\n',
            'package.json': JSON.stringify(
                { ...PKG, scripts: { ...PKG.scripts, 'check': 'larry check', 'ci:check': 'npm run check' } },
                null,
                4,
            ),
            '.github/workflows/ci.yml': CI_YML.replace('npm run lint:check', 'npm run check'),
        }),
    );
    assert.match(result.err, /`ci:check` does not run `lint:check`/);
    assert.doesNotMatch(result.err, /larry check`/);
});

// ── 18: the engines.node rule the full-stack copy did not have ──────────────

test('18. a CI Node major above or below engines.node is reported, both directions', (t) => {
    const above = patched(t, 'node-version: 24', 'node-version: 26');
    assert.match(run(above).err, /installs Node 26 while `engines\.node` is ">=24"/);

    const below = project(t, {
        'package.json': JSON.stringify({ ...PKG, engines: { node: '>=26' } }, null, 4),
    });
    assert.match(run(below).err, /installs Node 24, below the `engines\.node` floor of >=26/);
});

test('18. no engines.node at all, and no node-version anywhere, are each reported', (t) => {
    const noEngines = project(t, { 'package.json': JSON.stringify({ ...PKG, engines: undefined }, null, 4) });
    assert.match(run(noEngines).err, /declares no `engines\.node`/);

    const noVersion = patched(t, '          node-version: 24\n', '');
    assert.match(run(noVersion).err, /no `node-version:` found in any workflow or action/);
});

// ── Parsing and scope ────────────────────────────────────────────────────────

test('a workflow that is not valid YAML is reported, not silently skipped', (t) => {
    const { err, failed } = run(project(t, { '.github/workflows/broken.yml': 'jobs:\n  - [unclosed\n' }));
    assert.equal(failed, true);
    assert.match(err, /is not valid YAML/);
});

test('a commented-out workflow is parked, not treated as having zero jobs', (t) => {
    const { out, failed } = run(project(t, { '.github/workflows/parked.yml': '# name: Later\n' }));
    assert.equal(failed, false);
    assert.match(out, /1 parked workflow skipped: \.github\/workflows\/parked\.yml\./);
});

test('a composite action is read for steps like a workflow job', (t) => {
    const { err, failed } = run(
        project(t, {
            '.github/actions/setup/action.yml': `name: Setup
runs:
  using: composite
  steps:
    - run: npm install
`,
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /\.github\/actions\/setup\/action\.yml/);
    assert.match(err, /runs `npm install`/);
});

test('a bare `on:` key, which YAML 1.1 reads as the boolean true, still resolves the triggers', (t) => {
    // `on: workflow_run` parses as the key `true`. If the gate missed that, rules 8
    // and 9 would silently skip every workflow_run workflow in the repository.
    const { err, failed } = run(
        project(t, {
            '.github/workflows/deploy.yml': WORKFLOW_RUN.replace('    needs: gate\n', '').replace(
                'on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]',
                'on:\n  workflow_run:\n    workflows: [CI]',
            ),
        }),
    );
    assert.equal(failed, true);
    assert.match(err, /does not gate on `workflow_run\.conclusion == 'success'`/);
});

// ── 20: a release is one queue ───────────────────────────────────────────────

const RELEASE = `name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
concurrency:
  group: release-\${{ github.ref }}
  cancel-in-progress: false
jobs:
  publish:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
      - run: gh release create "$GITHUB_REF_NAME" --draft
`;

/** The passing release workflow with one piece rewritten. */
const release = (t, from, to) => {
    assert.ok(RELEASE.includes(from), `fixture does not contain: ${from}`);
    return project(t, { '.github/workflows/release.yml': RELEASE.replace(from, to) });
};

test('20. a release workflow that queues and groups by tag passes, and the summary says so', (t) => {
    const { out, err, failed } = run(project(t, { '.github/workflows/release.yml': RELEASE }));
    assert.equal(failed, false, err);
    assert.match(out, /every release workflow one queue that never cancels/);
});

test('20. a release workflow that cancels in-progress runs is reported', (t) => {
    const { err, failed } = run(release(t, 'cancel-in-progress: false', 'cancel-in-progress: true'));
    assert.equal(failed, true);
    assert.match(err, /publishes a release but cancels in-progress runs/);
});

test('20. a release workflow grouped by commit is reported, for push and for workflow_run', (t) => {
    for (const sha of ['github.sha', 'github.event.workflow_run.head_sha']) {
        const { err, failed } = run(release(t, 'release-${{ github.ref }}', `release-\${{ ${sha} }}`));
        assert.equal(failed, true, sha);
        assert.match(err, /publishes a release but groups concurrency by commit/);
    }
});

test('20. the release action and `gh release upload` count as publishing', (t) => {
    const step = '      - run: gh release create "$GITHUB_REF_NAME" --draft\n';
    for (const publish of [
        `      - uses: softprops/action-gh-release@${SHA} # v2\n`,
        '      - run: gh release upload "$GITHUB_REF_NAME" app.zip --clobber\n',
    ]) {
        const body = RELEASE.replace(step, publish).replace('cancel-in-progress: false', 'cancel-in-progress: true');
        const { err, failed } = run(project(t, { '.github/workflows/release.yml': body }));
        assert.equal(failed, true, publish);
        assert.match(err, /publishes a release but cancels in-progress runs/);
    }
});

test('20. a workflow that publishes nothing may cancel, whatever its group', (t) => {
    const { err, failed } = run(patched(t, 'group: ci-${{ github.ref }}', 'group: ci-${{ github.sha }}'));
    assert.equal(failed, false, err);
});

test('20. a release workflow with the one-line `concurrency:` form is reported once, by rule 2', (t) => {
    const { err, failed } = run(
        release(
            t,
            'concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false\n',
            'concurrency: release\n',
        ),
    );
    assert.equal(failed, true);
    assert.match(err, /`concurrency` does not set `cancel-in-progress`/);
    assert.doesNotMatch(err, /publishes a release/);
});
