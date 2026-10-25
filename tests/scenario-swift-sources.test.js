// The macOS leaves build their Swift tools from paths put together at run
// time, so a search for file names misses a stale one. Each build runs here
// against a stand-in swiftc that fails on a source that does not exist.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp-path.js";

const scenarios = join(import.meta.dirname, "..", "scripts", "scenarios");
// A leaf moves to ci/ once a job proves it, so look in both folders.
const leaf = (name) =>
  ["ci", "manual-only"].map((dir) => join(scenarios, dir, name)).find(existsSync) ??
  assert.fail(`no leaf ${name} in ci/ or manual-only/`);

function withFakeSwiftc(t, run) {
  const dir = tempDir(t, "fidget-swiftc-");
  const missing = join(dir, "missing.txt");
  const swiftc = join(dir, "swiftc");
  // Fails on a missing .swift input, else writes the -o output.
  writeFileSync(
    swiftc,
    `#!/bin/bash
out=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    *.swift) [ -f "$1" ] || { echo "$1" >> "${missing}"; exit 97; } ;;
  esac
  shift
done
[ -z "$out" ] || : > "$out"
`,
  );
  chmodSync(swiftc, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir };
  const result = run(env);
  let gone = "";
  try {
    gone = readFileSync(missing, "utf8");
  } catch {}
  return { result, gone };
}

test("chat-perch.sh --prepare builds from Swift sources that exist", (t) => {
  const { result, gone } = withFakeSwiftc(t, (env) =>
    spawnSync("bash", [leaf("chat-perch.sh"), "--prepare"], { encoding: "utf8", env }),
  );
  assert.equal(gone, "", `missing Swift sources:\n${gone}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("chat-glass.sh builds from Swift sources that exist", (t) => {
  // /bin/true as Fidget exits at once, so the run fails after the build.
  const { gone } = withFakeSwiftc(t, (env) =>
    spawnSync("bash", [leaf("chat-glass.sh"), "--go", "/bin/true", "/bin/true"], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    }),
  );
  assert.equal(gone, "", `missing Swift sources:\n${gone}`);
});
