/** Copy-paste across the sources. The suites repeat their fixtures on purpose, so they are not scanned. */
import { checkDuplication } from '../../src/gates/duplication.ts';

checkDuplication({
    scan: ['src'],
    ceilings: { typescript: { limit: 1.7, note: 'Where the gates stood when this package first checked itself.' } },
    maxCloneTokens: 125,
});
