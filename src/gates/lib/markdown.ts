/**
 * Markdown read as prose: code is quoted, not said, so a scan blanks it first.
 */

/** Blank out fenced blocks and inline code spans, keeping line numbers. */
export function stripMarkdownCode(source: string): string {
    return source
        .replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}
