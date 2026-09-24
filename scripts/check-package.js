/**
 * The package as a consumer gets it: packed, unpacked under a real `node_modules`,
 * then every export imported by Node and type-checked by tsc.
 *
 * `npm test` runs the sources, and a local `file:` install is a symlink whose realpath
 * is outside `node_modules`, so neither of them can see the two ways a published copy
 * breaks: Node refusing a `.ts` file under `node_modules`, and a declaration that fails
 * to resolve — which `skipLibCheck` turns into a silent `any` rather than an error.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-config-pack-'));
try {
    // The gates resolve the repository they run in when imported; a consumer is always inside one.
    fs.mkdirSync(path.join(work, '.git'));

    // ── Pack and unpack, as a registry install would ────────────────────────
    const [{ filename }] = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }),
    );
    const installed = path.join(work, 'node_modules', ...pkg.name.split('/'));
    fs.mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(work, filename), '-C', installed, '--strip-components=1']);

    const shipped = execFileSync('tar', ['-tzf', path.join(work, filename)], { encoding: 'utf8' });
    const stray = shipped.split('\n').filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
    if (stray.length > 0) throw new Error(`the tarball ships TypeScript sources:\n  ${stray.join('\n  ')}`);

    // Dependencies come from this repo's install, linked in beside the package.
    for (const entry of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
        if (entry.startsWith('.') || entry === pkg.name.split('/')[0]) continue;
        fs.symlinkSync(path.join(ROOT, 'node_modules', entry), path.join(work, 'node_modules', entry));
    }

    // ── Every export loads in Node ──────────────────────────────────────────
    const specifiers = Object.keys(pkg.exports).map((key) => pkg.name + key.slice(1));
    const loaded = {};
    fs.writeFileSync(
        path.join(work, 'load.mjs'),
        `const out = {};\n${specifiers
            .map((s) => `out[${JSON.stringify(s)}] = Object.keys(await import(${JSON.stringify(s)}));`)
            .join('\n')}\nconsole.log(JSON.stringify(out));\n`,
    );
    Object.assign(loaded, JSON.parse(execFileSync('node', ['load.mjs'], { cwd: work, encoding: 'utf8' })));

    // ── Every declaration resolves ──────────────────────────────────────────
    // Checked with skipLibCheck OFF, because that is the only way to see it: with it on, as a
    // consumer runs, an import this package's declarations cannot resolve is not reported at
    // all — the symbols behind it just become the error type, which reads as `any`. Errors in
    // other packages' typings are theirs, so only this package's files and the consumer count.
    fs.writeFileSync(
        path.join(work, 'consumer.ts'),
        specifiers.map((s, i) => `export * as m${i} from ${JSON.stringify(s)};`).join('\n') + '\n',
    );
    fs.writeFileSync(
        path.join(work, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                strict: true,
                noEmit: true,
                module: 'nodenext',
                moduleResolution: 'nodenext',
                target: 'es2024',
                types: ['node'],
                skipLibCheck: false,
            },
            files: ['consumer.ts'],
        }),
    );
    let diagnostics = '';
    try {
        execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json', '--pretty', 'false'], {
            cwd: work,
            encoding: 'utf8',
        });
    } catch (error) {
        diagnostics = String(error.stdout ?? '');
    }
    const ours = diagnostics
        .split('\n')
        .filter((line) => line.startsWith('consumer.ts') || line.startsWith(`node_modules/${pkg.name}/`));
    if (ours.length > 0) throw new Error(`the published declarations do not type-check:\n  ${ours.join('\n  ')}`);

    const count = Object.values(loaded).reduce((n, names) => n + names.length, 0);
    console.log(`✓ ${specifiers.length} entry points load and type-check from a packed install (${count} exports)`);
} finally {
    fs.rmSync(work, { recursive: true, force: true });
}
