/**
 * `larry init` at a terminal, in invented repositories. The prompts read keys from a stream
 * this suite writes to, each key sent once the question it answers is on the screen, so
 * the run goes as it would for a person typing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { initInteractively } from '../src/cli/init-prompts.ts';

const DOWN = '\u001b[B';
const ENTER = '\r';
const CTRL_C = '\u0003';

// eslint-disable-next-line no-control-regex -- the escape codes a terminal draws with are what is stripped.
const ESCAPES = /\u001b\[[\d;?]*[A-Za-z]/g;

/** A git repo holding `files`, with a package.json unless `files` says otherwise. */
const repo = (t, files = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larry-init-prompts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const manifest = JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }, null, 2);
    for (const [rel, body] of Object.entries({ 'package.json': manifest, ...files })) {
        if (body === null) continue;
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
};

/**
 * Runs init at a pretend terminal.
 *
 * @param answers Each question's text, and the keys that answer it.
 * @returns The exit code, the screen without its escape codes, and the questions that went unanswered.
 */
const ask = async (root, given, answers) => {
    const input = new PassThrough();
    // Wide enough that no line wraps, so what is matched is never split.
    const output = Object.assign(new PassThrough(), { columns: 200 });
    const pending = [...answers];
    let screen = '';
    output.on('data', (chunk) => {
        screen += String(chunk).replace(ESCAPES, '');
        while (pending[0] !== undefined && screen.includes(pending[0][0])) {
            const [, keys] = pending.shift();
            setImmediate(() => input.write(keys));
        }
    });
    const code = await initInteractively(
        root,
        { family: undefined, distribution: undefined, runtime: undefined, ...given },
        { input, output },
    );
    return { code, screen, unanswered: pending.map(([question]) => question) };
};

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test("init asks for the family, the distribution and a base project's runtime, and writes the answers", async (t) => {
    const root = repo(t, { 'src/index.ts': 'export {};\n' });
    const result = await ask(root, {}, [
        // The family list starts on api; base is last.
        ['What kind of project is this?', DOWN.repeat(6) + ENTER],
        ["Is the app's own source published?", DOWN + ENTER],
        ['Where does the source run?', DOWN + ENTER],
    ]);
    assert.equal(result.code, 0, result.screen);
    assert.deepEqual(result.unanswered, []);

    assert.match(read(root, 'larry.config.ts'), /family: 'base'/);
    assert.match(read(root, 'larry.config.ts'), /distribution: 'open'/);
    assert.match(read(root, 'eslint.config.js'), /browser: \['src\/\*\*\/\*\.ts'\],/);
    assert.match(result.screen, /base: \d+ files written/);
    assert.match(result.screen, /\+ larry\.config\.ts/);
    assert.match(
        result.screen,
        /To skip the questions next time: npx larry init base --distribution open --runtime browser/,
    );
});

test('the family question starts on the one package.json points at', async (t) => {
    const manifest = JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', dependencies: { vue: '3.5.0' } });
    const root = repo(t, { 'package.json': manifest });
    const result = await ask(root, {}, [
        ['What kind of project is this?', ENTER],
        ["Is the app's own source published?", ENTER],
    ]);
    assert.equal(result.code, 0, result.screen);
    assert.match(result.screen, /package\.json depends on vue/);
    assert.match(read(root, 'larry.config.ts'), /family: 'spa'/);
    assert.match(read(root, 'larry.config.ts'), /distribution: 'closed'/);
});

test('what the command line gave is not asked again, and only base is asked where it runs', async (t) => {
    const root = repo(t);
    const result = await ask(root, { family: 'library' }, [["Is the app's own source published?", ENTER]]);
    assert.equal(result.code, 0, result.screen);
    assert.doesNotMatch(result.screen, /What kind of project is this\?|Where does the source run\?/);
    assert.match(result.screen, /npx larry init library --distribution closed/);

    const given = repo(t);
    const quiet = await ask(given, { family: 'library', distribution: 'open' }, []);
    assert.equal(quiet.code, 0, quiet.screen);
    assert.doesNotMatch(quiet.screen, /\?/, 'nothing is asked');
    assert.doesNotMatch(quiet.screen, /skip the questions/);
});

test('stopping at a question writes nothing and exits 130', async (t) => {
    const root = repo(t);
    const result = await ask(root, {}, [['What kind of project is this?', CTRL_C]]);
    assert.equal(result.code, 130);
    assert.match(result.screen, /Stopped\. Nothing was written\./);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'package.json']);
});

test('a project with no package.json is told before the first question', async (t) => {
    const root = repo(t, { 'package.json': null });
    const result = await ask(root, {}, [['What kind of project is this?', ENTER]]);
    assert.equal(result.code, 2);
    assert.match(result.screen, /there is no package\.json in .*Run `npm init` first/s);
    assert.deepEqual(result.unanswered, ['What kind of project is this?']);
});
