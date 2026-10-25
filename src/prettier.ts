import type { Config } from 'prettier';

/** Takes no options: a project that needs a different value spreads this and overrides the one key. */
export const prettierConfig: Config = {
    singleQuote: true,
    useTabs: false,
    tabWidth: 4,
    printWidth: 120,
    quoteProps: 'consistent',
    objectWrap: 'preserve',
    trailingComma: 'all',
    bracketSameLine: true,
    arrowParens: 'always',
    htmlWhitespaceSensitivity: 'strict',
    vueIndentScriptAndStyle: false,
    semi: true,
    bracketSpacing: true,
    endOfLine: 'lf',
    singleAttributePerLine: true,
};

/** @alias The same config, for `export { default } from '@larrydarko/lint-config/prettier'`. */
export default prettierConfig;
