/**
 * Records, or checks, the rules ESLint actually resolves for a project's files.
 *
 * A migrated eslint.config.js is a few hundred lines shorter than the one it replaced,
 * and reading the two side by side proves nothing: flat config is last-match-wins, so
 * what matters is the severity ESLint ends up at, not the text that produced it. This
 * asks ESLint itself, one representative file per area.
 *
 *   node scripts/eslint-snapshot.js save  <project> <file...>   # before migrating
 *   node scripts/eslint-snapshot.js check <project> <file...>   # after
 *
 * Snapshots go in .eslint-snapshots/<project>/ and are not committed — they are a
 * before/after pair for one migration, not a fixture.
 *
 * Rules resolved to `off` are compared by severity alone: a disabled rule's leftover
 * options change nothing, and a version bump often rewrites them.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SNAPSHOT_DIR = path.resolve(import.meta.dirname, '..', '.eslint-snapshots');

const [mode, project, ...files] = process.argv.slice(2);

if (!['save', 'check'].includes(mode) || !project) {
    console.error('Usage: node scripts/eslint-snapshot.js <save|check> <projectDir> <file...>');
    process.exit(2);
}

const projectDir = path.resolve(project);
const outDir = path.join(SNAPSHOT_DIR, path.basename(projectDir));

/**
 * ESLint is imported from the PROJECT, so this reads the config that project really uses —
 * including the plugin versions it resolves, which is where a migration's surprises live.
 * Resolved through the project's own require, not by guessing at eslint's entry file.
 */
const projectRequire = createRequire(path.join(projectDir, 'package.json'));
const { ESLint } = await import(pathToFileURL(projectRequire.resolve('eslint')).href);
const eslint = new ESLint({ cwd: projectDir });

const isOff = (entry) => {
    const severity = Array.isArray(entry) ? entry[0] : entry;
    return severity === 0 || severity === 'off';
};

/** What the file's config means, with the noise a disabled rule carries stripped out. */
const meaningOf = async (file) => {
    const resolved = await eslint.calculateConfigForFile(path.join(projectDir, file));
    return Object.fromEntries(
        Object.entries(resolved.rules ?? {})
            .map(([rule, entry]) => [rule, isOff(entry) ? 'off' : entry])
            .sort(([a], [b]) => a.localeCompare(b)),
    );
};

const nameFor = (file) => `${file.replace(/[/\\]/g, '_')}.json`;

if (mode === 'save') {
    await mkdir(outDir, { recursive: true });
    for (const file of files) {
        const rules = await meaningOf(file);
        await writeFile(path.join(outDir, nameFor(file)), JSON.stringify(rules, null, 2));
        console.log(`  saved ${file} — ${Object.keys(rules).length} rules`);
    }
    console.log(`\n${files.length} snapshot(s) in ${path.relative(process.cwd(), outDir)}`);
    process.exit(0);
}

const saved = await readdir(outDir).catch(() => {
    console.error(`No snapshots for ${path.basename(projectDir)} — run \`save\` on the old config first.`);
    process.exit(2);
});

const targets = files.length ? files : saved.map((n) => n.replace(/\.json$/, '').replace(/_/g, '/'));
let differences = 0;

for (const file of targets) {
    const snapshot = path.join(outDir, nameFor(file));
    const before = JSON.parse(await readFile(snapshot, 'utf8'));
    const after = await meaningOf(file);

    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((rule) => JSON.stringify(before[rule]) !== JSON.stringify(after[rule]))
        .sort();

    if (changed.length === 0) {
        console.log(`  \x1b[32m✓\x1b[0m ${file}`);
        continue;
    }

    differences += changed.length;
    console.log(`  \x1b[31m✗\x1b[0m ${file} — ${changed.length} rule(s) changed`);
    for (const rule of changed) {
        console.log(`      ${rule}: ${JSON.stringify(before[rule])} → ${JSON.stringify(after[rule])}`);
    }
}

console.log(
    `\n${differences === 0 ? '\x1b[32m' : '\x1b[31m'}${targets.length} file(s) checked, ${differences} rule difference(s)\x1b[0m`,
);
if (differences > 0) {
    console.log('Every difference is either a bug in the migration or a change you meant — decide which, one by one.');
}
process.exit(differences === 0 ? 0 : 1);
