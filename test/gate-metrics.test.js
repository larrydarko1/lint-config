import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectMetrics } from '../src/gates/metrics.ts';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

// ─── Fixtures: a chain that resolves end to end ──────────────────────────────

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: worker
  labels:
    app: worker
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/name: worker
  ports:
    - name: metrics
      port: 9100
      targetPort: 9100
`;

const MONITOR = `apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: worker
spec:
  selector:
    matchLabels:
      app: worker
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
`;

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: worker
    spec:
      containers:
        - name: worker
          ports:
            - name: metrics
              containerPort: 9100
          livenessProbe:
            httpGet:
              path: /livez
              port: 9100
`;

const POLICY = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: worker
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: worker
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9100
`;

const WORKER_INDEX = `import { startMetricsServer } from '@/lib/metrics.js';
import { initDb } from '@/lib/db.js';

startMetricsServer();
await initDb();
setInterval(() => {
    void emitMetrics();
}, 30_000);
`;

const WORKER_METRICS = `import { Gauge } from 'prom-client';

export const queueDepth = new Gauge({ name: 'queue_depth', help: 'jobs waiting', labelNames: ['queue'] });

export function startMetricsServer(): void {
    http.createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (path === '/livez') {
            res.writeHead(200);
            res.end('{"ok":true}');
        }
        if (path === '/metrics') {
            res.end(register.metrics());
        }
    }).listen(9100);
}
`;

const API_METRICS = `import { Histogram } from 'prom-client';

export const httpDuration = new Histogram({ name: 'http_duration', help: 'latency', labelNames: ['route', 'method'] });

