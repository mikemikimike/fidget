// The /proc math and frame counts behind scripts/bench-wakeups-linux.sh, on a
// fake /proc and a fake log, so no display or fidget is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const helpers = join(import.meta.dirname, "..", "scripts", "bench-linux-helpers.sh");

function bash(body, dir) {
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nproc="${dir}/proc"\n. "${helpers}"\n${body}`], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fakeProcess(dir, pid, comm, { utime, stime, voluntary }) {
  const at = join(dir, "proc", String(pid));
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "stat"), `${pid} (${comm}) S 1 1 1 0 -1 4194560 10 0 0 0 ${utime} ${stime} 0 0 20 0 4 0\n`);
  writeFileSync(join(at, "status"), `Name:\t${comm}\nvoluntary_ctxt_switches:\t${voluntary}\nnonvoluntary_ctxt_switches:\t7\n`);
}

test("rates are the change between a snapshot and now, per second of the window, for processes still running", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-wakeups-"));
  // A comm with ") " in it must not shift the tick fields.
  fakeProcess(dir, 41, "Web) Content", { utime: 100, stime: 50, voluntary: 1000 });
  fakeProcess(dir, 42, "Xvfb", { utime: 9, stime: 1, voluntary: 5 });
  fakeProcess(dir, 43, "gst-plugin-scan", { utime: 1, stime: 1, voluntary: 3 });
  bash(`proc_snapshot "WebKit=41" "Xvfb=42" "scanner=43" > "${dir}/before.tsv"`, dir);
  rmSync(join(dir, "proc", "43"), { recursive: true });
  fakeProcess(dir, 41, "Web) Content", { utime: 250, stime: 70, voluntary: 1600 });
  fakeProcess(dir, 42, "Xvfb", { utime: 9, stime: 1, voluntary: 6 });

  assert.equal(
    bash(`wakeup_rows "${dir}/before.tsv" 10 100`, dir),
    "WebKit\t41\t17.0\t60.0\nXvfb\t42\t0.0\t0.1\n",
  );
});

test("frames are counted by animation, only after the window's first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-wakeups-"));
  writeFileSync(
    join(dir, "process.log"),
    [
      "1792716498 frame: 1792716498446 Falling pos(960,541) sprite(897,413) fall#0 fdeef3d8",
      "1792716499 frame: 1792716499844 Grounded pos(960,1080) sprite(897,952) land#1 fdeef3d8",
      "1792716499 frame: 1792716499860 Grounded pos(960,1080) sprite(897,952) walk#0 fdeef3d8",
      "1792716499 overlay: draft BMO text=\"walk#3\"",
      "1792716499 frame: 1792716499876 Grounded pos(980,1080) sprite(917,952) walk#3 fdeef3d8",
      "1792716500 frame: 1792716500001 Climbing pos(1920,900) sprite(1857,772) climb#2 fdeef3d8",
      "",
    ].join("\n"),
  );

  assert.equal(bash(`frame_counts "${dir}/process.log" 2`, dir), "climb\t1\nwalk\t2\n");
});
