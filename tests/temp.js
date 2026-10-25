import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one place tests make a temp dir, so none outlives its test. `t` is the
// test or hook context that owns the dir; it goes when `t` ends, pass or fail.
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
