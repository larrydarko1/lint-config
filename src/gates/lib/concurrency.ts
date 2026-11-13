/**
 * The pipeline gate's rules 2 and 20: how runs of one workflow share the runner.
 * Every workflow says what a newer run does to an older one (`cancel-in-progress`),
 * and one that publishes a GitHub release is a single queue that never cancels,
 * because a release stopped half-way or racing another ships installers from a
 * commit other than the one its tag points at.
 */
import { isRecord } from './json.ts';
import type { GateFailure } from './report.ts';

type ConcurrencyInput = {
    rel: string;
    /** The workflow's top-level `concurrency`, as parsed. */
    concurrency: unknown;
    /** Every step of every job. */
    steps: { uses?: unknown; run?: unknown }[];
};

type Concurrency = {
    problems: GateFailure[];
    /** Workflows that publish a GitHub release. */
    releases: number;
};

const RELEASE_ACTION = /(?:^|\/)action-gh-release@/;
const RELEASE_COMMAND = /\bgh\s+release\s+(?:create|upload|edit)\b/;
const COMMIT_GROUP = /\bgithub\.(?:sha|event\.workflow_run\.head_sha)\b/;

export function inspectConcurrency(workflows: ConcurrencyInput[]): Concurrency {
    const problems: GateFailure[] = [];
    let releases = 0;

    for (const { rel, concurrency, steps } of workflows) {
        if (concurrency === undefined) {
            problems.push({
                file: rel,
                what: 'declares no `concurrency`',
                why: 'Three pushes in a minute queue three complete runs, and the last answer to arrive is for the oldest commit. Group by ref (or by branch, for workflow_run) so a newer run supersedes a stale one.',
            });
            continue;
        }
        const block = isRecord(concurrency) ? concurrency : null;
        if (block?.['cancel-in-progress'] === undefined) {
            problems.push({
                file: rel,
                what: '`concurrency` does not set `cancel-in-progress`',
                why: 'Omitting the key defaults it to false — runs serialise instead of superseding. Set it explicitly either way: true for checks and builds, false for anything destructive like a registry prune, where cancelling half-way leaves the mess it was cleaning.',
            });
        }

        const publishes = steps.some(
            (step) =>
                (typeof step.uses === 'string' && RELEASE_ACTION.test(step.uses)) ||
                (typeof step.run === 'string' && RELEASE_COMMAND.test(step.run)),
        );
        if (!publishes) continue;
        releases += 1;
        if (block === null) continue;

        const cancel = block['cancel-in-progress'];
        if (cancel !== undefined && cancel !== false) {
            problems.push({
                file: rel,
                what: 'publishes a release but cancels in-progress runs',
                why: 'A later push stops the release half-way: the tag is pushed and the draft open, and the next run resumes that tag from its own commit, so the installers do not match the tag. Set `cancel-in-progress: false`, so runs queue behind it.',
            });
        }
        if (typeof block['group'] === 'string' && COMMIT_GROUP.test(block['group'])) {
            problems.push({
                file: rel,
                what: 'publishes a release but groups concurrency by commit',
                why: "Every commit is a group of its own, so a later push's run starts while the release is still building, finds the draft unpublished, and uploads installers from its own commit over it. Group by the workflow (`github.workflow`) or, for a tag-triggered release, by the tag (`github.ref`).",
            });
        }
    }

    return { problems, releases };
}
