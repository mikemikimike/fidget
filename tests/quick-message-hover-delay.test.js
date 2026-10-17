// The pill waits the hover delay the latest frame carries, so a Settings change
// lands on the next hover. Drives the real src/index.html and main.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, probePage } from "./chrome-cdp.js";
import { pageClock } from "./page-clock.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const chrome = findChrome();

const frame = (hoverDelayMs) => ({
  sprites: [
    {
      id: "bmo",
      character: "Buddy Bot",
      animation: "idle",
      frame_index: 0,
      x: 200,
      y: 200,
      width: 64,
      height: 64,
      mirror: 1,
      bubble: true,
    },
  ],
  visible: true,
  fade_ms: 0,
  sound: false,
  hover_delay_ms: hoverDelayMs,
});

function hover() {
  const stub = `
<script type="module">
  ${pageClock()}
  ${pageWait()}
  const handlers = {};
  window.__TAURI__ = {
    core: {
      invoke(name) {
        if (name === "character") return Promise.resolve({ characters: {} });
        return Promise.resolve();
      },
    },
    event: {
      listen(name, handler) {
        handlers[name] = handler;
        listeningNow(name);
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "overlay-test" }) },
  };
  async function drive() {
    console.log("__PROBE_READY__");
    await ready("frame");
    handlers.frame({ payload: ${JSON.stringify(frame(400))} });
    await settle();
    // The delay moves before the pointer arrives, as an Apply in Settings would.
    handlers.frame({ payload: ${JSON.stringify(frame(900))} });
    await settle();
    const quick = document.querySelector('.quick-message[data-instance="bmo"]');
    document.querySelector('.sprite[data-instance="bmo"]').dispatchEvent(new PointerEvent("pointerenter"));
    window.__advance(899);
    await settle();
    const before = quick.classList.contains("visible");
    window.__advance(1);
    await settle();
    console.log("__PROBE_RESULT__" + JSON.stringify({ before, after: quick.classList.contains("visible") }));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "index.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
  return probePage(html);
}

const skip = chrome ? false : "headless Chromium is not installed";

test("the pill opens after the hover delay the latest frame carries", { skip, timeout: 60000 }, async () => {
  const report = await hover();
  assert.deepEqual(report, { before: false, after: true });
});
