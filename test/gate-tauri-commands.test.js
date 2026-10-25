/**
 * The Tauri commands gate against a temp app with the whole chain: lib.rs registering
 * a command from commands/file.rs, build.rs listing it, a capability granting it, the
 * bridge invoking it, an event emitted through a constant and listened for, and an
 * error whose code the bridge knows. Each test breaks one link.
 * - The traps are the silent ones: a second `invoke_handler` that unregisters the
 * first, a name the bridge spells differently from Rust, and a command that compiles,
 * registers and is refused because no capability grants it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectTauriCommands } from '../src/gates/tauri-commands.ts';

const LIB = `//! The app.

mod commands;
mod error;

use tauri::{AppHandle, Emitter};

use crate::commands::file::FILE_OPENED;

pub fn run() {
    let _app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::file::take_pending_files])
        .build(tauri::generate_context!());
}

fn queue_file(app: &AppHandle, path: &str) {
    if let Err(err) = app.emit(FILE_OPENED, path) {
        log::warn!(err:? = err; "Could not announce an opened file");
    }
}
`;

const FILE = `//! Files the OS opened.

use std::sync::Mutex;

use tauri::State;

use crate::error::{Error, Result};

/// The event that hands the window a file the OS opened.
pub const FILE_OPENED: &str = "file:opened";

#[derive(Default)]
pub struct PendingFiles(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn take_pending_files(pending: State<'_, PendingFiles>) -> Result<Vec<String>> {
    let mut files = pending.0.lock().map_err(|_| Error::StatePoisoned)?;
    Ok(files.drain(..).collect())
}
`;

const ERROR = `//! The error every command returns.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("a lock was poisoned")]
    StatePoisoned,
}

impl Error {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::StatePoisoned => "INTERNAL",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
`;

const BUILD = `const COMMANDS: &[&str] = &["take_pending_files"];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)));
}
`;

const CAPABILITY = JSON.stringify({
    identifier: 'main',
    windows: ['main'],
    permissions: ['core:default', 'allow-take-pending-files'],
});

const COMMANDS_TS = `import { invoke } from '@tauri-apps/api/core';

import { toErrorCode, type CommandResult } from '@/bridge/errors';

export async function takePendingFiles(): Promise<CommandResult<string[]>> {
    try {
        return { success: true, data: await invoke<string[]>('take_pending_files') };
    } catch (err: unknown) {
        return { success: false, error: toErrorCode(err) };
    }
}
`;

const EVENTS_TS = `import { listen } from '@tauri-apps/api/event';

export async function onFileOpened(handler: (path: string) => void): Promise<() => void> {
    return await listen<string>('file:opened', (event) => {
        handler(event.payload);
    });
}
`;

const ERRORS_TS = `export const ERROR_CODES = ['INTERNAL', 'FILE_READ_FAILED'] as const;
`;

const FILES = {
    'src-tauri/src/lib.rs': LIB,
    'src-tauri/src/commands.rs': 'pub mod file;\n',
    'src-tauri/src/commands/file.rs': FILE,
    'src-tauri/src/error.rs': ERROR,
    'src-tauri/build.rs': BUILD,
    'src-tauri/capabilities/main.json': CAPABILITY,
    'src/bridge/commands.ts': COMMANDS_TS,
    'src/bridge/events.ts': EVENTS_TS,
    'src/bridge/errors.ts': ERRORS_TS,
};

function app(t, files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-tauri-cmd-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [rel, body] of Object.entries({ ...FILES, ...files })) {
        if (body === null) continue;
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
    }
    return root;
}

const whats = (root) => inspectTauriCommands({ root }).problems.map((p) => p.what);

/** The app with one file's text replaced. */
const swap = (t, rel, from, to) => {
    const before = FILES[rel];
    assert.ok(before.includes(from), `fixture ${rel} has no ${from}`);
    return whats(app(t, { [rel]: before.replace(from, to) }));
};

