/**
 * Container images, checked without a Docker daemon:
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. Multi-stage.
 *   2. Non-root at runtime, with the base resolved (nginx-unprivileged needs no USER).
 *   3. A HEALTHCHECK that asks the running process something (not `pgrep`, not
 *      `node -e "process.exit(0)"`, not NONE).
 *   4. Base images pinned by tag — never `:latest`, never bare.
 *   5. Package lists cleaned in the same RUN.
 *   6. CMD and ENTRYPOINT in exec form, and never via a package manager.
 *   7. COPY, not ADD.
 *   8. No secrets baked into a layer.
 *   9. The base image's Node major is engines.node.
 *  10. .dockerignore covers the dangerous things.
 *  11. Manifests copied before sources.
 *  12. NODE_ENV=production in a Node runtime stage.
 *  13. Every Dockerfile is built by a workflow, from the configured context.
 *  14. `--ignore-scripts` on every npm install.
 *  15. EXPOSE agrees with the k8s containerPort (when `deployments` is given).
 *  16. The kustomization names images the build pushes (when `kustomization` is given).
 *  17. The images that need glibc stay on it (when `glibc` is given).
 * - Stages inherit USER, ENV and HEALTHCHECK through `FROM <earlier-stage>`; global
 * ARGs are substituted into FROM lines. CI node-version and workflow_run names are
 * the pipeline gate's.
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import {
    assignments,
    chainOf,
    effective,
    parentOf,
    parseStages,
    type Instruction,
    type Stage,
} from './lib/dockerfile.ts';
import { listAt, recordAt, stringAt, toRecord } from './lib/json.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { collectFailures, createGateReport, plural, type GateFailure } from './lib/report.ts';

export type DockerOptions = {
    root?: string;
    /** Where the Dockerfiles live. `*.Dockerfile` and a plain `Dockerfile` are read. Defaults to `docker`. */
    dockerDir?: string;
    /** Defaults to `.dockerignore`. */
    dockerignore?: string;
    /** The manifest whose `engines.node` every `node:` base is held to. Defaults to `package.json`. */
    packageJson?: string;
    /** The workflow whose `docker/build-push-action` steps must build every Dockerfile. Defaults to `.github/workflows/build.yml`. */
    buildWorkflow?: string;
    /** The context every build must use. Defaults to `.`, the repo root, where the lockfile is. */
    buildContext?: string;
    /** Extra bases that run unprivileged by construction, as RegExp sources. nginx-unprivileged is built in. */
    nonrootBases?: string[];
    /** Dockerfile → the k8s manifest that deploys it. Omitted, EXPOSE is not compared with containerPort. */
    deployments?: Record<string, string>;
    /** The kustomization whose `images:` must name what the build pushes. Omitted, not checked. */
    kustomization?: string;
    /** Images that must stay on a glibc base, each with the reason. */
    glibc?: GlibcImage[];
};

type GlibcImage = {
    /** The Dockerfile, as a repo-relative path (`docker/worker.Dockerfile`). */
    file: string;
    /** Which native module needs glibc, and how it fails on musl. Printed on failure. */
    why: string;
};

type DockerInspection = {
    problems: GateFailure[];
    counts: { images: number; stages: number; nodeMajor: string | null };
};

type Dockerfile = { rel: string; stages: Stage[] };

/** Bases that run unprivileged by construction, so no USER is needed. */
const NONROOT_BASES = [/^nginxinc\/nginx-unprivileged(:|$)/];

/** What must never reach the build context, and why. */
const REQUIRED_IGNORES = [
    [
        'node_modules',
        ['node_modules', '**/node_modules'],
        'ships a host-built tree, including native modules compiled for the wrong platform',
    ],
    ['dist', ['dist', '**/dist'], 'a stale host build overwrites the one the image just compiled'],
    ['.git', ['.git', '**/.git'], 'the entire history, including anything ever committed and later removed'],
    ['.env', ['.env', '**/.env'], 'secrets, baked into a layer'],
    ['.env.*', ['.env.*', '**/.env.*'], 'the same, for every per-environment variant'],
    ['coverage', ['coverage', '**/coverage'], 'megabytes of HTML no image runs'],
    [
        '__tests__',
        ['__tests__', '**/__tests__'],
        'test code in a production image is extra attack surface for no benefit',
    ],
    ['*.test.ts', ['*.test.ts', '**/*.test.ts'], 'the same, for co-located specs'],
    ['*.log', ['*.log', '**/*.log'], 'local logs, which can contain request bodies and tokens'],
] as const;

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL)/i;

