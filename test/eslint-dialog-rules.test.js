/**
 * `larry/no-native-dialog`, run through ESLint's RuleTester, plus where it is switched on.
 * The valid cases are the lookalikes a project really has: its own `notify`, an imported
 * or local `confirm`, a method that happens to share the name.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint, RuleTester } from 'eslint';
import globals from 'globals';
import ts from 'typescript-eslint';

import { larry } from '../src/eslint/index.ts';
import { dialogRules } from '../src/eslint/rules/dialogs.ts';
import * as electron from '../src/eslint/electron/index.ts';
import * as fullstack from '../src/eslint/fullstack/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
    languageOptions: { parser: ts.parser, sourceType: 'module', globals: globals.browser },
});

tester.run('no-native-dialog', dialogRules['no-native-dialog'], {
    valid: [
        "notify.error(t('errors.save_file_failed'));",
        // A name the module binds itself is not the browser's.
        "import { confirm } from '@/composables/useConfirm'; await confirm('Delete?');",
        'const prompt = usePrompt(); prompt.open();',
        'function alert(message) { notify.error(message); } alert("x");',
        // A method that shares the name, on something that is not the window.
        'dialog.confirm("Delete?"); toast.alert("x"); editor.prompt();',
        // Read, not called: a test stubbing it, a feature check.
        "vi.spyOn(window, 'alert'); if ('confirm' in window) {}",
    ],
    invalid: [
        { code: "alert(t('errors.save_file_failed'));", errors: [{ messageId: 'alert' }] },
        { code: 'window.alert("x");', errors: [{ messageId: 'alert' }] },
        { code: 'globalThis.confirm("Delete?");', errors: [{ messageId: 'confirm' }] },
        { code: "self['prompt']('Name?');", errors: [{ messageId: 'prompt' }] },
        { code: 'window.alert?.("x");', errors: [{ messageId: 'alert' }] },
        { code: 'if (confirm("Delete?")) remove();', errors: [{ messageId: 'confirm' }] },
        // Shadowed in another function does not hide the global here.
        { code: 'function f() { const alert = 1; } alert("x");', errors: [{ messageId: 'alert' }] },
    ],
});

const ROOT = import.meta.dirname;

const severityOf = async (config, file, rule) => {
    const eslint = new ESLint({ overrideConfigFile: true, baseConfig: config, cwd: ROOT });
    const resolved = await eslint.calculateConfigForFile(`${ROOT}/${file}`);
    const entry = resolved?.rules[rule];
    if (entry === undefined) return 'absent';
    return Array.isArray(entry) ? entry[0] : entry;
};

test('native dialogs are banned wherever the Vue app runs, and nowhere else', async () => {
    const rule = 'larry/no-native-dialog';
    const electronConfig = larry({ preset: 'electron', rootDir: ROOT, standards: electron.electronStandards() });
    const fullstackConfig = larry({ preset: 'fullstack', rootDir: ROOT, standards: fullstack.fullstackStandards() });
    assert.equal(await severityOf(electronConfig, 'src/renderer/App.vue', rule), 2);
    assert.equal(await severityOf(electronConfig, 'src/renderer/composables/vault/useVault.ts', rule), 2);
    assert.equal(await severityOf(electronConfig, 'src/main/index.ts', rule), 'absent');
    assert.equal(await severityOf(fullstackConfig, 'frontend/src/App.vue', rule), 2);
    assert.equal(await severityOf(fullstackConfig, 'frontend/src/composables/useFeed.ts', rule), 2);
    assert.equal(await severityOf(fullstackConfig, 'api/src/routes/x.ts', rule), 'absent');
});

test('the toast-library ban names every package with its subpaths, and nothing that merely contains the name', () => {
    const [{ regex }] = electron.noToastLibraryPatterns;
    const banned = new RegExp(regex);
    for (const specifier of [
        'vue-toastification',
        'vue-sonner',
        'notivue',
        'sweetalert2',
        'vue-toastification/dist/index.css',
    ]) {
        assert.ok(banned.test(specifier), specifier);
    }
    for (const specifier of [
        '@/components/NotificationCenter.vue',
        '@/composables/ui/useNotifications',
        'notivue-like',
    ]) {
        assert.ok(!banned.test(specifier), specifier);
    }
    assert.equal(fullstack.noToastLibraryPatterns, electron.noToastLibraryPatterns);
});
