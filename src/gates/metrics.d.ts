/** Observability gate — the scrape chain, the probes, and metric cardinality. See metrics.js. */

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

/** Every metric relationship this repo can be asked about, as a list of problems. */
export declare function inspectMetrics(input: MetricsInput): MetricsInspection;

/** Run the gate and print. */
export declare function checkMetrics(options: MetricsOptions): void;

export default checkMetrics;
