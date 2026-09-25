import vueI18n from '@intlify/eslint-plugin-vue-i18n';
import * as jsoncParser from 'jsonc-eslint-parser';

/**
 * @param [options.localeDir='./frontend/src/locales/*.json'] Where the locale files live.
 * @param [options.localeFiles='frontend/src/locales/*.json'] The same set as an ESLint glob.
 * @param [options.messageSyntaxVersion='^11.0.0'] The vue-i18n message syntax to validate.
 * @param [options.ignoreText=[]] Literals that are not translatable copy — the app's own
 *   name, usually, since a brand name reads the same in every locale.
 * @param [options.unscannedKeys=[]] Namespaces addressed by a COMPUTED key, which
 *   `no-unused-keys` cannot follow. Without them the rule reports only false positives; with them
 *   it still polices every namespace that IS statically addressed, which is why it earns its place.
 *   Each entry is genuinely unguarded, so keep the list short and keep each one justified.
 * @param [options.usageSrc='frontend/src'] The tree the unused-key scan reads.
 */
export const i18nStandards = (
    options: {
        localeDir?: string;
        localeFiles?: string;
        messageSyntaxVersion?: string;
        ignoreText?: string[];
        unscannedKeys?: string[];
        usageSrc?: string;
    } = {},
) => {
    const {
        localeDir = './frontend/src/locales/*.json',
        localeFiles = 'frontend/src/locales/*.json',
        messageSyntaxVersion = '^11.0.0',
        ignoreText = [],
        unscannedKeys = [],
        usageSrc = 'frontend/src',
    } = options;

    return [
        {
            settings: {
                'vue-i18n': {
                    localeDir,
                    messageSyntaxVersion,
                },
            },
        },
        {
            files: ['frontend/src/**/*.vue'],
            plugins: { '@intlify/vue-i18n': vueI18n },
            rules: {
                '@intlify/vue-i18n/no-raw-text': [
                    'error',
                    {
                        ignorePattern: '^[\\s\\d\\p{P}\\p{S}]*$', // Ignore pure whitespace/number/punctuation/symbol runs and empty-string ternary branches (e.g. `cond ? t('k') : ''`).
                        ignoreText,
                    },
                ],
                'vue/no-restricted-block': [
                    'error',
                    {
                        element: 'i18n',
                        message:
                            'No per-component <i18n> blocks — every key lives in frontend/src/locales/<locale>.json. A block splits a key away from its siblings, and no locale-parity check can see it.',
                    },
                ],
                '@intlify/vue-i18n/no-i18n-t-path-prop': 'error',
            },
        },
        {
            files: ['frontend/src/**/*.{ts,vue}'],
            plugins: { '@intlify/vue-i18n': vueI18n },
            rules: {
                '@intlify/vue-i18n/no-missing-keys': 'error',
                '@intlify/vue-i18n/valid-message-syntax': 'error',
                '@intlify/vue-i18n/valid-plural-forms': 'error',
                '@intlify/vue-i18n/no-unknown-locale': 'error',
                '@intlify/vue-i18n/prefer-linked-key-with-paren': 'error',
            },
        },
        {
            files: [localeFiles],
            plugins: { '@intlify/vue-i18n': vueI18n },
            languageOptions: { parser: jsoncParser },
            rules: {
                '@typescript-eslint/naming-convention': 'off',
                '@intlify/vue-i18n/no-missing-keys-in-other-locales': 'error',
                '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error',
                '@intlify/vue-i18n/valid-message-syntax': 'error',
                '@intlify/vue-i18n/valid-plural-forms': 'error',
                '@intlify/vue-i18n/no-unknown-locale': 'error',
                '@intlify/vue-i18n/prefer-linked-key-with-paren': 'error',
                '@intlify/vue-i18n/no-unused-keys': [
                    'error',
                    {
                        src: usageSrc,
                        extensions: ['.ts', '.vue'],
                        ignores: unscannedKeys,
                    },
                ],
            },
        },
    ];
};
