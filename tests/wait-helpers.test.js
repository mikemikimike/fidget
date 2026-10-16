// The shared bash wait core behind the macOS and X11 scenario leaves returns
// as soon as its event shows up and gives up within the seconds it is given,
// so a live check takes seconds. It is plain bash with BSD-safe tools, so it
// runs here on Linux too. Each platform helper must load it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scenarios = path.join(import.meta.dirname, "..", "scripts", "scenarios");
const helper = path.join(scenarios, "wait-helpers.sh");

function run(body, file = helper) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-mac-"));
  const script = `set -u\n. "${file}"\ndir="${dir}"\nlog="$dir/app.log"; : > "$log"\n${body}`;
  const started = Date.now();
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const ms = Date.now() - started;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr, ms };
}

test("wait_for_trace returns soon after a line lands", () => {
  const r = run(`: > "$dir/log"; (sleep 0.15; echo "verbs: Poke" >> "$dir/log") & wait_for_trace 2 "$dir/log" '^verbs: .*Poke'`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
});

test("wait_for_trace sees a line already there without waiting", () => {
  const r = run(`echo asked > "$dir/marks"; wait_for_marks 2 "$dir/marks" '^asked$'`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms < 500, `took ${r.ms} ms`);
});

test("wait_for_marks gives up within its seconds", () => {
  const r = run(`: > "$dir/marks"; wait_for_marks 1 "$dir/marks" '^never$'`);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.ms >= 900 && r.ms < 2000, `took ${r.ms} ms`);
});

test("waits fail at once when Fidget has exited", () => {
  const r = run(`: > "$dir/log"; sleep 0 & pid=$!; wait "$pid"; wait_for_trace 2 "$dir/log" x`);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.ms < 500, `took ${r.ms} ms`);
});

test("wait_for_file returns soon after the file appears", () => {
  const r = run(`(sleep 0.15; : > "$dir/f"; echo frame >> "$log") & wait_for_file 2 "$dir/f"`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
});

test("wait_until checks again when the app log grows", () => {
  const r = run(`(sleep 0.2; : > "$dir/flag"; echo frame >> "$log") & wait_until 2 test -f "$dir/flag"`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms >= 200 && r.ms < 1000, `took ${r.ms} ms`);
});

test("wait_until gives up within its seconds", () => {
  const r = run(`wait_until 1 false`);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.ms >= 900 && r.ms < 2000, `took ${r.ms} ms`);
});

test("wait_for_count returns only once the new line lands", () => {
  const r = run(`echo minimized > "$dir/t"; before=$(line_count "$dir/t" '^minimized$')
(sleep 0.4; echo minimized >> "$dir/t") & wait_for_count 2 "$dir/t" '^minimized$' "$before"`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms >= 400 && r.ms < 1200, `took ${r.ms} ms`);
});

test("wait_for_count does not count the line already there", () => {
  const r = run(`echo minimized > "$dir/t"; wait_for_count 1 "$dir/t" '^minimized$' 1`);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.ms >= 900 && r.ms < 2000, `took ${r.ms} ms`);
});

test("wait_for_file gives up within its seconds", () => {
  const r = run(`wait_for_file 1 "$dir/never"`);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.ms >= 900 && r.ms < 2000, `took ${r.ms} ms`);
});

test("in_state reads the last frame line", () => {
  const r = run(`printf 'frame: a Idle x\\nframe: b Climb x\\n' > "$dir/l"; in_state "$dir/l" Climb && ! in_state "$dir/l" Idle`);
  assert.strictEqual(r.code, 0, r.out);
});

test("stop_fidget kills Fidget and the processes under it", () => {
  const r = run(`bash -c 'sleep 30 & wait' & pid=$!; sleep 0.2; child=$(pgrep -P "$pid"); stop_fidget; sleep 0.1
! kill -0 "$pid" 2> /dev/null && ! kill -0 "$child" 2> /dev/null`);
  assert.strictEqual(r.code, 0, r.out);
});

for (const leaf of ["mac", "x11"]) {
  test(`wait-helpers.${leaf}.sh loads the shared core`, () => {
    const r = run(`for f in wait_for_trace wait_for_marks wait_for_file wait_until wait_for_count stop_fidget in_state wait_for_ax_dump answer_permission; do declare -F "$f" > /dev/null || { echo "missing $f"; exit 1; }; done`, path.join(scenarios, `wait-helpers.${leaf}.sh`));
    assert.strictEqual(r.code, 0, r.out);
  });
}

test("seed_tour_shown marks the first-run tour as shown", () => {
  const r = run(`seed_tour_shown "$dir/home"; grep -q '"first_run_tour_shown": true' "$dir/home/Library/Application Support/fidget/settings.json"`, path.join(scenarios, "wait-helpers.mac.sh"));
  assert.strictEqual(r.code, 0, r.out);
});

