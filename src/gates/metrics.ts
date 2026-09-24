/**
 * Observability gate — the scrape chain, the probes, and metric cardinality.
 *
 * Every rule here fails the same way: the manifests stay schema-valid, the app
 * stays healthy, `kubectl apply` succeeds, and the number you go looking for in
 * six months is not there. A ServiceMonitor whose label selector matches no
 * Service scrapes nothing and says nothing. A NetworkPolicy with no rule for the
 * monitoring namespace DROPS the scrape — no refusal, no log, no event — while
 * the Service and the ServiceMonitor both look perfectly correct. A gauge
 * refreshed every 30 seconds and scraped every 60 discards half its samples and
 * errors nowhere.
 *
 * WHY THIS ONE HAD NO DRIFT TO SETTLE. Only one project has Kubernetes
 * manifests, so unlike every other gate in this package this is a single copy
 * moved rather than several reconciled. What the move buys is that the rules stop
 * being one repo's private knowledge: the next project to grow a `k8s/` directory
 * gets fifteen rules that were each learned from something that had already gone
 * quietly wrong, instead of rediscovering them.
 *
 * WHAT WAS PARAMETERISED, and what deliberately was not. Paths, namespaces,
 * workload name patterns and the metric modules are options — they are this
 * repo's answers, not rules. The THRESHOLDS are not: `/livez` and `/healthz` are
 * fixed names because the whole point of rule 8 is that two endpoints answering
 * opposite questions must not become one, and a project free to name them
 * whatever it likes is a project free to point both probes at the same handler.
 *
 * TWO RULES ARE NEW, and both come from the standard rather than from the copy:
 *
 *   • A SERVICE THAT EXISTS ONLY TO BE SCRAPED MUST BE HEADLESS. With a
 *     ClusterIP, Prometheus discovers ONE endpoint and scrapes a randomly
 *     chosen pod each time. Nothing fails. The queue-depth graph for a
 *     three-replica worker simply jumps between three unrelated series and
 *     reads as noise, which is indistinguishable from a busy queue.
 *
 *   • THE `/healthz` DEPENDENCY CHECK MUST BE BOUNDED BY A TIMEOUT. An
 *     unbounded `ping` against a hung Mongo holds the probe open until
 *     kubelet's own timeout fires, so the pod reports a probe TIMEOUT instead
 *     of the 503 it meant to send — slower to react, and a different thing on
 *     every dashboard that counts readiness failures.
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';
import { stripComments } from './strip-comments.ts';

export interface MetricProblem {
    file: string | null;
    what: string;
    why: string;
}

export type Labels = Record<string, string>;

export interface K8sPort {
    name?: string;
    port?: number;
    targetPort?: number | string;
    containerPort?: number;
}

export interface Probe {
    exec?: { command?: string[] };
    httpGet?: { path?: string; port?: number | string };
}

export interface Container {
    name?: string;
    ports?: K8sPort[];
    livenessProbe?: Probe;
    readinessProbe?: Probe;
}

export interface K8sDoc {
    kind?: string;
    metadata?: { name?: string; labels?: Labels };
    spec?: {
        /** A Service selects pods with plain labels; a ServiceMonitor wraps them in `matchLabels`. */
        selector?: Record<string, unknown> & { matchLabels?: Labels };
        clusterIP?: string;
        endpoints?: { port?: string; path?: string; interval?: string }[];
        ports?: K8sPort[];
        template?: { metadata?: { labels?: Labels }; spec?: { containers?: Container[] } };
        podSelector?: { matchLabels?: Labels };
        ingress?: { from?: { namespaceSelector?: { matchLabels?: Labels } }[]; ports?: K8sPort[] }[];
    };
}

export interface Resource {
    rel: string;
    kind: string;
    name: string;
    doc: K8sDoc;
}

export interface ScrapeTarget {
    monitor: Resource;
    service: Resource;
    deployment: Resource;
    container: string;
    podLabels: Labels;
    port: number | undefined;
    path: string;
    interval: string | undefined;
}

/** A handler read out of a source file by pattern, so a rewrite is reported rather than passed. */
export interface Handler {
    file: string;
    /** Defaults to the Express `app.get('/livez', …)` / `app.get('/healthz', …)` shape. */
    pattern?: RegExp;
}

