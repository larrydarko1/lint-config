/**
 * The metrics gate's route-label rule. The label must be a template from the
 * API's route table, looked up by method and path, because a label rebuilt
 * from the request is wrong exactly when the request failed.
 */
import { collectFailures, type GateFailure } from './report.ts';
import { callSites } from './source.ts';

export type RouteLabel = {
    /** The file holding the label function. */
    file: string;
    /** The label function's name. */
    fn: string;
    /** The route lookup it calls: method and path in, the route's template or nothing out. Defaults to `routeOf`. */
    lookup?: string;
};

/**
 * Everything wrong with how `fn` in `source` builds the route label.
 *
 * @param source The file's code, comments already blanked.
 */
export function routeLabelProblems(source: string, { file, fn: name, lookup = 'routeOf' }: RouteLabel): GateFailure[] {
    const { problems, fail } = collectFailures();
    const fn = new RegExp(String.raw`function ${name}\([\s\S]*?\n\}`).exec(source)?.[0];

    if (fn === undefined) {
        fail(
            file,
            `has no \`${name}\` function`,
            'The route label is the one metric label here with an unbounded failure mode, and this rule can no longer see how it is built.',
        );
        return problems;
    }

    // A call, not a longer name ending in it (`myrouteOf(`)
    const lookups = callSites(fn, `${lookup}(`).filter(({ index }) => !/[\w$]/.test(fn[index - 1] ?? ''));
    if (lookups.length === 0) {
        fail(
            file,
            `\`${name}\` does not look the route up with \`${lookup}\``,
            "Rebuilt from the request, the label is wrong exactly when it matters. By the time a refused request finishes, Express has left the router and emptied `req.baseUrl`, so every router's `/:id` shares one series; a mount's own `:param` arrives as its value, one series per record; and a 401 or 429 from a mount's middleware never reached a route at all. Looked up in the route table, every request is labelled with a template from a fixed list.",
        );
    }

    // The requested path is the lookup's key, and nothing else
    const outside = lookups.reduceRight((text, { index, end }) => text.slice(0, index) + text.slice(end + 1), fn);
    for (const raw of ['req.url', 'req.path', 'req.originalUrl'].filter((ref) => outside.includes(ref))) {
        fail(
            file,
            `\`${name}\` uses \`${raw}\` outside \`${lookup}\``,
            'That is the REQUESTED url, not the route template, so /api/videos/abc and /api/videos/def become two series. Anyone spraying random paths can then mint unbounded series until Prometheus falls over. Pass it to the route lookup and label with what that returns.',
        );
    }

    if (fn.includes('req.baseUrl')) {
        fail(
            file,
            `\`${name}\` uses \`req.baseUrl\``,
            "It holds the mount prefix only while the request is inside the router. A response the error handler sends finishes after Express has reset it to the app's, so the label loses its prefix on exactly the requests that failed.",
        );
    }

    if (!/return\s+['"`]unknown['"`]/.test(fn)) {
        fail(
            file,
            `\`${name}\` has no \`unknown\` fallback`,
            'A request no route serves has no template. Without a single collapsed bucket for it, it is labelled by whatever was requested, which is the unbounded-cardinality hole in a different disguise.',
        );
    }

    return problems;
}