// The Windows helper blocks on FileSystemWatcher events. pwsh runs it here.
test("sprite_at_rest needs the same spot in all five frames", () => {
  const frames = (xs) => xs.map((x) => `echo "frame: 1 Grounded pos(1,1) sprite(${x},20) idle#1" >> "$log"`).join("; ");
  const still = run(`${frames([10, 10, 10, 10, 10])}; sprite_at_rest "$log"`);
  assert.strictEqual(still.code, 0, still.out);
  const moved = run(`${frames([10, 10, 10, 10, 11])}; sprite_at_rest "$log"`);
  assert.notStrictEqual(moved.code, 0, "a frame in another spot counted as rest");
  const walked = run(`${frames([10, 30, 50, 70, 90])}; sprite_at_rest "$log"`);
  assert.notStrictEqual(walked.code, 0, "five spots counted as rest");
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"], { encoding: "utf8" });
const noPwsh = pwsh.status !== 0;
const winHelper = path.join(scenarios, "wait-helpers.win.ps1");

function ps(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-win-"));
  const script = `. '${winHelper}'
function Later($c) { $p = New-Object Diagnostics.ProcessStartInfo "bash"; $p.ArgumentList.Add("-c"); $p.ArgumentList.Add("sleep 0.3; $c"); $null = [Diagnostics.Process]::Start($p) }
$W = '${dir}'
$data = Initialize-ScenarioData $W
${body}`;
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, lines: r.stdout.trim().split("\n").map((l) => l.trim()), err: r.stderr };
}

test("Windows: Wait-ForMarks returns soon after the line lands", { skip: noPwsh }, () => {
  const r = ps(`$m = "$W/marks"; Set-Content $m ""; Later "echo asked >> $m"; $t = Get-NowMs; Wait-ForMarks 2 $m '^asked$'; (Get-NowMs) - $t`);
  assert.strictEqual(r.lines[0], "True", r.err);
  assert.ok(Number(r.lines[1]) >= 250 && Number(r.lines[1]) < 1000, `took ${r.lines[1]} ms`);
});

test("Windows: Wait-ForCount ignores the line already there", { skip: noPwsh }, () => {
  const r = ps(`$m = "$W/marks"; Set-Content $m "spawn"; Wait-ForCount 1 $m '^spawn$' 1; Later "echo spawn >> $m"; Wait-ForCount 2 $m '^spawn$' 1`);
  assert.deepStrictEqual(r.lines.slice(0, 2), ["False", "True"], r.err);
});

test("Windows: Wait-Until re-checks on a trace change and gives up in time", { skip: noPwsh }, () => {
  const r = ps(`Later "echo x > $W/flag; echo frame >> $data/process.log"; Wait-Until 2 { Test-Path "$W/flag" }; $t = Get-NowMs; Wait-Until 1 { $false }; (Get-NowMs) - $t`);
  assert.deepStrictEqual(r.lines.slice(0, 2), ["True", "False"], r.err);
  assert.ok(Number(r.lines[2]) >= 900 && Number(r.lines[2]) < 2000, `took ${r.lines[2]} ms`);
});

test("Windows: Wait-ForFile sees the file appear", { skip: noPwsh }, () => {
  const r = ps(`Later "touch $data/process.log"; Wait-ForFile 2 "$data/process.log"`);
  assert.strictEqual(r.lines[0], "True", r.err);
});

test("Windows: Initialize-ScenarioData moves every data folder and seeds the tour", { skip: noPwsh }, () => {
  const r = ps(`$d = Initialize-ScenarioData $W @{ hide_in_fullscreen = $false }
$env:FIDGET_DATA_DIR -eq $d
$env:APPDATA.StartsWith($W)
$env:WEBVIEW2_USER_DATA_FOLDER.StartsWith($W)
Get-Content -Raw (Join-Path $d "settings.json")`);
  assert.deepStrictEqual(r.lines.slice(0, 3), ["True", "True", "True"], r.err);
  assert.deepStrictEqual(JSON.parse(r.lines[3]), { first_run_tour_shown: true, hide_in_fullscreen: false });
});

test("Windows: Get-SpriteAtRest needs five resting frames in one spot", { skip: noPwsh }, () => {
  const r = ps(`$t = "$W/p.log"
1..4 | % { Add-Content $t "1 frame: 1 Grounded pos(1,1) sprite(10,20) idle#1 x" }
[bool](Get-SpriteAtRest $t)
Add-Content $t "1 frame: 1 Grounded pos(1,1) sprite(10,20) idle#1 x"
(Get-SpriteAtRest $t).X
Add-Content $t "1 frame: 1 Falling pos(1,1) sprite(10,40) fall#1 x"
[bool](Get-SpriteAtRest $t)`);
  assert.deepStrictEqual(r.lines.slice(0, 3), ["False", "10", "False"], r.err);
});

test("Windows: a process.log write one folder below the watched folder wakes the wait", { skip: noPwsh }, () => {
  // The flag is outside the watched folder, so only the process.log write can wake it.
  const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wait-flag-")), "flag");
  const r = ps(`Later "touch ${flag}; echo frame >> $data/process.log"; $t = Get-NowMs; Wait-Until 3 { Test-Path '${flag}' }; (Get-NowMs) - $t`);
  assert.strictEqual(r.lines[0], "True", r.err);
  assert.ok(Number(r.lines[1]) < 1500, `took ${r.lines[1]} ms: the watcher missed the subfolder`);
});

test("Windows: Get-SpriteAtRest allows 2 px of jitter, not drift", { skip: noPwsh }, () => {
  const frame = (x) => `Add-Content $t "1 frame: 1 Grounded pos(1,1) sprite(${x},20) idle#1 x"`;
  const r = ps(`$t = "$W/p.log"
${[10, 11, 12, 11, 10].map(frame).join("\n")}
(Get-SpriteAtRest $t).X
${[10, 12, 14, 16, 18].map(frame).join("\n")}
[bool](Get-SpriteAtRest $t)
${[10, 10, 10, 10, 13].map(frame).join("\n")}
[bool](Get-SpriteAtRest $t)
${[10, 10, 10, 10, 210].map(frame).join("\n")}
[bool](Get-SpriteAtRest $t)`);
  assert.deepStrictEqual(r.lines.slice(0, 4), ["10", "False", "False", "False"], r.err);
});
