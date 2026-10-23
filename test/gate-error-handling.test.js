/**
 * The family error-handling gates, against minimal fixture projects.
 * - Each test starts from a project that PASSES and breaks exactly one thing, so a
 * failure names the check that caught it. The passing baseline matters as much as
 * the negatives: a gate that fails everything is as useless as one that fails
 * nothing, and only the baseline tells the two apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkElectronErrorHandling } from '../src/gates/error-handling/electron.ts';
import { checkFullstackErrorHandling } from '../src/gates/error-handling/fullstack.ts';
import { checkTauriErrorHandling } from '../src/gates/error-handling/tauri.ts';

/** Runs `fn` with console captured and the exit code restored afterwards. */
const capture = (fn) => {
    const out = [];
    const err = [];
    const [realLog, realError, realExit] = [console.log, console.error, process.exitCode];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    process.exitCode = undefined;
    try {
        fn();
        return { out: out.join('\n'), err: err.join('\n'), failed: process.exitCode === 1 };
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exitCode = realExit;
    }
};

/** Writes a { path: contents } map into a fresh temp repo and returns its root. */
const project = (files) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lint-config-eh-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return root;
};

// ── Electron ─────────────────────────────────────────────────────────────────

const ELECTRON = {
    'src/main/index.ts': `
process.on('uncaughtException', (e) => log(e));
process.on('unhandledRejection', (e) => log(e));
app.on('before-quit', async () => {
    await fsService.cleanup();
});
`,
    'src/main/handlers.ts': `
ipcMain.handle('vault:read', async (_e, p: string): Promise<{ success: boolean }> => {
    try {
        await fs.readFile(p);
        return { success: true };
    } catch (err) {
        return { success: false, error: String(err) };
    }
});
ipcMain.handle('app:status', () => getStatus());
`,
    'src/renderer/App.vue': '<template><div /></template>\n',
};

const CLEANUP = [['fsService', 'holds the vault fs watcher.']];

/** Runs the Electron gate over ELECTRON with `patch` applied. */
const electron = (patch = {}, options = {}) =>
    capture(() =>
        checkElectronErrorHandling({
            root: project({ ...ELECTRON, ...patch }),
            cleanupRequired: CLEANUP,
            ...options,
        }),
    );

test('electron: a compliant project passes and says what it proved', () => {
    const { out, failed } = electron();
    assert.equal(failed, false);
    // The concise getter is not counted as unguarded, but IS counted as a handler.
    assert.match(out, /2 IPC handlers containing their own failures/);
    assert.match(out, /shutdown releasing 1 native handle\b/);
});

test('electron NEGATIVE: a fallible handler with neither try nor envelope is caught', () => {
    const { err, failed } = electron({
        'src/main/handlers.ts': `ipcMain.handle('vault:read', async (_e, p: string) => {\n  await fs.readFile(p);\n});\n`,
    });
    assert.equal(failed, true);
    assert.match(err, /`vault:read` neither try\/catches nor returns a failure envelope/);
});

test('electron: a concise synchronous getter is not required to guard', () => {
    const { failed } = electron({ 'src/main/handlers.ts': `ipcMain.handle('app:status', () => getStatus());\n` });
    assert.equal(failed, false);
});

test('electron NEGATIVE: a throw in a guard clause above the try is caught', () => {
    // The case the `outsideTry` helper exists for: it reads correctly and it is the
    // one path whose error reaches the renderer unstructured.
    const { err, failed } = electron({
        'src/main/handlers.ts': `
ipcMain.handle('vault:read', async (_e, p: string) => {
    if (!p) throw new Error('no path');
    try {
        await fs.readFile(p);
    } catch (err) {
        return { success: false };
    }
});
`,
    });
    assert.equal(failed, true);
    assert.match(err, /`vault:read` has a `throw` outside its try block/);
});

test('electron NEGATIVE: each missing process backstop is caught', () => {
    for (const event of ['uncaughtException', 'unhandledRejection']) {
        const { err, failed } = electron({
            'src/main/index.ts': ELECTRON['src/main/index.ts'].replace(
                new RegExp(`process\\.on\\('${event}'.*\\n`),
                '',
            ),
        });
        assert.equal(failed, true, `a missing ${event} handler should fail`);
        assert.match(err, new RegExp(`registers no \`process\\.on\\('${event}'\\)\` handler`));
    }
});

