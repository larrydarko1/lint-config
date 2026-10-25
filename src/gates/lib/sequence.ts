/**
 * Which entries of `actual` are already in `ideal`'s order: the longest common
 * subsequence of the two. Everything outside it is what has to move, so one moved
 * statement is one problem, not every statement after it.
 *
 * @param actual The entries as they sit, by id.
 * @param ideal The same ids in the order they belong.
 * @returns The ids that can stay where they are.
 */
export function inPlace(actual: number[], ideal: number[]): Set<number> {
    const n = actual.length;
    // An (n+1)×(n+1) table stored flat, row by row. Every read is within it.
    const dp = new Array<number>((n + 1) * (n + 1)).fill(0);
    const at = (x: number, y: number): number => dp[x * (n + 1) + y] ?? 0;
    for (let x = n - 1; x >= 0; x--) {
        for (let y = n - 1; y >= 0; y--) {
            dp[x * (n + 1) + y] = actual[x] === ideal[y] ? at(x + 1, y + 1) + 1 : Math.max(at(x + 1, y), at(x, y + 1));
        }
    }
    const keep = new Set<number>();
    let x = 0;
    let y = 0;
    while (x < n && y < n) {
        const ax = actual[x];
        if (ax !== undefined && ax === ideal[y]) {
            keep.add(ax);
            x++;
            y++;
        } else if (at(x + 1, y) >= at(x, y + 1)) x++;
        else y++;
    }
    return keep;
}
