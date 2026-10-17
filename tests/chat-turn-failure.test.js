// A turn the Harness failed reads as a Harness error, with the Harness's own
// words boxed, and not as a bare note. Drives src/chat.html the way
// chat-reply-code.test.js does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// What grok answered every `session/prompt` with once its balance ran out,
// as `acp_wire::error_text` renders it.
const BALANCE_EXHAUSTED =
  "Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted";
const TIMEOUT = "harness turn exceeded 60s; cancelled";

const chrome = findChrome();

function turnFailurePage(payloads) {
  const opening = {
    name: "BMO",
    character: "Buddy Bot",
    configured: true,
    enabled: true,
    harness: { name: "grok", alive: true, missing: null, initializing: false, login: null },
    model: "",
    host: "",
    chat_ui: "minimal",
    login: null,
    harness_name: "grok",
    instructions: "",
    personality: "",
    instance_prompt: "",
    prompt_limit: 2000,
  };
  const stub = `
<script type="module">
  ${pageWait()}
  const handlers = {};
  window.__TAURI__ = {
    core: {
      invoke(name) {
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
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  async function drive() {
    console.log("__PROBE_READY__");
    for (const payload of ${JSON.stringify(payloads)}) {
      await ready("chat");
      await until(() => !document.getElementById("line").disabled);
      const asked = document.querySelectorAll("#log .row.you").length;
      document.getElementById("line").value = "are you there?";
      document.getElementById("composer").requestSubmit();
      await until(() => document.querySelectorAll("#log .row.you").length !== asked);
      handlers.chat({
        payload: { said: null, busy: false, reacting_to: null, you: false, at: null, ...payload },
      });
      await settle();
    }
    const log = document.getElementById("log");
    const failed = log.querySelector(".harness-error");
    const report = {
      notes: [...log.querySelectorAll(".note:not(.harness-error)")].map((n) => n.lastChild.textContent),
      kicker: failed?.querySelector(".kicker")?.textContent ?? null,
      title: failed?.querySelector("h2")?.textContent ?? null,
      lede: failed?.querySelector("p:not(.kicker)")?.textContent ?? null,
      label: failed?.querySelector(".failure-part h3")?.textContent ?? null,
      box: failed?.querySelector("pre.failure-box.error")?.textContent ?? null,
      boxFont: failed ? getComputedStyle(failed.querySelector("pre")).fontFamily : null,
      sideways: Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        log.scrollWidth - log.clientWidth,
      ),
    };
    console.log("__PROBE_RESULT__" + JSON.stringify(report));
  }
  window.addEventListener("load", drive);
</script>`;
  return readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
}

function paint(payloads, width) {
  return probePage(turnFailurePage(payloads), { args: [`--window-size=${width},560`] });
}

const skip = chrome ? false : "headless Chromium is not installed";

test("a turn the Harness failed shows its words in a Harness error box", { skip, timeout: 90000 }, async () => {
  // The narrowest Chat, where a long unbroken error would push it sideways.
  const report = await paint([{ error: BALANCE_EXHAUSTED, failure: BALANCE_EXHAUSTED }], 320);
  assert.equal(report.kicker, "Harness error");
  assert.equal(report.title, "Grok couldn't answer");
  assert.equal(report.lede, "It sent back an error instead of a reply:");
  assert.equal(report.label, "Error output");
  assert.equal(report.box, BALANCE_EXHAUSTED);
  assert.match(report.boxFont, /mono/i);
  assert.deepEqual(report.notes, [], "the error is not also a note");
  assert.equal(report.sideways, 0, "the box pushed Chat sideways");
});

test("an error the Shell names stays a note", { skip, timeout: 90000 }, async () => {
  const report = await paint([{ error: TIMEOUT }], 420);
  assert.deepEqual(report.notes, [TIMEOUT]);
  assert.equal(report.kicker, null);
});
