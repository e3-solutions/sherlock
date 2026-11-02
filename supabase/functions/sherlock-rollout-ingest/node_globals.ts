// The pinned postgres.js fork is loaded as plain ESM from GitHub, not as an
// npm package, so the Supabase edge runtime does not give it the Node globals
// it uses (it booted with "Buffer is not defined"). postgres.ts imports this
// module first so these exist before the fork's modules evaluate.
import { Buffer } from "node:buffer";
import { clearImmediate, setImmediate } from "node:timers";

const globals = globalThis as Record<string, unknown>;
globals.Buffer ??= Buffer;
globals.setImmediate ??= setImmediate;
globals.clearImmediate ??= clearImmediate;
