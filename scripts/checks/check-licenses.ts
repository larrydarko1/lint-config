/**
 * The licences this package's dependencies carry. Its own source is public, but the
 * projects that install it may not be, so it holds itself to what a closed app can ship.
 */
import { checkLicenses } from '../../src/gates/licenses.ts';

checkLicenses({ distribution: 'closed' });