export function routeLabel(req: Request): string {
    if (req.route === undefined) return 'unknown';
    return \`\${req.baseUrl}\${req.route.path}\`;
}
`;

const API_INDEX = `app.get('/metrics', async (_req, res) => {
    res.end(await register.metrics());
});

app.get('/healthz', async (_req: Request, res: Response) => {
    try {
        await getDb().command({ ping: 1 }, { timeoutMS: 5000 });
        res.json({ ok: true });
    } catch {
        res.status(503).json({ ok: false });
    }
});

app.get('/livez', (_req: Request, res: Response) => {
    res.json({ ok: true });
});
`;

const KUBE_LINTER = `checks:
  exclude:
    # A queue consumer pulls its work; readiness would only cut off its scrape.
    - no-read-only-root-fs
    - unset-cpu-requirements
`;

const WORKFLOW = `name: k8s-validate
jobs:
  validate:
    steps:
      - run: kubectl apply -f crds/servicemonitors.yaml
      - run: kubeconform -schema-location default k8s/
`;

const FILES = {
    'k8s/worker/service.yaml': SERVICE,
    'k8s/worker/servicemonitor.yaml': MONITOR,
    'k8s/worker/deployment.yaml': DEPLOYMENT,
    'k8s/network-policies/worker.yaml': POLICY,
    'worker/src/index.ts': WORKER_INDEX,
    'worker/src/lib/metrics.ts': WORKER_METRICS,
    'api/src/lib/metrics.ts': API_METRICS,
    'api/src/index.ts': API_INDEX,
    '.kube-linter.yaml': KUBE_LINTER,
    '.github/workflows/k8s-validate.yml': WORKFLOW,
};

const good = (overrides = {}) => ({ ...FILES, ...overrides });

const OPTIONS = {
    manifests: 'k8s',
    workflow: '.github/workflows/k8s-validate.yml',
    kubeLinter: '.kube-linter.yaml',
    metricModules: [
        { module: 'api/src/lib/metrics.ts', server: 'api/src/index.ts', label: 'api' },
        { module: 'worker/src/lib/metrics.ts', server: 'worker/src/lib/metrics.ts', label: 'worker' },
    ],
    gaugeRefresh: { file: 'worker/src/index.ts', call: 'emitMetrics', monitors: /worker/ },
    listenBeforeInit: { file: 'worker/src/index.ts', listen: 'startMetricsServer', slowInit: /await\s+initDb\s*\(/ },
    livezHandlers: [
        { file: 'api/src/index.ts' },
        { file: 'worker/src/lib/metrics.ts', pattern: /if\s*\(\s*path === ['"`]\/livez['"`]\s*\)\s*\{[\s\S]*?\n\s*\}/ },
    ],
    healthzHandlers: [{ file: 'api/src/index.ts' }],
    ownWorkloads: /^(api|worker)/,
    queueConsumers: /^worker/,
    routeLabel: { file: 'api/src/lib/metrics.ts', fn: 'routeLabel' },
    headlessServices: ['worker'],
};

const run = (root, overrides = {}) => inspectMetrics({ root, ...OPTIONS, ...overrides });
const whats = (root, overrides) => run(root, overrides).problems.map((p) => p.what);

// ─── The baseline ────────────────────────────────────────────────────────────

test('a chain that resolves end to end reports nothing', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('the counts describe the chain that was walked', (t) => {
    const { counts } = run(tree(t, good()));
    assert.deepEqual(counts, { monitors: 1, services: 1, workloads: 1, crdKinds: ['ServiceMonitor'] });
});

// ─── Parsing ─────────────────────────────────────────────────────────────────

test('an unparseable manifest is reported before anything else is graded', (t) => {
    const root = tree(t, good({ 'k8s/worker/broken.yaml': 'kind: Service\n  bad: [indent\n' }));
    assert.match(whats(root)[0], /is not valid YAML/);
});

test('an empty manifest directory fails rather than passing vacuously', (t) => {
    const files = good();
    for (const key of Object.keys(files)) if (key.startsWith('k8s/')) delete files[key];
    const root = tree(t, files);
    assert.deepEqual(whats(root), ['contains no manifests']);
});

test('kustomization.yaml is not read as a resource', (t) => {
    const root = tree(t, good({ 'k8s/kustomization.yaml': 'resources:\n  - worker/service.yaml\n' }));
    assert.deepEqual(whats(root), []);
});

// ─── 1-3. The scrape chain ───────────────────────────────────────────────────

test('no ServiceMonitor at all is reported', (t) => {
    const files = good();
    delete files['k8s/worker/servicemonitor.yaml'];
    const root = tree(t, files);
    assert.match(whats(root)[0], /declares no ServiceMonitor/);
});

test('a ServiceMonitor with no matchLabels is reported', (t) => {
    const root = tree(
        t,
        good({
            'k8s/worker/servicemonitor.yaml': MONITOR.replace('  selector:\n    matchLabels:\n      app: worker\n', ''),
        }),
    );
    assert.match(whats(root)[0], /has no `spec.selector.matchLabels`/);
});

test('a ServiceMonitor selecting a label no Service carries is reported', (t) => {
    const root = tree(t, good({ 'k8s/worker/servicemonitor.yaml': MONITOR.replace('app: worker', 'app: workers') }));
    assert.match(whats(root)[0], /matches no Service/);
});

test('a port name the Service does not declare is reported, with what it does declare', (t) => {
    const root = tree(t, good({ 'k8s/worker/service.yaml': SERVICE.replace('name: metrics', 'name: http') }));
    assert.match(whats(root)[0], /scrapes port `metrics`, which Service `worker` does not declare/);
    assert.match(run(root).problems[0].why, /`http` \(9100\)/);
});

test('a Service selecting labels no pod template carries is reported', (t) => {
    const root = tree(
        t,
        good({
            'k8s/worker/deployment.yaml': DEPLOYMENT.replace(
                'app.kubernetes.io/name: worker',
                'app.kubernetes.io/name: workers',
            ),
        }),
    );
    assert.match(whats(root).join(' '), /matches no Deployment's pod template/);
});

test('a Service with no selector is reported', (t) => {
    const root = tree(
        t,
        good({ 'k8s/worker/service.yaml': SERVICE.replace('  selector:\n    app.kubernetes.io/name: worker\n', '') }),
    );
    assert.match(whats(root)[0], /has no pod selector/);
});

test('a targetPort no container declares is reported', (t) => {
    const root = tree(t, good({ 'k8s/worker/service.yaml': SERVICE.replace('targetPort: 9100', 'targetPort: 9200') }));
    assert.match(whats(root)[0], /does not expose port 9200/);
});

test('a label matching only by type coercion still matches', (t) => {
    const root = tree(
        t,
        good({
            'k8s/worker/service.yaml': SERVICE.replace('app: worker', 'version: "2"'),
            'k8s/worker/servicemonitor.yaml': MONITOR.replace('app: worker', 'version: 2'),
        }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 4. The NetworkPolicy ────────────────────────────────────────────────────

test('a workload no policy admits from the monitoring namespace is reported', (t) => {
    const files = good();
    delete files['k8s/network-policies/worker.yaml'];
    const root = tree(t, files);
    assert.match(whats(root)[0], /nothing admits the `monitoring` namespace/);
});

test('a policy admitting monitoring on the wrong port is reported', (t) => {
    const root = tree(t, good({ 'k8s/network-policies/worker.yaml': POLICY.replace('- port: 9100', '- port: 8080') }));
    assert.match(whats(root)[0], /nothing admits the `monitoring` namespace to `worker` on port 9100/);
});

test('a policy admitting a different namespace is reported', (t) => {
    const root = tree(
        t,
        good({
            'k8s/network-policies/worker.yaml': POLICY.replace(
                'kubernetes.io/metadata.name: monitoring',
                'kubernetes.io/metadata.name: default',
            ),
        }),
    );
    assert.match(whats(root)[0], /nothing admits the `monitoring` namespace/);
});

test('a policy with no port restriction admits every port', (t) => {
    const root = tree(
        t,
        good({ 'k8s/network-policies/worker.yaml': POLICY.replace('      ports:\n        - port: 9100\n', '') }),
    );
    assert.deepEqual(whats(root), []);
});

test('an empty podSelector admits every pod, as Kubernetes reads it', (t) => {
    const root = tree(
        t,
        good({
            'k8s/network-policies/worker.yaml': POLICY.replace(
                '  podSelector:\n    matchLabels:\n      app.kubernetes.io/name: worker\n',
                '  podSelector: {}\n',
            ),
        }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 5. Headless scrape-only Services ────────────────────────────────────────

test('a scrape-only Service with a ClusterIP is reported', (t) => {
    const root = tree(t, good({ 'k8s/worker/service.yaml': SERVICE.replace('  clusterIP: None\n', '') }));
    assert.match(whats(root)[0], /exists only to be scraped but is not headless/);
});

test('a named scrape-only Service that no longer exists is reported', (t) => {
    const root = tree(t, good());
    assert.match(whats(root, { headlessServices: ['metrics-svc'] })[0], /no Service named `metrics-svc`/);
});

// ─── 6. Interval vs gauge refresh ────────────────────────────────────────────

test('a scrape interval that differs from the refresh is reported with both numbers', (t) => {
    const root = tree(t, good({ 'k8s/worker/servicemonitor.yaml': MONITOR.replace('interval: 30s', 'interval: 60s') }));
    assert.match(whats(root)[0], /scrapes every 60s, but worker\/src\/index.ts refreshes the gauges every 30s/);
});

test('a gauge that is never refreshed on a timer is reported', (t) => {
    const root = tree(
        t,
        good({ 'worker/src/index.ts': WORKER_INDEX.replace('void emitMetrics();', 'void heartbeat();') }),
    );
    assert.match(whats(root)[0], /does not call `emitMetrics\(\)` on an interval/);
});

test('a ServiceMonitor the refresh rule does not cover is left alone', (t) => {
    const root = tree(t, good({ 'k8s/worker/servicemonitor.yaml': MONITOR.replace('interval: 30s', 'interval: 60s') }));
    assert.deepEqual(
        whats(root, { gaugeRefresh: { file: 'worker/src/index.ts', call: 'emitMetrics', monitors: /^api$/ } }),
        [],
    );
});

// ─── 7. Registered metrics are served ────────────────────────────────────────

test('a module that registers metrics but serves no /metrics route is reported', (t) => {
    const root = tree(
        t,
        good({
            'worker/src/lib/metrics.ts': WORKER_METRICS.replace(
                "if (path === '/metrics') {\n            res.end(register.metrics());\n        }",
                '',
            ),
        }),
    );
    assert.match(whats(root).join(' '), /serves no \/metrics route/);
});

test('a module that registers nothing is not asked to serve anything', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/metrics.ts':
                'export function routeLabel(req: Request): string {\n    if (req.route === undefined) return "unknown";\n    return `${req.baseUrl}${req.route.path}`;\n}\n',
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('a ServiceMonitor scraping a path the server does not serve is reported', (t) => {
    const root = tree(
        t,
        good({ 'k8s/worker/servicemonitor.yaml': MONITOR.replace('path: /metrics', 'path: /prometheus') }),
    );
    assert.match(whats(root).join(' '), /scrapes `\/prometheus`/);
});

test('a metrics module that has gone missing is reported, not skipped', (t) => {
    const files = good();
    delete files['worker/src/lib/metrics.ts'];
    const root = tree(t, files);
    assert.match(
        run(root)
            .problems.map((p) => p.why)
            .join(' '),
        /worker metrics module is gone/,
    );
});

// ─── 8-9, 12. Probes ─────────────────────────────────────────────────────────

test('an exec liveness probe is reported with its command', (t) => {
    const withExec = DEPLOYMENT.replace(
        '          livenessProbe:\n            httpGet:\n              path: /livez\n              port: 9100\n',
        '          livenessProbe:\n            exec:\n              command: ["node", "-e", "process.exit(0)"]\n',
    );
    const root = tree(t, good({ 'k8s/worker/deployment.yaml': withExec }));
    assert.match(whats(root)[0], /uses an `exec` liveness probe/);
});

test('an exec READINESS probe is allowed — it reaches the real server', (t) => {
    const withExec = DEPLOYMENT.replace('metadata:\n  name: worker', 'metadata:\n  name: redis').replace(
        '          livenessProbe:\n            httpGet:\n              path: /livez\n              port: 9100\n',
        '          readinessProbe:\n            exec:\n              command: ["redis-cli", "ping"]\n',
    );
    const root = tree(t, good({ 'k8s/redis/deployment.yaml': withExec }));
    assert.deepEqual(whats(root), []);
});

test('a probe on an undeclared port is reported', (t) => {
    const root = tree(
        t,
        good({
            'k8s/worker/deployment.yaml': DEPLOYMENT.replace(
                '              path: /livez\n              port: 9100',
                '              path: /livez\n              port: 8080',
            ),
        }),
    );
    assert.match(whats(root)[0], /probes liveness on port 8080/);
});

test('liveness pointed at anything but /livez is reported', (t) => {
    const root = tree(t, good({ 'k8s/worker/deployment.yaml': DEPLOYMENT.replace('path: /livez', 'path: /healthz') }));
    assert.match(whats(root)[0], /probes liveness at `\/healthz`/);
});

test('a third-party workload keeps its own probe paths', (t) => {
    const chart = DEPLOYMENT.replace('name: worker\n', 'name: grafana\n').replace('path: /livez', 'path: /api/health');
    const root = tree(t, good({ 'k8s/grafana/deployment.yaml': chart }));
    assert.deepEqual(whats(root), []);
});

test('one endpoint used for both probes is reported', (t) => {
    const both = `${DEPLOYMENT.replace('name: worker\nspec', 'name: api\nspec')}          readinessProbe:
            httpGet:
              path: /livez
              port: 9100
`;
    const root = tree(t, good({ 'k8s/api/deployment.yaml': both }));
    assert.match(whats(root).join(' '), /for both liveness and readiness/);
});

// ─── 10-11. The two health endpoints ─────────────────────────────────────────

test('a /livez that awaits something is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': API_INDEX.replace(
                "app.get('/livez', (_req: Request, res: Response) => {\n    res.json({ ok: true });",
                "app.get('/livez', async (_req: Request, res: Response) => {\n    await getDb().command({ ping: 1 });\n    res.json({ ok: true });",
            ),
        }),
    );
    assert.match(whats(root).join(' '), /\/livez awaits something/);
});

test('a /livez that names a dependency without awaiting is still reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': API_INDEX.replace(
                '    res.json({ ok: true });\n});\n',
                '    res.json({ ok: redis.status === "ready" });\n});\n',
            ),
        }),
    );
    assert.match(whats(root).join(' '), /\/livez references a dependency/);
});

test('a /livez rewritten into an unrecognisable shape is reported, not skipped', (t) => {
    const root = tree(
        t,
        good({
            'worker/src/lib/metrics.ts': WORKER_METRICS.replace(
                "if (path === '/livez') {",
                "if (path.endsWith('livez')) {",
            ),
        }),
    );
    assert.match(whats(root).join(' '), /no recognisable \/livez handler/);
});

test('a /healthz whose dependency check has no timeout is reported', (t) => {
    const root = tree(t, good({ 'api/src/index.ts': API_INDEX.replace(', { timeoutMS: 5000 }', '') }));
    assert.match(whats(root).join(' '), /awaits a dependency with no timeout/);
});

test('a /healthz bounded by an AbortSignal passes', (t) => {
    const root = tree(
        t,
        good({ 'api/src/index.ts': API_INDEX.replace('{ timeoutMS: 5000 }', '{ signal: AbortSignal.timeout(5000) }') }),
    );
    assert.deepEqual(whats(root), []);
});

// ─── 13. Listening before slow init ──────────────────────────────────────────

test('a listener started after slow init is reported', (t) => {
    const root = tree(
        t,
        good({
            'worker/src/index.ts': WORKER_INDEX.replace(
                'startMetricsServer();\nawait initDb();',
                'await initDb();\nstartMetricsServer();',
            ),
        }),
    );
    assert.match(whats(root)[0], /runs after the slow initialisation/);
});

test('an import of the listener is not mistaken for calling it early', (t) => {
    const root = tree(
        t,
        good({
            'worker/src/index.ts': WORKER_INDEX.replace(
                'startMetricsServer();\nawait initDb();',
                'await initDb();\nstartMetricsServer();',
            ),
        }),
    );
    assert.equal(whats(root).length, 1);
});

test('a listener that is never started is reported', (t) => {
    const root = tree(t, good({ 'worker/src/index.ts': WORKER_INDEX.replace('startMetricsServer();\n', '') }));
    assert.match(whats(root).join(' '), /never calls `startMetricsServer`/);
});

// ─── 14. Queue consumers ─────────────────────────────────────────────────────

test('a readiness probe on a queue consumer is reported', (t) => {
    const withReadiness = `${DEPLOYMENT}          readinessProbe:
            httpGet:
              path: /healthz
              port: 9100
`;
    const root = tree(t, good({ 'k8s/worker/deployment.yaml': withReadiness }));
    assert.match(whats(root).join(' '), /has a readinessProbe/);
});

// ─── 15. kube-linter exclusions ──────────────────────────────────────────────

test('an exclusion with no comment above its run is reported by line', (t) => {
    const root = tree(
        t,
        good({
            '.kube-linter.yaml': KUBE_LINTER.replace(
                '    # A queue consumer pulls its work; readiness would only cut off its scrape.\n',
                '',
            ),
        }),
    );
    assert.equal(whats(root).length, 2);
    assert.match(run(root).problems[0].file, /\.kube-linter\.yaml:3/);
});

test('one comment justifies the run of exclusions beneath it', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

test('a missing kube-linter config is reported', (t) => {
    const files = good();
    delete files['.kube-linter.yaml'];
    const root = tree(t, files);
    assert.match(
        run(root)
            .problems.map((p) => p.why)
            .join(' '),
        /Nothing records which policies are waived/,
    );
});

// ─── 16. Metric cardinality ──────────────────────────────────────────────────

test('an unbounded label is reported by name', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/metrics.ts': API_METRICS.replace(
                "labelNames: ['route', 'method']",
                "labelNames: ['route', 'userId']",
            ),
        }),
    );
    assert.match(whats(root)[0], /metric label `userId` is unbounded/);
});

test('a project can add its own unbounded label names', (t) => {
    const root = tree(t, good({ 'api/src/lib/metrics.ts': API_METRICS.replace("'method'", "'channelSlug'") }));
    assert.match(whats(root, { unboundedLabels: ['channelSlug'] })[0], /`channelSlug` is unbounded/);
});

// ─── 17. The route label ─────────────────────────────────────────────────────

test('a route label built from req.url is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/metrics.ts': API_METRICS.replace(
                'return `${req.baseUrl}${req.route.path}`;',
                'return req.url;',
            ),
        }),
    );
    assert.match(whats(root).join(' '), /uses `req.url`/);
});

