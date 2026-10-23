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

// Node passes an undefined env value on as the string "undefined".
function session(display, wayland) {
  return {
    ...(display ? { DISPLAY: display } : {}),
    ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}),
  };
}

function probe({ display, wayland, running }) {
  const dir = mkdtempSync(join(tmpdir(), "bench-gpu-linux-"));
  const pids = {};
  const children = running.map(({ comm, display: own, serves }) => {
    const child = spawn(
      "bash",
      ["-c", "sleep 30; :", comm, ...(serves ? [serves] : [])],
      {
        env: { PATH: "/usr/bin:/bin", ...session(own) },
      },
    );
    (pids[comm] ??= []).push(child.pid);
    return child;
  });
  const table = Object.entries(pids)
    .map(
      ([comm, list]) => `${comm}) printf '%s\\n' ${list.join(" ")}; exit 0 ;;`,
    )
    .join("\n");
  stub(dir, "pgrep", `case "\${!#}" in\n${table}\nesac\nexit 1`);
  for (const tool of ["xrandr", "xdpyinfo", "glxinfo"])
    stub(dir, tool, "exit 0");
  // Its saved setting says on; a WM started with --compositor=off overrides it.
  stub(dir, "xfconf-query", "echo true");
  try {
    const result = spawnSync(
      "/bin/bash",
      [script, "env", "--out", join(dir, "out")],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          HOME: dir,
          ...session(display, wayland),
        },
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
    for (const child of children) child.kill();
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
        { comm: "Xvfb", display: ":1", serves: ":77" },
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
        { comm: "Xtigervnc", display: ":77", serves: ":1" },
      ],
    }),
    { compositor: "none", compositing: "false", x_server: "none" },
  );
});

test("an X server started from this display but serving another is not picked", () => {
  assert.deepEqual(
    probe({
      display: ":77",
      running: [
        { comm: "Xvfb", display: ":77", serves: ":78" },
        { comm: "Xorg", display: ":1", serves: ":77" },
      ],
    }),
    { compositor: "none", compositing: "false", x_server: "Xorg" },
  );
});

test("a Wayland session picks the compositor serving its socket, with no X server", () => {
  assert.deepEqual(
    probe({
      wayland: "wayland-77",
      running: [
        { comm: "weston", serves: "--socket=wayland-78" },
        { comm: "weston", serves: "--socket=wayland-77" },
        { comm: "Xvfb", display: ":1", serves: ":77" },
      ],
    }),
    { compositor: "weston", compositing: "true", x_server: "none" },
  );
});

test("xfwm4 started with --compositor=off is not compositing", () => {
  assert.deepEqual(
    probe({
      display: ":77",
      running: [{ comm: "xfwm4", display: ":77", serves: "--compositor=off" }],
    }),
    { compositor: "xfwm4", compositing: "false", x_server: "none" },
  );
});

