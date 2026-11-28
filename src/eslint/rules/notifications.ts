/**
 * One way to tell the user something failed: `notify` from the app's one notification
 * module, rendered by one `NotificationCenter` that is always mounted. And every caught
 * failure goes somewhere the user or the caller will see it.
 * - `notify-usage` — `notify` and `useNotifications` come from `composables/ui/useNotifications`,
 *   and `notify` has `error` and `dismiss`, nothing else.
 * - `notify-translated` — `notify.error`'s message is a translation call. Switched on by the
 *   i18n block, so a single-language app is spared it.
 * - `notification-center` — `<NotificationCenter>` appears once, in `App.vue`, outside every
 *   `v-if`, `v-show` and `v-for`. Whether it appears at all is the dead-code gate's: a module
 *   whose reader nothing imports is an unused export.
 * - `catch-reports` — a `catch` shows the failure, passes it on, or says why it does neither:
 *   a comment inside an empty one, a disable comment above any other.
 */
import { AST_NODE_TYPES, type TSESLint } from '@typescript-eslint/utils';
import type { AST, Rule } from 'eslint';

import { catchReports } from './catch-reports.ts';
import { isNotify, isTranslation, NOTIFICATIONS_MODULE, propertyName } from './notify-bindings.ts';

/** The few template nodes `notification-center` reads. vue-eslint-parser's own types are not a dependency here. */
type VDirective = { directive: true; key: { name: { name: string } } };
type VAttribute = { directive: false };
type VNode = { type: string };
type VElement = VNode & {
    type: 'VElement';
    rawName: string;
    parent: VElement | VNode;
    startTag: { attributes: (VAttribute | VDirective)[]; loc: AST.SourceLocation };
};
type TemplateServices = {
    defineTemplateBodyVisitor(templateVisitor: Record<string, (node: VElement) => void>): Rule.RuleListener;
};

/** Where it belongs, under whatever the app's `@/` points at (`@/renderer/` in Electron). */
const NOTIFICATIONS_HOME = /^@\/(?:[\w-]+\/)*composables\/ui\/useNotifications$/;
const NOTIFY_METHODS = new Set(['error', 'dismiss']);
/** Directives that leave an element unmounted, or mounted more than once. */
const CONDITIONAL = new Set(['if', 'else-if', 'else', 'show', 'for']);

const notifyUsage: TSESLint.RuleModule<'home' | 'method'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: {
            description: "`notify` comes from the app's one notification module and has `error` and `dismiss` only.",
        },
        schema: [],
        messages: {
            home: 'The notification module lives at `@/composables/ui/useNotifications`, in every project, so every failure reaches the one `NotificationCenter`. A notifications *feature* (an inbox) is named for what it is — `useInbox` — so the two never share a name.',
            method: '`notify` has `error` and `dismiss`, nothing else. A success the user can already see needs no notice: confirming what is on screen trains people to ignore the corner the errors appear in.',
        },
    },
    create(context): TSESLint.RuleListener {
        return {
            ImportDeclaration(node): void {
                const source = node.source.value;
                if (NOTIFICATIONS_MODULE.test(source) && !NOTIFICATIONS_HOME.test(source)) {
                    context.report({ node: node.source, messageId: 'home' });
                }
            },
            MemberExpression(node): void {
                if (!isNotify(context, node.object)) return;
                const name = propertyName(node);
                if (name === null || !NOTIFY_METHODS.has(name)) {
                    context.report({ node: node.property, messageId: 'method' });
                }
            },
        };
    },
};

const notifyTranslated: TSESLint.RuleModule<'translated'> = {
    meta: {
        defaultOptions: [],
        type: 'problem',
        docs: { description: "`notify.error`'s message is translated where it is called." },
        schema: [],
        messages: {
            translated:
                "Translate the message where you call `notify.error`: `notify.error(t('errors.save_file_failed'))`. A string built elsewhere and passed in is one the locale files never see, so a missing translation ships in English.",
        },
    },
    create(context): TSESLint.RuleListener {
        return {
            CallExpression(node): void {
                const { callee } = node;
                if (callee.type !== AST_NODE_TYPES.MemberExpression || propertyName(callee) !== 'error') return;
                if (!isNotify(context, callee.object)) return;
                const [message] = node.arguments;
                if (message === undefined || !isTranslation(context, message)) {
                    context.report({ node: message ?? node, messageId: 'translated' });
                }
            },
        };
    },
};

const notificationCenter: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: { description: '`<NotificationCenter>` is mounted once, in `App.vue`, outside every condition.' },
        schema: [],
        messages: {
            notApp: '`<NotificationCenter>` is mounted in `App.vue` and nowhere else. A second one renders every notification twice; one inside a view disappears with the view.',
            twice: '`<NotificationCenter>` is mounted once. A second one renders every notification twice.',
            conditional:
                '`<NotificationCenter>` sits outside every `v-if`, `v-show` and `v-for`, so a failure has somewhere to appear on every screen, the welcome screen included.',
        },
    },
    create(context): Rule.RuleListener {
        const services: unknown = context.sourceCode.parserServices;
        if (!hasTemplateVisitor(services)) return {};
        const inApp = /(?:^|[\\/])App\.vue$/.test(context.filename);
        let seen = 0;
        return services.defineTemplateBodyVisitor({
            VElement(element): void {
                if (element.rawName.replaceAll('-', '').toLowerCase() !== 'notificationcenter') return;
                seen += 1;
                const loc = element.startTag.loc;
                if (!inApp) context.report({ loc, messageId: 'notApp' });
                else if (seen > 1) context.report({ loc, messageId: 'twice' });
                else if (underCondition(element)) context.report({ loc, messageId: 'conditional' });
            },
        });
    },
};

export const notificationRules = {
    'notify-usage': notifyUsage,
    'notify-translated': notifyTranslated,
    'notification-center': notificationCenter,
    'catch-reports': catchReports,
};

const hasTemplateVisitor = (services: unknown): services is TemplateServices =>
    typeof services === 'object' &&
    services !== null &&
    'defineTemplateBodyVisitor' in services &&
    typeof services.defineTemplateBodyVisitor === 'function';

/** Whether the element, or anything it sits in, mounts only sometimes or more than once. */
function underCondition(element: VElement): boolean {
    for (let node: VElement | VNode = element; isElement(node); node = node.parent) {
        const conditional = node.startTag.attributes.some((a) => a.directive && CONDITIONAL.has(a.key.name.name));
        if (conditional) return true;
    }
    return false;
}

const isElement = (node: VElement | VNode): node is VElement => node.type === 'VElement';
