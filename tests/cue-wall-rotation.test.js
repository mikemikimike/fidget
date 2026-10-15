// Where a landing puff ends up, through the real src/index.html and main.js in
// headless Chrome. Floor and wall take one path: flush against the surface,
// centred on the contact, lying along it.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const PROBE_MS = 3000;

const chrome = findChrome();

function harness(sprite, css) {
  const frame = {
    sprites: [
      {
        id: "test",
        character: "Buddy Bot",
        animation: "idle",
        frame_index: 0,
        x: 400,
        y: 300,
        width: 64,
        height: 64,
        mirror: 1,
        bubble: true,
        ...sprite,
      },
    ],
    visible: true,
    fade_ms: 0,
    sound: false,
  };
  return `
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  #stage { width: 100%; height: 100%; }
  ${css}
</style>
<script type="module">
  let heard;
  const listening = new Promise((resolve) => { heard = resolve; });
  window.__TAURI__ = {
    core: {
      invoke(name) {
        if (name === "character") return Promise.resolve({ characters: {} });
        return Promise.resolve();
      },
    },
    event: {
      listen(name, handler) {
        if (name === "frame") heard(handler);
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "overlay-test" }) },
  };
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
  const puffDrawn = new Promise((resolve) => {
    new MutationObserver((_, observer) => {
      const puff = document.querySelector(".cue-layer .cue-puff");
      if (!puff) return;
      observer.disconnect();
      resolve(puff);
    }).observe(document.body, { childList: true, subtree: true });
  });
  listening.then(async (onFrame) => {
    onFrame({ payload: ${JSON.stringify(frame)} });
    console.log("__PROBE_READY__");
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error("no puff within 3s")), ${PROBE_MS});
    });
    try {
      const puff = await Promise.race([puffDrawn, timeout]);
      clearTimeout(timerId);
      const [animation] = puff.getAnimations();
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration;
      const box = puff.getBoundingClientRect();
      const style = getComputedStyle(puff);
      const spread = parseFloat(style.getPropertyValue("--puff-shadow") || "0");
      console.log("__PROBE_RESULT__" + JSON.stringify({
        errors,
        found: true,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        shadow: spread * new DOMMatrix(style.transform).d,
      }));
    } catch (err) {
      clearTimeout(timerId);
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)], found: false, timeout: err.message }));
    }
  }).catch((err) => console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [String(err)], found: false, thrown: String(err) })));
</script>`;
}

