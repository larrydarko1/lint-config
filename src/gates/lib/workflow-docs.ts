/**
 * A GitHub workflow or composite action, as far as the pipeline gate walks one.
 */
import { isRecord } from './json.ts';

/*
 * Parsed YAML is whatever the file says. Only the containers the gate walks through are
 * named; every value it reads is `unknown` and checked where it is read.
 */
type StepInputs = { cache?: unknown; ref?: unknown; tags?: unknown; push?: unknown; [input: string]: unknown };
export type Step = { uses?: unknown; run?: unknown; name?: unknown; if?: unknown; with?: StepInputs | null };
type Permissions = string | Record<string, unknown> | null;
export type Job = {
    'runs-on'?: unknown;
    'timeout-minutes'?: unknown;
    'if'?: unknown;
    'needs'?: unknown;
    'permissions'?: Permissions;
    'steps'?: unknown;
    'strategy'?: { matrix?: { include?: unknown; [key: string]: unknown } | null } | null;
};
export type WorkflowDoc = {
    name?: unknown;
    on?: unknown;
    /** YAML 1.1 reads a bare `on:` key as the boolean `true`. */
    true?: unknown;
    jobs?: Record<string, Job> | null;
    concurrency?: unknown;
    permissions?: Permissions;
    /** A composite action's steps. */
    runs?: Job;
};

/** The first container this gate walks that is not the map or list it should be, by its path. */
export function workflowShapeProblem(doc: Record<string, unknown>): string | null {
    const { jobs, runs, permissions } = doc;
    if (!isPermissions(permissions)) return '`permissions` is neither a scope nor a map of scopes';
    if (runs !== undefined) return jobShapeProblem(runs, 'runs');
    if (jobs === undefined || jobs === null) return null;
    if (!isRecord(jobs)) return '`jobs` is not a map of jobs';
    for (const [name, job] of Object.entries(jobs)) {
        const problem = jobShapeProblem(job, `jobs.${name}`);
        if (problem !== null) return problem;
    }
    return null;
}

export const isWorkflowDoc = (doc: Record<string, unknown>): doc is WorkflowDoc => workflowShapeProblem(doc) === null;

export const isStep = (step: unknown): step is Step =>
    isRecord(step) && (step['with'] === undefined || step['with'] === null || isRecord(step['with']));

function jobShapeProblem(job: unknown, at: string): string | null {
    if (!isRecord(job)) return `\`${at}\` is not a map`;
    if (!isPermissions(job['permissions'])) return `\`${at}.permissions\` is neither a scope nor a map of scopes`;
    const { steps, strategy } = job;
    if (steps !== undefined && steps !== null && !(Array.isArray(steps) && steps.every(isStep))) {
        return `\`${at}.steps\` is not a list of steps, each a map`;
    }
    if (strategy === undefined || strategy === null) return null;
    if (!isRecord(strategy)) return `\`${at}.strategy\` is not a map`;
    const { matrix } = strategy;
    return matrix === undefined || matrix === null || isRecord(matrix)
        ? null
        : `\`${at}.strategy.matrix\` is not a map`;
}

const isPermissions = (value: unknown): value is Permissions | undefined =>
    value === undefined || value === null || typeof value === 'string' || isRecord(value);
