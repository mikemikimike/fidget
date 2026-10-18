// A sign-in link a Harness hands over as a URL elicitation: Chat draws the
// link whole, and Open opens it before it tells the Harness yes. A link the
// Harness says is complete goes dead with nothing sent. Drives src/chat.html
// the way chat-landing-format.test.js does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const URL_ = "https://example.test/device?code=ABCD-1234";

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
  sign_in: [{ id: "chat-gpt-device-code", label: "ChatGPT device code" }],
  harness_name: "codex",
  instructions: "",
  personality: "",
  instance_prompt: "",
  prompt_limit: 2000,
};

const form = {
  request: "7",
  message: "Enter ABCD-1234 on the sign-in page.",
  field: "",
  options: [],
  url: URL_,
};

// Clicks Open, or with `settled` retires the row the way the Shell does on
// `elicitation/complete`: the settled event with no option.
function paint(settled = false) {
  const stub = `
<script type="module">
  ${pageWait()}
  const handlers = {};
  window.__invoked = [];
  window.__TAURI__ = {
    core: {
      invoke(name, args) {
        window.__invoked.push({ name, args });
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
    await until(() => !document.getElementById("landing").hidden);
    handlers["chat-elicitation"]({ payload: ${JSON.stringify(form)} });
    await until(() => document.querySelector(".row.ask"));
    const row = document.querySelector(".row.ask");
    const buttons = [...row.querySelectorAll("button")];
    const drawn = {
      code: [...row.querySelectorAll("code")].map((n) => n.textContent),
      buttons: buttons.map((b) => [b.textContent, b.dataset.option]),
      anchors: row.querySelectorAll("a").length,
    };
    const before = window.__invoked.length;
    if (${settled}) {
      handlers["chat-permission-settled"]({ payload: { request: "7", option: null } });
    } else {
      buttons.find((b) => b.textContent === "Open").click();
    }
    await until(() => buttons.every((b) => b.disabled));
    const calls = window.__invoked.slice(before);
    console.log("__PROBE_RESULT__" + JSON.stringify({
      ...drawn,
      calls,
      disabled: buttons.every((b) => b.disabled),
      chosen: row.querySelectorAll(".chosen").length,
    }));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html);
}

test("a sign-in link is drawn whole and Open opens it before answering yes", { skip: chromeSkip, timeout: 60000 }, async () => {
  const report = await paint();
  assert.deepEqual(report.code, [URL_]);
  assert.deepEqual(report.buttons, [
    ["Open", "open"],
    ["Decline", "decline"],
  ]);
  assert.equal(report.anchors, 0, "an <a href> would navigate the Chat webview");
  assert.deepEqual(report.calls, [
    { name: "open_link", args: { url: URL_ } },
    { name: "elicitation_answer", args: { request: "7", value: "open" } },
  ]);
  assert.equal(report.disabled, true);
});

test("a completed link goes dead with nothing chosen and nothing sent", { skip: chromeSkip, timeout: 60000 }, async () => {
  const report = await paint(true);
  assert.deepEqual(report.code, [URL_], "the row stays, so the log says what was asked");
  assert.equal(report.disabled, true);
  assert.equal(report.chosen, 0);
  assert.deepEqual(report.calls, []);
});
