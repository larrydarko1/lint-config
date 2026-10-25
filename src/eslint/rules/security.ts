export type SecurityOptions = {
    /**
     * Components allowed to use `v-html`: markup sanitised on the way in, or static copy
     * the project authors itself — never anything a user submitted.
     */
    vHtmlAllowed?: string[];
};

export const bannedCryptoModules = [
    {
        name: 'bcrypt',
        message: 'Password hashing must use Argon2id (argon2), never bcrypt',
    },
    {
        name: 'bcryptjs',
        message: 'Password hashing must use Argon2id (argon2), never bcrypt',
    },
    {
        name: 'scrypt-js',
        message: 'Password hashing must use Argon2id (argon2), never scrypt',
    },
    {
        name: 'scryptsy',
        message: 'Password hashing must use Argon2id (argon2), never scrypt',
    },
    {
        name: 'crypto-js',
        message: 'Use Node’s built-in `node:crypto` (AES-256-GCM / HMAC-SHA-256), not crypto-js',
    },
];

/**
 * @param layout.code Everything the crypto and `eval` bans cover.
 * @param layout.vue The components `v-html` is banned in; none for a family with no frontend.
 */
export const securityStandards = (layout: { code: string[]; vue: string[] }, options: SecurityOptions = {}) => {
    const { vHtmlAllowed = [] } = options;

    return [
        {
            files: layout.code,
            rules: {
                'no-restricted-imports': ['error', { paths: bannedCryptoModules }],
                'no-eval': 'error',
                'no-implied-eval': 'error',
            },
        },
        ...(layout.vue.length ? [{ files: layout.vue, rules: { 'vue/no-v-html': 'error' } }] : []),
        ...(vHtmlAllowed.length ? [{ files: vHtmlAllowed, rules: { 'vue/no-v-html': 'off' } }] : []),
    ];
};