test('the whole chain passes, and the counts are what it holds', (t) => {
    const { problems, counts } = inspectTauriCommands({ root: app(t) });
    assert.deepEqual(problems, []);
    assert.deepEqual(counts, { commands: 1, invokes: 1, events: 1, codes: 1 });
});

test('a missing crate is one problem, not a crash', (t) => {
    assert.deepEqual(
        whats(
            app(t, {
                'src-tauri/src/lib.rs': null,
                'src-tauri/src/commands.rs': null,
                'src-tauri/src/commands/file.rs': null,
                'src-tauri/src/error.rs': null,
            }),
        ).slice(0, 1),
        ['does not exist'],
    );
});

// ── Registration ────────────────────────────────────────────────────────────

test('THE SECOND HANDLER TRAP: a second invoke_handler fails', (t) => {
    const problems = swap(
        t,
        'src-tauri/src/lib.rs',
        '.build(',
        '.invoke_handler(tauri::generate_handler![commands::file::take_pending_files])\n        .build(',
    );
    assert.ok(problems.includes('calls `invoke_handler` a second time'), problems.join('\n'));
});

test('a command missing from generate_handler! fails, and so does a stray entry', (t) => {
    const unregistered = swap(
        t,
        'src-tauri/src/lib.rs',
        'commands::file::take_pending_files',
        'commands::file::read_note',
    );
    assert.ok(unregistered.includes('command `take_pending_files` is not in `generate_handler!`'));
    assert.ok(unregistered.includes('`generate_handler!` registers `read_note`, which is no `#[tauri::command]` here'));
});

test('a command outside commands/, or not pub, fails', (t) => {
    const root = app(t, {
        'src-tauri/src/lib.rs': LIB.replace('pub fn run', '#[tauri::command]\nfn ping() {}\n\npub fn run').replace(
            'take_pending_files]',
            'take_pending_files, ping]',
        ),
        'src-tauri/build.rs': BUILD.replace('"take_pending_files"', '"take_pending_files", "ping"'),
        'src-tauri/capabilities/main.json': CAPABILITY.replace(
            '"allow-take-pending-files"',
            '"allow-take-pending-files","allow-ping"',
        ),
        'src/bridge/commands.ts': `${COMMANDS_TS}\nexport async function ping(): Promise<void> {\n    await invoke('ping');\n}\n`,
    });
    assert.deepEqual(whats(root), [
        'command `ping` is outside `src-tauri/src/commands/`',
        'command `ping` is not `pub`',
    ]);
});

test('two commands with one name collide, across modules', (t) => {
    const root = app(t, {
        'src-tauri/src/commands/other.rs': '#[tauri::command]\npub fn take_pending_files() {}\n',
    });
    assert.ok(
        whats(root).includes('command `take_pending_files` is also defined in src-tauri/src/commands/other.rs:2'),
    );
});

// ── Return types ────────────────────────────────────────────────────────────

test('a command failing with String fails', (t) => {
    assert.deepEqual(
        swap(
            t,
            'src-tauri/src/commands/file.rs',
            '-> Result<Vec<String>>',
            '-> std::result::Result<Vec<String>, String>',
        ),
        ['command `take_pending_files` fails with `String`'],
    );
});

test('tauri::Result and anyhow::Result fail: their error serialises to English', (t) => {
    assert.deepEqual(
        swap(t, 'src-tauri/src/commands/file.rs', '-> Result<Vec<String>>', '-> tauri::Result<Vec<String>>'),
        ['command `take_pending_files` fails with `tauri::Error`'],
    );
    assert.deepEqual(
        swap(t, 'src-tauri/src/commands/file.rs', '-> Result<Vec<String>>', '-> anyhow::Result<Vec<String>>'),
        ['command `take_pending_files` fails with `anyhow::Error`'],
    );
});

test('a bare Result imported from outside the crate fails', (t) => {
    assert.deepEqual(
        swap(
            t,
            'src-tauri/src/commands/file.rs',
            'use crate::error::{Error, Result};',
            'use crate::error::Error;\nuse tauri::Result;',
        ),
        ['command `take_pending_files` returns a `Result` imported from outside the crate'],
    );
});

