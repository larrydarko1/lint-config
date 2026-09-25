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
 * @param [options.vHtmlAllowed=[]] Views allowed to use `v-html` — long-form static
 *   copy the project authors itself, never anything a user submitted.
 */
export const securityStandards = (options: { vHtmlAllowed?: string[] } = {}) => {
    const { vHtmlAllowed = [] } = options;

    return [
        {
            files: ['api/src/**/*.ts', 'worker/src/**/*.ts', 'packages/**/*.ts'],
            rules: {
                'no-restricted-imports': ['error', { paths: bannedCryptoModules }],
                'no-eval': 'error',
                'no-implied-eval': 'error',
            },
        },
        {
            files: ['frontend/src/**/*.{ts,vue}'],
            rules: {
                'no-restricted-imports': ['error', { paths: bannedCryptoModules }],
                'no-eval': 'error',
                'no-implied-eval': 'error',
                'vue/no-v-html': 'error',
            },
        },
        ...(vHtmlAllowed.length ? [{ files: vHtmlAllowed, rules: { 'vue/no-v-html': 'off' } }] : []),
    ];
};
