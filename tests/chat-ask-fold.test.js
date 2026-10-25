// An ask is a fold: open while it waits, shut once the Shell settles it, with
// what was asked and what won in its handle. Opening it again shows the
// question and choices that can no longer be pressed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function opening(theme) {
  return {
    name: "BMO",
    character: "Buddy Bot",
    configured: true,
    enabled: true,
    harness: { alive: true, missing: false, initializing: false },
    model: "",
    host: "",
    chat_ui: theme,
    login: null,
    harness_name: "cursor-agent",
    instructions: "",
    personality: "",
    instance_prompt: "",
    prompt_limit: 2000,
  };
}

const PERMISSION = {
  request: "5",
  title: "Run `ls -la`\nin the home folder",
  kind: "execute",
  content: ["Shell allowlist is empty"],
  input: null,
  locations: [],
  options: [
    { id: "allow-once", name: "Allow once", kind: "allow_once" },
    { id: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};

const FORM = {
  request: "6",
  message: "Which branch?\nPick one to check out.",
  field: "branch",
  options: [
    { name: "main", value: "main" },
    { name: "dev", value: "dev" },
  ],
  url: null,
};

const CANCELLED = { ...PERMISSION, request: "7", title: "Delete build/" };

function surface(theme) {
  const stub = `
<script type="module">
  ${pageWait()}
  const handlers = {};
  window.__invoked = [];
  window.__TAURI__ = {
    core: {
      invoke(name, args) {
        window.__invoked.push({ name, args });
        if (name === "chat_opening") return Promise.resolve(${JSON.stringify(opening(theme))});
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
  const answers = () => window.__invoked.filter((call) => call.name.endsWith("_answer"));
  function look(row) {
    const toggle = row.querySelector(".thinking-toggle");
    const choices = [...row.querySelectorAll(".options button")];
    return {
      handle: toggle.textContent,
      expanded: toggle.getAttribute("aria-expanded"),
      shown: getComputedStyle(row.querySelector(".said")).display !== "none",
      toggleLooksLikeAChoice: getComputedStyle(toggle).borderTopStyle !== "none",
      choices: choices.map((b) => ({
        name: b.textContent,
        disabled: b.disabled,
        ariaDisabled: b.getAttribute("aria-disabled"),
        chosen: b.classList.contains("chosen"),
      })),
      dim: Number(getComputedStyle(row.querySelector(".options")).opacity),
    };
  }
  async function drive() {
    console.log("__PROBE_READY__");
    await ready("chat-permission-settled");
    await until(() => !document.getElementById("line").disabled);

    handlers["chat-permission"]({ payload: ${JSON.stringify(PERMISSION)} });
    await until(() => document.querySelector('#log .row.ask [data-option="allow-once"]'));
    const row = document.querySelector("#log .row.ask");
    const pending = look(row);
    const allow = row.querySelector('[data-option="allow-once"]');
    allow.focus();
    allow.click();
    await until(() => answers().length === 1);
    const sent = look(row);
    const focusOnHandle = document.activeElement === row.querySelector(".thinking-toggle");
    handlers["chat-permission-settled"]({ payload: { request: "5", option: "allow-once" } });
    await until(() => row.querySelector(".thinking-toggle").getAttribute("aria-expanded") === "false");
    const answered = look(row);
    row.querySelector(".thinking-toggle").click();
    await until(() => row.querySelector(".thinking-toggle").getAttribute("aria-expanded") === "true");
    const reopened = look(row);
    for (const button of row.querySelectorAll(".options button")) button.click();
    await settle();
    const calls = answers();

    handlers["chat-elicitation"]({ payload: ${JSON.stringify(FORM)} });
    await until(() => document.querySelectorAll("#log .row.ask").length === 2);
    const formRow = document.querySelectorAll("#log .row.ask")[1];
    formRow.querySelector('[data-option="dev"]').click();
    handlers["chat-permission-settled"]({ payload: { request: "6", option: "dev" } });
    await until(() => formRow.querySelector(".thinking-toggle").getAttribute("aria-expanded") === "false");
    const form = look(formRow);

    handlers["chat-permission"]({ payload: ${JSON.stringify(CANCELLED)} });
    await until(() => document.querySelectorAll("#log .row.ask").length === 3);
    const goneRow = document.querySelectorAll("#log .row.ask")[2];
    handlers["chat-permission-settled"]({ payload: { request: "7", option: null } });
    await until(() => goneRow.querySelector(".thinking-toggle").getAttribute("aria-expanded") === "false");
    const cancelled = look(goneRow);

    console.log("__PROBE_RESULT__" + JSON.stringify({
      pending, sent, focusOnHandle, answered, reopened, calls, form, cancelled,
    }));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace("<head>", `<head>${stub}`);
  return probePage(html, { args: ["--force-dark-mode"] });
}

const OPEN = [
  { name: "Allow once", disabled: false, ariaDisabled: null, chosen: false },
  { name: "Reject", disabled: false, ariaDisabled: null, chosen: false },
];
const SETTLED = [
  { name: "Allow once", disabled: true, ariaDisabled: "true", chosen: true },
  { name: "Reject", disabled: true, ariaDisabled: "true", chosen: false },
];

for (const theme of ["minimal", "terminal", "glass"]) {
  test(`${theme}: an ask folds shut once answered, and its choices go dead`, { skip: chromeSkip, timeout: 60000 }, async () => {
    const report = await surface(theme);

    assert.equal(report.pending.handle, "BMO · asks");
    assert.equal(report.pending.expanded, "true");
    assert.equal(report.pending.shown, true);
    assert.equal(report.pending.toggleLooksLikeAChoice, false, "the fold handle is painted as an answer button");
    assert.deepEqual(report.pending.choices, OPEN);
    assert.equal(report.pending.dim, 1);

    assert.equal(report.sent.expanded, "true", "the row stays open until the Shell says what won");
    assert.equal(report.sent.choices.every((choice) => choice.disabled), true);
    assert.equal(report.focusOnHandle, true, "focus fell out of the row with its dead button");

    assert.equal(report.answered.handle, "Run ls -la · Allow once");
    assert.equal(report.answered.expanded, "false");
    assert.equal(report.answered.shown, false);

    assert.equal(report.reopened.expanded, "true");
    assert.equal(report.reopened.shown, true);
    assert.deepEqual(report.reopened.choices, SETTLED);
    assert.ok(report.reopened.dim < 1, `settled choices are not dimmed: opacity ${report.reopened.dim}`);

    assert.deepEqual(report.calls, [
      { name: "permission_answer", args: { request: "5", option: "allow-once" } },
    ]);

    assert.equal(report.form.handle, "Which branch? · dev");
    assert.equal(report.form.shown, false);
    assert.deepEqual(
      report.form.choices.map(({ name, chosen, disabled }) => [name, chosen, disabled]),
      [["main", false, true], ["dev", true, true], ["Decline", false, true]],
    );

    assert.equal(report.cancelled.handle, "Delete build/ · Closed");
    assert.equal(report.cancelled.shown, false);
    assert.equal(report.cancelled.choices.some((choice) => choice.chosen), false);
    assert.equal(report.cancelled.choices.every((choice) => choice.disabled), true);
  });
}