test('a route label without req.baseUrl is reported', (t) => {
    const root = tree(
        t,
        good({
            'api/src/lib/metrics.ts': API_METRICS.replace(
                'return `${req.baseUrl}${req.route.path}`;',
                'return req.route.path;',
            ),
        }),
    );
    assert.match(whats(root).join(' '), /does not use `req.baseUrl`/);
});

test('a route label with no unknown fallback is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/metrics.ts': API_METRICS.replace("if (req.route === undefined) return 'unknown';", '') }),
    );
    assert.match(whats(root).join(' '), /has no `unknown` fallback/);
});

test('a routeLabel that has been renamed away is reported', (t) => {
    const root = tree(
        t,
        good({ 'api/src/lib/metrics.ts': API_METRICS.replace('function routeLabel', 'function labelFor') }),
    );
    assert.match(whats(root).join(' '), /has no `routeLabel` function/);
});

// ─── 18. CRDs in CI ──────────────────────────────────────────────────────────

test('a CRD kind the workflow never installs is reported', (t) => {
    const root = tree(
        t,
        good({
            '.github/workflows/k8s-validate.yml': WORKFLOW.replace(
                'kubectl apply -f crds/servicemonitors.yaml',
                'kubectl version',
            ),
        }),
    );
    assert.match(whats(root)[0], /does not install the CRD for `ServiceMonitor`/);
});

