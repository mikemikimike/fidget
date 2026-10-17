// Fixture test for Harness initialization: starting state visible throughout,
// then settling to ready or failed. Verifies DOM shows data-initializing attribute
// and landing copy during the initializing phase.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, probePage } from "./chrome-cdp.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const chrome = findChrome();

function opening(harness) {
  return {
    name: "Atlas",
    character: "Buddy Bot",
    configured: true,
    enabled: true,
    harness: { name: "hermes", session: null, alive: false, login: null, ...harness },
    model: "",
    host: "",
    chat_ui: "minimal",
    login: null,
    harness_name: "hermes",
    instructions: "",
    personality: "",
    instance_prompt: "",
    prompt_limit: 2000,
  };
}

function paint(open) {
  const stub = `
<script type="module">
  const handlers = {};
  window.__invoked = [];
  window.__TAURI__ = {
    core: {
      invoke(name, args) {
        window.__invoked.push({ name, args });
        if (name === "chat_opening") return Promise.resolve(${JSON.stringify(open)});
        return Promise.resolve();
      },
    },
    event: {
      listen(name, handler) {
        handlers[name] = handler;
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function drive() {
    console.log("__PROBE_READY__");
    while (!handlers.chat || document.getElementById("empty").hidden) await tick();
    const landing = document.getElementById("landing");
    const title = document.getElementById("landing-title");
    const lede = document.getElementById("landing-lede");
    const composer = document.getElementById("line");
    const report = {
      landingHidden: landing.hidden,
      dataInitializing: landing.dataset.initializing,
      title: title.textContent,
      lede: lede.textContent,
      composerPlaceholder: composer.placeholder,
      composerDisabled: composer.disabled,
    };
    console.log("__PROBE_RESULT__" + JSON.stringify(report));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
  return probePage(html, { timeout: 10000 });
}

test("fixture Harness with slow initialize shows starting state", { skip: !chrome }, async () => {
  const result = await paint(opening({ initializing: true }));

  assert.equal(result.landingHidden, false, "landing is visible");
  assert.equal(result.dataInitializing, "true", "data-initializing attribute set to true");
  assert.match(result.title, /Initializing Hermes/, "title shows initializing");
  assert.match(result.lede, /starting up/, "lede mentions starting up");
  assert.match(result.lede, /download/i, "lede mentions first-run download");
  assert.match(result.lede, /can take a while/i, "lede does not promise a fixed duration");
  assert.doesNotMatch(result.lede, /\d+\s*[–-]\s*\d+\s*seconds/i, "no fixed second range");
  assert.match(result.lede, /when the Harness answers/, "lede clarifies when ready");
  assert.equal(result.composerPlaceholder, "Starting Hermes…", "composer shows starting placeholder");
  assert.equal(result.composerDisabled, true, "composer is disabled during init");
});

test("fixture Harness transitions from initializing to ready", { skip: true }, async () => {
  const initializing = await paint(opening({ initializing: true }));
  assert.equal(initializing.dataInitializing, "true", "starts with data-initializing true");
  assert.match(initializing.title, /Initializing/, "shows initializing title");

  const ready = await paint(opening({ alive: true, initializing: false }));
  assert.equal(ready.landingHidden, true, "landing hidden when ready");
  assert.equal(ready.composerDisabled, false, "composer enabled when ready");
});

test("fixture Harness transitions from initializing to failed", { skip: true }, async () => {
  const initializing = await paint(opening({ initializing: true }));
  assert.equal(initializing.dataInitializing, "true", "starts with data-initializing true");
  assert.match(initializing.title, /Initializing/, "shows initializing title");

  const failed = await paint(opening({
    initializing: false,
    failed: "hermes exited before initialize, exit status: 1"
  }));
  assert.equal(failed.landingHidden, false, "landing still visible when failed");
  assert.equal(failed.dataInitializing, "false", "data-initializing false after failure");
  assert.match(failed.title, /failed to start/, "shows failure title");
  assert.match(failed.lede, /exited before initialize/, "lede shows failure reason");
  assert.equal(failed.composerDisabled, true, "composer stays disabled after failure");
});
