// Chat's "More options in Settings" button sends the user to the AI source
// picker. The page is the real Settings surface, with the snapshot the Shell
// would have pushed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

// What `Reveal::AiSource.target()` serializes to. form.rs pins the same pair.
const AI_SOURCE = { tab: "AI", row: "harness", focus: "control" };
const PRIVACY_ROW = { tab: "Privacy", row: "consent_accessibility", focus: "row" };

function render(pageName, stub, { size = "760,640" } = {}) {
  const html = readFileSync(join(SRC, pageName), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html, { args: [`--window-size=${size}`] });
}

const REPORT = `
  const report = (value) => {
    console.log("__PROBE_RESULT__" + JSON.stringify(value));
  };`;

export function settingsWith({ first, later = null, size = "760,640", freeze = null, values: over = {} }) {
  const form = read("settings-snapshot-harnessDriving.json");
  if (freeze) {
    for (const tab of form.tabs) for (const section of tab.sections) for (const row of section.rows) {
      if (row.id === freeze) row.frozen = true;
    }
  }
  const values = read("settings-values-harnessDriving.json");
  const stub = `
<script>
  ${REPORT}
  ${pageWait()}
  const heard = {};
  let snapshot = ${JSON.stringify({ form, view: { ...values, ...over }, reveal: first })};
  window.__TAURI__ = {
    core: { invoke(name) { return name === "settings_snapshot" ? Promise.resolve(snapshot) : Promise.resolve(); } },
    event: { listen(name, handler) { heard[name] = handler; listeningNow(name); return Promise.resolve(() => {}); } },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "settings-test" }) },
  };
  function seen() {
    const at = document.activeElement;
    const style = at ? getComputedStyle(at) : null;
    const box = at?.getBoundingClientRect();
    return {
      tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
      focus: at?.dataset?.id ?? at?.dataset?.row ?? at?.tagName ?? null,
      tag: at?.tagName ?? null,
      ring: at?.matches(":focus-visible") === true && style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 2
        && style.outlineColor !== "rgba(0, 0, 0, 0)" && style.outlineColor !== "transparent",
      inView: Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight,
      checked: [...document.querySelectorAll('[data-row="consent_accessibility"] input')].map((i) => i.checked),
    };
  }
  async function run() {
    console.log("__PROBE_READY__");
    await ready("settings-refresh");
    await settle();
    const out = { first: seen() };
    ${later ? `snapshot = { ...snapshot, reveal: ${JSON.stringify(later)} };
    heard["settings-refresh"]();
    await settle();
    out.later = seen();` : ""}
    report(out);
  }
  window.addEventListener("load", () => run().catch((why) => report({ error: String(why) })));
</script>`;
  return render("settings.html", stub, { size });
}

const without = ({ inView, checked, ...rest }) => rest;

test("Settings opened on the AI source aim shows the AI tab with the picker focused", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsWith({ first: AI_SOURCE });
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(without(seen.first), { tab: "AI", focus: "harness", tag: "SELECT", ring: true });
});

test("an open Settings page on another tab moves to the AI source picker", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsWith({ first: null, later: AI_SOURCE });
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.first.tab, "Presence");
  assert.deepEqual(without(seen.later), { tab: "AI", focus: "harness", tag: "SELECT", ring: true });
});

test("the Chat landing button opens Settings on the AI source, not plain Settings", { skip: chromeSkip, timeout: 60000 }, async () => {
  const opening = {
    name: "Buddy Bot", character: "Buddy Bot", configured: false, enabled: true, harness: null,
    model: "", host: "", chat_ui: "minimal", login: null, harness_name: null,
    instructions: "", personality: "", instance_prompt: "", prompt_limit: 2000,
  };
  const stub = `
<script>
  ${REPORT}
  ${pageWait()}
  const heard = {};
  const calls = [];
  window.__TAURI__ = {
    core: { invoke(name) {
      calls.push(name);
      return name === "chat_opening" ? Promise.resolve(${JSON.stringify(opening)}) : Promise.resolve();
    } },
    event: { listen(name, handler) { heard[name] = handler; listeningNow(name); return Promise.resolve(() => {}); } },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  async function run() {
    console.log("__PROBE_READY__");
    await ready("chat-opening");
    heard["chat-opening"]({ payload: ${JSON.stringify(opening)} });
    await settle();
    calls.length = 0;
    document.getElementById("settings-btn").click();
    await until(() => calls.includes("show_ai_source"));
    report({ calls });
  }
  window.addEventListener("load", () => run().catch((why) => report({ error: String(why) })));
</script>`;
  const seen = await render("chat.html", stub, { size: "420,560" });
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.calls, ["show_ai_source"]);
});

test("the Privacy row keeps the row focused and its consent box unchecked", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsWith({ first: PRIVACY_ROW, values: { consent_accessibility: false } });
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.first.tab, "Privacy");
  assert.deepEqual([seen.first.tag, seen.first.focus], ["DIV", "consent_accessibility"]);
  assert.deepEqual(seen.first.checked, [false], "the aim grants nothing");
});

test("a frozen picker leaves the focus on its row", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsWith({ first: AI_SOURCE, freeze: "harness" });
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual([seen.first.tab, seen.first.tag, seen.first.focus], ["AI", "DIV", "harness"]);
});

test("the focused picker is inside a short window", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsWith({ first: AI_SOURCE, size: "760,360" });
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.first.tag, "SELECT");
  assert.equal(seen.first.inView, true);
});
