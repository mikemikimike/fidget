// The verify-fidget launch and cleanup helpers, run as the skill runs them,
// against a stand-in Fidget. Launch returns once the overlay line lands and
// fails within 3 s when it never does; cleanup force-kills only a TERM ignorer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const helpers = path.join(import.meta.dirname, "..", ".agents", "skills", "verify-fidget", "helpers");

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(fake) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-helpers-"));
  roots.push(root);
  const bin = path.join(root, "fidget");
  fs.writeFileSync(bin, `#!/usr/bin/env bash\n${fake}\n`, { mode: 0o755 });
  return { root, env: { ...process.env, FIDGET_VERIFY_ROOT: root, FIDGET_VERIFY_BIN: bin } };
}

function helper(name, env) {
  const started = Date.now();
  const r = spawnSync("bash", [path.join(helpers, name)], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr, ms: Date.now() - started };
}

function pidOf(root) {
  return Number(fs.readFileSync(path.join(root, "scratch", "pids", "app.pid"), "utf8"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("launch is ready as soon as the overlay line is written", () => {
  const { root, env } = scratch('sleep 0.3; echo "overlay: overlay-0 covers 1x1 at (0,0)" >&2; exec sleep 30');
  const r = helper("launch.sh", env);
  const pid = pidOf(root);
  process.kill(pid, "SIGKILL");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ready \(overlay line\)/);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test("launch fails within 3 s when no overlay line ever comes", () => {
  const { root, env } = scratch("exec sleep 30");
  const r = helper("launch.sh", env);
  process.kill(pidOf(root), "SIGKILL");
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.ms >= 2800 && r.ms < 4500, `took ${r.ms} ms`);
});

test("launch fails at once when Fidget exits during startup", () => {
  const { env } = scratch("echo crashed >&2; exit 3");
  const r = helper("launch.sh", env);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /process exited/);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test("cleanup stops a Fidget that honours TERM without a force kill", () => {
  const { root, env } = scratch('echo "overlay: up" >&2; exec sleep 30');
  helper("launch.sh", env);
  const pid = pidOf(root);
  const r = helper("cleanup.sh", env);
  assert.equal(r.code, 0, r.out);
  assert.equal(alive(pid), false, "still running");
  assert.doesNotMatch(r.out, /kill -9/);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test("cleanup returns as soon as a Fidget that takes 0.5 s to stop has exited", () => {
  const { root, env } = scratch('trap \'sleep 0.5; kill "$s"; exit 0\' TERM; echo "overlay: up" >&2; sleep 30 & s=$!; wait "$s"');
  helper("launch.sh", env);
  const pid = pidOf(root);
  const r = helper("cleanup.sh", env);
  assert.equal(r.code, 0, r.out);
  assert.equal(alive(pid), false, "still running");
  assert.doesNotMatch(r.out, /kill -9/);
  assert.ok(r.ms >= 450 && r.ms < 1500, `took ${r.ms} ms`);
});

test("cleanup force-kills a Fidget that ignores TERM, after 3 s", () => {
  const { root, env } = scratch('trap "" TERM; echo "overlay: up" >&2; exec sleep 30');
  helper("launch.sh", env);
  const pid = pidOf(root);
  const r = helper("cleanup.sh", env);
  assert.equal(r.code, 0, r.out);
  assert.equal(alive(pid), false, "still running");
  assert.match(r.out, new RegExp(`kill -9 ${pid}`));
  assert.ok(r.ms >= 2800 && r.ms < 4500, `took ${r.ms} ms`);
});

test("cleanup stops Fidget and a child in its own session, promptly", () => {
  const { root, env } = scratch('setsid sleep 30 & echo $! > "$(dirname "$0")/child.pid"; echo "overlay: up" >&2; sleep 30 & wait $!');
  helper("launch.sh", env);
  const pid = pidOf(root);
  const child = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  const r = helper("cleanup.sh", env);
  const left = alive(child);
  if (left) process.kill(child, "SIGKILL");
  assert.equal(r.code, 0, r.out);
  assert.equal(alive(pid), false, "Fidget still running");
  assert.equal(left, false, "the child was left running");
  assert.doesNotMatch(r.out, /kill -9/);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test("cleanup force-kills at once when it has no way to watch the exit", () => {
  const { root, env } = scratch('trap "" TERM; echo "overlay: up" >&2; exec sleep 30');
  helper("launch.sh", env);
  const pid = pidOf(root);
  fs.rmSync(path.join(root, "scratch", "pids", "fidget.lock"), { force: true });
  const r = helper("cleanup.sh", env);
  assert.equal(r.code, 0, r.out);
  assert.equal(alive(pid), false, "still running");
  assert.match(r.out, new RegExp(`kill -9 ${pid}`));
  // macOS still watches the pid through caffeinate, so only Linux is immediate.
  if (process.platform === "linux") assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});
