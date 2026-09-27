export const utilsBannedImportPatterns = [
    {
        group: ['@/lib/*', '@/api/*', '@/services/*', '@/composables/*', '@/stores/*', '**/lib/*', '**/services/*'],
        message:
            'utils/ is pure functions — no side effects, no state, no I/O. Importing infrastructure makes it none of those. Move the function to lib/ (owns one external concern) or to the composable that needs it.',
    },
];

export const libBannedImportPatterns = [
    {
        group: ['@/services/*', '@/services/**', '**/services/*', '**/services/**'],
        message:
            'lib/ owns one external concern and is consumed BY services/ — never the reverse. If lib needs this type, the type belongs in lib (or packages/shared), not in the service.',
    },
];
