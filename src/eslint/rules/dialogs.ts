/**
 * The browser's own dialogs stay out of the app. `alert()`, `confirm()` and `prompt()` freeze
 * the window until they are answered, and ignore the theme, the locale and the layout;
 * Electron does not implement `prompt()` at all. What the user is told goes through the
 * project's notification function, and what they are asked through its own dialog.
 * `vueStandards()` turns `no-native-dialog` on for everything that runs in the Vue app.
 */
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type Dialog = 'alert' | 'confirm' | 'prompt';
type Context = Readonly<TSESLint.RuleContext<Dialog, []>>;

/** The names the window is reachable by. */
const OWNERS = new Set(['window', 'globalThis', 'self']);

const noNativeDialog: TSESLint.RuleModule<Dialog> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: {
            description: "Tell the user through the app's notification function, not the browser's blocking dialogs.",
        },
        schema: [],
        messages: {
            alert: "`alert()` freezes the whole window until it is dismissed, and ignores the theme and the layout. Tell the user through the app's notification function — `notify.error(t(…))` — so every message reaches them through one component, and a failure that repeats updates one notice instead of stacking dialogs.",
            confirm:
                "`confirm()` freezes the whole window, and its buttons follow the OS language, not the app's. Ask through the app's own confirm dialog; in Electron, `dialog.showMessageBox` from the main process is the native alternative.",
            prompt: "`prompt()` freezes the whole window, and Electron does not implement it: it returns nothing. Ask with an inline input or the app's own dialog.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                const dialog = dialogCalled(context, node.callee);
                if (dialog !== null) context.report({ node, messageId: dialog });
            },
        };
    },
};

export const dialogRules = { 'no-native-dialog': noNativeDialog };

const isDialog = (name: string | null): name is Dialog => name === 'alert' || name === 'confirm' || name === 'prompt';

/** Whether `name` at `node` is the global, not a local or an import that shadows it. */
function isGlobal(context: Context, node: TSESTree.Node, name: string): boolean {
    for (let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(name);
        if (variable !== undefined) return variable.defs.length === 0;
    }
    return true;
}

function propertyName(member: TSESTree.MemberExpression): string | null {
    const { property } = member;
    if (!member.computed && property.type === 'Identifier') return property.name;
    if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
    return null;
}

/** `alert(…)`, `window.alert(…)`, `globalThis['confirm'](…)`; null for anything else. */
function dialogCalled(context: Context, callee: TSESTree.Node): Dialog | null {
    if (callee.type === 'Identifier') {
        return isDialog(callee.name) && isGlobal(context, callee, callee.name) ? callee.name : null;
    }
    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null;
    if (!OWNERS.has(callee.object.name) || !isGlobal(context, callee.object, callee.object.name)) return null;
    const name = propertyName(callee);
    return isDialog(name) ? name : null;
}
