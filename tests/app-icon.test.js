// The committed app icon must keep Apple's grid, and the head must leave the
// headphones clear of the body's edge. The generator's self-check measures both.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "make-app-icon.py");

test("app icon keeps an 824 px body and the head under 86% of it", () => {
  const out = execFileSync("python3", [SCRIPT, "--self-check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /self-check:/);
});