test('electron NEGATIVE: a missing before-quit, and a service it forgets to release', () => {
    const withoutHook = electron({
        'src/main/index.ts': `process.on('uncaughtException', (e) => log(e));\nprocess.on('unhandledRejection', (e) => log(e));\n`,
    });
    assert.equal(withoutHook.failed, true);
    assert.match(withoutHook.err, /has no `before-quit` handler/);

    const withoutCleanup = electron(
        {},
        { cleanupRequired: [...CLEANUP, ['aiService', 'holds a model in native memory.']] },
    );
    assert.equal(withoutCleanup.failed, true);
    assert.match(withoutCleanup.err, /`before-quit` never calls `aiService\.cleanup\(\)`/);
});

test('electron: no native handles is a legitimate answer, but the hook is still required', () => {
    assert.equal(electron({}, { cleanupRequired: [] }).failed, false);
    const { err } = electron(
        {
            'src/main/index.ts': `process.on('uncaughtException', (e) => log(e));\nprocess.on('unhandledRejection', (e) => log(e));\n`,
        },
        { cleanupRequired: [] },
    );
    assert.match(err, /has no `before-quit` handler/);
});

// ── Full-stack ───────────────────────────────────────────────────────────────

const FULLSTACK = {
    'packages/shared/src/errors.ts': `export const ERROR_CODES = ['NOT_FOUND', 'INCORRECT_PASSWORD', 'INTERNAL'] as const;\n`,
    'api/src/lib/app-error.ts': `
export class AppError extends Error {
    readonly status: number;
    readonly code: ErrorCode;
    readonly params?: Record<string, string>;
    readonly logContext?: object;
    readonly securityEvent?: boolean;
    constructor(status: number, code: ErrorCode, message: string, options?: AppErrorOptions) { super(message); }
}
type AppErrorOptions = { params?: object; logContext?: object; securityEvent?: boolean };
`,
    'api/src/middleware/error-handler.ts': `
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (err instanceof AppError) { res.status(err.status).json({ error: err.code }); return; }
    if (err instanceof ZodError) { res.status(422).json({ error: 'VALIDATION_FAILED' }); return; }
    res.status(500).json({ error: 'INTERNAL' });
}
`,
    'api/src/index.ts': `app.use(routes);\napp.use(errorHandler);\n`,
    'api/src/routes/thing.ts': `
throw new AppError(404, 'NOT_FOUND', 'no such thing');
throw new AppError(401, 'INCORRECT_PASSWORD', 'bad password', { securityEvent: true });
const x = 'INTERNAL';
`,
    'worker/src/jobs.ts': `const queue = new Worker<Job>('q', run);\nqueue.on('failed', (job, err) => log(err));\n`,
    'frontend/src/api/client.ts': `
const key = \`errors.\${data.error}\`;
if (i18n.global.te(key)) { data.error = i18n.global.t(key); }
else { data.error = i18n.global.t('errors.INTERNAL'); }
`,
    'frontend/src/i18n/locales/en.json': JSON.stringify({
        errors: { NOT_FOUND: 'Not found', INCORRECT_PASSWORD: 'Wrong password', INTERNAL: 'Something broke' },
    }),
};

/** Runs the full-stack gate over FULLSTACK with `patch` applied. */
const fullstack = (patch = {}, options = {}) =>
    capture(() =>
        checkFullstackErrorHandling({
            root: project({ ...FULLSTACK, ...patch }),
            handlerBranches: ['AppError', 'ZodError'],
            ...options,
        }),
    );

test('fullstack: a compliant project passes and says what it proved', () => {
    const { out, err, failed } = fullstack();
    assert.equal(failed, false, err);
    assert.match(out, /2 AppError throws across 2 codes/);
    assert.match(out, /1 credential-failure code carrying the securityEvent flag/);
    // Singular throughout: "1 codes" is the kind of small wrongness that makes a
    // reader stop trusting the rest of the number.
    assert.ok(!/\b1 [a-z-]+s\b/.test(out), `summary should not say "1 <plural>": ${out}`);
});

test('fullstack NEGATIVE: a status outside the policy table is caught', () => {
    const { err, failed } = fullstack({
        'api/src/routes/thing.ts': `throw new AppError(418, 'NOT_FOUND', 'teapot');\nconst x = 'INCORRECT_PASSWORD';\nconst y = 'INTERNAL';\n`,
    });
    assert.equal(failed, true);
    assert.match(err, /status 418 is not in the policy table/);
});

