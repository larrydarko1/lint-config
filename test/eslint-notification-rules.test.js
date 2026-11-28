/**
 * The notification rules, run through ESLint's RuleTester, plus where each is switched on.
 * The valid cases are the lookalikes a project really has: a local `notify`, a `t` it wrote
 * itself, a catch that hands its failure to a helper or a caller.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, RuleTester } from 'eslint';
import globals from 'globals';
import ts from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

import { larry } from '../src/eslint/index.ts';
import { notificationRules } from '../src/eslint/rules/notifications.ts';
import * as electron from '../src/eslint/electron/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
    languageOptions: { parser: ts.parser, sourceType: 'module', globals: globals.browser },
});
const vueTester = new RuleTester({
    languageOptions: { parser: vueParser, parserOptions: { parser: ts.parser }, sourceType: 'module' },
});

const NOTIFY = "import { notify } from '@/composables/ui/useNotifications';\n";

tester.run('notify-usage', notificationRules['notify-usage'], {
    valid: [
        `${NOTIFY}notify.error(t('errors.save_failed')); notify.dismiss('save');`,
        "import { notify, useNotifications } from '@/renderer/composables/ui/useNotifications';",
        // Not the module's `notify`: a local one, or another module's.
        'const notify = { success() {} }; notify.success();',
        "import { notify } from '@/lib/mailer'; notify.info('x');",
    ],
    invalid: [
        {
            code: "import { notify } from '@/composables/useNotifications';",
            errors: [{ messageId: 'home' }],
        },
        {
            code: "import { useNotifications } from '@/composables/engagement/useNotifications';",
            errors: [{ messageId: 'home' }],
        },
        { code: `${NOTIFY}notify.success(t('saved'));`, errors: [{ messageId: 'method' }] },
        { code: `${NOTIFY}notify.info('x');`, errors: [{ messageId: 'method' }] },
        { code: `${NOTIFY}notify['warn']('x');`, errors: [{ messageId: 'method' }] },
    ],
});

tester.run('notify-translated', notificationRules['notify-translated'], {
    valid: [
        `${NOTIFY}import { useI18n } from 'vue-i18n'; const { t } = useI18n(); notify.error(t('errors.save_failed'));`,
        `${NOTIFY}import { i18n } from '@/i18n'; notify.error(i18n.global.t('errors.load_failed'));`,
        `${NOTIFY}import { t } from '@/i18n'; notify.error(t('errors.x', { reason }), { id: 'x' });`,
        `${NOTIFY}import { i18n } from '@/i18n'; const translate = i18n.global.t; notify.error(translate('errors.export_failed'));`,
        `${NOTIFY}import { useI18n } from 'vue-i18n'; const { t: translate } = useI18n(); notify.error(translate('errors.x'));`,
        `${NOTIFY}import { t as translate } from '@/i18n'; notify.error(translate('errors.x'));`,
        // Another module's `notify` is not held to it.
        "const notify = { error() {} }; notify.error('x');",
    ],
    invalid: [
        { code: `${NOTIFY}notify.error('Could not save.');`, errors: [{ messageId: 'translated' }] },
        { code: `${NOTIFY}const message = 'x'; notify.error(message);`, errors: [{ messageId: 'translated' }] },
        { code: `${NOTIFY}notify.error(failureMessage('saved'));`, errors: [{ messageId: 'translated' }] },
        { code: `${NOTIFY}notify.error();`, errors: [{ messageId: 'translated' }] },
        // A `.t` that is not vue-i18n's is still a member call; only `.t(…)` itself counts.
        { code: `${NOTIFY}notify.error(messages.format('x'));`, errors: [{ messageId: 'translated' }] },
        // A function merely named `t` translates nothing.
        {
            code: `${NOTIFY}import { format } from '@/i18n'; notify.error(format('x'));`,
            errors: [{ messageId: 'translated' }],
        },
        {
            code: `${NOTIFY}const { format } = useI18n(); notify.error(format('x'));`,
            errors: [{ messageId: 'translated' }],
        },
        {
            code: `${NOTIFY}const translate = messages.format; notify.error(translate('x'));`,
            errors: [{ messageId: 'translated' }],
        },
        { code: `${NOTIFY}const t = (s) => s; notify.error(t('x'));`, errors: [{ messageId: 'translated' }] },
    ],
});

const APP = '/project/src/App.vue';

vueTester.run('notification-center', notificationRules['notification-center'], {
    valid: [
        { filename: APP, code: '<template><div><main v-if="ready" /><NotificationCenter /></div></template>' },
        { filename: APP, code: '<template><notification-center /></template>' },
        // Not every project has one; the dead-code gate catches a module nobody renders.
        { filename: APP, code: '<template><main /></template>' },
        { filename: '/project/src/views/Home.vue', code: '<template><main /></template>' },
    ],
    invalid: [
        {
            filename: '/project/src/views/Home.vue',
            code: '<template><NotificationCenter /></template>',
            errors: [{ messageId: 'notApp' }],
        },
        {
            filename: APP,
            code: '<template><div><NotificationCenter /><NotificationCenter /></div></template>',
            errors: [{ messageId: 'twice' }],
        },
        {
            filename: APP,
            code: '<template><div v-if="ready"><NotificationCenter /></div></template>',
            errors: [{ messageId: 'conditional' }],
        },
        {
            filename: APP,
            code: '<template><div><template v-else><NotificationCenter /></template></div></template>',
            errors: [{ messageId: 'conditional' }],
        },
        {
            filename: APP,
            code: '<template><NotificationCenter v-show="open" /></template>',
            errors: [{ messageId: 'conditional' }],
        },
    ],
});

const silent = [{ messageId: 'silent' }];

tester.run('catch-reports', notificationRules['catch-reports'], {
    valid: [
        // Shown.
        `${NOTIFY}try { await save(); } catch { notify.error(t('errors.save_failed')); }`,
        'try { await load(); } catch { loadError.value = t("errors.load_failed"); }',
        'try { await load(); } catch { state.error = "LOAD_FAILED"; }',
        'const emit = defineEmits(); try { await save(); } catch { emit("failed"); }',
        // Passed on.
        'try { await save(); } catch (err) { if (isAbort(err)) return; throw err; }',
        // A `try` with only a `finally` lets the throw out.
        'function check(x) { try { if (x === null) throw new Error("missing"); } finally { cleanup(); } } try { await save(); } catch { check(null); }',
        'try { await save(); } catch (err) { try { await undo(); } finally { throw err; } }',
        'function f() { try { return parse(x); } catch { return null; } }',
        'new Promise((resolve, reject) => { try { resolve(run()); } catch (err) { reject(err); } });',
        'const rejected = []; for (const f of files) { try { await upload(f); } catch { rejected.push(f); } }',
        // Through a helper in the same file that shows it.
        `${NOTIFY}function reportFailure() { notify.error(t('errors.save_failed')); }
         try { await save(); } catch { reportFailure(); }`,
        `${NOTIFY}const reportFailure = () => notify.error(t('x')); load().catch(() => reportFailure());`,
        "import { useI18n } from 'vue-i18n'; const { t } = useI18n(); function fail() { message.value = t('errors.save_failed'); } try { await save(); } catch { fail(); }",
        'const emit = defineEmits(); function failed() { emit("failed"); } try { await save(); } catch { failed(); }',
        // A promise's handler that resolves to a value the caller checks.
        'const data = await load().catch(() => null);',
        'load().catch((err) => { throw new LoadError(err); });',
        // A handler passed by name is the named function's business.
        'load().catch(onFailure);',
        // An empty catch whose comment says why: the reason the error-handling gate asks for.
        'try { await unlink(tmp); } catch { /* the file was already gone */ }',
        'try { await unlink(tmp); } catch {\n    // the file was already gone\n}',
        'load().catch(() => {\n    // the log is the channel that failed\n});',
    ],
    invalid: [
        { code: 'try { await save(); } catch {}', errors: silent },
        { code: 'try { await save(); } catch { /* ignore */ }', errors: silent },
        { code: 'try { await save(); } catch { /* noop. */ }', errors: silent },
        { code: 'load().catch(() => { /* ignore */ });', errors: silent },
        // A disable comment inside gives no reason for the drop.
        { code: 'try { await save(); } catch { /* eslint-disable-line no-empty */ }', errors: silent },
        // A comment beside code that only logs is not an empty catch: the disable comment is the escape there.
        { code: 'try { await save(); } catch (err) { /* nothing to show */ console.error(err); }', errors: silent },
        { code: 'try { await save(); } catch (err) { console.error(err); }', errors: silent },
        { code: 'try { await save(); } catch (err) { logger.warn({ err }, "save failed"); }', errors: silent },
        { code: 'async function f() { try { await save(); } catch { return; } }', errors: silent },
        { code: 'async function f() { try { await save(); } catch { return undefined; } }', errors: silent },
        // Another export of the notification module is not `notify`.
        {
            code: "import { history } from '@/composables/ui/useNotifications'; try { await save(); } catch (err) { history.log(err); }",
            errors: silent,
        },
        { code: 'load().catch(() => {});', errors: silent },
        { code: 'load().catch((err) => console.warn(err));', errors: silent },
        { code: 'load().catch(() => undefined);', errors: silent },
        { code: 'load().then(show, () => {});', errors: silent },
        // An expression body made for what it does returns nothing the caller can check.
        { code: 'load().catch(async (err) => await flushLog(err));', errors: silent },
        { code: 'load().catch((err) => logger?.warn(err));', errors: silent },
        // A flag local to the function is not something the template reads.
        { code: 'let saved = true; try { await save(); } catch { saved = false; }', errors: silent },
        { code: 'let failed = false; load().catch(() => (failed = true));', errors: silent },
        // A helper that only logs, or only returns, shows nothing.
        {
            code: 'function logFailure(err) { console.error(err); } try { await save(); } catch (err) { logFailure(err); }',
            errors: silent,
        },
        {
            code: 'function describe(err) { return String(err); } try { await save(); } catch (err) { describe(err); }',
            errors: silent,
        },
        // A helper's own parameter is not the caller's callback.
        {
            code: 'function run(cb) { cb(); } try { await save(); } catch { run(() => {}); }',
            errors: silent,
        },
        // Writing it somewhere later code never reads: a local of the catch itself.
        { code: 'try { await save(); } catch (err) { const seen = []; seen.push(err); }', errors: silent },
        // A notify that runs later, inside a function nothing calls, shows nothing now.
        { code: `${NOTIFY}try { await save(); } catch { const later = () => notify.error(t('x')); }`, errors: silent },
        // A helper that refetches writes refs, and shows only its own failure: the caller's stays silent.
        {
            code: `import { useI18n } from 'vue-i18n'; const { t } = useI18n();
                   async function refetch() { loading.value = true; try { list.value = await get(); } catch { error.value = t('errors.load'); } }
                   try { await reorder(); } catch { await refetch(); }`,
            errors: silent,
        },
        // A throw the helper catches itself never reaches the caller.
        {
            code: 'async function refetch() { try { if (id === "") throw new Error("no id"); list.value = await get(id); } catch {} } try { await reorder(); } catch { await refetch(); }',
            // Its own empty catch is flagged too.
            errors: [...silent, ...silent],
        },
        // A helper's list is not the caller's.
        {
            code: 'const seen = []; function remember(x) { seen.push(x); } try { await save(); } catch (err) { remember(err); }',
            errors: silent,
        },
        // A recursive helper ends, and still shows nothing.
        { code: 'function retry() { retry(); } try { await save(); } catch { retry(); }', errors: silent },
    ],
});

