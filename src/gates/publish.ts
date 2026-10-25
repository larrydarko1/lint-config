/**
 * The package as an installer gets it: packed, unpacked under a real `node_modules`, then
 * every entry point imported by Node and type-checked by tsc.
 * –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
 *   1. The tarball packs (npm runs `prepack`, so the build runs too).
 *   2. It ships no TypeScript source: Node refuses to strip types under `node_modules`.
 *   3. Every file `exports`, `main`, `types` and `bin` name is in the tarball.
 *   4. Every `bin` starts with a `#!` line, or the shell cannot run it.
 *   5. Every entry point loads in Node, from the installed copy.
 *   6. Every entry point's declarations resolve, with `skipLibCheck` off.
 *
 * - The test suite runs the sources, and a `file:` install is a symlink whose realpath is
 * outside `node_modules`, so neither sees rules 2 and 6: a copy that only breaks once
 * published. `skipLibCheck` turns a declaration that cannot resolve into a silent `any`
 * rather than an error, which is why rule 6 runs with it off.
 * - Not checked: subpath patterns (`./*`), which name no one file to load.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packageBin } from './lib/bin.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';

export type PublishOptions = {
    /** The package's directory, holding its package.json. Defaults to the repo root. */
    root?: string;
};

type PublishInspection = {
    problems: GateFailure[];
    counts: {
        /** Specifiers imported and type-checked: one per subpath export. */
        entryPoints: number;
        /** Named exports across every entry point that loaded. */
        exports: number;
        /** Files in the tarball. */
        files: number;
        /** Subpath patterns, which name no one file and are not loaded. */
        patterns: number;
    };
};

/** package.json, as far as this gate reads it. */
type Manifest = {
    name?: string;
    main?: string;
    types?: string;
    bin?: string | Record<string, string>;
    exports?: unknown;
};

/** What the loader script prints for each specifier. */
type Loaded = Record<string, { names: string[] } | { error: string }>;

/** The consumer's compiler: strict, Node's resolution, and `skipLibCheck` off (rule 6). `types` is set per package. */
const CONSUMER_TSCONFIG = {
    compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2024',
        skipLibCheck: false,
    },
    files: ['consumer.ts'],
};

