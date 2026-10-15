import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "bench-gpu-compositing-linux.sh",
);

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function probe({ display, running }) {
  const dir = mkdtempSync(join(tmpdir(), "bench-gpu-linux-"));
  const children = running.map(({ comm, display: own }) => ({
    comm,
    child: spawn("sleep", ["30"], {
      env: { PATH: "/usr/bin:/bin", DISPLAY: own },
    }),
  }));
  const table = children
    .map(({ comm, child }) => `${comm}) echo ${child.pid}; exit 0 ;;`)
    .join("\n");
  stub(dir, "pgrep", `case "\${!#}" in\n${table}\nesac\nexit 1`);
  for (const tool of ["xrandr", "xdpyinfo", "glxinfo"])
    stub(dir, tool, "exit 0");
  try {
    const result = spawnSync(
      "/bin/bash",
      [script, "env", "--out", join(dir, "out")],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, DISPLAY: display },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      result.stdout
        .split("\n")
        .filter((line) => /^(compositor|compositing|x_server)=/.test(line))
        .map((line) => line.split("=")),
    );
  } finally {
    for (const { child } of children) child.kill();
  }
}

test("no compositor on this display reports compositing false", () => {
  assert.deepEqual(probe({ display: ":77", running: [] }), {
    compositor: "none",
    compositing: "false",
    x_server: "none",
  });
});

test("picom and Xvfb on this display are picked up, with compositing true", () => {
  assert.deepEqual(
    probe({
      display: ":77",
      running: [
        { comm: "picom", display: ":77" },
        { comm: "Xvfb", display: ":77" },
      ],
    }),
    { compositor: "picom", compositing: "true", x_server: "Xvfb" },
  );
});

test("a compositor and X server serving another display are ignored", () => {
  assert.deepEqual(
    probe({
      display: ":77",
      running: [
        { comm: "mutter", display: ":1" },
        { comm: "Xtigervnc", display: ":1" },
      ],
    }),
    { compositor: "none", compositing: "false", x_server: "none" },
  );
});

test("idle reads mask_rebuild lines the app writes to process.log", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-gpu-linux-"));
  const bin = join(dir, "fakefid");
  stub(
    dir,
    "fakefid",
    `log="$XDG_DATA_HOME/fidget/process.log"
echo "1792071672 overlay: 1 display(s); sprite 126x128; BMO as BMO" >> "$log"
sleep 4.5
for _ in 1 2 3 4; do echo "1792071675 mask_rebuild: opaque" >> "$log"; done
exec sleep 30`,
  );
  stub(dir, "pgrep", "exit 1");
  const out = join(dir, "out");
  const result = spawnSync(
    "/bin/bash",
    [script, "idle", "--seconds", "3", "--bin", bin, "--out", out],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const idle = readFileSync(join(out, "rows.tsv"), "utf8")
    .split("\n")[1]
    .split("\t");
  assert.deepEqual(idle.slice(0, 5), ["idle", "N/A", "none", "4", "1.33"]);
});
