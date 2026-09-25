/**
 * A CLI this package depends on, resolved from this package rather than from the
 * project running the gate.
 *
 * knip and jscpd are dependencies here so every project runs the version the gates
 * were written against. The gates parse their JSON reports, so a project pinning its
 * own copy is not a style choice, it is a second report format to be wrong about.
 * Resolving `node_modules/.bin` under the project root would quietly undo that — it
 * finds whichever copy the project happens to have, or none.
 *
 * Walked by hand through Node's own lookup paths because `require.resolve` honours
 * `exports`, and knip's does not expose `package.json` or `bin/`.
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
