/**
 * A Kubernetes manifest, as far as the metrics gate reads one. Parsed YAML is whatever the
 * file says, so a document is only typed once every field the gate reads has its type.
 */
import { isRecord } from './json.ts';

/** YAML reads `version: 2` as a number; the gate matches labels by their text. */
export type Labels = Record<string, string | number | boolean>;

type K8sPort = {
    name?: string;
    port?: number;
    targetPort?: number | string;
    containerPort?: number;
};

type Probe = {
    exec?: { command?: string[] };
    httpGet?: { path?: string; port?: number | string };
};

export type Container = {
    name?: string;
    ports?: K8sPort[];
    livenessProbe?: Probe;
    readinessProbe?: Probe;
};

export type K8sDoc = {
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
};

/** True when every field the gate reads has the type the type above names. */
export function isK8sDoc(doc: unknown): doc is K8sDoc {
    if (!isRecord(doc) || !isOptional(doc['kind'], isString)) return false;
    const { metadata, spec } = doc;
    if (
        !isOptional(
            metadata,
            (value) => isRecord(value) && isOptional(value['name'], isString) && isOptional(value['labels'], isLabels),
        )
    )
        return false;
    return isOptional(spec, isSpec);
}

function isSpec(spec: unknown): boolean {
    if (!isRecord(spec)) return false;
    const { selector, clusterIP, endpoints, ports, template, podSelector, ingress } = spec;
    return (
        isOptional(selector, (value) => isRecord(value) && isOptional(value['matchLabels'], isLabels)) &&
        isOptional(clusterIP, isString) &&
        isOptional(endpoints, (value) => isListOf(value, isEndpoint)) &&
        isOptional(ports, (value) => isListOf(value, isPort)) &&
        isOptional(template, isTemplate) &&
        isOptional(podSelector, isLabelSelector) &&
        isOptional(ingress, (value) => isListOf(value, isIngressRule))
    );
}

const isTemplate = (template: unknown): boolean =>
    isRecord(template) &&
    isOptional(template['metadata'], (value) => isRecord(value) && isOptional(value['labels'], isLabels)) &&
    isOptional(
        template['spec'],
        (value) => isRecord(value) && isOptional(value['containers'], (list) => isListOf(list, isContainer)),
    );

const isContainer = (container: unknown): boolean =>
    isRecord(container) &&
    isOptional(container['name'], isString) &&
    isOptional(container['ports'], (value) => isListOf(value, isPort)) &&
    isOptional(container['livenessProbe'], isProbe) &&
    isOptional(container['readinessProbe'], isProbe);

const isProbe = (probe: unknown): boolean =>
    isRecord(probe) &&
    isOptional(
        probe['exec'],
        (value) => isRecord(value) && isOptional(value['command'], (list) => isListOf(list, isString)),
    ) &&
    isOptional(
        probe['httpGet'],
        (value) => isRecord(value) && isOptional(value['path'], isString) && isOptional(value['port'], isPortRef),
    );

const isPort = (port: unknown): boolean =>
    isRecord(port) &&
    isOptional(port['name'], isString) &&
    isOptional(port['port'], isNumber) &&
    isOptional(port['targetPort'], isPortRef) &&
    isOptional(port['containerPort'], isNumber);

const isEndpoint = (endpoint: unknown): boolean =>
    isRecord(endpoint) && ['port', 'path', 'interval'].every((key) => isOptional(endpoint[key], isString));

const isIngressRule = (rule: unknown): boolean =>
    isRecord(rule) &&
    isOptional(rule['from'], (list) =>
        isListOf(list, (peer) => isRecord(peer) && isOptional(peer['namespaceSelector'], isLabelSelector)),
    ) &&
    isOptional(rule['ports'], (value) => isListOf(value, isPort));

const isLabelSelector = (selector: unknown): boolean =>
    isRecord(selector) && isOptional(selector['matchLabels'], isLabels);

const isLabels = (labels: unknown): boolean =>
    isRecord(labels) && Object.values(labels).every((value) => ['string', 'number', 'boolean'].includes(typeof value));

const isPortRef = (port: unknown): boolean => isNumber(port) || isString(port);

const isOptional = (value: unknown, check: (present: unknown) => boolean): boolean =>
    value === undefined || check(value);

const isListOf = (list: unknown, check: (item: unknown) => boolean): boolean =>
    Array.isArray(list) && list.every(check);

const isString = (value: unknown): boolean => typeof value === 'string';

const isNumber = (value: unknown): boolean => typeof value === 'number';
