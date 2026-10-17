// What the overlay tells the Shell it draws outside the art. Windows keeps every
// rect in the window's region so none is clipped, and the frame loop takes a
// click only over the clickable ones. Drives the real src/index.html and main.js.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function chromeBin() {
  if (process.env.FIDGET_CHROME) {
    return process.env.FIDGET_CHROME;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    const path = found.stdout.trim();
    if (found.status === 0 && path) {
      return path;
    }
  }
  return null;
}

const chrome = chromeBin();

const sprite = (id, x, extra) => ({
  id,
  character: "Buddy Bot",
  animation: "idle",
  frame_index: 0,
  x,
  y: 400,
  width: 64,
  height: 64,
  mirror: 1,
  bubble: true,
  ...extra,
});

// Long enough to truncate, which is what puts "Open chat" in the bubble.
const longLine = "word ".repeat(200).trim();

const frame = {
  sprites: [
    sprite("talker", 100, { dialogue: longLine }),
    sprite("thinker", 600, { thinking: true }),
    sprite("idler", 1000),
  ],
  visible: true,
  fade_ms: 0,
  sound: false,
};

// Every bubble moved to another display's overlay.
const handedOff = {
  ...frame,
  sprites: frame.sprites.map(({ dialogue, thinking, ...rest }) => ({ ...rest, bubble: false })),
};

// One launch for every test here: a headless Chrome start is most of the cost.
let probe = null;

function drive() {
  probe ??= launch();
  return probe;
}

function launch() {
  const stub = `
<script type="module">
  const handlers = {};
  // Event-driven: each wait resolves on the invoke or listen it is waiting
  // for, never on a timer. The bubbles show over a few frames after the pill,
  // so the probe waits for the report that holds every rect, not for the pill.
  const waiters = [];
  const until = (ready) =>
    new Promise((resolve) => {
      const check = () => (ready() ? (resolve(), true) : false);
      if (!check()) waiters.push(check);
    });
  const wake = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) if (waiters[i]()) waiters.splice(i, 1);
  };
  // Headless Chrome under --virtual-time-budget does not always deliver a
  // display frame: a requestAnimationFrame can stay pending until the budget
  // runs out, so draw() never runs, no bubble shows, and only the pill (placed
  // outside draw) is reported. Drive frames from a virtual 60 Hz clock, which
  // virtual time always advances, so every arm() is drawn.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.__invoked = [];
  window.__TAURI__ = {
    core: {
      invoke(name, args) {
        window.__invoked.push({ name, args: structuredClone(args) });
        queueMicrotask(wake);
        if (name === "character") return Promise.resolve({ characters: {} });
        if (name === "overlay_hit_tests_hotspots") return Promise.resolve(true);
        return Promise.resolve();
      },
    },
    event: {
      listen(name, handler) {
        handlers[name] = handler;
        queueMicrotask(wake);
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "overlay-test" }) },
  };
  const box = (el, tail = 0) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height) + tail];
  };
  const rects = () => window.__invoked.filter((c) => c.name === "overlay_rects").map((c) => c.args.rects);
  const last = () => rects().at(-1) ?? null;
  const has = (instance, clickable) => (last() ?? []).some((r) => r.follows?.instance === instance && r.clickable === clickable);
  async function drive() {
    await until(() => handlers.frame);
    handlers.frame({ payload: ${JSON.stringify(frame)} });
    const quick = document.querySelector('.quick-message[data-instance="idler"]');
    document.querySelector('.sprite[data-instance="idler"]').dispatchEvent(new PointerEvent("pointerenter"));
    // Open chat, the speech, the dots and the pill: four rects, all reported.
    await until(() => has("talker", true) && has("talker", false) && has("thinker", false) && has("idler", true));
    const bubble = (id) => document.querySelector('.bubble:not(.quick-message)[data-instance="' + id + '"]');
    const reported = last();
    const expected = {
      openChat: box(bubble("talker").querySelector(".bubble-more")),
      speech: box(bubble("talker"), 10),
      dots: box(bubble("thinker"), 10),
      pill: box(quick),
    };
    handlers.frame({ payload: ${JSON.stringify(handedOff)} });
    await until(() => last()?.length === 0);
    const out = document.createElement("pre");
    out.id = "probe";
    out.textContent = JSON.stringify({
      reported,
      expected,
      handedOff: last(),
      sent: rects().map((r) => JSON.stringify(r)),
    });
    document.body.append(out);
  }
  window.addEventListener("load", drive);
</script>`;

  const dir = mkdtempSync(join(tmpdir(), "overlay-rects-"));
  const page = join(dir, "harness.html");
  const html = readFileSync(join(SRC, "index.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
  writeFileSync(page, html);

  const run = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${join(dir, "profile")}`,
      "--allow-file-access-from-files",
      "--window-size=1400,900",
      "--virtual-time-budget=8000",
      "--dump-dom",
      pathToFileURL(page).href,
    ],
    { encoding: "utf8", maxBuffer: 1 << 24, timeout: 40000, killSignal: "SIGKILL" },
  );
  const match = run.stdout.match(/<pre id="probe"[^>]*>(.*?)<\/pre>/s);
  assert.ok(match, `the overlay did not report. ${run.stderr?.slice(-500) ?? ""}`);
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

const skip = chrome ? false : "headless Chromium is not installed";

test("Open chat and the pill take clicks; the bubble and its dots are only drawn", { skip, timeout: 60000 }, () => {
  const { reported, expected } = drive();
  assert.ok(reported, "the overlay reported its rects");
  // Each names the sprite it rides with and where that sprite was, so the
  // Shell can keep it in the region while a drag moves the sprite (#1568).
  const rows = [
    ["Open chat", expected.openChat, true, { instance: "talker", at: [100, 400] }],
    ["the quick pill", expected.pill, true, { instance: "idler", at: [1000, 400] }],
    ["a line of speech", expected.speech, false, { instance: "talker", at: [100, 400] }],
    ["the thinking dots", expected.dots, false, { instance: "thinker", at: [600, 400] }],
  ];
  for (const [name, rect, clickable, follows] of rows) {
    const want = JSON.stringify({ rect, clickable, follows });
    assert.ok(
      reported.some((r) => JSON.stringify(r) === want),
      `${name}: want ${want} in ${JSON.stringify(reported)}`,
    );
  }
  assert.equal(reported.length, rows.length, "nothing else is reported");
});

test("an overlay that hands its bubbles on clears its rects, and only a change is sent", { skip, timeout: 60000 }, () => {
  const { handedOff, sent } = drive();
  assert.deepEqual(handedOff, [], "an empty list clears");
  const repeats = sent.filter((rects, i) => i > 0 && rects === sent[i - 1]);
  assert.deepEqual(repeats, [], "no report repeats the one before it");
});
