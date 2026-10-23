import { bannedPackages } from '../rules/banned-packages.ts';

// The webview has no Node at runtime: everything outside the browser goes through Rust.
export const webviewBannedImports = {
    patterns: [
        bannedPackages(
            ['node:', 'fs', 'path', 'os', 'child_process', 'crypto'],
            'No Node built-ins in the webview — a Tauri app ships no Node, so this would not resolve at runtime. Do the filesystem/OS work through an official plugin or a Rust command, called from src/bridge/.',
        ),
        bannedPackages(
            ['electron', 'electron-log'],
            'This is a Tauri app: the webview reaches the OS through src/bridge/, and the log is tauri-plugin-log behind `@/bridge/log`.',
        ),
    ],
};
