/**
 * The docker gate, against a minimal fixture repository that passes and a
 * negative for every rule: each test breaks exactly one thing.
 *
 * The parser tests at the end are the ones worth reading first. Each is a
 * Dockerfile shape the original repo never used, so the copy could not have
 * shown it getting them wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkDocker, inspectDocker } from '../src/gates/docker.ts';

const API = `# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY api/package.json api/
RUN npm ci --ignore-scripts

FROM deps AS builder
COPY api/tsconfig.json api/
COPY api/src api/src/
RUN npm run build --workspace=api

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=builder /repo/api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s \\
    CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
`;

const FRONTEND = `FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ frontend/
RUN npm run build --workspace=frontend

# Not nginx:alpine — that image's master process is root.
FROM nginxinc/nginx-unprivileged:alpine AS serve
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
`;

const DOCKERIGNORE = `**/node_modules
**/dist
.git
.env
.env.*
!.env.example
**/coverage
**/__tests__
**/*.test.ts
*.log
`;

const BUILD = `name: Build
on:
  push:
    branches: [main]
env:
  API_IMAGE: ghcr.io/acme/app-api
  FRONTEND_IMAGE: ghcr.io/acme/app-frontend
jobs:
  api:
    runs-on: ubuntu-24.04
    steps:
      - uses: docker/build-push-action@${'a'.repeat(40)}
        with:
          context: .
          file: docker/api.Dockerfile
  frontend:
    runs-on: ubuntu-24.04
    steps:
      - uses: docker/build-push-action@${'a'.repeat(40)}
        with:
          context: .
          file: docker/frontend.Dockerfile
`;

const deployment = (port) => `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          ports:
            - containerPort: ${port}
`;

const KUSTOMIZATION = `images:
  - name: app-api
    newName: ghcr.io/acme/app-api
    newTag: SET_BY_CI
  - name: app-frontend
    newName: ghcr.io/acme/app-frontend
`;

const WORKER = `FROM node:24-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-slim AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:9091/livez').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "dist/index.js"]
`;

const FILES = {
    'docker/api.Dockerfile': API,
    'docker/frontend.Dockerfile': FRONTEND,
    '.dockerignore': DOCKERIGNORE,
    'package.json': JSON.stringify({ name: 'app', engines: { node: '>=24' } }),
    '.github/workflows/build.yml': BUILD,
    'k8s/api/deployment.yaml': deployment(3001),
    'k8s/frontend/deployment.yaml': deployment(8080),
    'k8s/kustomization.yaml': KUSTOMIZATION,
};

const OPTIONS = {
    deployments: {
        'docker/api.Dockerfile': 'k8s/api/deployment.yaml',
        'docker/frontend.Dockerfile': 'k8s/frontend/deployment.yaml',
    },
    kustomization: 'k8s/kustomization.yaml',
};

/** A repository that passes, with `files` merged over it; null deletes one. */
function tree(t, files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-docker-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries({ ...FILES, ...files })) {
        if (body === null) continue;
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return root;
}

const run = (root, options = {}) => inspectDocker({ root, ...OPTIONS, ...options });
const whats = (root, options) => run(root, options).problems.map((p) => p.what);
const whys = (root, options) => run(root, options).problems.map((p) => p.why);

/** The api Dockerfile with one string replaced, asserting the fixture contained it. */
const api = (from, to) => {
    assert.ok(API.includes(from), `fixture does not contain: ${from}`);
    return { 'docker/api.Dockerfile': API.replace(from, to) };
};

const has = (list, pattern) =>
    list.some((item) => (typeof pattern === 'string' ? item === pattern : pattern.test(item)));

// ── The baseline ─────────────────────────────────────────────────────────────

test('a repository that satisfies every rule passes', (t) => {
    assert.deepEqual(whats(tree(t)), []);
});

test('the counts name the images, the stages and the Node major', (t) => {
    assert.deepEqual(run(tree(t)).counts, { images: 2, stages: 6, nodeMajor: '24' });
});

