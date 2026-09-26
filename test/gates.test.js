/**
 * The gate helpers, asserted against the behaviour the projects' own copies had.
 * These three were the only files every gate imported, and the two families had
 * genuinely different versions of each — so what matters here is that the shared
 * one still answers the way each family's copy did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { packageBin } from '../src/gates/lib/bin.ts';
import { stripComments } from '../src/gates/lib/strip-comments.ts';
import { createImportOrder } from '../src/gates/import-order.ts';
import { findRepoRoot } from '../src/gates/lib/repo-root.ts';
import {
    braceBlock,
    callArgs,
    callSites,
    catchBodies,
    declaredBody,
    declaredFunction,
    evalProduct,
    fnBody,
    functionParts,
    propertyValue,
    splitTopLevel,
} from '../src/gates/lib/source.ts';

test('stripComments blanks comments and keeps every offset', () => {
    const src = 'const a = 1; // note\n/* block */ const b = 2;\n';
    const out = stripComments(src);
    assert.equal(out.length, src.length, 'byte offsets must survive so a gate can report a position');
    assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers must survive');
    assert.ok(!out.includes('note'));
    assert.ok(!out.includes('block'));
    assert.ok(out.includes('const a = 1;'));
    assert.ok(out.includes('const b = 2;'));
});

test('stripComments leaves a // inside a string alone', () => {
    // The false positive this exists to prevent: blanking the rest of a URL.
    const src = `const url = 'https://example.com//path';\n`;
    assert.equal(stripComments(src), src);
});

