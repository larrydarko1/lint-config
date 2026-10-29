/**
 * Every preset's resolved rules, held to the snapshot committed in test/presets/. A
 * shared block, a plugin bump or a reordered config changes what every family's files
 * get, and most of those changes are invisible in the diff that caused them: flat config
 * is last-match-wins, so a block moved past another can switch a rule off in one family
 * only. The failure names each rule that moved, and where.
 *
 * A change that is meant is re-recorded with `npm run presets:record`, and the snapshot
 * diff is read and committed with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FAMILIES } from '../src/eslint/presets.ts';
import { PRESETS, resolvePreset } from './presets/resolve.js';

const recorded = (preset) =>
    JSON.parse(readFileSync(path.join(import.meta.dirname, 'presets', `${preset}.json`), 'utf8'));

/** `rule: what changed`, one line per rule whose files or entry differ. */
const differences = (before, after) =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((rule) => {
        if (!(rule in before)) return [`${rule}: now on — ${JSON.stringify(after[rule])}`];
        if (!(rule in after)) return [`${rule}: now off everywhere (was ${JSON.stringify(before[rule])})`];
        if (JSON.stringify(before[rule]) === JSON.stringify(after[rule])) return [];
        return [`${rule}:\n      was ${JSON.stringify(before[rule])}\n      now ${JSON.stringify(after[rule])}`];
    });

for (const preset of Object.keys(PRESETS)) {
    test(`the ${preset} preset resolves the rules its snapshot records`, async () => {
        const changed = differences(recorded(preset), await resolvePreset(preset));
        assert.ok(
            changed.length === 0,
            `${changed.length} rule(s) changed in the ${preset} preset:\n  ${changed.join('\n  ')}\n` +
                'If every one is meant, run `npm run presets:record` and commit the snapshots with the change.',
        );
    });
}

test('every preset has a snapshot, so a new family cannot ship without one', () => {
    assert.deepEqual(Object.keys(PRESETS).sort(), [...FAMILIES].sort());
});
