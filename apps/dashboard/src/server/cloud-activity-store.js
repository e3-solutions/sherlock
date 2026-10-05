import { open, readFile, rename, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { CloudActivityError, sha256 } from "./cloud-activity.js";

// An existing private directory is required; no default under CODEX_HOME and
// no transcript discovery. A stale lock requires explicit operator recovery.
export class FileCheckpointStore {
  constructor(path) {
    if (!isAbsolute(path)) throw new CloudActivityError("checkpoint_absolute_path_required");
    this.path = path;
  }
  async runExclusive(operation) {
    let lock;
    try { lock = await open(`${this.path}.lock`, "wx", 0o600); }
    catch { throw new CloudActivityError("checkpoint_locked_or_unwritable"); }
    try { return await operation(); }
    finally { await lock.close(); await unlink(`${this.path}.lock`); }
  }
  async load() {
    let text;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 8388608) throw new Error();
      text = await readFile(this.path, "utf8");
    }
    catch (error) { if (error.code === "ENOENT") return null; throw new CloudActivityError("checkpoint_unreadable"); }
    try {
      if (Buffer.byteLength(text) > 8388608) throw new Error();
      const envelope = JSON.parse(text);
      if (sha256(JSON.stringify(envelope.state)) !== envelope.sha256) throw new Error();
      return envelope.state;
    } catch { throw new CloudActivityError("checkpoint_invalid"); }
  }
  async save(state) {
    const text = JSON.stringify({ state, sha256: sha256(JSON.stringify(state)) });
    if (Buffer.byteLength(text) > 8388608) throw new CloudActivityError("checkpoint_too_large");
    const temporary = `${this.path}.pending.${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path);
    // Make the rename durable, including on an abrupt machine restart.
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
