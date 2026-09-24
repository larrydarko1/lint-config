import type { Config } from 'prettier';

/**
 * Prettier configuration. Byte-identical in all five projects today, so it takes
 * no options — a project that needs a different value spreads this and overrides
 * the one key, which makes the departure visible in that project's own config.
 */
const config: Config = {
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

export default config;
