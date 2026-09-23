import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HEAD_CHECKS, entryPath, inspectHtmlStandards } from '../src/gates/html-standards.js';

/** A temp repo holding exactly the files a case needs. */
const tree = (t, files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

const SHELL = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '  </head>',
    '  <body>',
    '    <div id="app"></div>',
    '    <script type="module" src="/main.ts"></script>',
    '  </body>',
    '</html>',
].join('\n');

const MOTION = [
    '@media (prefers-reduced-motion: reduce) {',
    '    *,',
    '    *::after {',
    '        animation-duration: 0.01ms !important;',
    '        transition-duration: 0.01ms !important;',
    '    }',
    '}',
].join('\n');

/** A repo that passes everything, so a case only has to break one thing. */
const good = (overrides = {}) => ({
    'src/index.html': SHELL,
    'src/main.ts': 'export {};\n',
    'src/base.scss': MOTION,
    ...overrides,
});

const run = (root, options = {}) =>
    inspectHtmlStandards({ root, indexHtml: 'src/index.html', baseScss: 'src/base.scss', ...options });

const whats = (result) => result.problems.map((p) => p.what);

// ── The baseline ────────────────────────────────────────────────────────────
test('a correct shell has no problems', (t) => {
    const root = tree(t, good());
    assert.deepEqual(run(root, { require: ['lang', 'charset', 'appMount'] }).problems, []);
});

test('the inspection reports how many tags were required', (t) => {
    const root = tree(t, good());
    assert.equal(run(root, { require: ['lang', 'charset'] }).required, 2);
});

// ── 1. The document shell ───────────────────────────────────────────────────
test('every head requirement has a matcher, a name and a reason', () => {
    for (const [key, check] of Object.entries(HEAD_CHECKS)) {
        assert.ok(check.re instanceof RegExp, `${key} has no matcher`);
        assert.match(check.what, /\S/, `${key} has no name`);
        assert.ok(check.why.length > 20, `${key} has no reason`);
    }
});

test('a missing required tag fails, naming the tag', (t) => {
    const root = tree(t, good({ 'src/index.html': SHELL.replace('<html lang="en">', '<html>') }));
    assert.deepEqual(whats(run(root, { require: ['lang', 'charset'] })), ['is missing <html lang="…">']);
});

test('a tag that was not required is not checked', (t) => {
    const root = tree(t, good());
    assert.deepEqual(run(root, { require: ['lang'] }).problems, []);
});

test('an unknown requirement throws rather than passing silently', (t) => {
    const root = tree(t, good());
    assert.throws(() => run(root, { require: ['ogTtile'] }), /Unknown head requirement 'ogTtile'/);
});

test('a description shorter than a sentence does not count', (t) => {
    const short = SHELL.replace('</head>', '<meta name="description" content="Short." /></head>');
    const long = SHELL.replace('</head>', `<meta name="description" content="${'a'.repeat(60)}" /></head>`);
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': short })), { require: ['description'] })), [
        'is missing <meta name="description">',
    ]);
    assert.deepEqual(run(tree(t, good({ 'src/index.html': long })), { require: ['description'] }).problems, []);
});

test('a relative og:image does not count, because crawlers do not resolve one', (t) => {
    const rel = SHELL.replace('</head>', '<meta property="og:image" content="/og.png" /></head>');
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': rel })), { require: ['ogImage'] })), [
        'is missing <meta property="og:image">',
    ]);
});

test('a viewport that blocks zoom fails even though no zoom rule was asked for', (t) => {
    const html = SHELL.replace(
        '</head>',
        '<meta name="viewport" content="width=device-width, user-scalable=no" /></head>',
    );
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': html })))), ['has a viewport that blocks zoom']);
});

test('maximum-scale=1 blocks zoom too', (t) => {
    const html = SHELL.replace(
        '</head>',
        '<meta name="viewport" content="width=device-width, maximum-scale=1" /></head>',
    );
    assert.equal(run(tree(t, good({ 'src/index.html': html }))).problems.length, 1);
});

test('a document with no viewport tag never reaches the zoom rule', (t) => {
    assert.deepEqual(run(tree(t, good())).problems, []);
});

