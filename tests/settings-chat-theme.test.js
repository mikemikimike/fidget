// Settings reads the Chat surface's tokens (ADR-0029), so it paints the Chat UI
// and the Light/Dark Mode the user picked, not Minimal under the OS scheme.
// This drives the real Settings page headless with the snapshot it is sent.

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

// The page's ink, `--chat-ink` per design block in chat-ui.css.
const INK = {
  "Minimal/Dark": "rgb(232, 235, 242)",
  "Minimal/Light": "rgb(26, 29, 36)",
  "Terminal/Dark": "rgb(198, 208, 220)",
  "Terminal/Light": "rgb(26, 35, 48)",
  "Glass/Dark": "rgb(241, 244, 249)",
  "Glass/Light": "rgb(26, 31, 43)",
};

// The browser prefers light (Blink's 1), so a Dark pick that paints is the pick.
function settingsThemes(first, later) {
  const form = read("settings-snapshot-harnessDriving.json");
  const values = read("settings-values-harnessDriving.json");
  const view = ([chat_ui, chat_appearance]) => ({ ...values, chat_ui, chat_appearance });
  const stub = `
<script>
  ${pageWait()}
  const heard = {};
  let snapshot = ${JSON.stringify({ form, view: view(first), reveal: null })};
  window.__TAURI__ = {
    core: { invoke(name) { return name === "settings_snapshot" ? Promise.resolve(snapshot) : Promise.resolve(); } },
    event: { listen(name, handler) { heard[name] = handler; listeningNow(name); return Promise.resolve(() => {}); } },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "settings-test" }) },
  };
  const report = (value) => console.log("__PROBE_RESULT__" + JSON.stringify(value));
  const seen = () => {
    const root = document.documentElement;
    return {
      designs: [...root.classList].filter((name) => name.startsWith("chat-ui-")),
      palette: root.dataset.chatPalette,
      ink: getComputedStyle(document.body).color,
      // Glass frames Chat's pane; the OS already frames this window.
      framed: getComputedStyle(document.body).borderTopWidth !== "0px",
      shadow: getComputedStyle(document.body).boxShadow,
      // Blink writes rgba() only below alpha 1; a see-through page shows the webview's black backing.
      opaque: getComputedStyle(document.body).backgroundColor.startsWith("rgb("),
    };
  };
  async function run() {
    console.log("__PROBE_READY__");
    await ready("settings-refresh");
    await until(() => document.querySelector(".set-form").childElementCount > 0);
    const out = { first: seen(), later: [] };
    for (const pick of ${JSON.stringify(later.map(view))}) {
      snapshot = { ...snapshot, view: pick };
      heard["settings-refresh"]();
      await settle();
      await settle();
      out.later.push(seen());
    }
    report(out);
  }
  window.addEventListener("load", () => run().catch((why) => report({ error: String(why) })));
</script>`;
  const html = readFileSync(join(SRC, "settings.html"), "utf8").replace("<head>", `<head>${stub}`);
  return probePage(html, { args: ["--window-size=760,640", "--blink-settings=preferredColorScheme=1"], timeout: 6000 });
}

const expect = ([design, appearance]) => ({
  designs: [`chat-ui-${design.toLowerCase()}`],
  palette: appearance.toLowerCase(),
  ink: INK[`${design}/${appearance}`],
  framed: false,
  shadow: "none",
  opaque: true,
});

test("Settings opens in the picked Chat UI and Light/Dark Mode", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsThemes(["Glass", "Dark"], []);
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.first, expect(["Glass", "Dark"]));
});

test("an open Settings page repaints when the Chat UI or the mode changes", { skip: chromeSkip, timeout: 60000 }, async () => {
  const picks = [
    ["Minimal", "Dark"],
    ["Terminal", "Dark"],
    ["Terminal", "Light"],
    ["Glass", "Light"],
    ["Minimal", "Light"],
  ];
  const seen = await settingsThemes(["Minimal", "Light"], picks);
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.later, picks.map(expect));
});

test("System follows the computer", { skip: chromeSkip, timeout: 60000 }, async () => {
  const seen = await settingsThemes(["Terminal", "System"], []);
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.first, expect(["Terminal", "Light"]));
});
