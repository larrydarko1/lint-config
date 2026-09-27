export const sharedPackageBannedImports = {
    patterns: [
        {
            group: ['vue', 'vue/*', '@vue/*', 'vue-router', 'pinia', 'vue-i18n'],
            message:
                'The shared package is framework-neutral — api and worker import it, so it must not pull in Vue. A Vue-flavoured type belongs in frontend/src/types/.',
        },
        {
            group: ['express', 'express/*', '@types/express', 'mongodb', 'bullmq', 'ioredis'],
            message:
                'The shared package is dependency-light and framework-neutral — it must not import a server framework or a driver. Share the plain shape (a type or constant), and let each workspace import the library itself.',
        },
    ],
};
