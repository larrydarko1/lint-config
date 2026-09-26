/**
 * Resolves a CLI from this package, not the project, so the gates always parse the
 * report format of the version they pin. Walks Node's lookup paths by hand because
 * knip's `exports` hides `package.json` and `bin/` from `require.resolve`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Absolute path to the script behind `pkg`'s `bin` entry — run it with `process.execPath`. */
export function packageBin(pkg: string, bin: string = pkg): string {
    for (const dir of require.resolve.paths(pkg) ?? []) {
        const manifest = path.join(dir, pkg, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const { bin: bins } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
            bin?: string | Record<string, string>;
        };
        const entry = typeof bins === 'string' ? bins : bins?.[bin];
        if (entry === undefined) throw new Error(`${pkg} has no \`${bin}\` binary.`);
        return path.join(dir, pkg, entry);
    }
    throw new Error(`${pkg} is not installed beside @larrydarko/lint-config. Reinstall it.`);
}