test('an empty docker directory is reported rather than passing vacuously', (t) => {
    const root = tree(t, { 'docker/api.Dockerfile': null, 'docker/frontend.Dockerfile': null });
    assert.ok(has(whats(root), 'no Dockerfile found'));
});

test('a missing docker directory is reported rather than crashing', (t) => {
    assert.ok(has(whats(tree(t), { dockerDir: 'images' }), 'no Dockerfile found'));
});

test('a plain `Dockerfile` is read as well as `*.Dockerfile`', (t) => {
    const root = tree(t, { 'docker/Dockerfile': 'FROM node:24-alpine\nCMD ["node", "x.js"]\n' });
    assert.ok(has(whats(root), /^single-stage build/));
});

// ── 1. Multi-stage ───────────────────────────────────────────────────────────

test('1. a single-stage image is reported', (t) => {
    const root = tree(t, { 'docker/api.Dockerfile': 'FROM node:24-alpine\nUSER node\nCMD ["node", "x.js"]\n' });
    assert.ok(has(whats(root), 'single-stage build (1 FROM)'));
});

// ── 2. Non-root ──────────────────────────────────────────────────────────────

test('2. a final stage with no USER is reported', (t) => {
    assert.ok(
        has(whats(tree(t, api('USER node\n', ''))), /^final stage \(runtime, FROM node:24-alpine\) declares no USER/),
    );
});

test('2. USER root is reported', (t) => {
    assert.ok(has(whats(tree(t, api('USER node', 'USER root'))), 'final stage runs as `USER root`'));
});

test('2. USER 0 is reported as root', (t) => {
    assert.ok(has(whats(tree(t, api('USER node', 'USER 0:0'))), 'final stage runs as `USER 0:0`'));
});

test('2. a USER set in an earlier stage does not reach a final stage on a fresh base', (t) => {
    // `runtime` is FROM node:24-alpine, not FROM prod-deps, so it inherits nothing.
    const moved = API.replace('USER node\n', '').replace(
        'RUN npm prune --omit=dev',
        'RUN npm prune --omit=dev\nUSER node',
    );
    assert.ok(has(whats(tree(t, { 'docker/api.Dockerfile': moved })), /declares no USER/));
});

test('2. stock nginx with no USER is reported — its master process is root', (t) => {
    const root = tree(t, {
        'docker/frontend.Dockerfile': FRONTEND.replace('nginxinc/nginx-unprivileged:alpine', 'nginx:1.27-alpine'),
    });
    assert.ok(has(whats(root), /FROM nginx:1\.27-alpine\) declares no USER/));
});

test('2. a base named in nonrootBases needs no USER', (t) => {
    const root = tree(t, {
        'docker/frontend.Dockerfile': FRONTEND.replace(
            'nginxinc/nginx-unprivileged:alpine',
            'cgr.dev/chainguard/nginx:1.27',
        ),
    });
    assert.ok(has(whats(root), /declares no USER/));
    assert.deepEqual(whats(root, { nonrootBases: ['^cgr\\.dev/chainguard/'] }), []);
});

// ── 3. HEALTHCHECK ───────────────────────────────────────────────────────────

const HEALTH = `HEALTHCHECK --interval=30s --timeout=5s \\
    CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`;

test('3. a final stage with no HEALTHCHECK is reported', (t) => {
    assert.ok(has(whats(tree(t, api(HEALTH, ''))), 'final stage has no HEALTHCHECK'));
});

test('3. HEALTHCHECK NONE is reported, not counted as having one', (t) => {
    assert.ok(has(whats(tree(t, api(HEALTH, 'HEALTHCHECK NONE'))), /HEALTHCHECK NONE$/));
});

test('3. a HEALTHCHECK that only looks for a process is reported', (t) => {
    const root = tree(t, api(HEALTH, 'HEALTHCHECK CMD pgrep -f "node dist/index.js" || exit 1'));
    assert.ok(has(whats(root), /only proves a process exists/));
});

test('3. a HEALTHCHECK that starts a fresh node process is reported', (t) => {
    const root = tree(t, api(HEALTH, 'HEALTHCHECK CMD node -e "process.exit(0)"'));
    assert.ok(has(whats(root), /does not ask the running process anything/));
    assert.ok(has(whys(root), /FRESH process, which always exits 0/));
});

