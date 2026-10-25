/** Declaration and import order in the sources. `--fix` rewrites the imports. */
import { checkDeclarationOrder } from '../../src/gates/declaration-order.ts';

checkDeclarationOrder({ sourceRoots: ['src', 'scripts'] });