test('stripComments keeps the newlines inside a block comment', () => {
    const src = '/*\n *\n */\nconst after = 1;\n';
    const out = stripComments(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.match(out, /^\s+\n\s+\n\s+\nconst after = 1;\n$/);
});

test('stripComments handles an unterminated block comment without hanging', () => {
    const out = stripComments('const a = 1;\n/* never closed\n');
    assert.equal(out.length, 'const a = 1;\n/* never closed\n'.length);
    assert.ok(!out.includes('never'));
});

test('import groups: three without a workspace scope, four with one', () => {
    assert.deepEqual(createImportOrder().IMPORT_GROUPS, ['builtin', 'external', 'local']);
    assert.deepEqual(createImportOrder({ workspaceScope: '@orchid/' }).IMPORT_GROUPS, [
        'builtin',
        'external',
        'workspace',
        'local',
    ]);
});

/** Runs `checkImportsInFile` over `code` written to a scratch file, and returns its problems. */
const problemsFor = (mod, code) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lint-config-gates-'));
    writeFileSync(path.join(dir, 'file.ts'), code);
    try {
        return mod.checkImportsInFile('file.ts', dir).problems.map((p) => p.message);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

test('a workspace package sorts between external and local where the scope is declared', () => {
    const mod = createImportOrder({ workspaceScope: '@orchid/' });

    // Correct order: builtin, external, workspace, local — one blank line between each.
    assert.deepEqual(
        problemsFor(
            mod,
            "import fs from 'node:fs';\n\nimport vue from 'vue';\n\nimport { x } from '@orchid/shared';\n\nimport { y } from './y';\n",
        ),
        [],
    );

    // The workspace import placed after the local one is out of order.
    const wrong = problemsFor(
        mod,
        "import fs from 'node:fs';\n\nimport vue from 'vue';\n\nimport { y } from './y';\n\nimport { x } from '@orchid/shared';\n",
    );
    assert.ok(wrong.length > 0, 'a misplaced workspace import should be reported');
    assert.ok(wrong.some((m) => m.includes('@orchid/shared') && m.includes('workspace')));
});

test('without a workspace scope the same specifier is just another npm package', () => {
    const mod = createImportOrder();
    // `@orchid/shared` now belongs in the external group, so it sorts with `vue`, before local.
    assert.deepEqual(
        problemsFor(
            mod,
            "import fs from 'node:fs';\n\nimport { x } from '@orchid/shared';\nimport vue from 'vue';\n\nimport { y } from './y';\n",
        ),
        [],
    );
});

test('localAliases make a package-looking specifier sort as local', () => {
    const mod = createImportOrder({ localAliases: ['@test-utils'] });

    // Inside the local group the order is alphabetical by specifier, and '.' sorts before '@' —
    // so `./y` comes first even though `@test-utils` looks like a package.
    assert.deepEqual(
        problemsFor(mod, "import vue from 'vue';\n\nimport { y } from './y';\nimport { h } from '@test-utils';\n"),
        [],
    );

    // Without the alias it would be external, and belong up with `vue` instead.
    const asPackage = problemsFor(
        createImportOrder(),
        "import vue from 'vue';\n\nimport { y } from './y';\nimport { h } from '@test-utils';\n",
    );
    assert.ok(asPackage.some((m) => m.includes('@test-utils')));
});

test('a side-effect import never moves, and splits the run around itself', () => {
    const mod = createImportOrder();
    // `dotenv/config` must run before anything that reads process.env at import time,
    // so it stays put even though `vue` would sort before it alphabetically.
    assert.deepEqual(problemsFor(mod, "import 'dotenv/config';\n\nimport vue from 'vue';\n"), []);
});

test('findRepoRoot walks up to a workspaces manifest, and to .git without one', () => {
    // This package has no `workspaces`, so the .git fallback is what answers here.
    const root = findRepoRoot(import.meta.dirname);
    assert.equal(typeof root, 'string');
    assert.ok(root.length > 1);
});

test('findRepoRoot fails loudly rather than returning the filesystem root', () => {
    assert.throws(() => findRepoRoot('/'), /Could not locate the repository root/);
});

// ─── source.js — the helpers several gates carried copies of ─────────────────

test('callSites reports where each call starts and ends', () => {
    const source = 'io.use(a);\nio.use(b);\n';
    assert.deepEqual(
        callSites(source, 'io.use(').map((site) => [site.index, site.end, site.args]),
        [
            [0, 8, 'a'],
            [11, 19, 'b'],
        ],
    );
});

test('callSites spans the whole call when the arguments nest', () => {
    const source = 'io.use((socket, next) => { check({ a: (1) }); next(); });';
    const [site] = callSites(source, 'io.use(');
    assert.equal(site.end, source.length - 2);
});

test('callSites is what lets an order rule survive a reformat', () => {
    // Anchoring on a closing `\n    });` instead would encode one day's
    // indentation as the contract.
    const oneLine = callSites('io.use(a);io.use(b);', 'io.use(').map((site) => site.index);
    const wrapped = callSites('io.use(\n    a,\n);\nio.use(\n    b,\n);', 'io.use(').map((site) => site.index);
    assert.equal(oneLine.length, wrapped.length);
});

test('callSites returns nothing for an unbalanced call rather than looping', () => {
    assert.deepEqual(callSites('io.use((a, b', 'io.use('), []);
});

test('callArgs keeps a nested call whole', () => {
    const calls = callArgs('jwt.verify(token, secret, { algorithms: fn(a, b) });', 'jwt.verify(');
    assert.deepEqual(calls, ['token, secret, { algorithms: fn(a, b) }']);
});

test('callArgs matches the call, not a longer name that starts the same way', () => {
    assert.deepEqual(callArgs('jwt.verifyAsync(a);', 'jwt.verify('), []);
});

test('callArgs returns every call in source order', () => {
    assert.deepEqual(callArgs('f(1); f(2); f(3);', 'f('), ['1', '2', '3']);
});

test('callArgs stops on an unbalanced call rather than rescanning it forever', () => {
    assert.deepEqual(callArgs('f(1); f(2', 'f('), ['1']);
});

test('braceBlock reads past a nested object', () => {
    const block = braceBlock('hsts: { maxAge: 1, reportTo: { group: "x" }, preload: false }', /hsts:\s*/);
    assert.match(block, /preload: false/);
});

test('braceBlock returns empty when nothing matches, so a rule fails rather than passing', () => {
    assert.equal(braceBlock('const a = 1;', /hsts:\s*/), '');
});

test('fnBody stops at the next top-level export', () => {
    const src = 'export function a() {\n  first();\n}\n\nexport function b() {\n  second();\n}\n';
    assert.match(fnBody(src, 'export function a'), /first\(\)/);
    assert.ok(!fnBody(src, 'export function a').includes('second()'));
});

test('fnBody returns empty for a header that is gone', () => {
    assert.equal(fnBody('export function a() {}', 'export function renamed'), '');
});

test('catchBodies reads each catch separately, not the function around them', () => {
    const src = 'try { a(); } catch (e) { log(e); }\nthrow new Error("after");\ntry { b(); } catch { throw e; }';
    const bodies = catchBodies(src);
    assert.equal(bodies.length, 2);
    assert.ok(!bodies[0].includes('throw'), 'a throw after the catch is not a throw inside it');
    assert.match(bodies[1], /throw e;/);
});

test('evalProduct multiplies a literal duration', () => {
    assert.equal(evalProduct('5 * 60 * 1000'), 300000);
});

test('evalProduct reads numeric separators, which Number() alone does not', () => {
    assert.equal(evalProduct('60_000'), 60000);
});

test('evalProduct returns 0 for anything that is not a literal product', () => {
    assert.equal(evalProduct('config.timeout'), 0);
    assert.equal(evalProduct(undefined), 0);
});

// ─── source.js: propertyValue ────────────────────────────────────────────────

test('propertyValue reads one value up to its own comma', () => {
    assert.equal(propertyValue('a: 1, b: 2', 'a')?.trim(), '1');
});

test('propertyValue reads through nesting and stops at the closing brace', () => {
    assert.equal(propertyValue('x: { y: [1, 2], z: f(a, b) } }', 'x')?.trim(), '{ y: [1, 2], z: f(a, b) }');
});

test('propertyValue does not match a longer key or a member access', () => {
    assert.equal(propertyValue('nodeIntegrationInWorker: true', 'nodeIntegration'), null);
    assert.equal(propertyValue('prefs.sandbox: true', 'sandbox'), null);
    assert.equal(propertyValue('disallowRequest: f', 'allowRequest'), null);
});

test('propertyValue is null when the key is absent', () => {
    assert.equal(propertyValue('a: 1', 'b'), null);
});

// ─── source.js: splitTopLevel ────────────────────────────────────────────────

test('splitTopLevel keeps generics, calls and strings whole', () => {
    assert.deepEqual(splitTopLevel("a: Record<string, number>, f(x, y), 'p,q', `r,${s}`", ','), [
        'a: Record<string, number>',
        'f(x, y)',
        "'p,q'",
        '`r,${s}`',
    ]);
});

test('splitTopLevel does not read an arrow as a closing angle bracket', () => {
    assert.deepEqual(splitTopLevel('(a) => a, b', ','), ['(a) => a', 'b']);
});

test('splitTopLevel: an arrow inside a call does not close the call', () => {
    assert.deepEqual(splitTopLevel('f(a => a, b), c', ','), ['f(a => a, b)', 'c']);
});

test('splitTopLevel: a template inside an interpolation does not end the outer one', () => {
    assert.deepEqual(splitTopLevel('`x ${`y,z`} w`, v', ','), ['`x ${`y,z`} w`', 'v']);
});

// ─── source.js: functionParts ────────────────────────────────────────────────

test('an arrow with a block body', () => {
    assert.deepEqual(functionParts('(a, b) => { return a + b; }, next'), {
        params: ['a', 'b'],
        body: ' return a + b; ',
    });
});

test('an expression-bodied arrow ends at its own comma or paren', () => {
    assert.deepEqual(functionParts('(e, url) => open(url, e), other)'), { params: ['e', 'url'], body: 'open(url, e)' });
});

test('an async arrow with a single bare parameter', () => {
    assert.deepEqual(functionParts('async x => x * 2;'), { params: ['x'], body: 'x * 2' });
});

test('THE RETURN-TYPE TRAP: a brace in the return type is not the body', () => {
    const handler = "({ url }): { action: 'deny' } => { return { action: 'deny' }; }";
    assert.deepEqual(functionParts(handler), { params: ['url'], body: " return { action: 'deny' }; " });
    const promised = 'async (_e, id: unknown): Promise<{ success: boolean; error?: string }> => { check(id); }';
    assert.equal(functionParts(promised)?.body, ' check(id); ');
});

test('an arrow INSIDE the return type is not the arrow of the function', () => {
    assert.deepEqual(functionParts('(): Promise<(x: number) => void> => { run(); }'), { params: [], body: ' run(); ' });
});

test('a function expression, typed and async', () => {
    assert.deepEqual(functionParts('async function (a: string, b = 2): Promise<void> { go(); }'), {
        params: ['a', 'b'],
        body: ' go(); ',
    });
});

test('rest, optional, defaulted and destructured parameters are reduced to names', () => {
    assert.deepEqual(functionParts('(_event, ...args: unknown[]) => 0')?.params, ['_event', 'args']);
    assert.deepEqual(functionParts('(a?: string, { b, c: d }: T = {}) => 0')?.params, ['a', 'b', 'd']);
});

test('a string holding a brace does not end the body', () => {
    assert.equal(functionParts("() => { log('}'); done(); }")?.body, " log('}'); done(); ");
});

test('anything that is not a function expression is null', () => {
    assert.equal(functionParts('handlers.open'), null);
    assert.equal(functionParts("'a string'"), null);
});

// ─── source.js: declaredFunction / declaredBody ──────────────────────────────

test('a function declaration is found by name', () => {
    const source =
        'export async function write(level: string, entry: unknown): Promise<void> {\n    parse(entry);\n}\n';
    assert.deepEqual(declaredFunction(source, 'write'), { params: ['level', 'entry'], body: '\n    parse(entry);\n' });
});

test('a const arrow is found by name', () => {
    assert.deepEqual(declaredFunction('const write = (entry) => { parse(entry); };', 'write'), {
        params: ['entry'],
        body: ' parse(entry); ',
    });
});

test('THE NEXT-BRACE TRAP: an expression-bodied const does not borrow the next block', () => {
    const source = 'const write = (entry) => log(entry);\nfunction other() { safeParse(entry); }\n';
    assert.equal(declaredBody(source, 'write'), 'log(entry)');
});

test('a member or a longer name is not the declaration', () => {
    assert.equal(declaredFunction('function rewrite(a) { x(a); }', 'write'), null);
    assert.equal(declaredFunction('obj.write = (a) => a;', 'write'), null);
});

test('a name that is not an identifier is refused, not turned into a regex', () => {
    assert.equal(declaredFunction('function a() {}', 'a|b'), null);
    assert.equal(declaredBody('function a() {}', '('), '');
});

test('packageBin finds the knip and jscpd this package depends on, not a project copy', () => {
    for (const pkg of ['knip', 'jscpd']) {
        const bin = packageBin(pkg);
        assert.ok(existsSync(bin), `${pkg}: ${bin} does not exist`);
        assert.ok(bin.startsWith(path.resolve(import.meta.dirname, '..')), `${pkg} resolved outside this package`);
    }
    assert.throws(() => packageBin('knip', 'nope'), /no `nope` binary/);
});
