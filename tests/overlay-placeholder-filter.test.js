// The verify scripts find the overlay among windows of the app's own class.
// Placeholder windows share that class, so each filter must skip both
// placeholder sizes. Fake X tools and the PowerShell parser stand in for a display.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";
import { tempDir } from "./temp-path.js";

const scripts = path.join(import.meta.dirname, "..", "scripts");
const x11Lib = path.join(scripts, "lib", "x11.sh");
const winScript = path.join(scripts, "verify-settings-webview-phase2-win.ps1");

function bash(body, env = {}) {
  const out = spawnSync("bash", ["-c", `set -euo pipefail; source "$X11_LIB"; ${body}`], {
    env: { ...process.env, X11_LIB: x11Lib, ...env },
    encoding: "utf8",
  });
  return { status: out.status, stdout: out.stdout.trim(), stderr: out.stderr };
}

const gdkPlaceholders = bash('echo "${GDK_PLACEHOLDER_PX[@]}"').stdout.split(" ").map(Number);

// Writes xdotool, xprop and xwininfo that report `windows` in order.
function fakeX(t, windows) {
  const dir = tempDir(t, "x11-placeholder-");
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  write("xdotool", windows.map((w) => `echo ${w.id}`).join("\n"));
  const byId = (line) => `case "$2" in\n${windows.map((w) => `  ${w.id}) ${line(w)} ;;`).join("\n")}\nesac`;
  write("xprop", byId((w) => `echo 'WM_NAME(STRING) = "${w.name}"'`));
  write("xwininfo", byId((w) => `printf '  Width: %s\\n  Height: %s\\n' ${w.w} ${w.h}`));
  return `${dir}${path.delimiter}${process.env.PATH}`;
}

// The CI Xvfb screen; callers set the floor to half the root window.
const root = { w: 1920, h: 1080 };
const halfRoot = { MIN_OVERLAY_W: String(root.w / 2), MIN_OVERLAY_H: String(root.h / 2) };
const placeholderWindows = () => gdkPlaceholders.map((px, i) => ({ id: 100 + i, name: "Fidget", w: px, h: px }));

test("lib/x11.sh names both GDK placeholder sizes", () => {
  assert.deepEqual(gdkPlaceholders, [10, 200]);
});

test("find_overlay_window skips both placeholders for the display-sized overlay", (t) => {
  const PATH = fakeX(t, [...placeholderWindows(), { id: 300, name: "Fidget", ...root }]);
  const r = bash("find_overlay_window", { PATH, ...halfRoot });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "300");
});

test("find_overlay_window finds nothing when only placeholders exist", (t) => {
  const PATH = fakeX(t, placeholderWindows());
  const r = bash("find_overlay_window", { PATH, ...halfRoot });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
});

const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

// Loads $PlaceholderPx and Get-OverlayMinSize through the parser, so no
// Win32 call runs, then prints `body`'s output one value per line.
function pwsh(body) {
  const loader = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:WIN_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "parse errors: $($errors | Out-String)" }
$px = $ast.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$PlaceholderPx' }, $true)
Invoke-Expression $px.Extent.Text
$fn = $ast.Find({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Get-OverlayMinSize' }, $true)
Invoke-Expression $fn.Extent.Text
${body}`;
  const out = spawnSync(resolved.command, [...(resolved.args ?? []), "-NoProfile", "-NonInteractive", "-Command", loader], {
    env: { ...process.env, WIN_SCRIPT: winScript, TERM: "dumb" },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/).map(Number);
}

test("the Windows script names both Tauri placeholder sizes", { skip }, () => {
  assert.deepEqual(pwsh("$PlaceholderPx"), [10, 200]);
});

for (const monitor of [
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`the overlay floor on ${monitor.width}x${monitor.height} is above both placeholders`, { skip }, () => {
    const [minW, minH, ...placeholders] = pwsh(
      `$m = Get-OverlayMinSize @(@{ width = ${monitor.width}; height = ${monitor.height} }); $m.width; $m.height; $PlaceholderPx`,
    );
    for (const px of placeholders) {
      assert.ok(px < minW && px < minH, `${px}x${px} placeholder passes a ${minW}x${minH} floor`);
    }
    assert.ok(monitor.width >= minW && monitor.height >= minH, "the display-sized overlay is below the floor");
  });
}
