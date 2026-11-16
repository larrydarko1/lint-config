import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectExtensionManifest } from '../src/gates/extension-manifest.ts';

/** An invented extension that passes everything, so a case only has to break one thing. */
const MANIFEST = {
    name: 'tally',
    displayName: 'Tally',
    version: '1.0.0',
    publisher: 'someone',
    main: './out/extension.cjs',
    contributes: {
        viewsContainers: { activitybar: [{ id: 'tally', title: 'Tally', icon: 'resources/tally.svg' }] },
        views: { tally: [{ id: 'tally.counts', name: 'Counts' }] },
        viewsWelcome: [{ view: 'tally.counts', contents: '[Start counting](command:tally.start)' }],
        commands: [
            { command: 'tally.start', title: 'Start' },
            { command: 'tally.reset', title: 'Reset' },
        ],
        menus: {
            'commandPalette': [{ command: 'tally.reset', when: 'false' }],
            'view/item/context': [{ command: 'tally.reset', when: 'view == tally.counts' }],
        },
        configuration: { title: 'Tally', properties: { 'tally.step': { type: 'number', default: 1 } } },
    },
    activationEvents: ['workspaceContains:.tally'],
    capabilities: {
        untrustedWorkspaces: {
            supported: 'limited',
            description: 'Counting needs a trusted folder.',
            restrictedConfigurations: ['tally.step'],
        },
        virtualWorkspaces: false,
    },
    devDependencies: { '@types/vscode': '~1.100.0' },
    engines: { vscode: '^1.100.0' },
};

const ENTRY = `import * as vscode from 'vscode';

import { createCounts } from '@/vscode/counts';

export function activate(context: vscode.ExtensionContext): void {
    const command = (name: string, run: () => void): void => {
        context.subscriptions.push(vscode.commands.registerCommand(name, run));
    };
    command('tally.start', start);
    command('tally.reset', reset);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('tally.counts', createCounts()));
}

export function deactivate(): void {}
`;

const SETTINGS = `import * as vscode from 'vscode';

export const step = (): number => vscode.workspace.getConfiguration('tally').get<number>('step', 1);
`;

const GOOD = {
    'package.json': MANIFEST,
    '.vscodeignore': '**\n!package.json\n!out/extension.cjs\n',
    'src/extension.ts': ENTRY,
    'src/vscode/settings.ts': SETTINGS,
};

const tree = (t, overrides = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries({ ...GOOD, ...overrides })) {
        if (body === null) continue;
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 4));
    }
    return root;
};

const run = (t, overrides) => inspectExtensionManifest({ root: tree(t, overrides) });
const whats = (result) => result.problems.map((problem) => problem.what);
const withManifest = (change) => ({ 'package.json': change(structuredClone(MANIFEST)) });

test('an extension whose manifest and source agree passes, and is counted', (t) => {
    const result = run(t);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.counts, { commands: 2, views: 1, settings: 1 });
});

// ── 1. Identity ─────────────────────────────────────────────────────────────
test('types newer than the oldest editor the extension claims fail', (t) => {
    const result = run(
        t,
        withManifest((m) => ({ ...m, devDependencies: { '@types/vscode': '~1.104.0' } })),
    );
    assert.deepEqual(whats(result), ['`@types/vscode` ~1.104.0 is newer than `engines.vscode` ^1.100.0']);
});

test('a manifest with no publisher or engine fails on each', (t) => {
    const result = run(
        t,
        withManifest(({ publisher: _publisher, engines: _engines, ...m }) => m),
    );
    assert.deepEqual(whats(result), ['has no `publisher`', 'has no `engines.vscode`']);
});

// ── 2. main and the entry ───────────────────────────────────────────────────
test('main pointing at the source fails', (t) => {
    const result = run(
        t,
        withManifest((m) => ({ ...m, main: './src/extension.ts' })),
    );
    assert.ok(whats(result).includes('`main` does not name the bundle'));
});

test('the entry exports what the editor calls and nothing else', (t) => {
    const result = run(t, {
        'src/extension.ts': `${ENTRY.replace('export function activate', 'function activate')}export const VERSION = 1;\n`,
    });
    assert.deepEqual(whats(result), ['does not export `activate`', 'exports `VERSION`']);
});

// ── 3–5. Namespace, commands, views, settings ───────────────────────────────
test('a command outside the namespace fails', (t) => {
    const result = run(t, {
        ...withManifest((m) => {
            m.contributes.commands.push({ command: 'counter.start', title: 'Start' });
            return m;
        }),
        'src/extension.ts': ENTRY.replace(
            "command('tally.reset', reset);",
            "command('tally.reset', reset);\n    command('counter.start', start);",
        ),
    });
    assert.deepEqual(whats(result), ['`counter.start` is outside the `tally.` namespace']);
});

test('a contributed command nothing registers fails, followed through the helper', (t) => {
    const result = run(t, { 'src/extension.ts': ENTRY.replace("    command('tally.reset', reset);\n", '') });
    assert.deepEqual(whats(result), ['command `tally.reset` is contributed but nothing registers it']);
});

test('a registered command the manifest does not list fails, at the registration', (t) => {
    const result = run(t, {
        'src/extension.ts': ENTRY.replace(
            "command('tally.reset', reset);",
            "command('tally.reset', reset);\n    context.subscriptions.push(vscode.commands.registerCommand('tally.secret', reset));",
        ),
    });
    assert.deepEqual(
        result.problems.map((problem) => [problem.file, problem.what]),
        [['src/extension.ts:11', 'registers command `tally.secret`, which the manifest does not contribute']],
    );
});