/** A HEALTHCHECK that only proves a process exists. */
const PROCESS_PROBE = /\b(pgrep|pidof|ps)\b/;
/** A HEALTHCHECK that asks the running process something over the network. */
const ASKS_THE_PROCESS = /fetch\(|\bwget\b|\bcurl\b|https?:\/\/|\bhttp\.(get|request)\(|\bnc\b/;

/** Tags that name a moving target rather than a build. */
const MUTABLE_TAG = /^(latest|stable|main|master|prod|production)$/;

export function inspectDocker(input: DockerOptions): DockerInspection {
    const {
        root = REPO_ROOT,
        dockerDir = 'docker',
        dockerignore = '.dockerignore',
        packageJson = 'package.json',
        buildWorkflow = '.github/workflows/build.yml',
        buildContext = '.',
        nonrootBases = [],
        deployments,
        kustomization,
        glibc = [],
    } = input;

    const { problems, fail } = collectFailures();
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));

    /** Every document in a YAML file, or null with the failure reported. The parser recovers rather than throws, so `errors` is read. */
    const yamlDocuments = (rel: string): unknown[] | null => {
        const documents = YAML.parseAllDocuments(read(rel));
        const list = Array.isArray(documents) ? documents : [documents];
        const broken = list.find((d) => d.errors.length > 0);
        if (broken !== undefined) {
            fail(
                rel,
                `is not valid YAML (${broken.errors[0]?.message.split('\n')[0] ?? ''})`,
                'Every rule that reads this file is blind to it until it parses.',
            );
            return null;
        }
        return list.map((d) => d.toJS() as unknown);
    };

    const nonroot = [...NONROOT_BASES, ...nonrootBases.map((source) => new RegExp(source))];

    const dockerfiles: Dockerfile[] = exists(dockerDir)
        ? fs
              .readdirSync(path.join(root, dockerDir))
              .filter((f) => f.endsWith('.Dockerfile') || f === 'Dockerfile')
              .sort()
              .map((f) => {
                  const rel = `${dockerDir}/${f}`;
                  return { rel, stages: parseStages(read(rel)) };
              })
        : [];

    if (dockerfiles.length === 0) {
        fail(dockerDir, 'no Dockerfile found', 'The gate would pass vacuously. Did the directory move?');
    }

    for (const { rel, stages } of dockerfiles) {
        const last = stages.at(-1);

        // ── 1. Multi-stage ──────────────────────────────────────────────────
        if (stages.length < 2) {
            fail(
                rel,
                `single-stage build (${stages.length} FROM)`,
                'Build in one stage with devDependencies, ship another with only the compiled output and production deps. A single stage ships the TypeScript compiler and every dev tool to production.',
            );
        }
        if (last === undefined) continue;
        const lastBase = chainOf(stages, last)[0]?.base ?? last.base;

        // ── 2. Non-root at runtime ──────────────────────────────────────────
        const user = effective(stages, last, 'USER')?.args ?? null;
        if (user === null) {
            if (!nonroot.some((pattern) => pattern.test(lastBase))) {
                fail(
                    rel,
                    `final stage (${last.name ?? 'unnamed'}, FROM ${lastBase}) declares no USER`,
                    'It therefore runs as root. Add `USER node` — or use a base that is unprivileged by construction and name it in `nonrootBases` with a note on why it qualifies.',
                );
            }
        } else if (/^(root|0)(:|$)/.test(user)) {
            fail(
                rel,
                `final stage runs as \`USER ${user}\``,
                'Never root at runtime. A container escape starts with the privileges of the process it escaped from.',
            );
        }

        // ── 3. A HEALTHCHECK that asks the process ──────────────────────────
        const health = effective(stages, last, 'HEALTHCHECK');
        if (health === undefined) {
            fail(
                rel,
                'final stage has no HEALTHCHECK',
                'Orchestrators gate traffic on it. Without one, a container that is up but wedged keeps receiving requests.',
            );
        } else if (/^NONE\b/i.test(health.args)) {
            fail(
                rel,
                `line ${health.line}: HEALTHCHECK NONE`,
                'It disables the check the base image may have had, which is the same as having none.',
            );
        } else if (PROCESS_PROBE.test(health.args)) {
            fail(
                rel,
                `line ${health.line}: the HEALTHCHECK only proves a process exists`,
                'A deadlocked process is still very much there. Ask it something over the network — `fetch` a liveness route — so an answer proves its event loop is turning.',
            );
        } else if (!ASKS_THE_PROCESS.test(health.args)) {
            fail(
                rel,
                `line ${health.line}: the HEALTHCHECK does not ask the running process anything`,
                '`node -e "process.exit(0)"` starts a FRESH process, which always exits 0 and says nothing about the one serving traffic. Make a request to it.',
            );
        }

        for (const stage of stages) problems.push(...stageProblems(rel, stages, stage));

        // ── 12. NODE_ENV in a Node runtime stage ────────────────────────────
        if (/^(?:docker\.io\/)?(?:library\/)?node:/.test(lastBase)) {
            const env = chainOf(stages, last)
                .flatMap((s) => s.instructions)
                .filter((i) => i.instruction === 'ENV')
                .flatMap((i) => assignments(i.args));
            const nodeEnv = env.filter(([name]) => name === 'NODE_ENV').at(-1)?.[1];
            if (nodeEnv !== 'production') {
                fail(
                    rel,
                    'final stage does not set NODE_ENV=production',
                    'Express serves stack traces, Mongoose keeps autoIndex on, and npm packages take their development code paths. Nothing crashes — the image is just quietly running a development configuration.',
                );
            }
        }
    }

    // ── 9. The base image's Node major is engines.node ──────────────────────
    const enginesRange = exists(packageJson)
        ? (stringAt(recordAt(JSON.parse(read(packageJson)), 'engines'), 'node') ?? '')
        : '';
    const enginesMajor = /(\d+)/.exec(enginesRange)?.[1] ?? null;
    if (enginesMajor === null) {
        fail(
            packageJson,
            `engines.node is ${enginesRange === '' ? 'absent' : `"${enginesRange}"`}`,
            'It is the single statement of which Node major this app runs on, and the one number every base image here is held to. Declare it.',
        );
    } else {
        for (const { rel, stage } of dockerfiles.flatMap(({ rel, stages }) =>
            stages.map((stage) => ({ rel, stage })),
        )) {
            const m = /^(?:docker\.io\/)?(?:library\/)?node:(\d+)(?:[.-]|$)/.exec(stage.base);
            if (m !== null && m[1] !== enginesMajor) {
                fail(
                    rel,
                    `line ${stage.from}: FROM ${stage.base}, but engines.node is "${enginesRange}"`,
                    'A Docker build never reads engines, so this drifts in total silence and only production runs the untested major. Bump the tag with the engines range, together.',
                );
            }
        }
    }

    // ── 10. .dockerignore coverage ──────────────────────────────────────────
    if (!exists(dockerignore)) {
        fail(
            dockerignore,
            'missing',
            'Without it the whole working tree is sent to the daemon on every build — slow, and it ships .env files.',
        );
    } else {
        const lines = read(dockerignore)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('#'));
        for (const [label, spellings, why] of REQUIRED_IGNORES) {
            // The last line naming it wins (`!.env` re-includes).
            const verdict = lines.filter((l) => (spellings as readonly string[]).includes(l.replace(/^!/, ''))).at(-1);
            if (verdict === undefined || verdict.startsWith('!')) {
                fail(
                    dockerignore,
                    verdict === undefined ? `no entry ignoring ${label}` : `\`${verdict}\` re-includes ${label}`,
                    `${why}. Add one of: ${spellings.join(', ')}.`,
                );
            }
        }
    }

    // ── 13. Every Dockerfile is built, from the configured context ──────────
    const pushed = new Set<string | undefined>();
    if (!exists(buildWorkflow)) {
        fail(
            buildWorkflow,
            'missing',
            `Nothing builds the images, so every Dockerfile in ${dockerDir}/ is unverified.`,
        );
    } else {
        const [build] = yamlDocuments(buildWorkflow) ?? [null];
        const builds: { jobName: string; file: string; context: string | undefined }[] = [];
        const steps = Object.entries(recordAt(build, 'jobs')).flatMap(([jobName, job]) =>
            listAt(job, 'steps').map((step) => ({ jobName, step })),
        );
        for (const { jobName, step } of steps) {
            const file = stringAt(recordAt(step, 'with'), 'file');
            const building = stringAt(step, 'uses')?.startsWith('docker/build-push-action') === true;
            if (building && file !== undefined && file !== '') {
                builds.push({ jobName, file, context: stringAt(recordAt(step, 'with'), 'context') });
            }
        }
        for (const { jobName, file, context } of builds) {
            if (!exists(file)) {
                fail(
                    buildWorkflow,
                    `job \`${jobName}\` builds \`${file}\`, which does not exist`,
                    'The build fails on the first push to main. Fix the path or drop the job.',
                );
            }
            if (context !== buildContext) {
                fail(
                    buildWorkflow,
                    `job \`${jobName}\` builds with context \`${context}\``,
                    `Must be \`${buildContext}\`: the lockfile and every workspace an image depends on live there, and a narrower context cannot see them.`,
                );
            }
        }
        const unbuilt = build === null ? [] : dockerfiles.filter(({ rel }) => !builds.some((b) => b.file === rel));
        for (const { rel } of unbuilt) {
            fail(
                rel,
                `no job in ${path.basename(buildWorkflow)} builds it`,
                'Nothing verifies it parses, let alone that it produces a working image. It will rot until the day it is needed.',
            );
        }
        for (const value of Object.values(recordAt(build, 'env'))) {
            if (typeof value === 'string' && value.includes('/')) pushed.add(value.split('/').pop());
        }
    }

    // ── 15. EXPOSE agrees with the k8s containerPort ────────────────────────
    if (deployments !== undefined) {
        for (const { rel, stages } of dockerfiles) {
            const manifest = deployments[rel];
            if (manifest === undefined) {
                fail(
                    rel,
                    'is not mapped to a k8s deployment',
                    'Add it to `deployments`, or the port drift this rule exists to catch goes unchecked for this image.',
                );
                continue;
            }
            if (!exists(manifest)) {
                fail(
                    rel,
                    `maps to ${manifest}, which does not exist`,
                    'The mapping is stale. Point it at the manifest that deploys this image.',
                );
                continue;
            }
            const last = stages.at(-1);
            const exposed = new Set(
                (last === undefined ? [] : chainOf(stages, last))
                    .flatMap((s) => s.instructions)
                    .filter((i) => i.instruction === 'EXPOSE')
                    .flatMap((i) => i.args.split(/\s+/).map((p) => Number.parseInt(p, 10))),
            );
            const unexposed = containerPorts(yamlDocuments(manifest) ?? []).filter((port) => !exposed.has(port));
            for (const port of unexposed) {
                fail(
                    rel,
                    `${manifest} declares containerPort ${port}, which this image does not EXPOSE (${exposed.size > 0 ? [...exposed].join(', ') : 'nothing'})`,
                    'Two files describing one port, and only a failed rollout to tell you they disagree. EXPOSE is documentation, which is exactly why it drifts.',
                );
            }
        }
    }

    // ── 16. The kustomization names images the build pushes ─────────────────
    if (kustomization !== undefined) {
        if (!exists(kustomization)) {
            fail(
                kustomization,
                'missing',
                'Nothing deploys the images these Dockerfiles build. Did the directory move?',
            );
        } else {
            const [doc] = yamlDocuments(kustomization) ?? [null];
            const images = listAt(doc, 'images').map((entry) => ({
                name: stringAt(entry, 'name'),
                newName: stringAt(entry, 'newName'),
                newTag: stringAt(entry, 'newTag'),
            }));
            const published = [...pushed].filter((name) => name !== undefined).sort();
            const built = { pushed, published, workflow: path.basename(buildWorkflow) };
            for (const entry of images) problems.push(...imageProblems(kustomization, entry, built));
        }
    }

    // ── 17. The images that need glibc stay on it ───────────────────────────
    for (const { file, why } of glibc) {
        const image = dockerfiles.find((d) => d.rel === file);
        if (image === undefined) {
            fail(
                file,
                'missing',
                'It is listed in `glibc`, so this rule is unenforced until the entry names the image again.',
            );
            continue;
        }
        for (const stage of image.stages) {
            if (stage.base.includes('alpine')) {
                fail(
                    file,
                    `line ${stage.from}: FROM ${stage.base} is musl-based`,
                    `${why} Use a glibc base such as node:*-slim.`,
                );
            }
        }
    }

    return {
        problems,
        counts: {
            images: dockerfiles.length,
            stages: dockerfiles.reduce((n, d) => n + d.stages.length, 0),
            nodeMajor: enginesMajor,
        },
    };
}