test('a skipped kind is reported even when its CRD is installed', (t) => {
    const root = tree(
        t,
        good({
            '.github/workflows/k8s-validate.yml': WORKFLOW.replace('-schema-location default', '-skip ServiceMonitor'),
        }),
    );
    assert.match(whats(root)[0], /passes `-skip ServiceMonitor`/);
});

test('core kinds are not asked for a CRD', (t) => {
    const root = tree(t, good());
    assert.deepEqual(run(root).counts.crdKinds, ['ServiceMonitor']);
});

test('a missing workflow is reported with the kinds left unchecked', (t) => {
    const files = good();
    delete files['.github/workflows/k8s-validate.yml'];
    const root = tree(t, files);
    assert.match(run(root).problems[0].why, /ServiceMonitor/);
});

// ─── Comments must not answer for the code ───────────────────────────────────

test('a comment naming req.baseUrl does not satisfy the route-label rule', (t) => {
    const commented = API_METRICS.replace(
        'export function routeLabel(req: Request): string {',
        'export function routeLabel(req: Request): string {\n    // req.baseUrl carries the mount point.',
    ).replace('return `${req.baseUrl}${req.route.path}`;', 'return req.route.path;');
    const root = tree(t, good({ 'api/src/lib/metrics.ts': commented }));
    assert.match(whats(root).join(' '), /does not use `req.baseUrl`/);
});

