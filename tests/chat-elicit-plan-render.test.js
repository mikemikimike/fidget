// An elicitation question and a plan step reach Chat with their lines and
// length. Drives src/chat.html as chat-elicit-link.test.js does and reads
// `innerText`, where a line break the CSS collapses reads as a space.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const chrome = findChrome();

const opening = {
  name: "BMO",
  character: "Buddy Bot",
  configured: true,
  enabled: true,
  harness: { name: "codex", session: null, alive: true, login: "codex login" },
  model: "",
  host: "",
  chat_ui: "minimal",
  login: "codex login",
  sign_in: [],
  harness_name: "codex",
  instructions: "",
  personality: "",
  instance_prompt: "",
  prompt_limit: 2000,
};

const LONG = "Pick the branch the release goes out from. ".repeat(20).trim();

const form = {
  request: "8",
  message: `Which branch?\n- main\n-\u202e release\n${LONG}`,
  field: "branch",
  options: [{ value: "main", name: "main" }],
  url: null,
};

const steps = [
  { content: `write the\npatch\u2066\n${LONG}`, status: "in_progress", priority: "high" },
];

function paint() {
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
    await ready("chat-elicitation");
    await ready("chat-plan");
    await until(() => !document.getElementById("landing").hidden);
    handlers["chat-elicitation"]({ payload: ${JSON.stringify(form)} });
    handlers["chat-plan"]({ payload: ${JSON.stringify(steps)} });
    await until(() => document.querySelector(".row.ask .said") && document.querySelector("#plan .step"));
    console.log("__PROBE_RESULT__" + JSON.stringify({
      question: document.querySelector(".row.ask .said").innerText,
      step: document.querySelector("#plan .step").innerText,
    }));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head><base href="${pathToFileURL(SRC).href}">${stub}`,
  );
  return probePage(html);
}

const skip = chrome ? false : "headless Chromium is not installed";

test("a question and a plan step are drawn whole, line by line, without unsafe characters", { skip, timeout: 60000 }, async () => {
  const report = await paint();
  assert.equal(report.question, `Which branch?\n- main\n- release\n${LONG}\nmain\nDecline`);
  assert.equal(report.step, `write the\npatch\n${LONG}`);
});
