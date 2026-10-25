/**
 * The publish gate, against small invented packages that npm really packs. Packing is
 * the point: what the gate catches is the difference between the sources and the
 * installed copy, which only exists once npm has decided what goes in the tarball.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectPublish } from '../src/gates/publish.ts';

/** A temp package holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
};

const manifest = (fields) => ({ name: '@example/widgets', version: '1.0.0', type: 'module', ...fields });

test('a built package with declarations, a runnable bin and a subpath pattern passes', (t) => {
    const root = tree(t, {
        'package.json': manifest({
            files: ['dist'],
            bin: { widgets: './dist/cli.js' },
            exports: {
                '.': { types: './dist/index.d.ts', default: './dist/index.js' },
                './sizes': { types: './dist/sizes.d.ts', default: './dist/sizes.js' },
                './icons/*': './dist/icons/*.js',
            },
        }),
        'dist/index.js': 'export const widget = (size) => ({ size });\n',
        'dist/index.d.ts': 'export declare const widget: (size: number) => { size: number };\n',
        'dist/sizes.js': "export const SIZES = ['s', 'm'];\nexport const largest = 'm';\n",
        'dist/sizes.d.ts': 'export declare const SIZES: string[];\nexport declare const largest: string;\n',
        'dist/cli.js': "#!/usr/bin/env node\nconsole.log('widgets');\n",
        'src/index.ts': 'export const widget = (size: number) => ({ size });\n',
    });

    const { problems, counts } = inspectPublish({ root });
    assert.deepEqual(problems, []);
    assert.deepEqual(counts, { entryPoints: 2, exports: 3, files: 6, patterns: 1 });
});

test('what only breaks once installed is reported once, at the entry point it breaks', (t) => {
    const root = tree(t, {
        'package.json': manifest({
            files: ['dist', 'src'],
            bin: './dist/cli.js',
            exports: {
                '.': { types: './dist/index.d.ts', default: './dist/index.js' },
                './missing': './dist/missing.js',
                './throws': { types: './dist/throws.d.ts', default: './dist/throws.js' },
                './untyped': './dist/untyped.js',
            },
        }),
        'dist/index.js': 'export const widget = 1;\n',
        'dist/index.d.ts': "export { Size } from './sizes.js';\nexport declare const widget: number;\n",
        'dist/throws.js': "throw new Error('boom at import');\n",
        'dist/throws.d.ts': 'export {};\n',
        'dist/untyped.js': 'export const loose = 1;\n',
        'dist/cli.js': "console.log('widgets');\n",
        'src/index.ts': 'export const widget = 1;\n',
    });

    const found = inspectPublish({ root }).problems.map(({ file, what }) => `${file}: ${what.split(':')[0]}`);
    // The missing file is the one finding for ./missing: loading it again would only repeat it.
    assert.deepEqual(found.sort(), [
        '@example/widgets/throws: does not load',
        '@example/widgets/untyped: error TS7016',
        'dist/cli.js: `bin.@example/widgets` has no `#!` line',
        'node_modules/@example/widgets/dist/index.d.ts: error TS2307',
        'package.json: `exports["./missing"]` names dist/missing.js, which is not in the tarball',
        'src/index.ts: TypeScript source in the tarball',
    ]);
});

test('a package with no exports is imported by its name, through main', (t) => {
    const root = tree(t, {
        'package.json': manifest({ main: './index.js', types: './index.d.ts' }),
        'index.js': 'export const widget = 1;\n',
        'index.d.ts': 'export declare const widget: number;\n',
    });

    const { problems, counts } = inspectPublish({ root });
    assert.deepEqual(problems, []);
    assert.equal(counts.entryPoints, 1);
});
