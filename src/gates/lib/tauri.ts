/**
 * What the Tauri gates share: the crate's Rust files read once, its `#[tauri::command]`
 * functions, and the error type a signature's `Result` names.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './files.ts';
import { lexRust, rustItems, splitRustList, type RustItem, type RustLex } from './rust.ts';

export type RustFile = { rel: string; source: string; lexed: RustLex; items: RustItem[] };

export type TauriCommand = { name: string; file: RustFile; item: RustItem };

/** Every `.rs` file under `dir`, lexed and split into items. */
export function readRustFiles(root: string, dir: string): RustFile[] {
    return walkFiles(root, dir, { match: /\.rs$/ }).map((rel) => {
        const source = fs.readFileSync(path.join(root, rel), 'utf8');
        const lexed = lexRust(source);
        return { rel, source, lexed, items: rustItems(source, lexed) };
    });
}

/** Every top-level function carrying `#[tauri::command]`, or `#[command]` once imported. */
export function tauriCommands(files: RustFile[]): TauriCommand[] {
    return files.flatMap((file) =>
        file.items
            .filter((item) => item.kind === 'fn' && item.attributes.some((a) => /^#\[\s*(?:tauri::)?command\b/.test(a)))
            .map((item) => ({ name: item.name, file, item })),
    );
}

/**
 * The error type of a signature's `Result`: `null` when it returns none, `''` for the
 * crate's one-argument alias, and `tauri::Error` for `tauri::Result<T>`.
 */
export function resultError(head: string): string | null {
    const returns = /->\s*([\s\S]*?)\s*(?:\bwhere\b|$)/.exec(head)?.[1]?.trim() ?? '';
    const m = /^((?:\w+::)*)Result\s*</.exec(returns);
    if (m === null) return null;
    const prefix = m[1] ?? '';
    const args = splitRustList(returns.slice(m[0].length, returns.lastIndexOf('>')));
    if (args.length < 2) return prefix === '' ? '' : `${prefix}Error`;
    return (args[1] ?? '').replace(/\s+/g, ' ');
}