test('3. curl against the process is a real healthcheck', (t) => {
    assert.deepEqual(
        whats(tree(t, api(HEALTH, 'HEALTHCHECK CMD curl -fsS http://127.0.0.1:3001/livez || exit 1'))),
        [],
    );
});

// ── 4. Tags ──────────────────────────────────────────────────────────────────

test('4. an untagged base is reported', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS deps', 'FROM node AS deps'));
    assert.ok(has(whats(root), /FROM node has no tag$/));
});

test('4. :latest is reported', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS deps', 'FROM node:latest AS deps'));
    assert.ok(has(whats(root), /FROM node:latest$/));
});

test('4. a registry port is not mistaken for a tag', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS deps', 'FROM registry.local:5000/node AS deps'));
    assert.ok(has(whats(root), /FROM registry\.local:5000\/node has no tag$/));
});

test('4. a digest pin passes', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS deps', `FROM node:24-alpine@sha256:${'b'.repeat(64)} AS deps`));
    assert.deepEqual(whats(root), []);
});

test('4. FROM scratch is not an untagged image', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': API.replace(
            'FROM deps AS prod-deps\nRUN npm prune --omit=dev',
            'FROM scratch AS empty\nCOPY x /x\n\nFROM deps AS prod-deps\nRUN npm prune --omit=dev',
        ),
    });
    assert.deepEqual(whats(root), []);
});

test('4. a stage built FROM an earlier stage is not graded as an image', (t) => {
    assert.ok(!has(whats(tree(t)), /FROM deps/));
});

// ── 5. Package lists ─────────────────────────────────────────────────────────

test('5. apt-get install with the lists removed in a later RUN is reported', (t) => {
    const root = tree(
        t,
        api(
            'WORKDIR /app\n',
            'WORKDIR /app\nRUN apt-get update && apt-get install -y ffmpeg\nRUN rm -rf /var/lib/apt/lists/*\n',
        ),
    );
    assert.ok(has(whats(root), /apt-get install without `rm -rf \/var\/lib\/apt\/lists\/\*` in the same RUN/));
});

test('5. apt-get install cleaned in the same RUN passes', (t) => {
    const root = tree(
        t,
        api(
            'WORKDIR /app\n',
            'WORKDIR /app\nRUN apt-get update && apt-get install -y ffmpeg \\\n    && rm -rf /var/lib/apt/lists/*\n',
        ),
    );
    assert.deepEqual(whats(root), []);
});

