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
 * @param [options.vHtmlAllowed=[]] Components allowed to use `v-html`: markup that is
 *   sanitised on the way in, or static and internal.
 */
export const securityStandards = (options: { vHtmlAllowed?: string[] } = {}) => {
    const { vHtmlAllowed = [] } = options;

    return [
        {
            files: ['src/**/*.{ts,vue}'],
            rules: {
                'no-restricted-imports': ['error', { paths: bannedCryptoModules }],
                'no-eval': 'error',
                'no-implied-eval': 'error',
            },
        },
        {
            files: ['src/renderer/**/*.vue'],
            rules: { 'vue/no-v-html': 'error' },
        },
        ...(vHtmlAllowed.length ? [{ files: vHtmlAllowed, rules: { 'vue/no-v-html': 'off' } }] : []),
    ];
};