vueTester.run('catch-reports in a component', notificationRules['catch-reports'], {
    valid: [
        '<script setup lang="ts">\nconst emit = defineEmits<{ failed: [] }>();\nasync function save(): Promise<void> { try { await write(); } catch { emit("failed"); } }\n</script>',
    ],
    invalid: [
        {
            code: '<script setup lang="ts">\nasync function remove(): Promise<void> { try { await api.delete(id); } catch { /* ignore */ } }\n</script>',
            errors: silent,
        },
    ],
});

test('a disable comment with a reason is the escape, on the line above the catch', async () => {
    const eslint = new ESLint({
        overrideConfigFile: true,
        baseConfig: [
            {
                files: ['**/*.ts'],
                languageOptions: { parser: ts.parser },
                plugins: { larry: { rules: notificationRules } },
                rules: { 'larry/catch-reports': 'error' },
            },
        ],
    });
    const code = [
        'try {',
        '    applyTheme();',
        '    // eslint-disable-next-line larry/catch-reports -- the theme is already applied locally',
        '} catch {}',
        '',
    ].join('\n');
    const [result] = await eslint.lintText(code, { filePath: `${import.meta.dirname}/x.ts` });
    assert.deepEqual(result?.messages, []);
});

const ROOT = import.meta.dirname;

