import vueI18n from '@intlify/eslint-plugin-vue-i18n';
import * as jsoncParser from 'jsonc-eslint-parser';

export type I18nOptions = {
    /** The locale files as an ESLint glob. Defaults to the family's. */
    localeFiles?: string;
    /** The same set as the plugin wants it. Defaults to `./` + `localeFiles`. */
    localeDir?: string;
    /** The vue-i18n message syntax to validate. Defaults to `^11.0.0`. */
    messageSyntaxVersion?: string;
    /**
     * Literals that are not translatable copy — the app's own name, usually, since a
     * brand name reads the same in every locale.
     */
    ignoreText?: string[];
    /**
     * Keys `no-unused-keys` cannot see: namespaces addressed by a computed key, or a key
     * read as a plain property instead of through `t()`. Each entry goes unchecked, so
     * keep the list short.
     */
    unscannedKeys?: string[];
    /** The tree the unused-key scan reads. Defaults to the family's. */
    usageSrc?: string;
    /** Locale names that are not language codes but are meant to be there, like a joke locale. */
    customLocales?: string[];
};

/** Whether the family's `locales` role is read: not with i18n off, nor when `localeFiles` names the files itself. */
export const readsLocalesRole = (options: I18nOptions | false | undefined): boolean =>
    options !== false && options?.localeFiles === undefined;

/**
 * @param layout.vue The components.
 * @param layout.frontend Everything that runs in the Vue app, components and scripts both.
 * @param layout.localeFiles The family's default for `options.localeFiles`.
 * @param layout.usageSrc The family's default for `options.usageSrc`.
 */
export const i18nStandards = (
    layout: { vue: string[]; frontend: string[]; localeFiles: string; usageSrc: string },
    options: I18nOptions = {},
) => {
    const {
        localeFiles = layout.localeFiles,
        localeDir = `./${localeFiles}`,
        messageSyntaxVersion = '^11.0.0',
        ignoreText = [],
        unscannedKeys = [],
        usageSrc = layout.usageSrc,
        customLocales = [],
    } = options;

    const noUnknownLocale = ['error', { locales: customLocales }];

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
            files: layout.vue,
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
                        message: `No per-component <i18n> blocks — every key lives in ${localeFiles.replace('*', '<locale>')}. A block splits a key away from its siblings, and no locale-parity check can see it.`,
                    },
                ],
                '@intlify/vue-i18n/no-i18n-t-path-prop': 'error',
            },
        },
        {
            files: layout.frontend,
            plugins: { '@intlify/vue-i18n': vueI18n },
            rules: {
                '@intlify/vue-i18n/no-missing-keys': 'error',
                '@intlify/vue-i18n/valid-message-syntax': 'error',
                '@intlify/vue-i18n/valid-plural-forms': 'error',
                '@intlify/vue-i18n/no-unknown-locale': noUnknownLocale,
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
                '@intlify/vue-i18n/no-unknown-locale': noUnknownLocale,
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
