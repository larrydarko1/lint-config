import vueI18n from '@intlify/eslint-plugin-vue-i18n';
import * as jsoncParser from 'jsonc-eslint-parser';

/**
 * @param {object} [options]
 * @param {string} [options.localeDir='./assets/locales/*.json'] Where the locale files live.
 * @param {string} [options.localeFiles='assets/locales/*.json'] The same set as an ESLint glob.
 * @param {string} [options.messageSyntaxVersion='^11.0.0'] The vue-i18n message syntax to validate.
 * @param {string[]} [options.ignoreText=[]] Literals that are not translatable copy — the app's
 *   own name, usually, since a brand name is the same in every locale.
 * @param {string[]} [options.unscannedKeys=[]] Keys the unused-key scan cannot see because nothing
 *   calls `t()` for them: a locale's own endonym read as a plain property, for instance.
 * @param {string} [options.usageSrc='src/renderer'] The tree the unused-key scan reads.
 */
export const i18n = (options = {}) => {
    const {
        localeDir = './assets/locales/*.json',
        localeFiles = 'assets/locales/*.json',
        messageSyntaxVersion = '^11.0.0',
        ignoreText = [],
        unscannedKeys = [],
        usageSrc = 'src/renderer',
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
            files: ['src/renderer/**/*.vue'],
            plugins: { '@intlify/vue-i18n': vueI18n },
            rules: {
                '@intlify/vue-i18n/no-raw-text': [
                    'error',
                    {
                        // Pure whitespace/number/punctuation/symbol runs, and empty-string ternary branches.
                        ignorePattern: '^[\\s\\d\\p{P}\\p{S}]*$',
                        ignoreText,
                    },
                ],
                'vue/no-restricted-block': [
                    'error',
                    {
                        element: 'i18n',
                        message:
                            'No per-component <i18n> blocks — every key lives in assets/locales/<locale>.json. A block splits a key away from its siblings, and no locale-parity check can see it.',
                    },
                ],
                '@intlify/vue-i18n/no-i18n-t-path-prop': 'error',
            },
        },
        {
            files: ['src/renderer/**/*.{ts,vue}'],
            plugins: { '@intlify/vue-i18n': vueI18n },
            rules: {
                '@intlify/vue-i18n/no-missing-keys': 'error',
                '@intlify/vue-i18n/valid-message-syntax': 'error',
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

export default i18n;