// ── 2. The entry module ─────────────────────────────────────────────────────
test('an entry that does not exist fails', (t) => {
    const root = tree(t, { 'src/index.html': SHELL, 'src/base.scss': MOTION });
    assert.deepEqual(whats(run(root)), ['entry `/main.ts` does not exist']);
});

test('a `.js` src for a `.ts` module is named, not accepted quietly', (t) => {
    const html = SHELL.replace('src="/main.ts"', 'src="/main.js"');
    const root = tree(t, good({ 'src/index.html': html }));
    assert.deepEqual(whats(run(root)), ['entry is `/main.js` but the file is `main.ts`']);
});

test('a shell with no module script fails', (t) => {
    const html = SHELL.replace('<script type="module" src="/main.ts"></script>', '');
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': html })))), [
        'has no `<script type="module" src="…">`',
    ]);
});

test('an entry is resolved against the document, not the repo root', () => {
    assert.equal(entryPath('/src/main.ts', 'frontend/index.html'), 'frontend/src/main.ts');
    assert.equal(entryPath('./main.ts', 'src/renderer/index.html'), 'src/renderer/main.ts');
    assert.equal(entryPath('/main.ts', 'src/renderer/index.html'), 'src/renderer/main.ts');
});

// ── 3. The CSP ──────────────────────────────────────────────────────────────
const POLICY =
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'self'";
const withCsp = (policy) =>
    SHELL.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="${policy}" /></head>`);

test('a locked policy passes', (t) => {
    assert.deepEqual(run(tree(t, good({ 'src/index.html': withCsp(POLICY) })), { csp: true }).problems, []);
});

test('no CSP tag fails only when the meta tag is the policy', (t) => {
    const root = tree(t, good());
    assert.deepEqual(
        run(root, { csp: true }).problems.map((p) => p.what),
        ['has no Content-Security-Policy meta tag'],
    );
    assert.deepEqual(run(root, { csp: false }).problems, []);
});

test('a missing directive is named', (t) => {
    const policy = POLICY.replace("; base-uri 'none'", '');
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true })), [
        "CSP is missing `base-uri 'none'`",
    ]);
});

test('a widened default-src is a missing directive, not a pass', (t) => {
    const policy = POLICY.replace("default-src 'self'", "default-src 'self' https:");
    assert.equal(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true }).problems.length, 1);
});

test("'unsafe-eval' anywhere in the policy fails", (t) => {
    const policy = POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'");
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true })), [
        "CSP contains 'unsafe-eval'",
    ]);
});

test("'unsafe-inline' fails in script-src and passes in style-src", (t) => {
    const bad = POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    const ok = `${POLICY}; style-src 'self' 'unsafe-inline'`;
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': withCsp(bad) })), { csp: true })), [
        "CSP contains 'unsafe-inline' in script-src",
    ]);
    assert.deepEqual(run(tree(t, good({ 'src/index.html': withCsp(ok) })), { csp: true }).problems, []);
});

test('a wildcard host fails', (t) => {
    const policy = POLICY.replace("script-src 'self'", "script-src 'self' *");
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true })), [
        "CSP contains a wildcard host ('*')",
    ]);
});

test('a remote origin in the policy is named', (t) => {
    const policy = `${POLICY}; connect-src 'self' https://api.example.com`;
    assert.deepEqual(whats(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true })), [
        'CSP allows the remote origin `https://api.example.com`',
    ]);
});

test('the dev-server HMR socket on localhost is allowed', (t) => {
    const policy = `${POLICY}; connect-src 'self' ws://localhost:5173 http://127.0.0.1:5173`;
    assert.deepEqual(run(tree(t, good({ 'src/index.html': withCsp(policy) })), { csp: true }).problems, []);
});

// ── 4. Remote subresources ──────────────────────────────────────────────────
test('a remote script in the shell fails', (t) => {
    const html = SHELL.replace('</head>', '<script src="https://cdn.example.com/a.js"></script></head>');
    assert.equal(run(tree(t, good({ 'src/index.html': html }))).problems.length, 1);
});

