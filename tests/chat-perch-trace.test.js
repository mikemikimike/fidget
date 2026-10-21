import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/scenarios/e2e/chat-perch.sh", import.meta.url));

function check(trace, firstLine = 2, instance = "character-a") {
  const dir = mkdtempSync(join(tmpdir(), "fidget-perch-trace-"));
  try {
    const log = join(dir, "app.log");
    writeFileSync(log, trace);
    return spawnSync("bash", [script, "--check-click", log, String(firstLine), instance], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a new command trace for the clicked Character passes without a desktop", () => {
  const result = check("overlay: ready\nbubble: open-chat invoked instance=character-a\n");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const [name, trace] of [
  ["focus alone", "overlay: ready\nfocused-window=42|BMO\n"],
  ["a command before the click", "bubble: open-chat invoked instance=character-a\noverlay: ready\n"],
  ["another Character", "overlay: ready\nbubble: open-chat invoked instance=character-b\n"],
  ["an instance with the same prefix", "overlay: ready\nbubble: open-chat invoked instance=character-a-extra\n"],
  ["an empty log", ""],
]) {
  test(`${name} cannot prove the bubble click`, () => {
    const result = check(trace);
    assert.equal(result.status, 1, result.stderr || result.stdout);
  });
}

test("an invalid baseline is refused", () => {
  assert.equal(check("bubble: open-chat invoked instance=character-a\n", 0).status, 2);
});

test("without consent the scenario only prints its takeover header", () => {
  const result = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /Scenario: chat-perch/);
  assert.match(result.stdout, /Input: synthetic mouse clicks and typing inside Fidget only/);
});