test('5. apk add without --no-cache is reported', (t) => {
    assert.ok(
        has(whats(tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nRUN apk add ffmpeg\n'))), /apk add without --no-cache/),
    );
});

test('5. apk add --no-cache passes', (t) => {
    assert.deepEqual(whats(tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nRUN apk add --no-cache ffmpeg\n'))), []);
});

// ── 6. Exec form ─────────────────────────────────────────────────────────────

test('6. a shell-form CMD is reported', (t) => {
    assert.ok(
        has(
            whats(tree(t, api('CMD ["node", "dist/index.js"]', 'CMD node dist/index.js'))),
            /CMD node dist\/index\.js is shell form/,
        ),
    );
});

test('6. a shell-form ENTRYPOINT is reported', (t) => {
    const root = tree(t, api('CMD ["node", "dist/index.js"]', 'ENTRYPOINT node dist/index.js'));
    assert.ok(has(whats(root), /ENTRYPOINT node dist\/index\.js is shell form/));
});

test('6. npm as PID 1 is reported, although it is exec form', (t) => {
    const root = tree(t, api('CMD ["node", "dist/index.js"]', 'CMD ["npm", "start"]'));
    assert.ok(has(whats(root), /makes a package manager PID 1/));
    assert.ok(has(whys(root), /does not forward SIGTERM either/));
});

test('6. yarn and pnpm are package managers too', (t) => {
    for (const pm of ['yarn', 'pnpm']) {
        const root = tree(t, api('CMD ["node", "dist/index.js"]', `CMD ["${pm}", "start"]`));
        assert.ok(has(whats(root), /makes a package manager PID 1/), pm);
    }
});

// ── 7. ADD ───────────────────────────────────────────────────────────────────

test('7. ADD is reported', (t) => {
    assert.ok(
        has(whats(tree(t, api('COPY api/src api/src/', 'ADD api/src api/src/'))), 'line 10: ADD api/src api/src/'),
    );
});

// ── 8. Secrets ───────────────────────────────────────────────────────────────

test('8. ENV with a secret value is reported', (t) => {
    const root = tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV=production JWT_SECRET=supersecret123'));
    assert.ok(has(whats(root), /ENV JWT_SECRET=… bakes a secret into a layer/));
});

test('8. an ARG with a secret default is reported', (t) => {
    const root = tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nARG NPM_TOKEN=abc123\n'));
    assert.ok(has(whats(root), /ARG NPM_TOKEN=… bakes a secret into a layer/));
});

test('8. an ARG with no default, filled at build time, is not a baked secret', (t) => {
    assert.deepEqual(whats(tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nARG NPM_TOKEN\n'))), []);
});

test('8. a secret name set from another variable is not a literal', (t) => {
    assert.deepEqual(
        whats(tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nARG API_KEY_FILE\nENV API_KEY_PATH=${API_KEY_FILE}\n'))),
        [],
    );
});

test('8. a quoted secret value is reported', (t) => {
    const root = tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV=production DB_PASSWORD="hunter two"'));
    assert.ok(has(whats(root), /ENV DB_PASSWORD=… bakes a secret/));
});

// ── 9. Node major ────────────────────────────────────────────────────────────

test('9. a node base on another major is reported', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS runtime', 'FROM node:20-alpine AS runtime'));
    assert.ok(has(whats(root), 'line 16: FROM node:20-alpine, but engines.node is ">=24"'));
});

test('9. the fully qualified node image is still a node base', (t) => {
    const root = tree(t, api('FROM node:24-alpine AS runtime', 'FROM docker.io/library/node:22-alpine AS runtime'));
    assert.ok(has(whats(root), /FROM docker\.io\/library\/node:22-alpine, but engines\.node/));
});

test('9. an absent engines.node is reported', (t) => {
    assert.ok(has(whats(tree(t, { 'package.json': '{"name":"app"}' })), 'engines.node is absent'));
});

test('9. an engines.node with no number in it is reported', (t) => {
    assert.ok(has(whats(tree(t, { 'package.json': '{"engines":{"node":"lts"}}' })), 'engines.node is "lts"'));
});

test('9. the CI node-version is not graded here — the pipeline gate owns it', (t) => {
    const root = tree(t, {
        '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - with:\n          node-version: 20\n',
    });
    assert.deepEqual(whats(root), []);
});

// ── 10. .dockerignore ────────────────────────────────────────────────────────

test('10. a missing .dockerignore is reported', (t) => {
    assert.ok(has(whats(tree(t, { '.dockerignore': null })), 'missing'));
});

test('10. each required entry is reported by name when absent', (t) => {
    const root = tree(t, { '.dockerignore': DOCKERIGNORE.replace('.env\n', '') });
    assert.deepEqual(whats(root), ['no entry ignoring .env']);
    assert.ok(has(whys(root), /secrets, baked into a layer/));
});

test('10. either spelling of an entry satisfies it', (t) => {
    const root = tree(t, { '.dockerignore': DOCKERIGNORE.replace('.git\n', '**/.git\n') });
    assert.deepEqual(whats(root), []);
});

test('10. a commented-out entry does not count', (t) => {
    const root = tree(t, { '.dockerignore': DOCKERIGNORE.replace('*.log\n', '# *.log\n') });
    assert.deepEqual(whats(root), ['no entry ignoring *.log']);
});

test('10. an entry re-included by a later `!` line does not count', (t) => {
    const root = tree(t, { '.dockerignore': `${DOCKERIGNORE}!.env\n` });
    assert.deepEqual(whats(root), ['`!.env` re-includes .env']);
});

test('10. excluding it again after a re-include counts, because the last line wins', (t) => {
    assert.deepEqual(whats(tree(t, { '.dockerignore': `${DOCKERIGNORE}!.env\n**/.env\n` })), []);
});

test('10. a negation of a DIFFERENT file does not undo an entry', (t) => {
    // `!.env.example` sits right under `.env.*` in the fixture already.
    assert.deepEqual(whats(tree(t)), []);
});

// ── 11. Manifests before sources ─────────────────────────────────────────────

test('11. COPY . . before npm ci is reported', (t) => {
    const root = tree(t, api('COPY package.json package-lock.json ./', 'COPY . .'));
    assert.ok(has(whats(root), /`COPY \. \.` copies the whole context before `npm ci`/));
});

test('11. COPY with a flag and ./ is still the whole context', (t) => {
    const root = tree(
        t,
        api(
            'COPY package.json package-lock.json ./',
            'COPY package.json package-lock.json ./\nCOPY --chown=node:node ./ ./',
        ),
    );
    assert.ok(has(whats(root), /copies the whole context before `npm ci`/));
});

test('11. an install with no manifest copied first is reported', (t) => {
    const root = tree(t, api('COPY package.json package-lock.json ./\nCOPY api/package.json api/\n', ''));
    assert.ok(has(whats(root), 'stage `deps` runs npm ci with no package.json copied first'));
});

test('11. COPY package*.json counts as copying the manifests', (t) => {
    // Both manifest lines go, so nothing else in the stage says `package.json`.
    const root = tree(
        t,
        api('COPY package.json package-lock.json ./\nCOPY api/package.json api/', 'COPY package*.json ./'),
    );
    assert.deepEqual(whats(root), []);
});

test('11. copying sources AFTER the install is fine', (t) => {
    assert.deepEqual(whats(tree(t)), []);
});

// ── 12. NODE_ENV ─────────────────────────────────────────────────────────────

test('12. a Node runtime stage without NODE_ENV=production is reported', (t) => {
    assert.ok(
        has(whats(tree(t, api('ENV NODE_ENV=production\n', ''))), 'final stage does not set NODE_ENV=production'),
    );
});

test('12. NODE_ENV=development is reported', (t) => {
    const root = tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV=development'));
    assert.ok(has(whats(root), 'final stage does not set NODE_ENV=production'));
});

test('12. a later NODE_ENV overrides an earlier one', (t) => {
    const root = tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV NODE_ENV=test'));
    assert.ok(has(whats(root), 'final stage does not set NODE_ENV=production'));
});

test('12. the quoted and legacy spellings both count', (t) => {
    assert.deepEqual(whats(tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV="production"'))), []);
    assert.deepEqual(whats(tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV production'))), []);
});

test('12. a non-Node runtime is not graded on NODE_ENV', (t) => {
    // The frontend's final stage is nginx and sets no NODE_ENV.
    assert.deepEqual(whats(tree(t)), []);
});

// ── 13. Built by a workflow ──────────────────────────────────────────────────

test('13. a missing build workflow is reported', (t) => {
    assert.ok(has(whats(tree(t, { '.github/workflows/build.yml': null })), 'missing'));
});

test('13. a Dockerfile no job builds is reported', (t) => {
    const root = tree(t, { 'docker/worker.Dockerfile': WORKER });
    assert.ok(has(whats(root, { deployments: undefined }), 'no job in build.yml builds it'));
});

test('13. a job building a file that does not exist is reported', (t) => {
    const root = tree(t, {
        '.github/workflows/build.yml': BUILD.replace('file: docker/api.Dockerfile', 'file: docker/api-v2.Dockerfile'),
    });
    assert.ok(has(whats(root), 'job `api` builds `docker/api-v2.Dockerfile`, which does not exist'));
});

test('13. a build context other than the configured one is reported', (t) => {
    const root = tree(t, {
        '.github/workflows/build.yml': BUILD.replace(
            'context: .\n          file: docker/api',
            'context: api\n          file: docker/api',
        ),
    });
    assert.ok(has(whats(root), 'job `api` builds with context `api`'));
});

test('13. the context is an option', (t) => {
    const root = tree(t, { '.github/workflows/build.yml': BUILD.replaceAll('context: .', 'context: ./services') });
    assert.deepEqual(whats(root, { buildContext: './services' }), []);
});

test('13. a malformed build workflow is reported rather than crashing the gate', (t) => {
    const root = tree(t, { '.github/workflows/build.yml': `${BUILD}\n  bad: [unclosed\n` });
    const found = whats(root);
    assert.ok(has(found, /^is not valid YAML/));
    assert.ok(!has(found, /no job in build\.yml builds it/), 'a file it could not read is not evidence of anything');
});

// ── 14. --ignore-scripts ─────────────────────────────────────────────────────

test('14. npm ci without --ignore-scripts is reported', (t) => {
    const root = tree(t, api('RUN npm ci --ignore-scripts', 'RUN npm ci'));
    assert.ok(has(whats(root), 'line 6: npm install without --ignore-scripts'));
    assert.ok(has(whys(root), /arbitrary code from every transitive dependency/));
});

test('14. npm install counts as an install too', (t) => {
    assert.ok(
        has(
            whats(tree(t, api('RUN npm ci --ignore-scripts', 'RUN npm install'))),
            /npm install without --ignore-scripts/,
        ),
    );
});

test('14. npm prune and npm run are not installs', (t) => {
    assert.deepEqual(whats(tree(t)), []);
});

// ── 15. EXPOSE vs containerPort ──────────────────────────────────────────────

test('15. a containerPort the image does not EXPOSE is reported', (t) => {
    const root = tree(t, { 'k8s/api/deployment.yaml': deployment(3002) });
    assert.ok(
        has(
            whats(root),
            'k8s/api/deployment.yaml declares containerPort 3002, which this image does not EXPOSE (3001)',
        ),
    );
});

test('15. an image with no EXPOSE says so', (t) => {
    const root = tree(t, api('EXPOSE 3001\n', ''));
    assert.ok(has(whats(root), /does not EXPOSE \(nothing\)$/));
});

test('15. an unmapped Dockerfile is reported', (t) => {
    const root = tree(t, {
        'docker/worker.Dockerfile': WORKER,
        '.github/workflows/build.yml': `${BUILD}      - uses: docker/build-push-action@x\n        with:\n          context: .\n          file: docker/worker.Dockerfile\n`,
    });
    assert.ok(has(whats(root), 'is not mapped to a k8s deployment'));
});

test('15. a mapping to a manifest that does not exist is reported', (t) => {
    assert.ok(
        has(
            whats(tree(t, { 'k8s/api/deployment.yaml': null })),
            'maps to k8s/api/deployment.yaml, which does not exist',
        ),
    );
});

test('15. a malformed manifest is reported, not skipped in silence', (t) => {
    const root = tree(t, { 'k8s/api/deployment.yaml': `${deployment(3002)}  bad: [unclosed\n` });
    assert.ok(has(whats(root), /^is not valid YAML/));
});

test('15. without `deployments` the ports are not compared', (t) => {
    assert.deepEqual(whats(tree(t, { 'k8s/api/deployment.yaml': deployment(9999) }), { deployments: undefined }), []);
});

// ── 16. Kustomization ────────────────────────────────────────────────────────

test('16. an image the build does not push is reported', (t) => {
    const root = tree(t, {
        'k8s/kustomization.yaml': KUSTOMIZATION.replace('ghcr.io/acme/app-api', 'ghcr.io/acme/app-backend'),
    });
    assert.ok(has(whats(root), 'points `app-api` at `ghcr.io/acme/app-backend`, which build.yml does not push'));
});

test('16. a placeholder registry path is reported', (t) => {
    const root = tree(t, {
        'k8s/kustomization.yaml': KUSTOMIZATION.replace('ghcr.io/acme/app-api', 'ghcr.io/your-org/app-api'),
    });
    assert.ok(has(whats(root), '`ghcr.io/your-org/app-api` still contains a placeholder'));
});

test('16. a floating tag is reported', (t) => {
    const root = tree(t, { 'k8s/kustomization.yaml': KUSTOMIZATION.replace('SET_BY_CI', 'latest') });
    assert.ok(has(whats(root), 'pins `app-api` to the mutable tag `latest`'));
});

test('16. a missing kustomization is reported when one is configured', (t) => {
    assert.ok(has(whats(tree(t, { 'k8s/kustomization.yaml': null })), 'missing'));
});

test('16. without `kustomization` it is not checked', (t) => {
    assert.deepEqual(whats(tree(t, { 'k8s/kustomization.yaml': null }), { kustomization: undefined }), []);
});

// ── 17. glibc ────────────────────────────────────────────────────────────────

const GLIBC = [{ file: 'docker/worker.Dockerfile', why: 'onnxruntime-node ships glibc binaries.' }];
const WITH_WORKER = {
    'docker/worker.Dockerfile': WORKER,
    '.github/workflows/build.yml': `${BUILD}  worker:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: docker/build-push-action@x\n        with:\n          context: .\n          file: docker/worker.Dockerfile\n`,
};

test('17. an image on glibc passes', (t) => {
    assert.deepEqual(whats(tree(t, WITH_WORKER), { glibc: GLIBC, deployments: undefined }), []);
});

test('17. moving a glibc image to alpine is reported with the given reason', (t) => {
    const root = tree(t, {
        ...WITH_WORKER,
        'docker/worker.Dockerfile': WORKER.replaceAll('node:24-slim', 'node:24-alpine'),
    });
    const found = run(root, { glibc: GLIBC, deployments: undefined }).problems;
    assert.ok(
        found.some(
            (p) =>
                /FROM node:24-alpine is musl-based/.test(p.what) &&
                /onnxruntime-node ships glibc binaries\./.test(p.why),
        ),
    );
});

test('17. a listed image that no longer exists is reported', (t) => {
    assert.ok(has(whats(tree(t), { glibc: GLIBC }), 'missing'));
});

// ── What the move found the parser getting wrong ─────────────────────────────

test('parser: FROM --platform is read past the flag', (t) => {
    const root = tree(
        t,
        api('FROM node:24-alpine AS runtime', 'FROM --platform=$TARGETPLATFORM node:20-alpine AS runtime'),
    );
    const found = whats(root);
    assert.ok(has(found, /FROM node:20-alpine, but engines\.node/), 'the Node rule saw the real image');
    assert.ok(!has(found, /--platform/), 'the flag was not graded as an image');
});

test('parser: a global ARG default is substituted into FROM', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `ARG NODE_MAJOR=22\n${API.replaceAll('node:24-alpine', 'node:${NODE_MAJOR}-alpine')}`,
    });
    assert.ok(has(whats(root), /FROM node:22-alpine, but engines\.node/));
});

test('parser: the $NAME spelling of an ARG is substituted too', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `ARG BASE=node:20-alpine\n${API.replaceAll('node:24-alpine', '$BASE')}`,
    });
    assert.ok(has(whats(root), /FROM node:20-alpine, but engines\.node/));
});

test('parser: an ARG declared INSIDE a stage does not reach a later FROM', (t) => {
    // Docker scopes a stage's ARG to that stage; only ARGs above the first FROM
    // are visible to FROM lines.
    const root = tree(t, api('FROM node:24-alpine AS runtime', 'ARG TAG=20-alpine\nFROM node:${TAG} AS runtime'));
    assert.ok(!has(whats(root), /FROM node:20-alpine/));
});

test('parser: USER, HEALTHCHECK and ENV are inherited through FROM <stage>', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `FROM node:24-alpine AS base
ENV NODE_ENV=production
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1))"

FROM base AS runtime
EXPOSE 3001
CMD ["node", "dist/index.js"]
`,
    });
    assert.deepEqual(whats(root), []);
});

test('parser: a stage reference is matched case-insensitively, as Docker does', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `FROM node:24-alpine AS Base
ENV NODE_ENV=production
USER node
HEALTHCHECK CMD curl -f http://127.0.0.1:3001/livez

FROM base AS runtime
EXPOSE 3001
CMD ["node", "dist/index.js"]
`,
    });
    assert.deepEqual(whats(root), []);
});