test('fullstack NEGATIVE: 400 for a code that is not parse-level is caught', () => {
    const { err } = fullstack({
        'api/src/routes/thing.ts': `throw new AppError(400, 'NOT_FOUND', 'x');\nconst a = 'INCORRECT_PASSWORD';\nconst b = 'INTERNAL';\n`,
    });
    assert.match(err, /400 for `NOT_FOUND`/);
});

test('fullstack: parseLevel400 is what makes a 400 legitimate', () => {
    const files = {
        'api/src/routes/thing.ts': `throw new AppError(400, 'NOT_FOUND', 'x');\nconst a = 'INCORRECT_PASSWORD';\nconst b = 'INTERNAL';\n`,
    };
    assert.equal(fullstack(files, { parseLevel400: ['NOT_FOUND'] }).failed, false);
});

test('fullstack NEGATIVE: one code thrown as two statuses is caught', () => {
    const { err } = fullstack({
        'api/src/routes/thing.ts': `
throw new AppError(404, 'NOT_FOUND', 'a');
throw new AppError(404, 'NOT_FOUND', 'b');
throw new AppError(409, 'NOT_FOUND', 'c');
const a = 'INCORRECT_PASSWORD';
const b = 'INTERNAL';
`,
    });
    assert.match(err, /`NOT_FOUND` is thrown as 409 here but 404 in 2 other place\(s\)/);
});

test('fullstack NEGATIVE: a credential failure thrown without securityEvent is caught', () => {
    const { err } = fullstack({
        'api/src/routes/thing.ts': `throw new AppError(404, 'NOT_FOUND', 'x');\nthrow new AppError(401, 'INCORRECT_PASSWORD', 'bad');\nconst b = 'INTERNAL';\n`,
    });
    assert.match(err, /`INCORRECT_PASSWORD` is thrown without securityEvent/);
});

test('fullstack NEGATIVE: request input in wire params is caught', () => {
    // The reflected-XSS vector: params are interpolated into a translation client-side.
    const { err } = fullstack({
        'api/src/routes/thing.ts': `throw new AppError(404, 'NOT_FOUND', 'x', { params: { name: req.body.name } });\nconst a = 'INCORRECT_PASSWORD';\nconst b = 'INTERNAL';\n`,
    });
    assert.match(err, /`params` carries request input \(req\.body\)/);
});

test('fullstack NEGATIVE: an error handler mounted before another app.use is caught', () => {
    const { err } = fullstack({ 'api/src/index.ts': `app.use(errorHandler);\napp.use(routes);\n` });
    assert.match(err, /runs after errorHandler/);
});

test('fullstack NEGATIVE: a missing handler branch, and branches out of order', () => {
    const missing = fullstack({
        'api/src/middleware/error-handler.ts': FULLSTACK['api/src/middleware/error-handler.ts'].replace(
            /if \(err instanceof ZodError\).*\n/,
            '',
        ),
    });
    assert.match(missing.err, /a documented branch is missing/);

    const swapped = fullstack({
        'api/src/middleware/error-handler.ts': `
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (err instanceof ZodError) { res.status(422).json({ error: 'VALIDATION_FAILED' }); return; }
    if (err instanceof AppError) { res.status(err.status).json({ error: err.code }); return; }
    res.status(500).json({ error: 'INTERNAL' });
}
`,
    });
    assert.match(swapped.err, /branches are out of order/);
});

test('fullstack NEGATIVE: a code with no translation, and a translation with no code', () => {
    const missing = fullstack({
        'frontend/src/i18n/locales/en.json': JSON.stringify({ errors: { NOT_FOUND: 'x', INTERNAL: 'y' } }),
    });
    assert.match(missing.err, /no translation for `INCORRECT_PASSWORD`/);

    const orphan = fullstack({
        'frontend/src/i18n/locales/en.json': JSON.stringify({
            errors: { NOT_FOUND: 'x', INCORRECT_PASSWORD: 'y', INTERNAL: 'z', GONE: 'stale' },
        }),
    });
    assert.match(orphan.err, /`errors\.GONE` translates a code that no longer exists/);
});

