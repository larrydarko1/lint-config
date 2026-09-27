export const noStoreLibraryPatterns = [
    {
        group: ['pinia', 'vuex', 'pinia/*', 'vuex/*'],
        message:
            'No store library by default — state lives in composables. Reach for a store only when state is genuinely cross-view and shared by 3+ unrelated components, and add the exception here deliberately.',
    },
];

export const aliasOnlyImportPatterns = [
    {
        group: ['../*', './*'],
        message:
            'Use the `@/` alias, not a relative path — `@/composables/feed/useFeed`, not `../../composables/feed/useFeed` or `./useFeed`. Relative paths break silently when a file moves and hide the import depth.',
    },
];

/**
 * @param layout.vue The components.
 * @param layout.frontend Everything that runs in the Vue app, components and scripts both.
 */
export const vueStandards = (layout: { vue: string[]; frontend: string[] }) => [
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
