import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one place tests make a temp dir, so none outlives its owner. The caller
// must call `remove` when done; prefer tempDir when a test context owns it.
export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

// `t` is the test or hook context that owns the dir; it goes when `t` ends, pass or fail.
export function tempDir(t, prefix) {
  const { dir, remove } = makeTempDir(prefix);
  t.after(remove);
  return dir;
}
