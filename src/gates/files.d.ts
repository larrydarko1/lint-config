export type PathFilter = RegExp | ((rel: string) => boolean);

export type WalkOptions = {
    /** Keep only paths matching this. Defaults to every file. */
    match?: PathFilter;
    /** Drop paths matching this, applied after `match`. */
    exclude?: PathFilter;
};

/** Every file under `dirs`, relative to `root`, sorted. Missing directories are skipped. */
export declare function walkFiles(root: string, dirs: string | string[], options?: WalkOptions): string[];
export default walkFiles;
