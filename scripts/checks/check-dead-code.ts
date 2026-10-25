/** The import graph, with the files behind `exports` as this package's API. */
import { checkDeadCode } from '../../src/gates/dead-code.ts';
import { packageEntries } from '../../src/knip.ts';

checkDeadCode({ publicApi: packageEntries() });
