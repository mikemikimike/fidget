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
  const script = `set -u\n. "${file}"\ndir="${dir}"\n${body}`;
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
  const r = run(`(sleep 0.15; : > "$dir/f") & wait_for_file 2 "$dir/f"`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
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