export interface MetricsInput {
    root: string;
    /** The manifest directory, walked recursively; `kustomization.yaml` is skipped. */
    manifests: string;
    /** The namespace Prometheus runs in. Defaults to `monitoring`. */
    monitoringNamespace?: string;
    /** The CI workflow that dry-runs the manifests. */
    workflow?: string;
    /** The kube-linter config whose exclusions must each carry a reason. */
    kubeLinter?: string;
    /** Each process that registers metrics: the module, the file that serves them, its name. */
    metricModules?: { module: string; server: string; label: string }[];
    /** The timer that refreshes the gauges, and which ServiceMonitors it has to agree with. */
    gaugeRefresh?: { file: string; call: string; monitors: RegExp };
    /** The listener that must start before the slow initialisation beside it. */
    listenBeforeInit?: { file: string; listen: string; slowInit: RegExp };
    /** Every `/livez` handler — each must await nothing and touch no dependency. */
    livezHandlers?: Handler[];
    /** Every `/healthz` handler — each dependency check must be bounded by a timeout. */
    healthzHandlers?: Handler[];
    /** Deployments whose probe paths this repo owns. Others are third-party charts. */
    ownWorkloads?: RegExp;
    /** Deployments that pull their work, and so must have no readiness probe. */
    queueConsumers?: RegExp;
    /** The function that builds the route label, and the file holding it. */
    routeLabel?: { file: string; fn: string };
    /** Services that exist only to be scraped, and so must be headless. */
    headlessServices?: string[];
    /** Extra unbounded label names, beyond the built-in list. */
    unboundedLabels?: string[];
}

export interface MetricsInspection {
    problems: MetricProblem[];
    counts: { monitors: number; services: number; workloads: number; crdKinds: string[] };
}

export interface MetricsOptions extends Omit<MetricsInput, 'root'> {
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
}

/** Kinds every cluster already knows. Anything else is a CRD CI has to install. */
const CORE_KINDS = new Set([
    'Namespace',
    'Deployment',
    'Service',
    'ConfigMap',
    'Secret',
    'Ingress',
    'Job',
    'CronJob',
    'StatefulSet',
    'DaemonSet',
    'PersistentVolumeClaim',
    'PersistentVolume',
    'ServiceAccount',
    'Role',
    'RoleBinding',
    'ClusterRole',
    'ClusterRoleBinding',
    'NetworkPolicy',
    'HorizontalPodAutoscaler',
    'PodDisruptionBudget',
    'ResourceQuota',
    'LimitRange',
]);

/** Kustomize's own kinds never reach the API server, so CI never installs them. */
const KUSTOMIZE_KINDS = new Set(['Kustomization', 'Component']);

/**
 * Label names with one value per record. Prometheus holds one time series per
 * distinct label combination, in memory, forever — so these do not degrade the
 * server, they take it down. The identifier belongs in a log line, where it is
 * queryable and costs nothing.
 */
const UNBOUNDED_LABELS = [
    'id',
    'userId',
    'user_id',
    'videoId',
    'mediaId',
    'jobId',
    'requestId',
    'path',
    'url',
    'email',
    'ip',
    'sessionId',
];

/** Anything in a /livez handler that reaches outside this process. */
const DEPENDENCY_CALLS = /\b(?:getDb|mongo|redis|Redis|queue|Queue|fetch|ping)\b/;

/** The two probe paths. Fixed on purpose — see the header. */
const LIVENESS_PATH = '/livez';
const READINESS_PATH = '/healthz';

/**
 * True when every key of `selector` is present in `labels` with the same value.
 *
 * Both sides are stringified: YAML reads `version: 2` as a number and
 * `version: "2"` as a string, and a selector differing only in that matches in
 * the cluster but would not match here.
 *
 * An EMPTY selector matches everything, which is Kubernetes' own rule for a
 * NetworkPolicy `podSelector: {}` ("every pod in the namespace"). A Service's
 * empty selector means the opposite — it selects nothing — so that case is
 * reported where the Service is read, not bent into this helper.
 */
const matches = (selector: Record<string, unknown> | undefined, labels: Record<string, string> | undefined): boolean =>
    selector !== undefined &&
    labels !== undefined &&
    Object.entries(selector).every(([key, value]) => String(labels[key]) === String(value));

/**
 * Every metric relationship this repo can be asked about, as a list of problems.
 */
