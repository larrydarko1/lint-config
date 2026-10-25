/** File names and sizes across the sources. */
import { checkCodeStyle } from '../../src/gates/code-style.ts';

checkCodeStyle({
    scan: ['src', 'scripts', 'test'],
    casing: [{ files: /\.(?:ts|js)$/, style: 'kebab' }],
    // Over the softcap when this package first checked itself. Lower a number, never raise it.
    baseline: {
        'src/gates/api-standards.ts': 1617,
        'src/gates/code-style.ts': 441,
        'src/gates/db-drift.ts': 853,
        'src/gates/declaration-order.ts': 611,
        'src/gates/docker.ts': 645,
        'src/gates/electron-security.ts': 733,
        'src/gates/error-handling/fullstack.ts': 566,
        'src/gates/ipc-standards.ts': 487,
        'src/gates/lib/rust.ts': 424,
        'src/gates/metrics.ts': 761,
        'src/gates/pipeline.ts': 749,
        'src/gates/scss-standards.ts': 731,
        'src/gates/security-drift.ts': 952,
        'src/gates/tauri-commands.ts': 503,
        'src/gates/tauri-security.ts': 434,
        'src/gates/testing.ts': 612,
        'src/gates/tsconfigs.ts': 521,
        'src/gates/ws-standards.ts': 638,
    },
});
