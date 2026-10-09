import { bannedPackages } from './banned-packages.ts';

export const noStoreLibraryPatterns = [
    bannedPackages(
        ['pinia', 'vuex'],
        'No store library by default — state lives in composables. Reach for a store only when state is genuinely cross-view and shared by 3+ unrelated components, and add the exception here deliberately.',
    ),
];

export const aliasOnlyImportPatterns = [
    {
        group: ['../*', './*'],
        message:
            'Use the `@/` alias, not a relative path — `@/composables/feed/useFeed`, not `../../composables/feed/useFeed` or `./useFeed`. Relative paths break silently when a file moves and hide the import depth.',
    },
];

/** Where the standard keeps icons, under each components glob: `src/**\/*.vue` → `src/components/icons/*.vue`. */
const iconFiles = (vue: string[]): string[] =>
    vue.map((glob) => glob.replace(/\*\*\/\*\.vue$/, 'components/icons/*.vue'));

/**
 * @param layout.vue The components.
 * @param layout.frontend Everything that runs in the Vue app, components and scripts both.
 */
export const vueStandards = (layout: { vue: string[]; frontend: string[] }) => [
    // One home for icons — see icons.ts.
    { files: layout.vue, ignores: iconFiles(layout.vue), rules: { 'larry/no-inline-svg': 'error' } },
    { files: iconFiles(layout.vue), rules: { 'larry/icon-component': 'error' } },
    {
        files: layout.vue,
        rules: {
            'vue/component-api-style': ['error', ['script-setup']],
            'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
            'vue/define-props-declaration': ['error', 'type-based'],
            'vue/define-emits-declaration': ['error', 'type-based'],
            'vue/require-macro-variable-name': 'error',
            'vue/require-explicit-emits': 'error',
            'vue/no-required-prop-with-default': 'error',
            'vue/no-template-shadow': 'error',
            'vue/no-v-text': 'error',
            'vue/v-for-delimiter-style': 'error',
            'vue/prefer-true-attribute-shorthand': 'error',
            'vue/prefer-separate-static-class': 'error',
            'vue/no-unused-refs': 'error',
            'vue/no-restricted-syntax': [
                'error',
                {
                    selector: 'TSAsExpression',
                    message:
                        'No `as` in a template: the type rules cannot see it there. Move the expression into `<script setup>` and narrow it with a check — `targetOf(e, HTMLInputElement)`, a typed computed, a typed helper.',
                },
            ],
        },
    },
    {
        files: layout.frontend,
        rules: {
            'vue/no-ref-object-reactivity-loss': 'error',
            'vue/require-typed-ref': 'error',
            'vue/no-side-effects-in-computed-properties': 'error',
        },
    },
];