test('a commented-out dependency in /livez is not a dependency', (t) => {
    const root = tree(
        t,
        good({
            'api/src/index.ts': API_INDEX.replace(
                "app.get('/livez', (_req: Request, res: Response) => {",
                "app.get('/livez', (_req: Request, res: Response) => {\n    // deliberately does not await getDb().command({ ping: 1 })",
            ),
        }),
    );
    assert.deepEqual(whats(root), []);
});

test('a commented-out metric registration does not demand a /metrics route', (t) => {
    const commented = WORKER_METRICS.replace(
        "export const queueDepth = new Gauge({ name: 'queue_depth', help: 'jobs waiting', labelNames: ['queue'] });",
        "// export const queueDepth = new Gauge({ name: 'queue_depth', help: 'jobs waiting', labelNames: ['queue'] });",
    ).replace("if (path === '/metrics') {\n            res.end(register.metrics());\n        }", '');
    const root = tree(t, good({ 'worker/src/lib/metrics.ts': commented }));
    assert.deepEqual(whats(root), []);
});

test('the kube-linter comments are still read, since there they ARE the rule', (t) => {
    const root = tree(t, good());
    assert.deepEqual(whats(root), []);
});

// ─── Cases the mutation sweep found nothing pinning ──────────────────────────

test('a manifest whose `kind` parses as a map is skipped, not crashed on', (t) => {
    const root = tree(t, good({ 'k8s/worker/odd.yaml': 'kind:\n  nested: true\nmetadata:\n  name: odd\n' }));
    assert.deepEqual(whats(root), []);
});

