/**
 * A Dockerfile read into stages and instructions, without a Docker daemon: continuation
 * lines joined, comments dropped, global ARGs substituted into FROM lines.
 */
export type Instruction = { instruction: string; args: string; line: number };
export type Stage = { name: string | null; base: string; from: number; instructions: Instruction[] };

/** The stages, with each FROM's flags dropped and global ARGs (before the first FROM) substituted. */
export function parseStages(src: string): Stage[] {
    const stages: Stage[] = [];
    const globalArgs = new Map<string, string>();
    for (const ins of parseInstructions(src)) {
        if (ins.instruction === 'FROM') {
            const args = ins.args
                .replace(/^(?:--\S+\s+)*/, '')
                .replace(
                    /\$\{(\w+)\}|\$(\w+)/g,
                    (whole: string, braced?: string, bare?: string) => globalArgs.get(braced ?? bare ?? '') ?? whole,
                );
            const m = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
            stages.push({ name: m?.[2] ?? null, base: m?.[1] ?? args, from: ins.line, instructions: [] });
        } else if (stages.length === 0) {
            // An ARG before the first FROM is global: a FROM line may name it.
            const m = ins.instruction === 'ARG' ? /^(\w+)=(\S+)/.exec(ins.args) : null;
            if (m !== null) {
                globalArgs.set(m[1] ?? '', (m[2] ?? '').replace(/^["']|["']$/g, ''));
            }
        } else {
            stages.at(-1)?.instructions.push(ins);
        }
    }
    return stages;
}

/** A stage and every stage it is built `FROM`, root first: the chain USER, ENV and HEALTHCHECK inherit down. */
export function chainOf(stages: Stage[], stage: Stage): Stage[] {
    const chain: Stage[] = [stage];
    for (let parent = parentOf(stages, stage); parent !== undefined; parent = parentOf(stages, parent)) {
        chain.unshift(parent);
    }
    return chain;
}

/** The earlier stage `stage` is built FROM, if any (case-insensitive). Only earlier stages count, so no loops. */
export function parentOf(stages: Stage[], stage: Stage): Stage | undefined {
    const base = stage.base.toLowerCase();
    return stages
        .slice(0, stages.indexOf(stage))
        .filter((s) => s.name?.toLowerCase() === base)
        .at(-1);
}

/** The last instance of `instruction` in force for `stage`, inherited included. */
export function effective(stages: Stage[], stage: Stage, instruction: string): Instruction | undefined {
    return chainOf(stages, stage)
        .flatMap((s) => s.instructions)
        .filter((i) => i.instruction === instruction)
        .at(-1);
}

/** `ENV A=1 B=2` and the legacy `ENV A 1` both, as name/value pairs. */
export function assignments(args: string): [string, string][] {
    if (!args.includes('=')) {
        const m = /^([A-Za-z_]\w*)\s+(.+)$/.exec(args);
        return m === null ? [] : [[m[1] ?? '', (m[2] ?? '').trim()]];
    }
    return [...args.matchAll(/([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)/g)].map((m) => [
        m[1] ?? '',
        (m[2] ?? '').replace(/^["']|["']$/g, ''),
    ]);
}

/**
 * The instructions of a Dockerfile, with continuation lines joined and comment
 * lines dropped — including a comment inside a continued instruction, which
 * Docker also ignores.
 */
function parseInstructions(src: string): Instruction[] {
    const out: Instruction[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let text = lines[i] ?? '';
        if (/^\s*(#|$)/.test(text)) continue;
        const start = i;
        while (/\\\s*$/.test(text) && i + 1 < lines.length) {
            text = text.replace(/\\\s*$/, ' ');
            i++;
            const next = lines[i] ?? '';
            text += /^\s*#/.test(next) ? ' \\' : next;
        }
        const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(text);
        if (m !== null) {
            out.push({ instruction: (m[1] ?? '').toUpperCase(), args: (m[2] ?? '').trim(), line: start + 1 });
        }
    }
    return out;
}