test('fullstack NEGATIVE: a declared code nothing ever throws is caught', () => {
    const { err } = fullstack({
        'packages/shared/src/errors.ts': `export const ERROR_CODES = ['NOT_FOUND', 'INCORRECT_PASSWORD', 'INTERNAL', 'UNUSED'] as const;\n`,
        'frontend/src/i18n/locales/en.json': JSON.stringify({
            errors: { NOT_FOUND: 'x', INCORRECT_PASSWORD: 'y', INTERNAL: 'z', UNUSED: 'w' },
        }),
    });
    assert.match(err, /`UNUSED` is never thrown or emitted/);
});

test('fullstack NEGATIVE: a queue worker with no failed handler is caught', () => {
    const { err } = fullstack({ 'worker/src/jobs.ts': `const queue = new Worker<Job>('q', run);\n` });
    assert.match(err, /Worker `queue` has no 'failed' handler/);
});

test('fullstack NEGATIVE: AppError outside the API is caught, on both kinds of directory', () => {
    const inService = fullstack({ 'worker/src/jobs.ts': `throw new AppError(500, 'INTERNAL', 'x');\n` });
    assert.match(inService.err, /uses AppError/);

    const inFrontend = fullstack({ 'frontend/src/stores/thing.ts': `import { AppError } from 'x';\n` });
    assert.match(inFrontend.err, /references AppError/);

    // appErrorBanDirs holds a directory to the AppError rule without scanning its swallows.
    const inShared = fullstack(
        { 'packages/shared/src/util.ts': `const e = AppError;\ntry { a(); } catch {}\n` },
        { appErrorBanDirs: ['packages/shared/src'] },
    );
    assert.match(inShared.err, /uses AppError/);
    assert.ok(!/swallows a failure/.test(inShared.err), "a shared package's swallows are not this gate's business");
});

test('fullstack NEGATIVE: the interceptor contract is checked in both halves', () => {
    const noLocalise = fullstack({ 'frontend/src/api/client.ts': `data.error = data.error;\n` });
    assert.match(noLocalise.err, /the interceptor does not localise `data\.error`/);

    const noFallback = fullstack({
        'frontend/src/api/client.ts': `const key = \`errors.\${data.error}\`;\nif (i18n.global.te(key)) { data.error = i18n.global.t(key); }\n`,
    });
    assert.match(noFallback.err, /no fallback for an unknown code/);
});

test('fullstack: the key may be built into a variable before te() sees it', () => {
    // Orchid's copy required the template literal inline inside te(); Mosaic's did not,
    // and Mosaic's is right — extracting the variable changes nothing about the contract.
    assert.equal(fullstack().failed, false);
    const inline = fullstack({
        'frontend/src/api/client.ts': `
if (i18n.global.te(\`errors.\${data.error}\`)) { data.error = i18n.global.t(\`errors.\${data.error}\`); }
else { data.error = i18n.global.t('errors.INTERNAL'); }
`,
    });
    assert.equal(inline.failed, false, 'the inline form must keep working too');
});

test("fullstack NEGATIVE: a stale entry in the gate's own lists is caught", () => {
    // A gate whose config drifts from the codebase quietly narrows its own checks.
    const { err } = fullstack({}, { securityEventCodes: ['LONG_GONE'] });
    assert.match(err, /`LONG_GONE` is listed in this gate but no longer exists/);
});

test('fullstack NEGATIVE: a redundant explicit security code is caught', () => {
    const { err } = fullstack({}, { securityEventCodes: ['INCORRECT_PASSWORD'] });
    assert.match(err, /`INCORRECT_PASSWORD` is listed explicitly but a pattern already covers it/);
});

// ── Tauri ────────────────────────────────────────────────────────────────────

const TAURI = {
    'src-tauri/src/lib.rs': `//! The app.

mod commands;

pub fn run() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(panic:% = info; "Panicked");
        previous(info);
    }));
}
`,
    'src-tauri/src/commands/file.rs': `
#[tauri::command]
pub fn take_pending_files(pending: State<'_, PendingFiles>) -> Result<Vec<String>> {
    let mut files = pending
        .0
        .lock()
        .map_err(|_| Error::StatePoisoned)
        .inspect_err(|err| {
            log::error!(command = "take_pending_files", err:? = err; "Command failed");
        })?;
    Ok(files.drain(..).collect())
}

#[tauri::command]
pub fn app_version() -> String {
    String::from("1")
}
`,
    'src/bridge/commands.ts': `
export async function takePendingFiles(): Promise<CommandResult<string[]>> {
    try {
        return { success: true, data: await invoke<string[]>('take_pending_files') };
    } catch (err: unknown) {
        return { success: false, error: toErrorCode(err) };
    }
}
`,
    'src/bridge/files.ts': `
export async function readFile(path: string): Promise<CommandResult<string>> {
    try {
        return { success: true, data: await readTextFile(path) };
    } catch (err: unknown) {
        log.error('File read failed', { err });
        return { success: false, error: 'FILE_READ_FAILED' };
    }
}
`,
};

