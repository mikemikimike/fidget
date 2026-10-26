// The header keeps the name, the Character chip, and the mind line on one row.
// As the window narrows the mind line wraps first, down to its min-content
// width, then the Instance's name, and the chip last.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// From wider than build_chat's inner_size, past its 320 minimum.
const WIDTHS = Array.from({ length: 29 }, (_, i) => 480 - i * 10);

const THEMES = ["minimal", "terminal", "glass"];

// A custom Harness command's argv[0]. No hyphen: a hyphen is a break opportunity.
const LONG_HARNESS_PATH = "/Users/me/.local/share/agentlauncher/versions/2.4.1/bin/agentacp";

// One launch per call: every design is measured on the same page by switching
// the root class, which is all a design changes.
function measure(name, harness = { name: "cursor-agent", session: "fd4be1a2-497f-4899-a827-a4e42fbdc1f2" }) {
  const opening = {
    name,
    character: "Buddy Bot",
    configured: true,
    enabled: true,
    harness: {
      ...harness,
      alive: true,
      missing: false,
      initializing: false,
      login: null,
    },
    model: "",
    host: "",
    chat_ui: "minimal",
    login: null,
    harness_name: harness.name,
    instructions: "",
    personality: "",
    instance_prompt: "",
    prompt_limit: 2000,
  };
  const stub = `
<script>
  ${pageWait()}
  window.__TAURI__ = {
    core: {
      invoke(name) {
        if (name === "chat_opening") return Promise.resolve(${JSON.stringify(opening)});
        return Promise.resolve();
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  function lines(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  }
  function minContent(node) {
    node.style.width = "min-content";
    const width = node.getBoundingClientRect().width;
    node.style.width = "";
    return width;
  }
  const side = (a, b) => a.right <= b.left + 0.5 && a.top < b.bottom && b.top < a.bottom;
  async function drive() {
    console.log("__PROBE_READY__");
    await until(() => document.getElementById("mind-text").textContent);
    const header = document.querySelector(".tb");
    const name = document.getElementById("name");
    const chip = document.getElementById("character");
    const mind = document.getElementById("mind");
    const text = document.getElementById("mind-text");
    const { applyChatUiClass } = await import("./chat-ui-class.js");
    const reports = {};
    for (const theme of ${JSON.stringify(THEMES)}) {
      applyChatUiClass(document.documentElement, theme);
      document.body.style.width = "";
      const report = { mind: text.textContent, mindMin: minContent(mind), nameMin: minContent(name), widths: [] };
      reports[theme] = report;
      for (const width of ${JSON.stringify(WIDTHS)}) {
        document.body.style.width = width + "px";
        const n = name.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        const m = mind.getBoundingClientRect();
        report.widths.push({
          width,
          oneRow: side(n, c) && side(c, m),
          clipped: text.scrollWidth > text.clientWidth + 0.5 || m.right > header.getBoundingClientRect().right + 0.5,
          sideways:
            header.getBoundingClientRect().right > document.body.getBoundingClientRect().right + 0.5 ||
            document.body.scrollWidth > document.body.clientWidth + 0.5,
          name: lines(name),
          chip: lines(chip),
          mind: lines(text),
          mindWidth: m.width,
          nameWidth: n.width,
        });
      }
    }
    console.log("__PROBE_RESULT__" + JSON.stringify(reports));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html, { args: ["--window-size=420,560"] });
}

function check(theme, report) {
  const { mindMin, nameMin } = report;
  for (const at of report.widths) {
    const where = `${theme} at ${at.width}px ${JSON.stringify({ mindMin, nameMin, ...at })}`;
    assert.equal(at.oneRow, true, `${where}: the header left one row`);
    // build_chat's minimum. Below it every part can reach its floor and the row overflows.
    if (at.width >= 320) {
      assert.equal(at.clipped, false, `${where}: the mind line is cut off`);
      assert.equal(at.sideways, false, `${where}: Chat scrolls sideways`);
    }
    if (at.name > 1) {
      assert.ok(at.mindWidth <= mindMin + 0.5, `${where}: the name wrapped while the mind line could still give`);
    }
    if (at.chip > 1) {
      assert.ok(at.nameWidth <= nameMin + 0.5, `${where}: the chip wrapped while the name could still give`);
    }
  }
}

test(
  "the Chat header stays one row and wraps the mind line, then the name, then the chip",
  { skip: chromeSkip, timeout: 60000 },
  async () => {
    const reports = await measure("Buddy Bot");
    for (const theme of THEMES) {
      const report = reports[theme];
      assert.equal(report.mind, "cursor-agent · session fd4be1a2", theme);
      const widest = report.widths[0];
      const narrowest = report.widths.at(-1);
      assert.deepEqual([widest.name, widest.chip, widest.mind], [1, 1, 1], `${theme} at 480: something wrapped`);
      assert.ok(narrowest.mind > 1, `${theme} at 200: the mind line never wrapped`);
      check(theme, report);
    }
  },
);

test(
  "a name too long for the row wraps beside the chip and the mind line",
  { skip: chromeSkip, timeout: 60000 },
  async () => {
    const reports = await measure("Sir Reginald Buddington the Third of Cupertino");
    for (const theme of THEMES) {
      const report = reports[theme];
      const at = report.widths.find((w) => w.width === 320);
      assert.ok(at.name > 1, `${theme} at 320px ${JSON.stringify(at)}: the name did not wrap`);
      assert.equal(at.chip, 1, `${theme} at 320px ${JSON.stringify(at)}: the chip wrapped`);
      // Breaking anywhere must not stand the mind line on end, a letter a line.
      assert.ok(at.mind <= 4, `${theme} at 320px ${JSON.stringify(at)}: the mind line collapsed to a column`);
      check(theme, report);
    }
  },
);

test(
  "a custom Harness path with no break opportunity wraps inside the path instead of widening the header",
  { skip: chromeSkip, timeout: 60000 },
  async () => {
    const reports = await measure("Buddy Bot", {
      name: LONG_HARNESS_PATH,
      session: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    for (const theme of THEMES) {
      const report = reports[theme];
      assert.equal(report.mind, `${LONG_HARNESS_PATH} · session 7c9e6679`, theme);
      check(theme, report);
    }
  },
);