test('parser: an inherited USER root is still root', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': API.replace(
            'FROM node:24-alpine AS runtime',
            'FROM node:24-alpine AS rooted\nUSER root\n\nFROM rooted AS runtime',
        ).replace('USER node\n', ''),
    });
    assert.ok(has(whats(root), 'final stage runs as `USER root`'));
});

test('parser: the legacy `ENV NAME value` form is read by the secrets rule', (t) => {
    const root = tree(t, api('ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV JWT_SECRET supersecret123'));
    assert.ok(has(whats(root), /ENV JWT_SECRET=… bakes a secret/));
});

test('parser: a comment inside a continued instruction is dropped, as Docker does', (t) => {
    const root = tree(
        t,
        api('RUN npm ci --ignore-scripts', 'RUN npm ci \\\n    # lifecycle scripts stay off\n    --ignore-scripts'),
    );
    assert.deepEqual(whats(root), []);
});

test('parser: a commented-out instruction is not read', (t) => {
    assert.deepEqual(whats(tree(t, api('USER node', 'USER node\n# USER root'))), []);
});

test('parser: a stage cannot be built FROM itself — the name is the image', (t) => {
    // `FROM node AS node` names the image `node`, untagged. Read as a reference
    // to the stage, the tag rule skipped it and the chain never ended.
    const root = tree(t, api('FROM node:24-alpine AS deps', 'FROM node AS node\n\nFROM node:24-alpine AS deps'));
    assert.ok(has(whats(root), /FROM node has no tag$/));
});