export function checkDocker(options: DockerOptions): void {
    const report = createGateReport({ name: 'Docker' });
    const { problems, counts } = inspectDocker(options);

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Docker OK — ${plural(counts.images, 'image')} across ${plural(counts.stages, 'stage')}, all multi-stage, non-root, ` +
            `health-checked against the running process, on Node ${counts.nodeMajor ?? '?'} in lockstep with engines.node, ` +
            `no secrets in a layer, installs without lifecycle scripts and after the manifests, ` +
            `${plural(REQUIRED_IGNORES.length, '.dockerignore entry', '.dockerignore entries')} present, every image built by a workflow.`,
        notMachineChecked:
            "Whether a layer is ordered as cheaply as it could be, whether the base image is the right one for the workload, or whether an image is as small as it should be. `docker build --check` runs BuildKit's own linter over each image where a Docker daemon exists.",
    });
}

/** What is wrong with one stage: its base's tag, each instruction, and its install order. */
function stageProblems(rel: string, stages: Stage[], stage: Stage): GateFailure[] {
    const { problems, fail } = collectFailures();
    // ── 4. Base images pinned by tag ────────────────────────────────
    if (parentOf(stages, stage) === undefined && stage.base !== 'scratch' && !stage.base.includes('@sha256:')) {
        const lastColon = stage.base.lastIndexOf(':');
        const tag = lastColon > stage.base.lastIndexOf('/') ? stage.base.slice(lastColon + 1) : null;
        if (tag === null) {
            fail(
                rel,
                `line ${stage.from}: FROM ${stage.base} has no tag`,
                'An untagged reference means `:latest`, which is whatever the registry happened to point at. Pin the tag.',
            );
        } else if (tag === 'latest') {
            fail(
                rel,
                `line ${stage.from}: FROM ${stage.base}`,
                '`:latest` moves under you. Two builds of the same commit can produce different images, and nothing records which one production got.',
            );
        }
    }

    problems.push(...stage.instructions.flatMap((ins) => instructionProblems(rel, ins)));

    // ── 11. Manifests before sources ────────────────────────────────
    const installAt = stage.instructions.findIndex(
        (i) => i.instruction === 'RUN' && /\bnpm\s+(ci|install)\b/.test(i.args),
    );
    if (installAt !== -1) {
        const copies = stage.instructions.slice(0, installAt).filter((i) => i.instruction === 'COPY');
        const wholeContext = copies.find((i) => /^(--\S+\s+)*\.[\s/]/.test(i.args));
        if (wholeContext !== undefined) {
            fail(
                rel,
                `line ${wholeContext.line}: \`COPY ${wholeContext.args}\` copies the whole context before \`npm ci\``,
                'The install layer is then invalidated by every source edit, so a one-line change reinstalls every dependency. Copy package.json and package-lock.json first, install, then copy sources.',
            );
        }
        if (!copies.some((i) => /package(\.json|\*)/.test(i.args))) {
            fail(
                rel,
                `stage \`${stage.name ?? '?'}\` runs npm ci with no package.json copied first`,
                'Either the manifests arrive with a broad copy — which defeats layer caching — or this install is not reproducible.',
            );
        }
    }
    return problems;
}

