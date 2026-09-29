import { bannedPackages } from '../rules/banned-packages.ts';

export const sharedPackageBannedImports = {
    patterns: [
        bannedPackages(
            ['vue', '@vue', 'vue-router', 'pinia', 'vue-i18n'],
            'The shared package is framework-neutral — api and worker import it, so it must not pull in Vue. A Vue-flavoured type belongs in frontend/src/types/.',
        ),
        bannedPackages(
            ['express', '@types/express', 'mongodb', 'bullmq', 'ioredis'],
            'The shared package is dependency-light and framework-neutral — it must not import a server framework or a driver. Share the plain shape (a type or constant), and let each workspace import the library itself.',
        ),
    ],
};
