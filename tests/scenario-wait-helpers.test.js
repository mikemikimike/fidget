// The shared scenario wait helpers (#1503): wait-helpers.sh for the macOS
// leaves and wait-helpers.win.ps1 for the Windows ones. Each test runs the
// helper itself on a file another process writes; no app launches.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";

const scenarios = join(import.meta.dirname, "..", "scripts", "scenarios");
const posix = process.platform !== "win32";
const pwsh = resolvePwsh();
const noPwsh = pwsh.kind === "ready" ? false : pwsh.reason;

// BSD tail, as on macOS: no -s. The x11 helper streams through `tail -s`.
function bsdTailDir() {
  const dir = mkdtempSync(join(tmpdir(), "fidget-bsd-tail-"));
  const shim = join(dir, "tail");
  writeFileSync(
    shim,
    '#!/bin/sh\nfor a; do [ "$a" = -s ] && { echo "tail: illegal option -- s" >&2; exit 1; }; done\nexec /usr/bin/env -i PATH=/usr/bin:/bin tail "$@"\n',
  );
  chmodSync(shim, 0o755);
  return dir;
}

function bash(helper, body) {
  const dir = mkdtempSync(join(tmpdir(), "fidget-wait-"));
  return spawnSync(
    "bash",
    ["-c", `. "${join(scenarios, helper)}"; ${body}`],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bsdTailDir()}:${process.env.PATH}`, W: dir },
    },
  );
}

// A line written 300 ms into a 2 s wait.
const late = `( sleep 0.3; echo asked >> "$W/marks" ) & : > "$W/marks"
ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
s=$(ms); wait_for_marks 2 "$W/marks" '^asked$'; rc=$?
echo "rc=$rc ms=$(($(ms) - s))"`;

test(
  "macOS helper: a mark written mid-wait returns at once under BSD tail",
  { skip: posix ? false : "bash leaf helper" },
  () => {
    const out = bash("wait-helpers.sh", late);
    assert.equal(out.status, 0, out.stderr);
    const [, rc, ms] = out.stdout.match(/rc=(\d+) ms=(\d+)/);
    assert.equal(rc, "0", out.stdout);
    assert.ok(Number(ms) < 1000, `took ${ms} ms`);
  },
);

test(
  "macOS helper: a mark that never comes times out, and a dead Fidget fails at once",
  { skip: posix ? false : "bash leaf helper" },
  () => {
    const out = bash(
      "wait-helpers.sh",
      `: > "$W/marks"; wait_for_marks 1 "$W/marks" '^asked$'; echo "miss=$?"
sh -c 'exit 0' & pid=$!; wait $pid
s=$(date +%s); wait_for_marks 3 "$W/marks" '^asked$'; echo "gone=$? s=$(($(date +%s) - s))"`,
    );
    assert.match(out.stdout, /miss=1/);
    assert.match(out.stdout, /gone=1 s=0/);
  },
);

test(
  "macOS helper: seed_settings marks the first-run tour shown and keeps extras",
  { skip: posix ? false : "bash leaf helper" },
  () => {
    const out = bash(
      "wait-helpers.sh",
      `seed_settings "$W/home" '"hide_in_fullscreen": false'; cat "$W/home/Library/Application Support/fidget/settings.json"`,
    );
    assert.deepEqual(JSON.parse(out.stdout), {
      first_run_tour_shown: true,
      hide_in_fullscreen: false,
    });
  },
);

test("every macOS leaf that launches Fidget sources the macOS helper", () => {
  const leaves = readdirSync(scenarios).filter(
    (f) => f.endsWith(".sh") && !f.endsWith(".x11.sh") &&
      !["fixture-harness.sh", "wait-helpers.sh", "run-all.sh", "sign-in-button.sh"].includes(f),
  );
  assert.ok(leaves.length >= 13, leaves.join(" "));
  for (const leaf of leaves) {
    const text = readFileSync(join(scenarios, leaf), "utf8");
    assert.match(text, /wait-helpers\.sh"/, `${leaf} does not source wait-helpers.sh`);
    assert.doesNotMatch(text, /wait-helpers\.x11\.sh/, `${leaf} sources the x11 helper`);
  }
});

function ps(body) {
  const dir = mkdtempSync(join(tmpdir(), "fidget-wait-ps-"));
  const out = spawnSync(
    pwsh.command,
    [...(pwsh.args ?? []), "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = "Stop"; . "${join(scenarios, "wait-helpers.win.ps1")}"; $W = "${dir}"; ${body}`],
    { encoding: "utf8", env: { ...process.env, TERM: "dumb" } },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
}

// The writer is sh, so this one runs where pwsh and sh both are: CI's Linux.
test(
  "Windows helper: a mark written mid-wait returns within a second",
  { skip: noPwsh || (posix ? false : "needs sh for the writer") },
  () => {
    const [ok, ms] = ps(`
$marks = Join-Path $W "marks"; Set-Content -LiteralPath $marks -Value ""
$psi = New-Object Diagnostics.ProcessStartInfo "sh"
$psi.ArgumentList.Add("-c"); $psi.ArgumentList.Add("sleep 0.3; echo asked >> '$marks'")
$null = [Diagnostics.Process]::Start($psi)
$sw = [Diagnostics.Stopwatch]::StartNew()
Wait-ForMarks 2 $marks '^asked$'
$sw.ElapsedMilliseconds`);
    assert.equal(ok, "True");
    assert.ok(Number(ms) < 1000, `took ${ms} ms`);
  },
);

test(
  "Windows helper: Initialize-ScenarioData moves every data folder and seeds the tour",
  { skip: noPwsh },
  () => {
    const lines = ps(`
$data = Initialize-ScenarioData $W @{ hide_in_fullscreen = $false }
$env:FIDGET_DATA_DIR -eq $data
$env:TEMP.StartsWith($W)
$env:APPDATA.StartsWith($W)
$env:WEBVIEW2_USER_DATA_FOLDER.StartsWith($W)
Get-Content -Raw (Join-Path $data "settings.json")`);
    assert.deepEqual(lines.slice(0, 4), ["True", "True", "True", "True"]);
    assert.deepEqual(JSON.parse(lines[4]), {
      first_run_tour_shown: true,
      hide_in_fullscreen: false,
    });
  },
);

test("Windows helper: Wait-Until times out false", { skip: noPwsh }, () => {
  assert.deepEqual(ps(`Wait-Until 1 { $false }`), ["False"]);
});