test('an id the gate cannot read is reported, not guessed', (t) => {
    const result = run(t, {
        'src/extension.ts': ENTRY.replace("command('tally.reset', reset);", 'command(RESET_ID, reset);'),
    });
    assert.deepEqual(whats(result), [
        'command `tally.reset` is contributed but nothing registers it',
        '`command` is given an id this gate cannot read',
    ]);
});

test('a view nothing registers, and one in a container nobody contributes, fail', (t) => {
    const result = run(
        t,
        withManifest((m) => ({
            ...m,
            contributes: { ...m.contributes, views: { tally: [], tallies: [{ id: 'tally.counts', name: 'Counts' }] } },
        })),
    );
    assert.deepEqual(whats(result), ['views sit in `tallies`, which no `viewsContainers` entry contributes']);
    const unregistered = run(t, {
        'src/extension.ts': ENTRY.replace(
            "    context.subscriptions.push(vscode.window.registerTreeDataProvider('tally.counts', createCounts()));\n",
            '',
        ),
    });
    assert.deepEqual(whats(unregistered), ['view `tally.counts` is contributed but nothing registers it']);
});

test('a menu, a keybinding and a welcome link must name a contributed command', (t) => {
    const result = run(
        t,
        withManifest((m) => {
            m.contributes.menus.commandPalette.push({ command: 'tally.gone' });
            m.contributes.keybindings = [
                { command: 'tally.missing', key: 'ctrl+t' },
                { command: '-tally.start', key: 'ctrl+s' },
            ];
            m.contributes.viewsWelcome[0].contents = '[Count](command:tally.count)';
            return m;
        }),
    );
    assert.deepEqual(whats(result), [
        'menu `commandPalette` names `tally.gone`, which is not a contributed command',
        'a keybinding names `tally.missing`, which is not a contributed command',
        'a welcome link names `tally.count`, which is not a contributed command',
    ]);
});

test('a declared setting nothing reads fails', (t) => {
    const result = run(t, { 'src/vscode/settings.ts': null });
    assert.deepEqual(whats(result), ['setting `tally.step` is read nowhere']);
});

test('a setting read through a const, undeclared, fails at the read', (t) => {
    const result = run(t, {
        'src/vscode/more.ts': `import * as vscode from 'vscode';\n\nconst settings = vscode.workspace.getConfiguration('tally');\nexport const size = (): number => settings.get<number>('size', 2);\n`,
    });
    assert.deepEqual(
        result.problems.map((problem) => [problem.file, problem.what]),
        [['src/vscode/more.ts:4', 'reads setting `tally.size`, which the manifest does not declare']],
    );
});

test('a default in code that differs from the manifest fails', (t) => {
    const result = run(t, {
        'src/vscode/settings.ts': SETTINGS.replace("get<number>('step', 1)", "get<number>('step', 5)"),
    });
    assert.deepEqual(whats(result), ['reads `tally.step` with the default 5, not the manifest’s 1']);
});

// ── 6. Activation ───────────────────────────────────────────────────────────
test('activating on `*`, or on what the editor derives, fails', (t) => {
    const result = run(
        t,
        withManifest((m) => ({
            ...m,
            activationEvents: ['*', 'onCommand:tally.start', 'onView:tally.counts', 'onCommand:other.x'],
        })),
    );
    assert.deepEqual(whats(result), [
        'activates on `*`',
        'lists `onCommand:tally.start`',
        'lists `onView:tally.counts`',
    ]);
});

// ── 7. Workspace trust and virtual workspaces ───────────────────────────────
test('workspace trust and virtual workspaces are declared, with a reason when limited', (t) => {
    const missing = run(
        t,
        withManifest(({ capabilities: _capabilities, ...m }) => m),
    );
    assert.deepEqual(whats(missing), [
        '`capabilities.untrustedWorkspaces.supported` is not declared',
        '`capabilities.virtualWorkspaces` is not declared',
    ]);
    const unexplained = run(
        t,
        withManifest((m) => ({
            ...m,
            capabilities: {
                untrustedWorkspaces: { supported: false, restrictedConfigurations: ['tally.gone'] },
                virtualWorkspaces: { supported: false },
            },
        })),
    );
    assert.deepEqual(whats(unexplained), [
        'a limited or unsupported untrusted workspace gives no `description`',
        'restricts `tally.gone`, which is not a declared setting',
    ]);
});

// ── 8. The package ──────────────────────────────────────────────────────────
test('the package is an allowlist that ships main and no source', (t) => {
    assert.deepEqual(whats(run(t, { '.vscodeignore': 'src/\ntests/\n' })), [
        'does not start by leaving everything out',
        'does not ship `main` (out/extension.cjs)',
    ]);
    assert.deepEqual(whats(run(t, { '.vscodeignore': '**\n!out/extension.cjs\n!src/**\n' })), ['ships `src/`']);
    assert.deepEqual(whats(run(t, { '.vscodeignore': null })), ['has neither `files` nor a .vscodeignore']);
});

test('`files` is an allowlist too', (t) => {
    const result = run(t, {
        ...withManifest((m) => ({ ...m, files: ['out/', 'tests/'] })),
        '.vscodeignore': null,
    });
    assert.deepEqual(whats(result), ['ships `tests/`']);
});

// ── 9. Not checked yet ──────────────────────────────────────────────────────
test('a webview, a translated string or a string bundle is refused until a gate checks it', (t) => {
    const result = run(t, {
        'src/vscode/panel.ts': `import * as vscode from 'vscode';\n\nexport const open = (): vscode.WebviewPanel => vscode.window.createWebviewPanel('tally.panel', vscode.l10n.t('Tally'), 1);\n`,
        'package.nls.json': '{}',
    });
    assert.deepEqual(whats(result), [
        'uses createWebviewPanel, which no gate checks yet',
        'uses l10n.t, which no gate checks yet',
        'uses package.nls.json, which no gate checks yet',
    ]);
});