const severityOf = async (config, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved?.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

test('the notification rules run on the Vue app, catch-reports and notify-translated outside its tests', async () => {
    const electronConfig = larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards() });
    const fullstackConfig = larry({ preset: 'fullstack', rootDir: ROOT, standards: fullstack.fullstackStandards() });
    for (const rule of ['larry/notify-usage', 'larry/catch-reports', 'larry/notify-translated']) {
        assert.equal(await severityOf(electronConfig, 'src/renderer/composables/vault/useVault.ts', rule), 2, rule);
        assert.equal(await severityOf(fullstackConfig, 'frontend/src/composables/useFeed.ts', rule), 2, rule);
        assert.equal(await severityOf(fullstackConfig, 'api/src/routes/x.ts', rule), 'absent', rule);
        assert.equal(await severityOf(electronConfig, 'src/main/index.ts', rule), 'absent', rule);
    }
    assert.equal(await severityOf(fullstackConfig, 'frontend/src/App.vue', 'larry/notification-center'), 2);
    assert.equal(await severityOf(electronConfig, 'src/renderer/App.vue', 'larry/notification-center'), 2);
    const test = 'frontend/src/composables/__tests__/useFeed.test.ts';
    assert.equal(await severityOf(fullstackConfig, test, 'larry/catch-reports'), 'absent');
    assert.equal(await severityOf(fullstackConfig, test, 'larry/notify-translated'), 'absent');
});

test('a single-language app keeps the notify rules but not notify-translated', async () => {
    const config = larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards({ i18n: false }) });
    const file = 'src/renderer/composables/vault/useVault.ts';
    assert.equal(await severityOf(config, file, 'larry/notify-usage'), 2);
    assert.equal(await severityOf(config, file, 'larry/catch-reports'), 2);
    assert.equal(await severityOf(config, file, 'larry/notify-translated'), 'absent');
});