test('parser: only an EARLIER stage can be the base', (t) => {
    // `runtime` is declared after the stage that names it, so `FROM runtime`
    // here is the image `runtime`, which is untagged.
    const root = tree(t, api('FROM deps AS prod-deps', 'FROM runtime AS prod-deps'));
    assert.ok(has(whats(root), /FROM runtime has no tag$/));
});

test('parser: a final stage built FROM an unprivileged stage needs no USER', (t) => {
    const root = tree(t, {
        'docker/frontend.Dockerfile': FRONTEND.replace(
            'FROM nginxinc/nginx-unprivileged:alpine AS serve',
            'FROM nginxinc/nginx-unprivileged:alpine AS nginx-base\n\nFROM nginx-base AS serve',
        ),
    });
    assert.deepEqual(whats(root), []);
});

test('parser: a final stage built FROM a node stage is graded on NODE_ENV', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `FROM node:24-alpine AS base
USER node
HEALTHCHECK CMD curl -f http://127.0.0.1:3001/livez

FROM base AS runtime
EXPOSE 3001
CMD ["node", "dist/index.js"]
`,
    });
    assert.ok(has(whats(root), 'final stage does not set NODE_ENV=production'));
});

test('parser: an EXPOSE in a parent stage is in force in the final one', (t) => {
    const root = tree(t, {
        'docker/api.Dockerfile': `FROM node:24-alpine AS base
ENV NODE_ENV=production
USER node
EXPOSE 3001
HEALTHCHECK CMD curl -f http://127.0.0.1:3001/livez

FROM base AS runtime
CMD ["node", "dist/index.js"]
`,
    });
    assert.deepEqual(whats(root), []);
});

test('8. an empty value is not a baked secret', (t) => {
    assert.deepEqual(whats(tree(t, api('WORKDIR /app\n', 'WORKDIR /app\nARG NPM_TOKEN=""\n'))), []);
});

// ── The printing runner ──────────────────────────────────────────────────────

test('checkDocker prints the summary and sets no failing exit code on a clean tree', (t) => {
    const root = tree(t);
    const lines = [];
    const [log, exitCode] = [console.log, process.exitCode];
    console.log = (...a) => lines.push(a.join(' '));
    try {
        checkDocker({ root, ...OPTIONS });
        assert.notEqual(process.exitCode, 1);
    } finally {
        console.log = log;
        process.exitCode = exitCode;
    }
    assert.match(lines.join('\n'), /2 images across 6 stages/);
});
