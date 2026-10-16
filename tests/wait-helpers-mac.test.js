// The macOS scenario wait helpers return as soon as their event shows up and
// give up within the seconds they are given, so a live check takes seconds.
// They are plain bash with BSD-safe tools, so they run here on Linux too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const helper = path.join(import.meta.dirname, "..", "scripts", "scenarios", "wait-helpers.mac.sh");

function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-mac-"));
  const script = `set -u\n. "${helper}"\ndir="${dir}"\n${body}`;
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

test("wait_for_count needs one more line than before the trigger", () => {
  const r = run(`echo minimized > "$dir/t"; before=$(line_count "$dir/t" '^minimized$')
(sleep 0.15; echo minimized >> "$dir/t") & wait_for_count 2 "$dir/t" '^minimized$' "$before"`);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
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

test("seed_tour_shown marks the first-run tour as shown", () => {
  const r = run(`seed_tour_shown "$dir/home"; grep -q '"first_run_tour_shown": true' "$dir/home/Library/Application Support/fidget/settings.json"`);
  assert.strictEqual(r.code, 0, r.out);
});
