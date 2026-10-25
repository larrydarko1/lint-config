/** No credentials in anything git would commit. */
import { checkSecrets } from '../../src/gates/secrets.ts';

checkSecrets({
    allowlist: [
        {
            file: 'test/gate-env-drift.test.js',
            rule: 'private-key',
            reason: 'A bare header with no key after it: the input that proves env-drift spots one in an example file.',
        },
    ],
});
