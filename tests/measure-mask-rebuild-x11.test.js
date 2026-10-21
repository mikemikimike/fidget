// The X11 mask rebuild measurement must end when it is interrupted, with its
// app gone and no results printed. A fake Fidget stands in, so nothing shows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.join(import.meta.dirname, "..", "scripts", "measure-mask-rebuild-x11.sh");

function fakeFidget(dir) {
  const bin = path.join(dir, "fidget");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo $$ > "${dir}/app.pid"
echo "overlay: 1 display"
echo "mask_rebuild: 126x128 @1x scale, 6300 opaque pixels, 0.5 ms"
exec sleep 30
`,
    { mode: 0o755 },
  );
  return bin;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function interrupt(signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-measure-"));
  const child = spawn("bash", [script, "--bin", fakeFidget(dir), "idle", "100", "3"]);
  let out = "";
  let afterSignal = "";
  let sent = false;
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  child.stdout.on("data", (chunk) => {
    if (sent) afterSignal += chunk;
    out += chunk;
    if (!sent && out.includes("Waiting for 100 mask updates")) {
      sent = true;
      child.kill(signal);
    }
  });
  const result = await exited;
  const pid = Number(fs.readFileSync(path.join(dir, "app.pid"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, out, afterSignal, appAlive: alive(pid) };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} ends the measurement with status 130 and stops the app`, async () => {
    const r = await interrupt(signal);
    assert.strictEqual(r.code, 130, r.out);
    assert.strictEqual(r.appAlive, false, "the app outlived the script");
    assert.strictEqual(r.afterSignal, "", "measurement output followed the signal");
  });
}