async function launch(sprite, css = "") {
  const dir = mkdtempSync(join(tmpdir(), "cue-landing-"));
  const page = join(dir, "harness.html");
  const html = readFileSync(join(SRC, "index.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${harness(sprite, css)}`,
  );
  writeFileSync(page, html);

  const cdp = launchWithPipe(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${join(dir, "profile")}`,
    "--allow-file-access-from-files",
    "--window-size=800,600",
    `--virtual-time-budget=${PROBE_MS + 1000}`,
  ]);

  try {
    const { sessionId, navigate } = await createPageTarget(cdp);
    const result = await captureConsoleLog(
      cdp,
      sessionId,
      "__PROBE_RESULT__",
      PROBE_MS,
      () => navigate(pathToFileURL(page).href)
    );
    return result;
  } finally {
    await cleanupChrome(cdp);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// A 800x600 overlay. `gap` is from the surface to the puff's outer edge, shadow
// included; `drift` is along the surface from the contact to the puff's centre.
const SURFACES = {
  floor: {
    contact: { ripple_x: 400, ripple_y: 500, ripple_normal: { x: 0, y: -1 } },
    gap: (p) => 500 - (p.bottom + p.shadow),
    drift: (p) => (p.left + p.right) / 2 - 400,
    along: (p) => p.right - p.left > p.bottom - p.top,
  },
  "left wall": {
    contact: { ripple_x: 0, ripple_y: 150, ripple_normal: { x: 1, y: 0 } },
    gap: (p) => p.left - p.shadow - 0,
    drift: (p) => (p.top + p.bottom) / 2 - 150,
    along: (p) => p.bottom - p.top > p.right - p.left,
  },
  "right wall": {
    contact: { ripple_x: 800, ripple_y: 450, ripple_normal: { x: -1, y: 0 } },
    gap: (p) => 800 - (p.right + p.shadow),
    drift: (p) => (p.top + p.bottom) / 2 - 450,
    along: (p) => p.bottom - p.top > p.right - p.left,
  },
};

function assertLanded(puff, surface) {
  assert.deepEqual(puff.errors, [], "the overlay threw nothing");
  assert.ok(puff.found, `a puff was drawn: ${JSON.stringify(puff)}`);
  assert.ok(Math.abs(surface.gap(puff)) <= 0.01, `flush against the surface: ${surface.gap(puff)}px off`);
  assert.ok(Math.abs(surface.drift(puff)) <= 0.01, `centred on the contact: ${surface.drift(puff)}px off`);
  assert.ok(surface.along(puff), `lies along the surface: ${JSON.stringify(puff)}`);
}

const skip = chrome ? false : "headless Chromium is not installed";

for (const cue of ["drop", "throw"]) {
  for (const [name, surface] of Object.entries(SURFACES)) {
    test(`a ${cue} on the ${name} puffs flush against it, centred on the contact`, { skip }, async () => {
      assertLanded(await launch({ cue, ...surface.contact }), surface);
    });
  }
}

test("a landing the Shell sent no contact for puffs on the floor under the feet", { skip }, async () => {
  const puff = await launch({ cue: "drop", ripple_x: null, ripple_y: null, ripple_normal: null });
  assertLanded(puff, {
    gap: (p) => 364 - (p.bottom + p.shadow),
    drift: (p) => (p.left + p.right) / 2 - 432,
    along: SURFACES.floor.along,
  });
});

test("a same-tick landing beside the right edge below the Dock hits the wall, not the Dock", { skip }, async () => {
  const puff = await launch({ cue: "throw", ripple_x: 800, ripple_y: 560, ripple_normal: { x: -1, y: 0 } });
  const wallGap = 800 - (puff.right + puff.shadow);
  const verticalDrift = (puff.top + puff.bottom) / 2 - 560;
  assert.ok(Math.abs(wallGap) <= 0.01, `hits the wall at y=560: ${wallGap}px off, puff at ${JSON.stringify(puff)}`);
  assert.ok(Math.abs(verticalDrift) <= 0.01, `centred at y=560: ${verticalDrift}px off`);
  assert.ok(puff.bottom - puff.top > puff.right - puff.left, `vertical orientation confirms wall, not floor or Dock`);
});

test("a left wall puff near the top corner stays at the contact, not at y=0", { skip }, async () => {
  const puff = await launch({ cue: "drop", ripple_x: 0, ripple_y: 10, ripple_normal: { x: 1, y: 0 } });
  const drift = (puff.top + puff.bottom) / 2 - 10;
  assert.ok(Math.abs(drift) <= 0.01, `centred at y=10, not y=0: ${drift}px off, puff at ${JSON.stringify(puff)}`);
});

// The inset is measured from the stylesheet, so a restyled puff still lands flush.
const RESTYLES = {
  "a taller base": ".cue-puff { height: 20px !important; }",
  "a larger final scaleY": `
    @keyframes puff {
      from { transform: translate(-50%, -50%) scaleX(1) scaleY(0); }
      to { transform: translate(-50%, -50%) scaleX(4.6) scaleY(var(--puff-final-scale)); opacity: 0; }
    }
    .cue-puff { --puff-final-scale: 3; animation: puff 600ms ease-out forwards !important; }`,
  "a thicker shadow": ".cue-puff { box-shadow: 0 0 0 8px rgba(0, 0, 0, 0.15) !important; }",
  "a thicker border": ".cue-puff { border: 4px solid rgba(255, 255, 255, 0.3) !important; }",
};

for (const [restyle, css] of Object.entries(RESTYLES)) {
  for (const name of ["left wall", "right wall"]) {
    test(`a ${name} puff with ${restyle} still lands flush`, { skip }, async () => {
      const surface = SURFACES[name];
      assertLanded(await launch({ cue: "drop", ...surface.contact }, css), surface);
    });
  }
}