/** What is wrong with one instruction, on its own. */
function instructionProblems(rel: string, ins: Instruction): GateFailure[] {
    const { problems, fail } = collectFailures();
    // ── 5. Package lists cleaned in the same RUN ────────────────
    if (ins.instruction === 'RUN') {
        if (/apt-get\s+install/.test(ins.args) && !/rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(ins.args)) {
            fail(
                rel,
                `line ${ins.line}: apt-get install without \`rm -rf /var/lib/apt/lists/*\` in the same RUN`,
                'A layer can only add, so deleting the lists in a later instruction leaves ~40 MB in the image and merely hides it from `ls`. Chain the removal onto this RUN with &&.',
            );
        }
        if (
            /apk\s+add/.test(ins.args) &&
            !ins.args.includes('--no-cache') &&
            !/rm\s+-rf\s+\/var\/cache\/apk/.test(ins.args)
        ) {
            fail(
                rel,
                `line ${ins.line}: apk add without --no-cache`,
                'Same layer problem as apt lists. `--no-cache` is the one-word fix and needs no cleanup step.',
            );
        }
        // ── 14. --ignore-scripts on every install ───────────────
        if (/\bnpm\s+(ci|install|i)\b/.test(ins.args) && !/--ignore-scripts\b/.test(ins.args)) {
            fail(
                rel,
                `line ${ins.line}: npm install without --ignore-scripts`,
                'Lifecycle scripts are arbitrary code from every transitive dependency, run with the build’s filesystem and network. It also stops `prepare` installing husky into an image with no .git.',
            );
        }
    }

    // ── 6. Exec form, and not via a package manager ─────────────
    if (ins.instruction === 'CMD' || ins.instruction === 'ENTRYPOINT') {
        if (!ins.args.startsWith('[')) {
            fail(
                rel,
                `line ${ins.line}: ${ins.instruction} ${ins.args} is shell form`,
                'Shell form runs the process under `/bin/sh -c`, which becomes PID 1 and does not forward SIGTERM to its child. Every rollout then waits out the full grace period and SIGKILLs the process mid-job. Use exec form: ["node", "dist/index.js"].',
            );
        } else if (/^\[\s*"(npm|npx|yarn|pnpm)"/.test(ins.args)) {
            fail(
                rel,
                `line ${ins.line}: ${ins.instruction} ${ins.args} makes a package manager PID 1`,
                'It does not forward SIGTERM either — the same slow rollout and killed job as shell form. Run node directly: ["node", "dist/index.js"].',
            );
        }
    }

    // ── 7. COPY, not ADD ────────────────────────────────────────
    if (ins.instruction === 'ADD') {
        fail(
            rel,
            `line ${ins.line}: ADD ${ins.args}`,
            'ADD auto-extracts local archives and fetches remote URLs — the two behaviours that distinguish it from COPY are the two nobody wants implicitly. Use COPY, and a RUN for anything else.',
        );
    }

    // ── 8. No secrets in a layer ────────────────────────────────
    if (ins.instruction === 'ENV' || ins.instruction === 'ARG') {
        for (const [name, value] of assignments(ins.args)) {
            if (SECRET_NAME.test(name) && value !== '' && !value.startsWith('$')) {
                fail(
                    rel,
                    `line ${ins.line}: ${ins.instruction} ${name}=… bakes a secret into a layer`,
                    'Anyone who can pull the image can read it, and deleting it in a later layer does not remove it. Pass it at runtime (`docker run -e`, a k8s Secret), or use a BuildKit `--mount=type=secret` for build-time-only values.',
                );
            }
        }
    }

    return problems;
}

/** Every `containerPort` the pod templates in these manifests declare, once each. */
function containerPorts(docs: unknown[]): number[] {
    const containers = docs.flatMap((doc) =>
        listAt(recordAt(recordAt(recordAt(doc, 'spec'), 'template'), 'spec'), 'containers'),
    );
    const ports = containers.flatMap((container) =>
        listAt(container, 'ports').map((port) => toRecord(port)['containerPort']),
    );
    return [...new Set(ports.filter((port) => typeof port === 'number'))];
}

/** What is wrong with one `images:` entry of the kustomization, given what the build workflow pushes. */
function imageProblems(
    file: string,
    entry: { name: string | undefined; newName: string | undefined; newTag: string | undefined },
    built: { pushed: Set<string | undefined>; published: string[]; workflow: string },
): GateFailure[] {
    const { problems, fail } = collectFailures();
    if (entry.newName === undefined || entry.newName === '') return [];
    if (!built.pushed.has(entry.newName.split('/').pop())) {
        fail(
            file,
            `points \`${entry.name ?? '?'}\` at \`${entry.newName}\`, which ${built.workflow} does not push`,
            `It publishes: ${built.published.length > 0 ? built.published.join(', ') : 'nothing'}. Naming anything else pulls a tag that was never built — ImagePullBackOff on the cluster, and nothing red anywhere before that.`,
        );
    }
    if (/\byour-org\b|\bexample\b|<[^>]+>/.test(entry.newName)) {
        fail(
            file,
            `\`${entry.newName}\` still contains a placeholder`,
            'A manifest that cannot resolve is not a template, it is a broken deploy waiting for whoever applies it by hand. Put the real registry path in.',
        );
    }
    if (entry.newTag !== undefined && MUTABLE_TAG.test(entry.newTag)) {
        fail(
            file,
            `pins \`${entry.name ?? '?'}\` to the mutable tag \`${entry.newTag}\``,
            'Every deploy must be traceable to the commit CI validated, and a rollback needs an earlier tag to name — a floating tag gives you neither. Leave an unresolvable placeholder (SET_BY_CI) for `kustomize edit set image` to replace with the SHA.',
        );
    }
    return problems;
}