test('Result<T, Error> and a crate path to Error pass', (t) => {
    assert.deepEqual(
        swap(
            t,
            'src-tauri/src/commands/file.rs',
            '-> Result<Vec<String>>',
            '-> std::result::Result<Vec<String>, crate::error::Error>',
        ),
        [],
    );
});

// ── build.rs ────────────────────────────────────────────────────────────────

test('no command list in build.rs fails', (t) => {
    assert.deepEqual(whats(app(t, { 'src-tauri/build.rs': 'fn main() {\n    tauri_build::build();\n}\n' })), [
        'does not list the app’s commands (`AppManifest::new().commands(COMMANDS)`)',
    ]);
});

test('build.rs listing too much or too little fails, both ways', (t) => {
    const problems = swap(t, 'src-tauri/build.rs', '"take_pending_files"', '"take_pending_file"');
    assert.deepEqual(problems, [
        'lists `take_pending_file`, which is not registered',
        'does not list `take_pending_files`',
    ]);
});

test('an inline list in build.rs is read too', (t) => {
    assert.deepEqual(swap(t, 'src-tauri/build.rs', '.commands(COMMANDS)', '.commands(&["take_pending_files"])'), []);
});

// ── Capabilities ────────────────────────────────────────────────────────────

test('THE UNGRANTED TRAP: a registered command no capability grants fails', (t) => {
    assert.deepEqual(
        whats(
            app(t, {
                'src-tauri/capabilities/main.json': JSON.stringify({
                    identifier: 'main',
                    permissions: ['core:default'],
                }),
            }),
        ),
        ['no capability grants `allow-take-pending-files`'],
    );
});

test('a grant naming no command fails; one the app defines in permissions/ passes', (t) => {
    const stale = JSON.stringify({ identifier: 'main', permissions: ['allow-take-pending-files', 'allow-read-note'] });
    assert.deepEqual(whats(app(t, { 'src-tauri/capabilities/main.json': stale })), [
        'grants `allow-read-note`, which names no registered command',
    ]);
    const defined = app(t, {
        'src-tauri/capabilities/main.json': stale,
        'src-tauri/permissions/notes.toml':
            '[[permission]]\nidentifier = "allow-read-note"\ncommands.allow = ["take_pending_files"]\n',
    });
    assert.deepEqual(whats(defined), []);
});

// ── The bridge ──────────────────────────────────────────────────────────────

test('THE SPELLING TRAP: the bridge invoking a name Rust does not register fails, both ways', (t) => {
    assert.deepEqual(swap(t, 'src/bridge/commands.ts', "'take_pending_files'", "'takePendingFiles'"), [
        'invokes `takePendingFiles`, which Rust does not register',
        '`take_pending_files` is registered and the bridge never invokes it',
    ]);
});

test('an invoke whose name is not a literal fails', (t) => {
    assert.deepEqual(
        swap(t, 'src/bridge/commands.ts', "invoke<string[]>('take_pending_files')", 'invoke<string[]>(COMMAND)'),
        [
            'calls `invoke` with a name that is not a string literal',
            '`take_pending_files` is registered and the bridge never invokes it',
        ],
    );
});

test('a nested type argument on invoke is skipped, and a plugin command is not the app’s', (t) => {
    const ts = `${COMMANDS_TS.replace(
        'invoke<string[]>',
        'invoke<Array<Record<string, number>>>',
    )}\nexport async function x(): Promise<void> {\n    await invoke('plugin:dialog|open');\n}\n`;
    assert.deepEqual(whats(app(t, { 'src/bridge/commands.ts': ts })), []);
});

test('a commented-out invoke is not read', (t) => {
    assert.deepEqual(whats(app(t, { 'src/bridge/commands.ts': `${COMMANDS_TS}\n// await invoke('gone');\n` })), []);
});

// ── Events ──────────────────────────────────────────────────────────────────

