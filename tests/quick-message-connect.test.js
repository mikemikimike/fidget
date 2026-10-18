// The unavailable pill's Open chat link opens Chat and is not a Poke. Drives the
// real src/index.html and main.js the way chat-elicit-link.test.js drives Chat.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageClock } from "./page-clock.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// Nothing configured, so nothing can answer and nothing is starting.
const opening = { configured: false, enabled: true, harness: null, login: "" };

const frame = {
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
  hover_delay_ms: 1500,
};

function press() {
  const stub = `
<script type="module">
  ${pageClock()}
  ${pageWait()}
  const handlers = {};
  window.__invoked = [];
  window.__TAURI__ = {
    core: {
      invoke(name, args) {
        window.__invoked.push({ name, args });
        if (name === "character") return Promise.resolve({ characters: {} });
        if (name === "overlay_hit_tests_hotspots") return Promise.resolve(true);
        if (name === "chat_opening") return Promise.resolve(${JSON.stringify(opening)});
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
    handlers.frame({ payload: ${JSON.stringify(frame)} });
    await settle();
    const quick = document.querySelector('.quick-message[data-instance="bmo"]');
    document.querySelector('.sprite[data-instance="bmo"]').dispatchEvent(new PointerEvent("pointerenter"));
    await until(() => quick.classList.contains("visible"));
    const link = quick.querySelector(".quick-message-connect");
    const openChat = link.querySelector(".quick-message-open");
    const send = quick.querySelector(".quick-message-send");
    const shown = {
      hint: link.firstChild.textContent.trim(),
      control: openChat.textContent,
      linkShown: !link.hidden,
      sendShown: !send.hidden && getComputedStyle(send).display !== "none",
      oneLine: Math.abs(openChat.getBoundingClientRect().top - link.getBoundingClientRect().top) < 2,
    };
    const before = window.__invoked.length;
    const at = { bubbles: true, button: 0, pointerId: 1, isPrimary: true };
    openChat.dispatchEvent(new PointerEvent("pointerdown", at));
    openChat.dispatchEvent(new PointerEvent("pointerup", at));
    openChat.click();
    await until(() => !quick.classList.contains("visible"));
    console.log("__PROBE_RESULT__" + JSON.stringify({
      ...shown,
      clicks: window.__invoked
        .slice(before)
        .filter((c) => ["overlay_primary", "overlay_secondary", "overlay_open_chat"].includes(c.name)),
      open: quick.classList.contains("visible"),
    }));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "index.html"), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html);
}

test("a click on Open chat opens Chat, closes the pill, and is no Poke", { skip: chromeSkip, timeout: 60000 }, async () => {
  const report = await press();
  assert.equal(report.hint, "No AI connected yet.");
  assert.equal(report.control, "Open chat");
  assert.equal(report.oneLine, true, "the hint and Open chat share one line");
  assert.equal(report.linkShown, true);
  assert.equal(report.sendShown, false, "Send is hidden while the link is up");
  assert.deepEqual(report.clicks, [{ name: "overlay_open_chat", args: { id: "bmo" } }]);
  assert.equal(report.open, false);
});
