// The phase line on the open answer. The reducer tests never paint the row
// or run its stall timer, so this drives chat.html the way
// chat-thinking-render.test.js drives a turn.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, probePage } from "./chrome-cdp.js";

import { STALL_MS } from "../src/turn-phase.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const chrome = findChrome();

const OPENING = {
  name: "Buddy Bot",
  character: "Buddy Bot",
  configured: true,
  enabled: true,
  harness: { name: "claude", session: "fd4be1a2", alive: true, missing: false, initializing: false, login: null },
  model: "",
  host: "",
  chat_ui: "minimal",
  login: null,
  harness_name: "claude",
  instructions: "",
  personality: "",
  instance_prompt: "",
  prompt_limit: 2000,
};

function drive() {
  const stub = `
<script>
  const realSetTimeout = window.setTimeout.bind(window);
  const timers = new Map();
  let now = 0;
  let nextId = 1;
  Date.now = () => now;
  window.setTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.__advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let dueId = null;
      let due = null;
      for (const [id, item] of timers) {
        if (item.at <= target && (!due || item.at < due.at)) {
          dueId = id;
          due = item;
        }
      }
      if (!due) break;
      timers.delete(dueId);
      now = due.at;
      due.fn();
    }
    now = target;
  };
  const heard = {};
  window.__TAURI__ = {
    core: {
      invoke(name) {
        if (name === "chat_opening") return Promise.resolve(${JSON.stringify(OPENING)});
        return Promise.resolve();
      },
    },
    event: {
      listen(name, handler) {
        heard[name] = handler;
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  const tick = () => new Promise((r) => realSetTimeout(r, 0));
  const emit = (name, payload) => heard[name]({ payload });
  function phase() {
    const node = document.querySelector(".row.them .phase");
    return {
      text: node ? node.textContent : null,
      under: Boolean(node && node.parentElement.classList.contains("them") && !node.closest(".said")),
    };
  }
  async function run() {
    console.log("__PROBE_READY__");
    while (!heard.chat || !heard["chat-tool"] || !heard["chat-heard"]) await tick();
    while (document.getElementById("line").disabled) await tick();
    const report = {};
    emit("chat", { you: true, said: "read the roster", busy: false, reacting_to: null, thought: false, at: null, error: null });
    emit("chat-tool", { id: "t1", title: "Read file", status: "in_progress" });
    report.running = phase();
    window.__advance(${STALL_MS});
    report.stall = phase();
    emit("chat-heard", null);
    report.cleared = phase();
    emit("chat", { said: "Done.", busy: false, reacting_to: null, you: false, thought: false, at: null, error: null, streaming: false });
    report.settled = phase();
    console.log("__PROBE_RESULT__" + JSON.stringify(report));
  }
  window.addEventListener("load", () => run().catch((why) => {
    console.log("__PROBE_RESULT__" + JSON.stringify({ error: String(why) }));
  }));
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
  return probePage(html, { args: ["--window-size=420,560"], timeout: 10000 });
}

test(
  "the phase line sits under the open answer, stalls, clears, and leaves with the turn",
  { skip: chrome ? false : "headless Chromium is not installed", timeout: 60000 },
  async () => {
    const report = await drive();
    assert.equal(report.error, undefined, report.error);
    const stall = `No news for ${STALL_MS / 1000}s`;
    assert.deepEqual(report.running, { text: "Running: Read file", under: true });
    assert.deepEqual(report.stall, { text: stall, under: true });
    assert.deepEqual(report.cleared, { text: "Running: Read file", under: true });
    assert.deepEqual(report.settled, { text: null, under: false });
  },
);