test('a Service with an empty selector is reported', (t) => {
    const root = tree(
        t,
        good({
            'k8s/worker/service.yaml': SERVICE.replace(
                '  selector:\n    app.kubernetes.io/name: worker\n',
                '  selector: {}\n',
            ),
        }),
    );
    assert.match(whats(root)[0], /has no pod selector/);
});

test('the listener DEFINED in the file it starts is not its own early call', (t) => {
    const defines = `import { initDb } from '@/lib/db.js';

export function startMetricsServer(): void {
    http.createServer(() => {}).listen(9100);
}

await initDb();
startMetricsServer();
`;
    const root = tree(t, good({ 'worker/src/index.ts': defines }));
    assert.match(whats(root).join(' '), /runs after the slow initialisation/);
});

test('a comment above the whole file does not justify an exclusion inside it', (t) => {
    const distant = `# kube-linter configuration for this repo.
checks:
  exclude:
    - no-read-only-root-fs
`;
    const root = tree(t, good({ '.kube-linter.yaml': distant }));
    assert.match(whats(root).join(' '), /exclusion `no-read-only-root-fs` has no comment/);
});

test('kustomize input is not graded as a cluster resource, even when malformed', (t) => {
    // `kustomize build` fails loudly on its own file; this gate reads what the
    // cluster gets, and a kustomization.yaml is never applied.
    const root = tree(t, good({ 'k8s/kustomization.yaml': 'resources:\n  - [worker/service.yaml\n' }));
    assert.deepEqual(whats(root), []);
});
