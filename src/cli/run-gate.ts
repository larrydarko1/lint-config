/**
 * One gate in a process of its own, which `larry check` starts at a terminal so its spinner
 * keeps turning while the gate blocks on its work. Prints what the gate prints and exits 1
 * if it fails.
 *
 * Usage: run-gate.ts <root> <gate> [--fix] [--all]. The gate reads the flags from argv itself.
 */
import { runGate } from './check.ts';
import { isGate, loadConfig } from './load-config.ts';

const [root = '', name = ''] = process.argv.slice(2);
if (!isGate(name)) throw new Error(`run-gate: "${name}" is not a gate.`);

process.exitCode = (await runGate(await loadConfig(root), name)) ? 0 : 1;