test('a remote stylesheet fails', (t) => {
    const html = SHELL.replace('</head>', '<link rel="stylesheet" href="https://fonts.example.com/x.css" /></head>');
    assert.equal(run(tree(t, good({ 'src/index.html': html }))).problems.length, 1);
});

test('a protocol-relative URL is remote too', (t) => {
    const html = SHELL.replace('</head>', '<script src="//cdn.example.com/a.js"></script></head>');
    assert.equal(run(tree(t, good({ 'src/index.html': html }))).problems.length, 1);
});

test('a canonical link naming the live origin is metadata, not a subresource', (t) => {
    const html = SHELL.replace('</head>', '<link rel="canonical" href="https://example.com/" /></head>');
    assert.deepEqual(run(tree(t, good({ 'src/index.html': html }))).problems, []);
});

test('a preconnect is a fetch, so it still fails', (t) => {
    const html = SHELL.replace('</head>', '<link rel="preconnect" href="https://fonts.example.com" /></head>');
    assert.equal(run(tree(t, good({ 'src/index.html': html }))).problems.length, 1);
});

test('a local subresource passes', (t) => {
    const html = SHELL.replace('</head>', '<link rel="icon" href="/favicon.svg" /></head>');
    assert.deepEqual(run(tree(t, good({ 'src/index.html': html }))).problems, []);
});

// ── 5. The reduced-motion override ──────────────────────────────────────────
test('a stylesheet with no reduced-motion block fails', (t) => {
    const root = tree(t, good({ 'src/base.scss': 'body { margin: 0; }\n' }));
    assert.deepEqual(whats(run(root)), ['has no top-level `@media (prefers-reduced-motion: reduce)` block']);
});

test('a block that only guards scroll-behavior fails on both durations', (t) => {
    const scss = '@media (prefers-reduced-motion: reduce) {\n    html {\n        scroll-behavior: auto;\n    }\n}\n';
    assert.deepEqual(whats(run(tree(t, good({ 'src/base.scss': scss })))), [
        'reduced-motion block does not force animation-duration',
        'reduced-motion block does not force transition-duration',
    ]);
});

test('a duration without `!important` loses the cascade and does not count', (t) => {
    const scss = MOTION.replace('animation-duration: 0.01ms !important;', 'animation-duration: 0.01ms;');
    assert.deepEqual(whats(run(tree(t, good({ 'src/base.scss': scss })))), [
        'reduced-motion block does not force animation-duration',
    ]);
});

test('a declaration outside the block does not satisfy it', (t) => {
    const scss = `@media (prefers-reduced-motion: reduce) {\n    html {\n        scroll-behavior: auto;\n    }\n}\n\n.thing {\n    animation-duration: 0s !important;\n    transition-duration: 0s !important;\n}\n`;
    assert.equal(run(tree(t, good({ 'src/base.scss': scss }))).problems.length, 2);
});

test('a nested reduced-motion block is not the global override', (t) => {
    const scss = 'html {\n    @media (prefers-reduced-motion: reduce) {\n        scroll-behavior: auto;\n    }\n}\n';
    assert.equal(run(tree(t, good({ 'src/base.scss': scss }))).problems.length, 1);
});

test('a variable is a fine duration as long as it is forced', (t) => {
    const scss = MOTION.replace('0.01ms !important', '$duration-none !important');
    assert.deepEqual(run(tree(t, good({ 'src/base.scss': scss }))).problems, []);
});

test("no baseScss means the override is not this gate's business", (t) => {
    const root = tree(t, { 'src/index.html': SHELL, 'src/main.ts': 'export {};\n' });
    assert.deepEqual(inspectHtmlStandards({ root, indexHtml: 'src/index.html' }).problems, []);
});

// ── 6. The launch checklist ─────────────────────────────────────────────────
test('a placeholder origin warns rather than failing', (t) => {
    const html = SHELL.replace('</head>', '<link rel="canonical" href="https://app.example.com/" /></head>');
    const result = run(tree(t, good({ 'src/index.html': html })), { placeholderOrigin: 'app.example.com' });
    assert.deepEqual(result.problems, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /still uses the placeholder origin/);
});

test('no placeholder origin means no warning', (t) => {
    assert.deepEqual(run(tree(t, good())).warnings, []);
});
