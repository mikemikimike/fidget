// The transcript fits the window. A reply's code fence or table scrolls inside
// its own row, and a note's long path wraps; neither widens the log, which
// would push every other row, the ask card and its buttons included, past the
// right edge (#1832).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// build_chat's inner_size, then its minimum.
const WIDTHS = [420, 320];
const THEMES = ["minimal", "terminal", "glass"];
const PALETTES = ["dark", "light"];

// From the report's screenshot: Claude asking to run this.
const COMMAND = `open "spotify:search:jojo%27s%20bizarre%20adventure" && osascript -e 'tell application "Spotify" to player state'`;

// A Shell note naming a file: one token with no break opportunity.
const NOTICE = "Attached to /Users/oded/Library/Application_Support/fidget/sessions/eb8a1459_6c0e_461f_bf4a_7a00ab9ef7f0.jsonl";

// A reply that shows the command in a fence, and a table, before running it.
const REPLY = [
  "I'll run this:",
  "",
  "```bash",
  COMMAND,
  "```",
  "",
  "| uri | state |",
  "| --- | --- |",
  "| spotify:search:jojo%27s%20bizarre%20adventure%20stardust%20crusaders | playing |",
].join("\n");

const OPENING = {
  name: "Jotaro Kujo",
  character: "Jotaro Kujo",
  configured: true,
  enabled: true,
  harness: { name: "claude", session: "eb8a1459", alive: true, missing: false, initializing: false, login: null },
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

const ASK = {
  request: "7",
  title: COMMAND,
  kind: "execute",
  content: ["Open Spotify on a JoJo search and check player state"],
  input: null,
  locations: [],
  options: [
    { id: "allow-once", name: "Yes", kind: "allow_once" },
    { id: "allow-always", name: "Yes, and don't ask again for similar commands", kind: "allow_always" },
    { id: "reject-once", name: "No", kind: "reject_once" },
  ],
};

function measure() {
  const stub = `
<script>
  ${pageWait()}
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
        listeningNow(name);
        return Promise.resolve(() => {});
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: "chat-test" }) },
  };
  const emit = (name, payload) => heard[name]({ payload });
  function overflow() {
    const log = document.getElementById("log");
    const edge = log.getBoundingClientRect().right;
    const past = [...log.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length > 0 && !node.closest(".md-wide > *"))
      .filter((node) => node.getBoundingClientRect().right > edge + 0.5)
      .map((node) => node.tagName.toLowerCase() + "." + [...node.classList].join("."));
    const ask = log.querySelector(".row.ask");
    const buttons = [...ask.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return {
      past: [...new Set(past)],
      logScrolls: log.scrollWidth > log.clientWidth + 0.5,
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5,
      fenceScrolls: [...log.querySelectorAll(".md-wide")].every((wide) => wide.scrollWidth > wide.clientWidth + 0.5),
      buttonsInsideAsk: buttons.every((b) => b.right <= ask.getBoundingClientRect().right + 0.5),
    };
  }
  async function run() {
    console.log("__PROBE_READY__");
    await ready("chat");
    await ready("chat-tool");
    await ready("chat-permission");
    await ready("chat-permission-settled");
    await until(() => !document.getElementById("line").disabled);
    emit("chat", { you: true, said: "play some jojo", busy: false, reacting_to: null, thought: false, at: null, error: null, streaming: false });
    emit("chat", { you: false, said: ${JSON.stringify(REPLY)}, busy: false, reacting_to: null, thought: false, at: null, error: null, streaming: false });
    emit("chat", { you: true, said: "no, the anime", busy: false, reacting_to: null, thought: false, at: null, error: null, streaming: false });
    emit("chat-tool", {
      id: "t1", title: ${JSON.stringify(COMMAND)}, kind: "execute", status: "pending",
      locations: [], content: [{ type: "text", text: ${JSON.stringify(COMMAND)} }],
    });
    emit("chat", { you: false, said: "You asked something else before that answer landed, so I dropped it.", busy: false, reacting_to: null, thought: false, at: null, error: null, streaming: false });
    emit("chat-permission", ${JSON.stringify(ASK)});
    emit("chat", { notice: ${JSON.stringify(NOTICE)} });
    await until(() => document.querySelector('#log .row.ask [data-option="allow-always"]') && document.querySelector("#log .md-wide pre") && document.querySelector("#log > .note"));
    const { applyChatUiClass } = await import("./chat-ui-class.js");
    const report = [];
    const sweep = async (ask) => {
      for (const theme of ${JSON.stringify(THEMES)}) {
        applyChatUiClass(document.documentElement, theme);
        for (const palette of ${JSON.stringify(PALETTES)}) {
          document.documentElement.dataset.chatPalette = palette;
          for (const width of ${JSON.stringify(WIDTHS)}) {
            document.body.style.width = width + "px";
            await settle();
            report.push({ ask, theme, palette, width, ...overflow() });
          }
        }
      }
    };
    await sweep("pending");
    // Folded on the longest answer: its handle must give way too.
    emit("chat-permission-settled", { request: "7", option: "allow-always" });
    await until(() => document.querySelector('#log .row.ask[data-state="settled"] .ask-answer'));
    await sweep("settled");
    console.log("__PROBE_RESULT__" + JSON.stringify(report));
  }
  window.addEventListener("load", () => run().catch((why) => {
    console.log("__PROBE_RESULT__" + JSON.stringify({ error: String(why) }));
  }));
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace("<head>", `<head>${stub}`);
  return probePage(html, { args: ["--window-size=420,560"] });
}

test(
  "a long code line or path keeps every row, the ask card pending or folded, inside the log at 420 and 320",
  { skip: chromeSkip, timeout: 60000 },
  async () => {
    const report = await measure();
    assert.equal(report.error, undefined, report.error);
    assert.equal(report.length, 2 * THEMES.length * PALETTES.length * WIDTHS.length);
    for (const at of report) {
      const where = `${at.ask} ask, ${at.theme} ${at.palette} at ${at.width}px`;
      assert.deepEqual(at.past, [], `${where}: drawn past the log's right edge`);
      assert.equal(at.logScrolls, false, `${where}: the log scrolls sideways`);
      assert.equal(at.pageScrolls, false, `${where}: Chat scrolls sideways`);
      assert.equal(at.fenceScrolls, true, `${where}: a fence or table no longer scrolls in its row`);
      assert.equal(at.buttonsInsideAsk, true, `${where}: an ask button sticks out of its card`);
    }
  },
);