test("picom over a window manager is the compositor", () => {
  assert.deepEqual(
    probe({
      display: ":77",
      running: [
        { comm: "xfwm4", display: ":77", serves: "--compositor=off" },
        { comm: "picom", display: ":77" },
      ],
    }),
    { compositor: "picom", compositing: "true", x_server: "none" },
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
echo "1792071672 frame: 1 Grounded pos(960,1200) sprite(897,1072) idle#0 id" >> "$log"
sleep 1
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

function walkingOver(hit) {
  const dir = mkdtempSync(join(tmpdir(), "bench-gpu-linux-"));
  const aim = join(dir, "aim");
  stub(
    dir,
    "xdotool",
    `[ "$1" = mousemove ] && echo "$2 $3" > "${aim}"; exit 0`,
  );
  stub(
    dir,
    "fakefid",
    `log="$XDG_DATA_HOME/fidget/process.log"
echo "1 overlay: 1 display(s); sprite 126x128; BMO as BMO" >> "$log"
while :; do
  echo "1 frame: 1 Grounded pos(163,328) sprite(100,200) walk#0 id" >> "$log"
  echo "1 frame: 1 Falling pos(1920,128) sprite(1857,0) react#0 id" >> "$log"
  if [ "${hit}" = 1 ] && grep -qx "163 264" "${aim}" 2> /dev/null; then
    echo "1 mask_rebuild: opaque" >> "$log"
  fi
  sleep 0.1
done`,
  );
  for (const tool of ["xrandr", "xdpyinfo", "glxinfo"])
    stub(dir, tool, "exit 0");
  stub(dir, "pgrep", "exit 1");
  const out = join(dir, "out");
  const result = spawnSync(
    "/bin/bash",
    [
      script,
      "walking",
      "--seconds",
      "1",
      "--bin",
      join(dir, "fakefid"),
      "--out",
      out,
    ],
    {
      encoding: "utf8",
      timeout: 60000,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, DISPLAY: ":99" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(join(out, "rows.tsv"), "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .find((row) => row[0] === "walking-over");
}

test("walking-over aims at a Grounded frame, not a later Falling one", () => {
  const row = walkingOver(1);
  assert.notEqual(row[3], "N/A", row.join(" "));
  assert.ok(Number(row[3]) > 0, row.join(" "));
  assert.match(row.at(-1), /163,264/);
});

test("walking-over with no mask_rebuild after the move reports pointer missed", () => {
  const row = walkingOver(0);
  assert.deepEqual(row.slice(0, 7), [
    "walking-over",
    "N/A",
    "none",
    "N/A",
    "N/A",
    "N/A",
    "N/A",
  ]);
  assert.match(row[7], /pointer missed/);
});

// A fake fidget that writes the overlay line and one idle frame on the floor,
// then the given lines; it runs the scenario under the given session.
function scenarioRow(scenario, name, { display, wayland, script: body = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "bench-gpu-linux-"));
  stub(
    dir,
    "fakefid",
    `log="$XDG_DATA_HOME/fidget/process.log"
echo "1 overlay: 1 display(s); sprite 126x128; BMO as BMO" >> "$log"
echo "1 frame: 1 Grounded pos(960,1200) sprite(897,1072) idle#0 id" >> "$log"
${body}
exec sleep 30`,
  );
  for (const tool of ["xrandr", "xdpyinfo", "glxinfo", "xdotool", "xfce4-terminal"])
    stub(dir, tool, "exit 0");
  stub(dir, "pgrep", "exit 1");
  const out = join(dir, "out");
  const result = spawnSync(
    "/bin/bash",
    [script, scenario, "--seconds", "1", "--bin", join(dir, "fakefid"), "--out", out],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...session(display, wayland) },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const row = readFileSync(join(out, "rows.tsv"), "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .find((cells) => cells[0] === name);
  assert.ok(row, `no ${name} row in ${out}/rows.tsv`);
  return row;
}

test("chat opens Chat through FIDGET_OPEN_CHAT and samples once it is open", () => {
  const row = scenarioRow("chat", "chat", {
    display: ":99",
    script: '[ "$FIDGET_OPEN_CHAT" = 1 ] && echo "1 chat: chat-1 is open" >> "$log"',
  });
  assert.equal(row[3], "0", row.join(" "));
  assert.match(row[7], /Chat open/);
});

test("away samples a Go-away launch once presence reads hidden", () => {
  const row = scenarioRow("away", "away", {
    display: ":99",
    script: `grep -q '"hidden": *true' "$XDG_DATA_HOME/fidget/settings.json" && echo "1 presence: hidden over 0ms" >> "$log"`,
  });
  assert.equal(row[3], "0", row.join(" "));
  assert.match(row[7], /Go away/);
});

test("on Wayland the mask rate is N/A: the input region is not wired there", () => {
  const row = scenarioRow("idle", "idle", { wayland: "wayland-99" });
  assert.deepEqual(row.slice(3, 5), ["N/A", "N/A"]);
  assert.match(row[7], /input region/);
});

test("on Wayland fullscreen hide and walking-over are N/A, citing ADR-0020", () => {
  for (const [scenario, name] of [
    ["hidden", "hidden"],
    ["walking", "walking-over"],
  ]) {
    const row = scenarioRow(scenario, name, {
      wayland: "wayland-99",
      script: 'echo "1 frame: 2 Grounded pos(960,1200) sprite(897,1072) walk#0 id" >> "$log"',
    });
    assert.equal(row[3], "N/A", row.join(" "));
    assert.match(row[7], /ADR-0020/);
  }
});
