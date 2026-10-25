/**
 * Icons live in one place: `components/icons/`, one component per icon, imported where
 * it is drawn. Two rules hold both sides of that:
 * - `no-inline-svg` — outside that folder, an `<svg>` that draws a fixed picture is an
 *   icon in the wrong place. One drawn from data (a chart's bound `d`, a `v-for` of bars,
 *   a `<slot>`) is not an icon and stays.
 * - `icon-component` — inside it, a file is one `<svg>`, hidden from screen readers,
 *   with no fixed `id` to collide when it renders twice.
 * Which files are which is the config's business: `vueStandards()` aims each rule.
 */
import type { AST, Rule } from 'eslint';

/** The few template nodes these rules read. vue-eslint-parser's own types are not a dependency here. */
type VIdentifier = { name: string };
type VLiteral = { value: string };
type VAttribute = { directive: false; key: VIdentifier; value: VLiteral | null };
type VDirective = { directive: true; key: { name: VIdentifier } };
type VStartTag = { attributes: (VAttribute | VDirective)[]; loc: AST.SourceLocation };
type VNode = { type: string; loc: AST.SourceLocation };
type VElement = VNode & {
    type: 'VElement';
    name: string;
    parent: VElement | VNode;
    startTag: VStartTag;
    children: (VElement | VNode)[];
};

type TemplateServices = {
    defineTemplateBodyVisitor(templateVisitor: Record<string, (node: VElement) => void>): Rule.RuleListener;
};

/** Directives that only choose WHICH fixed drawing shows — they do not make it one drawn from data. */
const CHOOSING = new Set(['if', 'else', 'else-if', 'show']);

const noInlineSvg: Rule.RuleModule = {
    meta: {
        type: 'suggestion',
        docs: { description: 'An `<svg>` drawing a fixed picture belongs in `components/icons/`.' },
        schema: [],
        messages: {
            inlineIcon:
                'This `<svg>` draws a fixed picture, so it is an icon: move it to `components/icons/IconName.vue` and use `<IconName />` here. One icon drawn inline in two places is how they drift apart. An SVG drawn from data — bound attributes, `v-for`, a `<slot>` — stays inline.',
        },
    },
    create(context) {
        const services = templateServices(context);
        if (services === null) return {};
        return services.defineTemplateBodyVisitor({
            "VElement[name='svg']"(svg) {
                if (insideSvg(svg) || drawnFromData(svg)) return;
                context.report({ loc: svg.startTag.loc, messageId: 'inlineIcon' });
            },
        });
    },
};

const iconComponent: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: { description: 'An icon component is one `<svg>`, `aria-hidden`, with no fixed `id`.' },
        schema: [],
        messages: {
            oneSvg: 'An icon file is a template holding one `<svg>` and nothing else — anything around it belongs to whoever uses the icon.',
            ariaHidden:
                'An icon is decorative: give its `<svg>` `aria-hidden="true"`. Where an icon is the whole control, label the control (`<button aria-label="Close">`), not the drawing.',
            fixedId:
                'A fixed `id` repeats every time this icon renders twice on one page, and the second `url(#…)` points at the first. Bind one from `useId()` if a gradient or clip path needs it.',
        },
    },
    create(context) {
        const services = templateServices(context);
        if (services === null) return {};
        return services.defineTemplateBodyVisitor({
            "VElement[name='template']"(template) {
                if (template.parent.type !== 'VDocumentFragment') return;

                const roots = template.children.filter(isElement);
                const [svg] = roots;
                if (roots.length !== 1 || svg?.name !== 'svg') {
                    context.report({ loc: template.startTag.loc, messageId: 'oneSvg' });
                    return;
                }

                if (staticAttribute(svg, 'aria-hidden')?.value?.value !== 'true')
                    context.report({ loc: svg.startTag.loc, messageId: 'ariaHidden' });

                const visit = (node: VElement): void => {
                    if (staticAttribute(node, 'id') !== undefined)
                        context.report({ loc: node.startTag.loc, messageId: 'fixedId' });
                    node.children.filter(isElement).forEach(visit);
                };
                visit(svg);
            },
        });
    },
};

export const iconRules = {
    'no-inline-svg': noInlineSvg,
    'icon-component': iconComponent,
};

/** vue-eslint-parser's hook, or null when the file is not an SFC it parsed. */
function templateServices(context: Rule.RuleContext): TemplateServices | null {
    const services: unknown = context.sourceCode.parserServices;
    if (typeof services !== 'object' || services === null) return null;
    if (!('defineTemplateBodyVisitor' in services) || typeof services.defineTemplateBodyVisitor !== 'function')
        return null;
    return services as TemplateServices;
}

const isElement = (node: VElement | VNode): node is VElement => node.type === 'VElement';

const directives = (element: VElement): string[] =>
    element.startTag.attributes.flatMap((a) => (a.directive ? [a.key.name.name] : []));

const staticAttribute = (element: VElement, name: string): VAttribute | undefined =>
    element.startTag.attributes.find((a): a is VAttribute => !a.directive && a.key.name === name);

/**
 * Whether the picture comes from data: a binding, a loop, an interpolation, injected
 * markup or a `<slot>` anywhere inside it. The root's own `v-if`, `class` or `:class`
 * place the drawing; they do not draw it.
 */
function drawnFromData(svg: VElement): boolean {
    if (directives(svg).some((d) => d === 'html' || d === 'text')) return true;
    const visit = (node: VElement | VNode): boolean => {
        if (node.type === 'VExpressionContainer') return true;
        if (!isElement(node)) return false;
        if (node.name === 'slot') return true;
        if (node !== svg && directives(node).some((d) => !CHOOSING.has(d))) return true;
        return node.children.some(visit);
    };
    return visit(svg);
}

/** Only the outermost `<svg>` is judged; a nested one is part of its drawing. */
function insideSvg(element: VElement): boolean {
    for (let node = element.parent; isElement(node); node = node.parent) {
        if (node.name === 'svg') return true;
    }
    return false;
}
