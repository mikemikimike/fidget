import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./temp.js";

const TESTS = dirname(fileURLToPath(import.meta.url));

test("a temp dir lives under the system temp dir until its test ends", async (t) => {
  let dir;
  await t.test("owner", (owner) => {
    dir = tempDir(owner, "temp-test-");
    writeFileSync(join(dir, "file"), "x");
    assert.equal(dirname(dir), tmpdir());
    assert.match(relative(tmpdir(), dir), /^temp-test-/);
    assert.equal(existsSync(join(dir, "file")), true);
  });
  assert.equal(existsSync(dir), false);
});

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?js$/.test(entry.name) ? [relative(TESTS, path)] : [];
  });
}

const offenders = (pattern, allowed) =>
  sources(TESTS).filter((file) => !allowed.includes(file) && pattern.test(readFileSync(join(TESTS, file), "utf8")));

test("only temp.js makes temp dirs", () => {
  assert.deepEqual(offenders(/\bmkdtemp\w*\s*[(]/, ["temp.js"]), []);
});

// chrome-cdp.test.js only reads the flag back from its fake Chrome.
test("only chrome-cdp.js picks a Chrome profile dir", () => {
  assert.deepEqual(offenders(/--user-data-[d]ir/, ["chrome-cdp.js", "chrome-cdp.test.js"]), []);
});
