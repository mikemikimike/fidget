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

// Each case gets 3 s; a hang or a cleanup that misses the app fails fast.
const budgetMs = 3000;

async function interrupt(signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-measure-"));
  const pidFile = path.join(dir, "app.pid");
  const child = spawn("bash", [script, "--bin", fakeFidget(dir), "idle", "100", "2"]);
  let out = "";
  let afterSignal = "";
  let sent = false;
  let timer;
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no exit within ${budgetMs} ms:\n${out}`)), budgetMs);
  });
  child.stdout.on("data", (chunk) => {
    if (sent) afterSignal += chunk;
    out += chunk;
    if (!sent && out.includes("Waiting for 100 mask updates")) {
      sent = true;
      child.kill(signal);
    }
  });
  let pid;
  try {
    const result = await Promise.race([exited, budget]);
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    return { ...result, out, afterSignal, appAlive: alive(pid) };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (pid === undefined && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} ends the measurement with status 130 and stops the app`, async () => {
    const r = await interrupt(signal);
    assert.strictEqual(r.code, 130, r.out);
    assert.strictEqual(r.appAlive, false, "the app outlived the script");
    assert.strictEqual(r.afterSignal, "", "measurement output followed the signal");
  });
}
