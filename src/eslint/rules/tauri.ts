/**
 * A Tauri webview reaches Rust and the OS through its bridge alone. `@tauri-apps/api` and
 * every `@tauri-apps/plugin-*` are imported there and nowhere else, and nothing else touches
 * the `__TAURI__` globals, so the bridge is the one list of what the app can ask Rust for —
 * and the one module a test replaces. `tauriStandards()` turns `no-tauri-outside-bridge` on
 * for the webview outside `src/bridge/`.
 */
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

type MessageId = 'import' | 'global';
type Context = Readonly<TSESLint.RuleContext<MessageId, []>>;

const TAURI_PACKAGE = '@tauri-apps/';
/** `__TAURI__` (`withGlobalTauri`), `__TAURI_INTERNALS__` (what `invoke` calls), and any later one. */
const TAURI_GLOBAL = '__TAURI';

const noTauriOutsideBridge: TSESLint.RuleModule<MessageId> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: 'Reach Tauri through the bridge module, never from a component or composable.' },
        schema: [],
        messages: {
            import: "`{{source}}` is imported in src/bridge/ and nowhere else. Call the bridge's typed function — add one there if it is missing — and import its types from the bridge too, so the rest of the app never learns it runs in Tauri and a test replaces one module instead of mocking IPC.",
            global: '`{{name}}` is Tauri’s internal plumbing. Go through src/bridge/: an `invoke` wrapper for a command, `isTauri()` from `@tauri-apps/api/core` for detection — and keep `withGlobalTauri` off, which is what puts the whole API on `window.__TAURI__` for any script to call.',
        },
    },
    create(context) {
        const reportGlobal = (node: TSESTree.Node, name: string): void => {
            context.report({ node, messageId: 'global', data: { name } });
        };
        return {
            'ImportDeclaration': (node) => checkSource(context, node.source),
            'ImportExpression': (node) => checkSource(context, node.source),
            'ExportNamedDeclaration': (node) => checkSource(context, node.source),
            'ExportAllDeclaration': (node) => checkSource(context, node.source),
            // `window.__TAURI__`, `globalThis['__TAURI_INTERNALS__']`
            'MemberExpression'(node) {
                const name = propertyName(node);
                if (name?.startsWith(TAURI_GLOBAL) === true) reportGlobal(node, name);
            },
            // `'__TAURI__' in window`
            'BinaryExpression'(node) {
                const name = node.operator === 'in' ? stringValue(node.left) : null;
                if (name?.startsWith(TAURI_GLOBAL) === true) reportGlobal(node, name);
            },
            // A bare `__TAURI__.core.invoke(…)`: a global nothing in the module declares.
            'Program:exit'(program) {
                for (const reference of context.sourceCode.getScope(program).through) {
                    const { identifier } = reference;
                    if (identifier.name.startsWith(TAURI_GLOBAL)) reportGlobal(identifier, identifier.name);
                }
            },
        };
    },
};

export const tauriRules = { 'no-tauri-outside-bridge': noTauriOutsideBridge };

const stringValue = (node: TSESTree.Node): string | null =>
    node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

/** `a.b` and `a['b']` → `'b'`; `a[b]` names no property. */
function propertyName(member: TSESTree.MemberExpression): string | null {
    const { property } = member;
    if (!member.computed && property.type === 'Identifier') return property.name;
    return stringValue(property);
}

function checkSource(context: Context, source: TSESTree.Node | null): void {
    if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
    if (source.value.startsWith(TAURI_PACKAGE)) {
        context.report({ node: source, messageId: 'import', data: { source: source.value } });
    }
}
