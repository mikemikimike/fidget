// A model or effort the Harness did not take shows as a notice under its
// field, and the field shows the value Fidget restored. The page is the
// real Settings surface.

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

// The sentences `ConfigFailure::notice` writes. harness.rs checks the same
// fixture, so the page draws what the Shell sends.
const NOTICES = read("settings-not-applied-notices.json");
export const MODEL_NOTICE = NOTICES.model_refused;
export const EFFORT_NOTICE = NOTICES.effort_unadvertised;

// `before` is what the page holds after Apply. The steps send the refresh that
// follows once the next wake finds the refusal.
export function drive({ before, steps, size = "760,640" }) {
  const form = read("settings-snapshot-harnessDriving.json");
  const values = read("settings-values-harnessDriving.json");
  const stub = `
<script>
  ${pageWait()}
  const heard = {};
  let snapshot = ${JSON.stringify({ form, view: { ...values, ...before }, reveal: null })};
  window.__TAURI__ = {
    core: { invoke(name) { return name === "settings_snapshot" ? Promise.resolve(snapshot) : Promise.resolve(); } },
    event: { listen(name, handler) { heard[name] = handler; listeningNow(name); return Promise.resolve(() => {}); } },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "settings-test" }) },
  };
  const tab = (title) => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === title).click();
  const refresh = async (view) => {
    snapshot = { ...snapshot, view: { ...snapshot.view, ...view } };
    heard["settings-refresh"]();
    await settle();
  };
  const row = (id) => {
    const node = document.querySelector('[data-row="' + id + '"]');
    const notice = node?.querySelector(".set-notice");
    return {
      value: node?.querySelector("input")?.value ?? null,
      notice: notice?.textContent ?? null,
      alert: notice?.getAttribute("role") ?? null,
    };
  };
  async function run() {
    console.log("__PROBE_READY__");
    await ready("settings-refresh");
    await settle();
    const seen = {};
${steps}
    console.log("__PROBE_RESULT__" + JSON.stringify(seen));
  }
  window.addEventListener("load", () => run().catch((why) => {
    console.log("__PROBE_RESULT__" + JSON.stringify({ error: String(why) }));
  }));
</script>`;
  const html = readFileSync(join(SRC, "settings.html"), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html, { args: [`--window-size=${size}`] });
}

test("a refused model shows its notice and the old value is back in the field", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await drive({
    before: { harness_model: "nope", director_model: "nope" },
    steps: `
    tab("AI");
    await settle();
    seen.applied = row("harness_model");
    await refresh({ harness_model: "gpt-4o-mini", director_model: "gpt-4o-mini",
      harness_model_notice: ${JSON.stringify(MODEL_NOTICE)}, director_model_notice: ${JSON.stringify(MODEL_NOTICE)} });
    seen.refused = row("harness_model");
    seen.twin = row("director_model");`,
  });
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.applied, { value: "nope", notice: null, alert: null });
  assert.deepEqual(seen.refused, { value: "gpt-4o-mini", notice: MODEL_NOTICE, alert: "alert" });
  assert.match(seen.refused.notice, /You asked for "gpt-5"/, "the tried value is in the notice");
  // The Model / API row is off while a Harness drives, so it shows no notice.
  assert.deepEqual(seen.twin, { value: "gpt-4o-mini", notice: null, alert: null });
});

test("a Harness with no effort setting says so under the effort field", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await drive({
    before: { director_reasoning_effort: "high" },
    steps: `
    tab("Development");
    await settle();
    seen.applied = row("director_reasoning_effort");
    await refresh({ director_reasoning_effort: "", director_reasoning_effort_notice: ${JSON.stringify(EFFORT_NOTICE)} });
    seen.refused = row("director_reasoning_effort");`,
  });
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.applied, { value: "high", notice: null, alert: null });
  assert.deepEqual(seen.refused, { value: "", notice: EFFORT_NOTICE, alert: "alert" });
  assert.match(seen.refused.notice, /You asked for "high"/, "the tried value is in the notice");
});

test("a notice goes when the next snapshot carries none", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await drive({
    before: { harness_model: "gpt-4o-mini", harness_model_notice: MODEL_NOTICE },
    steps: `
    tab("AI");
    await settle();
    seen.shown = row("harness_model");
    snapshot.view.harness_model_notice = undefined;
    delete snapshot.view.harness_model_notice;
    await refresh({});
    seen.cleared = row("harness_model");`,
  });
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.shown.notice, MODEL_NOTICE);
  assert.equal(seen.cleared.notice, null);
});

test("a tried value with markup is shown as text and injects nothing", { skip: chromeSkip, timeout: 60000 }, async () => {
  const hostile = 'Model did not apply. You asked for "<img src=x onerror=window.__pwn=1><b>x</b>". The Harness refused it: <script>window.__pwn=1</script>. Fidget put back the Harness default.';
  const seen = await drive({
    before: { harness_model: "x" },
    steps: `
    tab("AI");
    await settle();
    await refresh({ harness_model: "", harness_model_notice: ${JSON.stringify(hostile).replace(/</g, "\\u003c")} });
    const notice = document.querySelector('[data-row="harness_model"] .set-notice');
    seen.text = notice.textContent;
    seen.elements = notice.children.length;
    seen.pwned = window.__pwn === 1;
    seen.injected = document.querySelectorAll("img[src='x'], .set-notice b, .set-notice script").length;`,
  });
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.text, hostile);
  assert.deepEqual([seen.elements, seen.pwned, seen.injected], [0, false, 0]);
});