const tauri = (overrides = {}) => {
    const files = { ...TAURI, ...overrides };
    for (const [rel, body] of Object.entries(files)) if (body === null) delete files[rel];
    return capture(() => checkTauriErrorHandling({ root: project(files) }));
};

const swapTauri = (rel, from, to) => {
    assert.ok(TAURI[rel].includes(from), `fixture ${rel} has no ${from}`);
    return tauri({ [rel]: TAURI[rel].replace(from, to) });
};

test('tauri: a compliant project passes and says what it proved', () => {
    const { failed, out } = tauri();
    assert.equal(failed, false);
    assert.match(out, /1 fallible command logging their own failures/);
});

test('tauri NEGATIVE: a command that can fail and never logs is caught', () => {
    const { err } = swapTauri(
        'src-tauri/src/commands/file.rs',
        `
        .inspect_err(|err| {
            log::error!(command = "take_pending_files", err:? = err; "Command failed");
        })?;`,
        '?;',
    );
    assert.match(err, /command `take_pending_files` can fail and never logs it/);
});

test('tauri: a command with no failure path is not asked to log', () => {
    // `app_version` returns no Result; a Result-returning command with no `?` or `Err` is the same.
    const { failed } = tauri({
        'src-tauri/src/commands/other.rs': '#[tauri::command]\npub fn ping() -> Result<()> {\n    Ok(())\n}\n',
    });
    assert.equal(failed, false);
});

test('tauri NEGATIVE: the bridge logging a command failure again is caught; a plugin wrapper is not', () => {
    const { err } = swapTauri(
        'src/bridge/commands.ts',
        'return { success: false',
        "log.error('Command failed', { err });\n        return { success: false",
    );
    assert.match(err, /`takePendingFiles` logs the failure of a command it invokes/);
    assert.doesNotMatch(err, /readFile/);
});

test('tauri NEGATIVE: no panic hook, and a hook that does not log, are caught', () => {
    const none = tauri({ 'src-tauri/src/lib.rs': '//! The app.\n\npub fn run() {}\n' });
    assert.match(none.err, /installs no panic hook/);
    const silent = swapTauri('src-tauri/src/lib.rs', 'log::error!(panic:% = info; "Panicked");', '');
    assert.match(silent.err, /the panic hook does not log/);
});

test('tauri NEGATIVE: a Rust swallow without a reason is caught, in each shape', () => {
    const shapes = [
        'window.show().ok();',
        'match window.show() {\n        Ok(()) => {}\n        Err(_) => {}\n    }',
        'if let Err(_) = window.show() {}',
    ];
    for (const shape of shapes) {
        const { err } = tauri({ 'src-tauri/src/window.rs': `fn show(window: &Window) {\n    ${shape}\n}\n` });
        assert.match(err, /without a reason/, shape);
    }
});

test('tauri: a Rust swallow with a reason beside it, above it or inside it passes', () => {
    const reasons = [
        '// The window is already closing; a failed show changes nothing.\n    window.show().ok();',
        'window.show().ok(); // The window is already closing.',
        'if let Err(_) = window.show() {\n        // The window is already closing.\n    }',
    ];
    for (const shape of reasons) {
        const { failed, err } = tauri({ 'src-tauri/src/window.rs': `fn show(window: &Window) {\n    ${shape}\n}\n` });
        assert.equal(failed, false, `${shape}\n${err}`);
    }
});

test('tauri NEGATIVE: a placeholder is not a reason', () => {
    const { err } = tauri({
        'src-tauri/src/window.rs': 'fn show(window: &Window) {\n    // ignore\n    window.show().ok();\n}\n',
    });
    assert.match(err, /`\.ok\(\);` discards an error without a reason \("ignore"\)/);
});

test('tauri NEGATIVE: an empty catch in the webview is caught', () => {
    const { err } = tauri({ 'src/composables/useThing.ts': 'try {\n    run();\n} catch {\n    // ignore\n}\n' });
    assert.match(err, /swallows a failure without a reason/);
});
