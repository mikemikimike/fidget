// Nim's frames must reach the bottom row, or Nim floats above the floor, and
// its shadow must stay under the hit-test threshold. The generator checks both.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "make-shipped-characters.py");

test("Nim stands on the floor and its shadow takes no clicks", () => {
  const out = execFileSync("python3", [SCRIPT, "--self-check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /self-check:/);
});
