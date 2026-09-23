export type PipelineOptions = {
    /** Repository root. Defaults to the caller's repo root. */
    root?: string;
    /** Where the `check-*.ts` gate scripts live. Fern's family spells it `scripts/check`, singular. */
    checksDir?: string;
    /** The workflow that must run every gate. */
    ciWorkflow?: string;
};

export declare function checkPipeline(options?: PipelineOptions): void;
export default checkPipeline;
