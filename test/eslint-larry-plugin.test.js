/**
 * The `larry/` rule, run on real code through ESLint's RuleTester, plus where it and
 * the cast ban are switched on. Every invalid case is a shape that reached a response in a
 * real project, or the nearest variation of one.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, RuleTester } from 'eslint';
import ts from 'typescript-eslint';

import { larry } from '../src/eslint/index.ts';
import { larryPlugin } from '../src/eslint/rules/larry-plugin.ts';
import * as electron from '../src/eslint/electron/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: ts.parser } });
const leak = { messageId: 'messageLeak' };

tester.run('no-caught-message-leak', larryPlugin.rules['no-caught-message-leak'], {
    valid: [
        // To the log, whole or in part.
        'try { a(); } catch (err) { logger.error({ err }, "Failed"); }',
        'try { a(); } catch (err) { logger.error({ detail: err.message }, "Failed"); }',
        'try { a(); } catch (err) { req.log.warn({ detail: err.message }, "Failed"); }',
        'try { a(); } catch (err) { this.logger.info({ stack: err.stack }, "Failed"); }',
        'p.catch((err) => logger.warn({ reason: err.message }, "Failed"));',
        // Into an error's own message: the error handler logs it and sends only the code.
        'try { a(); } catch (err) { throw new AppError(401, "INVALID_TOKEN", `Webhook: ${err.message}`); }',
        'try { a(); } catch (err) { throw new Error(`wrap: ${String(err)}`, { cause: err }); }',
        'try { a(); } catch (err) { throw new AppError(500, "INTERNAL", "Failed", { logContext: { reason: err.message } }); }',
        // Through a variable, as long as the variable goes somewhere allowed.
        `try { a(); } catch (err) {
            const detail = err instanceof Error ? err.message : 'Verification failed';
            throw new AppError(401, 'INVALID_TOKEN', \`Stripe: \${detail}\`, { logContext: { op: 'webhook' } });
        }`,
        // Read to decide something, not sent.
        'try { a(); } catch (err) { if (err.message.includes("E11000")) return null; throw err; }',
        'try { a(); } catch (err) { if (/duplicate/.test(err.message)) return; throw err; }',
        'try { a(); } catch (err) { return err.message === "aborted"; }',
        'try { a(); } catch (err) { if (!err.message) throw err; }',
        'try { a(); } catch (err) { return err.message.includes("timeout"); }',
        "try { a(); } catch (err) { results.push({ error: err.message ? 'FAILED' : 'UNKNOWN' }); }",
        "try { a(); } catch (err) { throw new AppError(401, 'X', String(err.message)); }",
        // A code goes out instead.
        "try { a(); } catch (err) { results.push({ error: err instanceof AppError ? err.code : 'UPLOAD_FAILED' }); }",
        // The error itself handed on is not its message.
        'try { a(); } catch (err) { report(err); }',
        // A message configured to sit elsewhere.
        {
            code: 'try { a(); } catch (err) { throw new HttpError(err.message); }',
            options: [{ messageArgs: { HttpError: 0 } }],
        },
    ],
    invalid: [
        // The shape that shipped: a batch result carrying each failure's message.
        {
            code: "try { a(); } catch (err) { results.push({ status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' }); }",
            errors: [leak],
        },
        { code: 'try { a(); } catch (err) { res.json({ error: err.message }); }', errors: [leak] },
        // An IPC handler's reply.
        {
            code: "try { a(); } catch (err) { return { success: false, error: err instanceof Error ? err.message : 'Write failed' }; }",
            errors: [leak],
        },
        { code: 'try { a(); } catch (err) { return err.stack; }', errors: [leak] },
        // Through a variable.
        {
            code: 'try { a(); } catch (err) { const msg = (err as Error).message; return { error: msg }; }',
            errors: [leak],
        },
        {
            code: "function f() { let reason = ''; try { a(); } catch (err) { reason = err.message; } return { reason }; }",
            errors: [leak],
        },
        // Destructured, aliased, stringified, trimmed.
        { code: 'try { a(); } catch ({ message }) { return { error: message }; }', errors: [leak] },
        { code: 'try { a(); } catch (e) { const failure = e; send(failure.message); }', errors: [leak] },
        { code: 'try { a(); } catch (err) { item.lastError = String(err); }', errors: [leak] },
        { code: 'try { a(); } catch (err) { results.push({ error: `${err}` }); }', errors: [leak] },
        { code: 'try { a(); } catch (err) { results.push({ error: `Failed: ${err.message}` }); }', errors: [leak] },
        { code: 'try { a(); } catch (err) { results.push({ error: err.message.slice(0, 80) }); }', errors: [leak] },
        { code: 'try { a(); } catch (err) { results.push({ error: err.toString() }); }', errors: [leak] },
        // A promise's catch.
        { code: 'const r = p.catch((err) => ({ error: err.message }));', errors: [leak] },
        // Into an error, but not as its message: the code and `params` both reach the client.
        { code: "try { a(); } catch (err) { throw new AppError(500, err.message, 'Failed'); }", errors: [leak] },
        {
            code: "try { a(); } catch (err) { throw new AppError(400, 'X', 'Failed', { params: { detail: err.message } }); }",
            errors: [leak],
        },
    ],
});

const ROOT = '/tmp/lint-config-eslint-test';

const severityOf = async (config, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved?.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

const electronConfig = larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards() });
const fullstackConfig = larry({ preset: 'fullstack', rootDir: ROOT, standards: fullstack.fullstackStandards() });

test('unchecked casts are banned in every typed file of both families, tests most of all', async () => {
    const rule = '@typescript-eslint/no-unsafe-type-assertion';
    for (const file of ['src/main/index.ts', 'src/renderer/App.vue', 'tests/thing.test.ts']) {
        assert.equal(await severityOf(electronConfig, file, rule), 2, file);
    }
    for (const file of [
        'api/src/routes/x.ts',
        'api/src/routes/__tests__/x.test.ts',
        'frontend/src/App.vue',
        'frontend/src/composables/__tests__/x.test.ts',
        'worker/src/index.ts',
        'packages/shared/src/index.ts',
        'e2e/specs/x.spec.ts',
        'scripts/x.ts',
    ]) {
        assert.equal(await severityOf(fullstackConfig, file, rule), 2, file);
    }
});

test('the message-leak rule covers the side that answers someone outside the process', async () => {
    const rule = 'larry/no-caught-message-leak';
    assert.equal(await severityOf(fullstackConfig, 'api/src/services/media/upload.ts', rule), 2);
    assert.equal(await severityOf(fullstackConfig, 'worker/src/jobs/transcode.ts', rule), 2);
    assert.equal(await severityOf(fullstackConfig, 'api/src/services/__tests__/x.test.ts', rule), 'absent');
    assert.equal(await severityOf(fullstackConfig, 'frontend/src/App.vue', rule), 'absent');
    assert.equal(await severityOf(electronConfig, 'src/main/services/file.ts', rule), 2);
    assert.equal(await severityOf(electronConfig, 'src/preload/index.ts', rule), 2);
    assert.equal(await severityOf(electronConfig, 'src/renderer/App.vue', rule), 'absent');
});

test('a workspace given the services role gets the message-leak rule too', async () => {
    const config = larry({
        preset: 'fullstack',
        rootDir: ROOT,
        standards: fullstack.fullstackStandards(),
        workspaces: { services: ['worker', 'ingestor'] },
    });
    assert.equal(await severityOf(config, 'ingestor/src/feed.ts', 'larry/no-caught-message-leak'), 2);
});
