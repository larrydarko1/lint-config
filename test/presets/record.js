/**
 * Re-records every preset snapshot: `npm run presets:record`. Run it when a rule change
 * is meant, then read the snapshot diff before committing it with the change.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { PRESETS, resolvePreset, serialise } from './resolve.js';

for (const preset of Object.keys(PRESETS)) {
    const file = path.join(import.meta.dirname, `${preset}.json`);
    const snapshot = await resolvePreset(preset);
    writeFileSync(file, serialise(snapshot));
    console.log(`  recorded ${preset} — ${Object.keys(snapshot).length} rules on`);
}