export function inspectPublish(input: PublishOptions = {}): PublishInspection {
    const { root = REPO_ROOT } = input;
    const problems: GateFailure[] = [];
    const fail = (file: string | null, what: string, why: string) => {
        problems.push({ file, what, why });
    };

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
    if (pkg.name === undefined) throw new Error('package.json has no `name`, so there is nothing to install.');
    const { name } = pkg;
    const subpaths = exportedSubpaths(pkg);
    const patterns = subpaths.filter(([subpath]) => subpath.includes('*')).length;
    const entries = subpaths.filter(([subpath]) => !subpath.includes('*'));
    const specifierOf = (subpath: string) => (subpath === '.' ? name : `${name}${subpath.slice(1)}`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-config-publish-'));
    try {
        // A package that resolves its caller's repository on import finds this one.
        fs.mkdirSync(path.join(work, '.git'));

        // ── 1. Pack and unpack, as a registry install would ─────────────────
        // Under `npm publish --dry-run` the flag reaches this gate as npm_config_dry_run, and a
        // dry-run pack reports a filename without writing the tarball, so it is dropped here.
        const { npm_config_dry_run: _dryRun, ...env } = process.env;
        const packed = JSON.parse(
            execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
                cwd: root,
                encoding: 'utf8',
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        ) as { filename: string; files: { path: string }[] }[];
        const [{ filename, files } = { filename: '', files: [] }] = packed;
        const shipped = new Set(files.map((file) => file.path));

        const installed = path.join(work, 'node_modules', ...name.split('/'));
        fs.mkdirSync(installed, { recursive: true });
        execFileSync('tar', ['-xzf', path.join(work, filename), '-C', installed, '--strip-components=1']);
        linkDependencies(path.join(root, 'node_modules'), path.join(work, 'node_modules'), name);

        // ── 2. No TypeScript source ─────────────────────────────────────────
        for (const file of shipped) {
            if (/\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) {
                fail(
                    file,
                    'TypeScript source in the tarball',
                    'Node refuses to strip types from a file under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an import that reaches it fails once installed. Ship the compiled output, and keep the sources out of `files`.',
                );
            }
        }

        // ── 3–4. Every file the manifest names is packed; bins are runnable ─
        /** Subpaths naming a file that is not there, which rules 5 and 6 would only report again. */
        const unpacked = new Set<string>();
        for (const [field, target, subpath] of namedFiles(pkg, entries)) {
            const file = path.posix.normalize(target);
            if (!shipped.has(file)) {
                if (subpath !== null) unpacked.add(subpath);
                fail(
                    'package.json',
                    `\`${field}\` names ${file}, which is not in the tarball`,
                    'An installer resolves the field to a file that is not there. Build before packing (a `prepack` script), or add the directory to `files`.',
                );
            } else if (
                field.startsWith('bin') &&
                !fs.readFileSync(path.join(installed, file), 'utf8').startsWith('#!')
            ) {
                fail(
                    file,
                    `\`${field}\` has no \`#!\` line`,
                    'npm links the file onto PATH as it is, and the shell runs it as a shell script without one. Start it with `#!/usr/bin/env node`.',
                );
            }
        }

        // ── 5. Every entry point loads ──────────────────────────────────────
        const specifiers = entries
            .filter(([subpath]) => !unpacked.has(subpath))
            .map(([subpath]) => specifierOf(subpath));
        fs.writeFileSync(path.join(work, 'load.mjs'), loaderScript(specifiers));
        const loaded = JSON.parse(
            execFileSync(process.execPath, ['load.mjs'], { cwd: work, encoding: 'utf8' }),
        ) as Loaded;
        let exports = 0;
        for (const specifier of specifiers) {
            const result = loaded[specifier];
            if (result !== undefined && 'names' in result) {
                exports += result.names.length;
                continue;
            }
            fail(
                specifier,
                `does not load: ${result?.error ?? 'no result'}`,
                'This is the error a project gets on its first import. The suite runs the sources, so only the installed copy shows it.',
            );
        }

        // ── 6. Every declaration resolves ───────────────────────────────────
        // Errors in other packages' typings are theirs, so only this package's files and the consumer count.
        fs.writeFileSync(
            path.join(work, 'consumer.ts'),
            `${specifiers.map((s, i) => `export * as m${i} from ${JSON.stringify(s)};`).join('\n')}\n`,
        );
        // Node's own types, where the package has them to give: its declarations may name them.
        const types = fs.existsSync(path.join(root, 'node_modules/@types/node')) ? ['node'] : [];
        const tsconfig = { ...CONSUMER_TSCONFIG, compilerOptions: { ...CONSUMER_TSCONFIG.compilerOptions, types } };
        fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify(tsconfig));
        for (const line of typeErrors(work)) {
            const consumer = /^consumer\.ts\((\d+),/.exec(line);
            const own = line.startsWith(`node_modules/${name}/`);
            if (consumer === null && !own) continue;
            const file = consumer === null ? line.slice(0, line.indexOf('(')) : specifiers[Number(consumer[1]) - 1];
            fail(
                file ?? null,
                line.slice(line.indexOf(': ') + 2),
                'With skipLibCheck on, as a project runs, this is not reported at all: the symbols behind it become the error type, which reads as `any`.',
            );
        }

        return { problems, counts: { entryPoints: entries.length, exports, files: shipped.size, patterns } };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

export function checkPublish(options: PublishOptions = {}): void {
    const report = createGateReport({ name: 'Publish' });

    let inspection;
    try {
        inspection = inspectPublish(options);
    } catch (error) {
        console.error(`✗ Publish check failed — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    const { problems, counts } = inspection;
    for (const { file, what, why } of problems) report.fail(file, what, why);

    const skipped = counts.patterns > 0 ? ` ${plural(counts.patterns, 'subpath pattern')} not loaded.` : '';
    report.done({
        summary: `${plural(counts.entryPoints, 'entry point')} load and type-check from a packed install (${plural(counts.exports, 'export')}), ${plural(counts.files, 'file')} packed, no TypeScript source.${skipped}`,
        notMachineChecked:
            'Whether each export behaves as documented, whether a subpath pattern resolves for every file it matches, or whether the package runs on the oldest Node `engines` admits.',
    });
}

/**
 * `[subpath, target]` for every export, `.` for the package itself. A manifest with no
 * `exports` is imported by its name alone, through `main`.
 */
function exportedSubpaths(pkg: Manifest): [string, unknown][] {
    const { exports } = pkg;
    if (exports === undefined) return [['.', pkg.main]];
    const isSubpathMap =
        typeof exports === 'object' && exports !== null && Object.keys(exports).every((key) => key.startsWith('.'));
    return isSubpathMap ? Object.entries(exports) : [['.', exports]];
}

/** Every file path a condition object leads to, however deeply nested. */
function targetsOf(target: unknown): string[] {
    if (typeof target === 'string') return [target];
    if (Array.isArray(target)) return target.flatMap(targetsOf);
    if (typeof target === 'object' && target !== null) return Object.values(target).flatMap(targetsOf);
    return [];
}

/** `[field, file, subpath]` for every file the manifest promises an installer; `subpath` for an export. */
function namedFiles(pkg: Manifest, entries: [string, unknown][]): [string, string, string | null][] {
    const bins = typeof pkg.bin === 'string' ? { [pkg.name ?? '']: pkg.bin } : (pkg.bin ?? {});
    const fields: [string, string | undefined][] = [
        ['main', pkg.main],
        ['types', pkg.types],
        ...Object.entries(bins).map(([bin, file]): [string, string] => [`bin.${bin}`, file]),
    ];
    return [
        ...entries.flatMap(([subpath, target]) =>
            targetsOf(target).map((file): [string, string, string] => [`exports["${subpath}"]`, file, subpath]),
        ),
        ...fields.flatMap(([field, file]): [string, string, null][] =>
            file === undefined ? [] : [[field, file, null]],
        ),
    ];
}

/**
 * The dependencies come from the package's own install, linked in beside it. A scope
 * is linked member by member, so the package's own place in it stays its own.
 */
function linkDependencies(from: string, to: string, self: string): void {
    if (!fs.existsSync(from)) return;
    for (const entry of fs.readdirSync(from)) {
        if (entry.startsWith('.') || entry === self) continue;
        if (!entry.startsWith('@')) {
            fs.symlinkSync(path.join(from, entry), path.join(to, entry));
            continue;
        }
        fs.mkdirSync(path.join(to, entry), { recursive: true });
        for (const member of fs.readdirSync(path.join(from, entry))) {
            if (`${entry}/${member}` === self) continue;
            fs.symlinkSync(path.join(from, entry, member), path.join(to, entry, member));
        }
    }
}

/** One import per specifier, each caught on its own, so one broken entry point hides no other. */
function loaderScript(specifiers: string[]): string {
    const imports = specifiers.map((s) => {
        const key = JSON.stringify(s);
        return `try { out[${key}] = { names: Object.keys(await import(${key})) }; } catch (e) { out[${key}] = { error: String(e?.message ?? e).split('\\n')[0] }; }`;
    });
    return `const out = {};\n${imports.join('\n')}\nconsole.log(JSON.stringify(out));\n`;
}

/** tsc's diagnostics for the consumer, one per line. tsc exits non-zero when there are any. */
function typeErrors(work: string): string[] {
    try {
        execFileSync(process.execPath, [packageBin('typescript', 'tsc'), '-p', 'tsconfig.json', '--pretty', 'false'], {
            cwd: work,
            encoding: 'utf8',
        });
        return [];
    } catch (error) {
        return ((error as { stdout?: string }).stdout ?? '')
            .split('\n')
            .filter((line) => /\(\d+,\d+\): error /.test(line));
    }
}
