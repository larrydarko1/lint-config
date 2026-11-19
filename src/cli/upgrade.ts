/**
 * `larry upgrade`: rewrites what a project set up for an older release of this package
 * into what this one reads. Each migration looks for the old shape itself rather than
 * going by version numbers, since a project can skip releases or update the package
 * without running this, and one that finds nothing to do changes nothing. They run in
 * order, each on the project as the ones before it left it, and nothing is written until
 * all have run.
 */
import { moveGateScripts } from './migrations/gate-scripts.ts';
import { renameOptions } from './migrations/renamed-options.ts';
import { commitTree, createTree, type Tree } from './migrations/tree.ts';

type Migration = {
    title: string;
    /** Changes the tree, and returns what is left for a person to do. */
    run: (tree: Tree) => Promise<string[]>;
};

type UpgradeStep = {
    title: string;
    /** Each file the migration changed, by path from the root. */
    changed: { file: string; how: 'added' | 'changed' | 'removed' }[];
    notes: string[];
};

/** Oldest first: a later migration may rely on an earlier one's result. */
const MIGRATIONS: Migration[] = [
    { title: 'Gate scripts → larry.config.ts', run: moveGateScripts },
    { title: 'Renamed gate options in larry.config.ts', run: renameOptions },
];

/**
 * @param root The repository root.
 * @param write False to work out the changes without writing them.
 * @returns Each migration that changed a file or left a note.
 * @throws When a migration cannot run, before anything is written.
 */
export async function upgrade(root: string, write: boolean): Promise<UpgradeStep[]> {
    const tree = createTree(root);
    const steps: UpgradeStep[] = [];
    for (const { title, run } of MIGRATIONS) {
        const before = tree.changes();
        const notes = await run(tree);
        const changed = [...tree.changes()]
            .filter(([file, content]) => before.get(file) !== content)
            .map(([file, content]) => ({ file, how: howChanged(tree, file, content) }));
        if (changed.length > 0 || notes.length > 0) steps.push({ title, changed, notes });
    }
    if (write) commitTree(root, tree);
    return steps;
}

function howChanged(tree: Tree, file: string, content: string | null): UpgradeStep['changed'][number]['how'] {
    if (content === null) return 'removed';
    return tree.existed(file) ? 'changed' : 'added';
}