test('an event emitted by a string literal fails', (t) => {
    const problems = swap(t, 'src-tauri/src/lib.rs', 'app.emit(FILE_OPENED, path)', 'app.emit("file:opened", path)');
    assert.ok(problems.includes('emits an event named by a string literal'), problems.join('\n'));
});

test('an event constant that is not domain:action, or not pub, fails', (t) => {
    const problems = swap(
        t,
        'src-tauri/src/commands/file.rs',
        'pub const FILE_OPENED: &str = "file:opened";',
        'const FILE_OPENED: &str = "file-opened";',
    );
    assert.ok(problems.includes('event constant `FILE_OPENED` is not `pub`'));
    assert.ok(problems.includes('event `file-opened` is not `domain:action` in lowerCamelCase'));
});

test('an event nobody listens for, and a listener for one nobody emits, both fail', (t) => {
    assert.deepEqual(swap(t, 'src/bridge/events.ts', "'file:opened'", "'file:changed'"), [
        'listens for `file:changed`, which Rust never emits',
        'emits `file:opened`, which the bridge never listens for',
    ]);
});

test('emit_to reads the event from its second argument', (t) => {
    assert.deepEqual(
        swap(t, 'src-tauri/src/lib.rs', 'app.emit(FILE_OPENED, path)', 'app.emit_to("main", FILE_OPENED, path)'),
        [],
    );
});

test('Tauri’s own events need no Rust emitter', (t) => {
    const ts = `${EVENTS_TS}\nexport async function onDrop(handler: () => void): Promise<() => void> {\n    return await listen('tauri://drag-drop', handler);\n}\n`;
    assert.deepEqual(whats(app(t, { 'src/bridge/events.ts': ts })), []);
});

// ── Error codes ─────────────────────────────────────────────────────────────

test('a code Rust returns that ERROR_CODES lacks fails', (t) => {
    const error = ERROR.replace('StatePoisoned,\n}', 'StatePoisoned,\n    #[error("read")]\n    Read,\n}').replace(
        'Self::StatePoisoned => "INTERNAL",',
        'Self::StatePoisoned => "INTERNAL",\n            Self::Read => "NOTE_READ_FAILED",',
    );
    assert.deepEqual(whats(app(t, { 'src-tauri/src/error.rs': error })), [
        '`code()` returns `NOTE_READ_FAILED`, which `ERROR_CODES` does not list',
    ]);
});

test('an error with no code(), or a Serialize that writes more, fails', (t) => {
    assert.deepEqual(
        swap(t, 'src-tauri/src/error.rs', 'pub const fn code(&self)', 'pub const fn name(&self)').slice(0, 1),
        ['has no `fn code(&self)`'],
    );
    assert.deepEqual(
        swap(
            t,
            'src-tauri/src/error.rs',
            'serializer.serialize_str(self.code())',
            'serializer.serialize_str(&self.to_string())',
        ),
        ['`Serialize` writes more than `self.code()`'],
    );
});

test('an error that derives Serialize instead fails', (t) => {
    const derived = ERROR.replace(/impl Serialize for Error \{[\s\S]*?\n\}\n/, '');
    assert.deepEqual(whats(app(t, { 'src-tauri/src/error.rs': derived })), ['has no `impl Serialize for Error`']);
});

// ── Stringified errors ──────────────────────────────────────────────────────

test('map_err to the English message fails, however it is spelt', (t) => {
    for (const spelling of [
        '.map_err(|e| e.to_string())',
        '.map_err(|err: std::io::Error| format!("failed: {err}"))',
        '.map_err(ToString::to_string)',
        '.map_err(|e| { e.to_string() })',
    ]) {
        const rs = `${FILE}\nfn helper() -> std::result::Result<(), String> {\n    std::fs::read("x")${spelling}?;\n    Ok(())\n}\n`;
        assert.ok(
            whats(app(t, { 'src-tauri/src/commands/file.rs': rs })).includes(
                'turns an error into its English message with `map_err`',
            ),
            spelling,
        );
    }
});

test('map_err to a variant of the app’s Error passes', (t) => {
    assert.deepEqual(whats(app(t)), []);
});