export function inspectMetrics(input: MetricsInput): MetricsInspection {
    const {
        root,
        manifests: manifestDir,
        monitoringNamespace = 'monitoring',
        workflow,
        kubeLinter,
        metricModules = [],
        gaugeRefresh,
        listenBeforeInit,
        livezHandlers = [],
        healthzHandlers = [],
        ownWorkloads,
        queueConsumers,
        routeLabel,
        headlessServices = [],
        unboundedLabels = [],
    } = input;

    const problems: MetricProblem[] = [];
    const fail = (file: string, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const abs = (rel: string) => path.join(root, rel);
    const exists = (rel: string) => fs.existsSync(abs(rel));
    const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
    /**
     * Source with every comment blanked, for the rules that ask what the CODE
     * does. Offsets survive, so the handler patterns still match. The kube-linter
     * config is read raw and never through this — there the comments ARE the rule.
     */
    const code = (rel: string) => stripComments(read(rel));

    /** @param rel @returns {string[]} */
    const walk = (rel: string): string[] => {
        if (!exists(rel)) return [];
        return fs.readdirSync(abs(rel), { withFileTypes: true }).flatMap((entry) => {
            const child = `${rel}/${entry.name}`;
            return entry.isDirectory() ? walk(child) : [child];
        });
    };

    // ── Parse every manifest once ────────────────────────────────────────────
    const resources: Resource[] = [];
    const files = walk(manifestDir)
        // kustomization.yaml is the build tool's INPUT, never a cluster
        // resource, so it is not graded here — `kustomize build` fails loudly on
        // its own file and needs no second opinion.
        .filter((rel) => /\.ya?ml$/.test(rel) && path.basename(rel) !== 'kustomization.yaml')
        .sort();

    for (const rel of files) {
        let documents: ReturnType<typeof YAML.parseAllDocuments>;
        try {
            documents = YAML.parseAllDocuments(read(rel));
        } catch (error) {
            fail(
                rel,
                `is not valid YAML (${(error as Error).message.split('\n')[0] ?? ''})`,
                'Every relationship this gate checks is invisible while the file cannot be parsed, so this has to be the first thing reported.',
            );
            continue;
        }
        for (const document of documents) {
            // The parser RECOVERS rather than throwing: a manifest with a bad
            // indent comes back as a document carrying errors, and whatever it
            // managed to build. The copy this came from only had the try/catch,
            // so a malformed file was skipped in silence and every rule about it
            // passed. Read `errors` instead.
            if (document.errors.length > 0) {
                fail(
                    rel,
                    `is not valid YAML (${document.errors[0]?.message.split('\n')[0] ?? ''})`,
                    'Every relationship this gate checks is invisible while the file cannot be parsed, so this has to be reported before anything that reads it.',
                );
                continue;
            }
            const object = document.toJS() as K8sDoc | null;
            // `typeof`, not `!== undefined`: a file that parses but whose `kind`
            // comes back as a map or a number crashed the copy this came from,
            // with a TypeError instead of the report the reader needed.
            if (typeof object?.kind !== 'string' || object.kind === '') continue;
            resources.push({ rel, kind: object.kind, name: object.metadata?.name ?? '<unnamed>', doc: object });
        }
    }

    if (resources.length === 0) {
        fail(
            manifestDir,
            'contains no manifests',
            'Every rule below would pass vacuously — the gate would report success having read nothing. Did the directory move?',
        );
        return { problems, counts: { monitors: 0, services: 0, workloads: 0, crdKinds: [] } };
    }

    const byKind = (kind: string) => resources.filter((resource) => resource.kind === kind);
    const services = byKind('Service');
    const monitors = byKind('ServiceMonitor');
    const deployments = byKind('Deployment');
    const policies = byKind('NetworkPolicy');

    const podsOf = (deployment: Resource) => deployment.doc.spec?.template?.metadata?.labels ?? {};
    const containersOf = (deployment: Resource) => deployment.doc.spec?.template?.spec?.containers ?? [];

    // ── 1-3. ServiceMonitor → Service → pods ────────────────────────────────
    // Three links, each of which stays schema-valid when it breaks. The only
    // symptom of any of them is a Prometheus target that sits at DOWN, which
    // nobody is looking at until they need the metric.
    const scraped: ScrapeTarget[] = [];

    if (monitors.length === 0) {
        fail(
            manifestDir,
            'declares no ServiceMonitor',
            'Nothing tells Prometheus to scrape anything, so every metric the code registers is computed and then thrown away on each pod restart.',
        );
    }

    for (const monitor of monitors) {
        const selector = monitor.doc.spec?.selector?.matchLabels;
        if (selector === undefined) {
            fail(
                monitor.rel,
                `ServiceMonitor \`${monitor.name}\` has no \`spec.selector.matchLabels\``,
                'It selects no Service, so it scrapes nothing. This is valid YAML and a valid ServiceMonitor — it simply never fires.',
            );
            continue;
        }

        const targets = services.filter((service) => matches(selector, service.doc.metadata?.labels));
        if (targets.length === 0) {
            fail(
                monitor.rel,
                `ServiceMonitor \`${monitor.name}\` selects ${JSON.stringify(selector)}, which matches no Service`,
                `Prometheus discovers pods THROUGH a Service, so this scrapes nothing at all and nothing reports it. The Services and their labels: ${services.map((service) => `${service.name}=${JSON.stringify(service.doc.metadata?.labels ?? {})}`).join(', ')}.`,
            );
            continue;
        }

        for (const endpoint of monitor.doc.spec?.endpoints ?? []) {
            for (const service of targets) {
                const ports = service.doc.spec?.ports ?? [];
                const port = ports.find((candidate) => candidate.name === endpoint.port);
                if (port === undefined) {
                    fail(
                        monitor.rel,
                        `ServiceMonitor \`${monitor.name}\` scrapes port \`${endpoint.port ?? ''}\`, which Service \`${service.name}\` does not declare`,
                        `A ServiceMonitor endpoint names a Service port by NAME. Both documents stay schema-valid, so renaming the port on one side leaves a target stuck at DOWN and nothing else. Service \`${service.name}\` declares: ${ports.length > 0 ? ports.map((p) => (p.name === undefined || p.name === '' ? `${String(p.port)} (unnamed)` : `\`${p.name}\` (${String(p.port)})`)).join(', ') : 'no ports'}.`,
                    );
                    continue;
                }

                const podSelector = service.doc.spec?.selector;
                if (podSelector === undefined || Object.keys(podSelector).length === 0) {
                    fail(
                        service.rel,
                        `Service \`${service.name}\` has no pod selector`,
                        'A Service without one creates no endpoints at all, so it resolves to nothing — which looks the same from outside as a workload that is merely idle.',
                    );
                    continue;
                }

                const backing = deployments.filter((deployment) => matches(podSelector, podsOf(deployment)));
                if (backing.length === 0) {
                    fail(
                        service.rel,
                        `Service \`${service.name}\` selects ${JSON.stringify(podSelector)}, which matches no Deployment's pod template`,
                        "A Service selecting nothing has no endpoints — indistinguishable from a workload that is simply idle. The selector must match `spec.template.metadata.labels`, not the Deployment's own labels, and those two are easy to edit apart.",
                    );
                    continue;
                }

                const target = port.targetPort ?? port.port;
                for (const deployment of backing) {
                    for (const container of containersOf(deployment)) {
                        const declared = (container.ports ?? []).map((p) => p.containerPort);
                        const named = (container.ports ?? []).find((p) => p.name === target);
                        if (typeof target === 'number' ? !declared.includes(target) : named === undefined) {
                            fail(
                                deployment.rel,
                                `Deployment \`${deployment.name}\` container \`${container.name ?? ''}\` does not expose ${typeof target === 'number' ? `port ${target}` : `a port named \`${String(target)}\``}, which Service \`${service.name}\` targets`,
                                `The Service forwards to a port nothing is listening on, so every scrape is refused. Declared containerPorts: ${declared.length > 0 ? declared.join(', ') : 'none'}.`,
                            );
                            continue;
                        }
                        scraped.push({
                            monitor,
                            service,
                            deployment,
                            container: container.name ?? '',
                            podLabels: podsOf(deployment),
                            port: typeof target === 'number' ? target : named?.containerPort,
                            path: endpoint.path ?? '/metrics',
                            interval: endpoint.interval,
                        });
                    }
                }
            }
        }
    }

    // ── 4. The NetworkPolicy admits the monitoring namespace ────────────────
    for (const { deployment, podLabels, port } of scraped) {
        // `podSelector: {}` is Kubernetes' way of saying "every pod in this
        // namespace", and it arrives here with no `matchLabels` at all — so an
        // absent matchLabels under a PRESENT podSelector is the empty selector,
        // not a missing one.
        const applicable = policies.filter((policy) => {
            const podSelector = policy.doc.spec?.podSelector;
            return podSelector !== undefined && matches(podSelector.matchLabels ?? {}, podLabels);
        });
        const admitted = applicable.some((policy) =>
            (policy.doc.spec?.ingress ?? []).some(
                (rule) =>
                    (rule.from ?? []).some(
                        (from) =>
                            from.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] ===
                            monitoringNamespace,
                    ) &&
                    (rule.ports === undefined || rule.ports.some((candidate) => candidate.port === port)),
            ),
        );
        if (!admitted) {
            fail(
                applicable[0]?.rel ?? `${manifestDir}/network-policies`,
                `nothing admits the \`${monitoringNamespace}\` namespace to \`${deployment.name}\` on port ${String(port)}`,
                'Under default-deny the scrape is DROPPED — no refusal, no log, no event. The Service and the ServiceMonitor both look correct while the target sits at DOWN. Add an ingress rule from the monitoring namespace on this port.',
            );
        }
    }

    // ── 5. A scrape-only Service is headless ────────────────────────────────
    // New, from the standard. With a ClusterIP, Prometheus discovers one
    // endpoint and scrapes a RANDOMLY CHOSEN pod each time, so a three-replica
    // workload's gauge jumps between three unrelated series and reads as noise.
    for (const name of headlessServices) {
        const service = services.find((candidate) => candidate.name === name);
        if (service === undefined) {
            fail(
                manifestDir,
                `no Service named \`${name}\``,
                'It is listed as scrape-only, so either it was renamed and this rule stopped applying to anything, or it is gone and nothing is being scraped.',
            );
            continue;
        }
        if (service.doc.spec?.clusterIP !== 'None') {
            fail(
                service.rel,
                `Service \`${name}\` exists only to be scraped but is not headless`,
                'Without `clusterIP: None` there is one endpoint for the whole Deployment, so each scrape lands on whichever pod the proxy picks. Nothing errors; the series simply interleaves samples from different pods, which on a gauge is indistinguishable from the value moving.',
            );
        }
    }

    // ── 6. The scrape interval equals the gauge refresh ─────────────────────
    if (gaugeRefresh !== undefined) {
        if (!exists(gaugeRefresh.file)) {
            fail(
                gaugeRefresh.file,
                'is missing',
                'It is where the gauges are refreshed on a timer; without it this rule checks nothing and the interval below is graded against no number at all.',
            );
        } else {
            const source = code(gaugeRefresh.file);
            const timer = /setInterval\(([\s\S]*?),\s*([\d_]+)\s*\)/.exec(source);
            if (timer === null || !new RegExp(String.raw`\b${gaugeRefresh.call}\s*\(`).test(timer[1] ?? '')) {
                fail(
                    gaugeRefresh.file,
                    `does not call \`${gaugeRefresh.call}()\` on an interval`,
                    'The gauges are then only ever whatever they were at startup, and Prometheus scrapes a constant. A queue that is backing up looks exactly like one that is empty.',
                );
            } else {
                const refreshSeconds = Number((timer[2] ?? '').replace(/_/g, '')) / 1000;
                for (const { monitor, interval } of scraped) {
                    if (interval === undefined || !/^\d+s$/.test(interval)) continue;
                    if (!gaugeRefresh.monitors.test(monitor.name)) continue;
                    const scrapeSeconds = Number(interval.replace('s', ''));
                    if (scrapeSeconds !== refreshSeconds) {
                        fail(
                            monitor.rel,
                            `ServiceMonitor \`${monitor.name}\` scrapes every ${scrapeSeconds}s, but ${gaugeRefresh.file} refreshes the gauges every ${refreshSeconds}s`,
                            'Gauges are point-in-time. Scraping slower than the refresh silently discards samples; scraping faster records the same value repeatedly. Either way a saturation graph misreports when a backlog began, and nothing errors. Keep the two numbers equal.',
                        );
                    }
                }
            }
        }
    }

    // ── 7. Every process that registers metrics serves them ────────────────
    for (const { module, server, label } of metricModules) {
        if (!exists(module)) {
            fail(
                module,
                'is missing',
                `The ${label} metrics module is gone, so this section is checking nothing. If it moved, update the list in the check script rather than leaving the rule silently unenforced.`,
            );
            continue;
        }

        const source = code(module);
        const registers =
            /new\s+(?:Histogram|Gauge|Counter|Summary)\s*\(/.test(source) || /collectDefaultMetrics\s*\(/.test(source);
        if (!registers) continue;

        if (!exists(server)) {
            fail(
                server,
                'is missing',
                `Nothing serves the ${label} metrics, so every one of them is computed and discarded.`,
            );
            continue;
        }

        const serves = code(server);
        if (!/['"`]\/metrics['"`]/.test(serves)) {
            fail(
                server,
                'registers prom-client metrics but serves no /metrics route',
                'prom-client only writes to an in-memory register. With no endpoint exposing it, every metric is computed and then thrown away on each pod restart — the most common way observability work silently produces nothing at all.',
            );
        }
        for (const { monitor, path: scrapePath } of scraped.filter((target) => target.monitor.name.includes(label))) {
            if (!new RegExp(`['"\`]${scrapePath}['"\`]`).test(serves)) {
                fail(
                    monitor.rel,
                    `ServiceMonitor \`${monitor.name}\` scrapes \`${scrapePath}\`, which ${server} does not serve`,
                    'Prometheus gets a 404 on every scrape and records it as a failed target, not as an error anyone is paged for.',
                );
            }
        }
    }

    // ── 8-9, 12. Probe shape ────────────────────────────────────────────────
    for (const deployment of deployments) {
        for (const container of containersOf(deployment)) {
            const declared = (container.ports ?? []).map((p) => p.containerPort);

            if (container.livenessProbe?.exec !== undefined) {
                fail(
                    deployment.rel,
                    `Deployment \`${deployment.name}\` uses an \`exec\` liveness probe: ${JSON.stringify(container.livenessProbe.exec.command)}`,
                    'An exec probe starts a NEW process, which succeeds on its own terms and never touches the one whose health was in question — it passes for a wedged event loop. That is worse than no probe, because it reports health it cannot possibly know. Use an httpGet against the real listener. (Readiness is exempt: `redis-cli ping` genuinely exercises the real server.)',
                );
            }

            for (const [kind, probe] of [
                ['liveness', container.livenessProbe],
                ['readiness', container.readinessProbe],
            ] as const) {
                const port = probe?.httpGet?.port;
                if (typeof port === 'number' && !declared.includes(port)) {
                    fail(
                        deployment.rel,
                        `Deployment \`${deployment.name}\` probes ${kind ?? ''} on port ${port}, which container \`${container.name ?? ''}\` does not declare`,
                        `The probe can never succeed, so the pod is either killed on a loop (liveness) or never enters service (readiness). Declared containerPorts: ${declared.length > 0 ? declared.join(', ') : 'none'}.`,
                    );
                }
            }

            if (ownWorkloads !== undefined && !ownWorkloads.test(deployment.name)) continue;

            const live = container.livenessProbe?.httpGet?.path;
            const ready = container.readinessProbe?.httpGet?.path;

            if (live !== undefined && live !== LIVENESS_PATH) {
                fail(
                    deployment.rel,
                    `Deployment \`${deployment.name}\` probes liveness at \`${live}\``,
                    `Liveness must hit \`${LIVENESS_PATH}\` — the dependency-free endpoint. Any other path risks carrying a dependency check, which turns a database blip into a cluster-wide restart storm: every pod fails at once, all get killed, and not one comes back faster for it.`,
                );
            }
            if (ready !== undefined && ready !== READINESS_PATH) {
                fail(
                    deployment.rel,
                    `Deployment \`${deployment.name}\` probes readiness at \`${ready}\``,
                    `Readiness must hit \`${READINESS_PATH}\` — the dependency-aware one. Pointing it at ${LIVENESS_PATH} means the pod reports ready before its dependencies are up, and the first requests it is sent fail.`,
                );
            }
            if (live !== undefined && live === ready) {
                fail(
                    deployment.rel,
                    `Deployment \`${deployment.name}\` uses \`${live}\` for both liveness and readiness`,
                    'They answer opposite questions and have opposite consequences — one restarts the pod, the other only pulls it from the load balancer. One endpoint cannot mean both.',
                );
            }
        }
    }

    // ── 10. /livez is dependency-free ───────────────────────────────────────
    for (const handler of livezHandlers) {
        if (!exists(handler.file)) {
            fail(
                handler.file,
                'is missing',
                `The ${LIVENESS_PATH} handler this rule reads is gone. If it moved, say so in the check script rather than leaving the rule unenforced.`,
            );
            continue;
        }
        const found = (handler.pattern ?? /app\.get\(\s*['"`]\/livez['"`][\s\S]*?\n\}\);/).exec(
            code(handler.file),
        )?.[0];
        if (found === undefined) {
            fail(
                handler.file,
                `has no recognisable ${LIVENESS_PATH} handler`,
                'Either the endpoint was removed — in which case the liveness probes can never pass — or it was rewritten into a shape this rule no longer recognises. Both need a human.',
            );
            continue;
        }
        if (/\bawait\b/.test(found)) {
            fail(
                handler.file,
                `${LIVENESS_PATH} awaits something`,
                'Liveness must be answerable synchronously. Anything awaited is a dependency, and a dependency in liveness turns an outage into a restart storm. Dependencies belong in readiness, where the pod is merely pulled from the load balancer and recovers by itself.',
            );
        }
        const dependency = DEPENDENCY_CALLS.exec(found)?.[0];
        if (dependency !== undefined) {
            fail(
                handler.file,
                `${LIVENESS_PATH} references a dependency (\`${dependency}\`)`,
                'Same reason: the probe must prove only that this event loop is turning. Move the check to readiness.',
            );
        }
    }

    // ── 11. The readiness check is bounded ──────────────────────────────────
    // New, from the standard. An unbounded ping against a hung Mongo holds the
    // probe open until kubelet's own timeout fires, so the pod reports a probe
    // TIMEOUT instead of the 503 it meant to send.
    for (const handler of healthzHandlers) {
        if (!exists(handler.file)) {
            fail(
                handler.file,
                'is missing',
                `Nothing serves ${READINESS_PATH}, so the readiness probe can never pass and the pod never enters service.`,
            );
            continue;
        }
        const found = (handler.pattern ?? /app\.get\(\s*['"`]\/healthz['"`][\s\S]*?\n\}\);/).exec(
            code(handler.file),
        )?.[0];
        if (found === undefined) {
            fail(
                handler.file,
                `has no recognisable ${READINESS_PATH} handler`,
                'Either it is gone, or it was rewritten into a shape this rule no longer recognises.',
            );
            continue;
        }
        if (/\bawait\b/.test(found) && !/timeoutMS|AbortSignal|timeout:/.test(found)) {
            fail(
                handler.file,
                `${READINESS_PATH} awaits a dependency with no timeout`,
                'A hung dependency then holds the probe open until kubelet times it out, so the pod reports a probe TIMEOUT rather than the 503 it meant to send — slower to react, and a different thing on every dashboard that counts readiness failures. The Mongo driver takes `timeoutMS` natively; no AbortController wrapper is needed.',
            );
        }
    }

    // ── 13. The listener starts before slow init ────────────────────────────
    if (listenBeforeInit !== undefined && exists(listenBeforeInit.file)) {
        // Function DECLARATIONS are blanked first. Where the listener is defined
        // in the same file it starts, `function startMetricsServer(` sits above
        // everything and would be found as the earliest "call" — so the rule
        // would pass on an ordering it never looked at.
        const body = code(listenBeforeInit.file).replace(/\bfunction\s+(\w+)\s*\(/g, (match) =>
            ' '.repeat(match.length),
        );
        const listen = body.search(new RegExp(String.raw`\b${listenBeforeInit.listen}\s*\(`));
        const slowInit = body.search(listenBeforeInit.slowInit);

        if (listen === -1) {
            fail(
                listenBeforeInit.file,
                `never calls \`${listenBeforeInit.listen}\``,
                `The process registers metrics and exposes none of them, and has no ${LIVENESS_PATH} for the kubelet to probe — so the liveness probe fails forever.`,
            );
        } else if (slowInit !== -1 && listen > slowInit) {
            fail(
                listenBeforeInit.file,
                `\`${listenBeforeInit.listen}\` runs after the slow initialisation it is supposed to precede`,
                `${LIVENESS_PATH} must answer while the database is still dialling and the models are still loading. If the listener only starts afterwards, kubelet fails the probe and restarts the pod mid-startup — an endless crash loop that presents as a broken image.`,
            );
        }
    }

    // ── 14. Queue consumers have no readiness probe ─────────────────────────
    if (queueConsumers !== undefined) {
        for (const deployment of deployments) {
            if (!queueConsumers.test(deployment.name)) continue;
            for (const container of containersOf(deployment)) {
                if (container.readinessProbe !== undefined) {
                    fail(
                        deployment.rel,
                        `Deployment \`${deployment.name}\` has a readinessProbe`,
                        "A queue consumer PULLS its work; nothing is routed to it. Readiness gates only a pod's membership in a Service's endpoints, and the only Service here exists so Prometheus can scrape it — so a failing readiness probe would cut off the queue-depth metrics at exactly the moment a dependency blip makes you need them.",
                    );
                }
            }
        }
    }

    // ── 15. Every kube-linter exclusion carries a reason ────────────────────
    if (kubeLinter !== undefined) {
        if (!exists(kubeLinter)) {
            fail(
                kubeLinter,
                'is missing',
                'Nothing records which policies are waived or why, so the next person reads every exclusion as laziness.',
            );
        } else {
            const lines = read(kubeLinter).split('\n');
            for (let i = 0; i < lines.length; i++) {
                const entry = /^\s*-\s*'?([a-z0-9-]+)'?\s*$/.exec(lines[i] ?? '');
                if (entry === null) continue;

                // Walk back over the sibling entries of this list: one comment
                // above a run of exclusions justifies the run, which is how they
                // are actually written.
                let j = i - 1;
                let justified = false;
                while (j >= 0) {
                    if (/^\s*#/.test(lines[j] ?? '')) {
                        justified = true;
                        break;
                    }
                    if (!/^\s*-\s*'?[a-z0-9-]+'?\s*$/.test(lines[j] ?? '')) break;
                    j -= 1;
                }

                if (!justified) {
                    fail(
                        `${kubeLinter}:${i + 1}`,
                        `exclusion \`${entry[1] ?? ''}\` has no comment explaining it`,
                        'A waived policy check with no rationale is indistinguishable from one waived to make the build go green. Write down what makes it inapplicable here, so the next reader can tell whether it still is.',
                    );
                }
            }
        }
    }

    // ── 16. No unbounded metric label ───────────────────────────────────────
    const unbounded = new Set([...UNBOUNDED_LABELS, ...unboundedLabels]);
    for (const { module } of metricModules) {
        if (!exists(module)) continue;
        for (const declaration of code(module).matchAll(/labelNames:\s*\[([^\]]*)\]/g)) {
            const labels = (declaration[1] ?? '')
                .split(',')
                .map((label) => label.trim().replace(/^['"`]|['"`]$/g, ''))
                .filter(Boolean);
            for (const label of labels) {
                if (unbounded.has(label)) {
                    fail(
                        module,
                        `metric label \`${label}\` is unbounded`,
                        `Prometheus holds one time series per distinct label combination, in memory, forever. \`${label}\` has as many values as you have records, so this does not degrade — it takes the server down. Put the identifier in a log line, where it is queryable and costs nothing.`,
                    );
                }
            }
        }
    }

    // ── 17. The route label is a template, never the requested URL ──────────
    if (routeLabel !== undefined && exists(routeLabel.file)) {
        const source = code(routeLabel.file);
        const fn = new RegExp(String.raw`function ${routeLabel.fn}\([\s\S]*?\n\}`).exec(source)?.[0];

        if (fn === undefined) {
            fail(
                routeLabel.file,
                `has no \`${routeLabel.fn}\` function`,
                'The route label is the one metric label here with an unbounded failure mode, and this rule can no longer see how it is built.',
            );
        } else {
            for (const raw of ['req.url', 'req.path', 'req.originalUrl']) {
                if (fn.includes(raw)) {
                    fail(
                        routeLabel.file,
                        `\`${routeLabel.fn}\` uses \`${raw}\``,
                        'That is the REQUESTED url, not the route template, so /api/videos/abc and /api/videos/def become two series. Anyone spraying random paths can then mint unbounded series until Prometheus falls over. Build it from `req.baseUrl` + `req.route.path`.',
                    );
                }
            }
            if (!fn.includes('req.baseUrl')) {
                fail(
                    routeLabel.file,
                    `\`${routeLabel.fn}\` does not use \`req.baseUrl\``,
                    "`req.route.path` alone is relative to the router's mount point, so every router's `/:id` collapses into ONE histogram — /api/videos/:id and /api/channels/:id share a series and the p95 becomes an average across unrelated endpoints. Nothing fails; the dashboards just render numbers that are quietly wrong.",
                );
            }
            if (!/return\s+['"`]unknown['"`]/.test(fn)) {
                fail(
                    routeLabel.file,
                    `\`${routeLabel.fn}\` has no \`unknown\` fallback`,
                    'Unmatched 404s never reach a route handler and have no template. Without a single collapsed bucket for them they are labelled by whatever was requested, which is the unbounded-cardinality hole in a different disguise.',
                );
            }
        }
    }

    // ── 18. CI knows about every CRD the manifests use ──────────────────────
    const crdKinds = [...new Set(resources.map((resource) => resource.kind))]
        .filter((kind) => !CORE_KINDS.has(kind) && !KUSTOMIZE_KINDS.has(kind))
        .sort();

    if (workflow !== undefined) {
        if (!exists(workflow)) {
            fail(
                workflow,
                'is missing',
                `Nothing validates the manifests in CI, so the CRD kinds in use (${crdKinds.join(', ')}) are unchecked until apply time.`,
            );
        } else {
            const source = read(workflow);
            for (const kind of crdKinds) {
                const pluralKind = `${kind.toLowerCase()}s`;
                if (!source.includes(pluralKind)) {
                    fail(
                        workflow,
                        `does not install the CRD for \`${kind}\``,
                        `A server-side dry-run resolves every kind against the live API and rejects an unregistered one outright as "no matches for kind". Add the ${pluralKind} CRD to the install step.`,
                    );
                }
                if (new RegExp(String.raw`-skip[^\n]*\b${kind}\b`).test(source)) {
                    fail(
                        workflow,
                        `passes \`-skip ${kind}\` to kubeconform`,
                        'A skipped kind is not schema-checked at all, so a typo in it sails through CI and only surfaces at apply time. Resolve the schema instead — `-schema-location` against the CRDs catalog validates it properly.',
                    );
                }
            }
        }
    }

    return {
        problems,
        counts: {
            monitors: monitors.length,
            services: new Set(scraped.map((target) => target.service.name)).size,
            workloads: new Set(scraped.map((target) => target.deployment.name)).size,
            crdKinds,
        },
    };
}

/**
 * Run the gate and print.
 */
export function checkMetrics({ root = REPO_ROOT, standard, ...rest }: MetricsOptions): void {
    const report = createGateReport({ name: 'Metrics', ...(standard === undefined ? {} : { standard }) });
    const { problems, counts } = inspectMetrics({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `${plural(counts.monitors, 'ServiceMonitor')} resolving through ${plural(counts.services, 'named Service port')} ` +
            `to ${plural(counts.workloads, 'workload')}, each admitted from the monitoring namespace and scraped in step with the gauge refresh; ` +
            `probes by httpGet only, ${LIVENESS_PATH} dependency-free and listening before slow init, no unbounded metric label, ` +
            `and ${plural(counts.crdKinds.length, 'CRD kind')} registered for CI${counts.crdKinds.length > 0 ? ` (${counts.crdKinds.join(', ')})` : ''}.`,
        notMachineChecked:
            'Whether a metric is worth collecting, whether the histogram buckets suit the real latency distribution, or whether an alert threshold is the right one. Nor whether Prometheus is deployed at all — this proves the chain is wired, not that anything is listening at the far end of it.',
    });
}

export default checkMetrics;
