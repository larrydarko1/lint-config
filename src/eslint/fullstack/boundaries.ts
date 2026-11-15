import { bannedPackages } from '../rules/banned-packages.ts';

export const sharedPackageBannedImports = {
    patterns: [
        bannedPackages(
            ['vue', '@vue', 'vue-router', 'pinia', 'vue-i18n'],
            'The shared package is framework-neutral — api and worker import it, so it must not load Vue. `import type` passes: it is erased before anything runs.',
        ),
        bannedPackages(
            ['express', '@types/express', 'mongodb', 'bullmq', 'ioredis'],
            'The shared package is dependency-light and framework-neutral — it must not load a server framework or a driver. Name its types with `import type`, which is erased before anything runs, and let each workspace import the library itself.',
        ),
    ],
};
