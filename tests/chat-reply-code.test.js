// The node stand-in in chat-markdown.test.js builds the nodes and cannot see
// paint. This drives src/chat.html the way scripts/chat-ask-order.mjs does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";
import { pageWait } from "./page-wait.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const REPLY =
  "Run `cargo test -p fidget-core` in the repo root.\n\n```bash\ncargo test -p fidget-core -- --test-threads=1\n```";
const FENCE = "cargo test -p fidget-core -- --test-threads=1";
const INLINE = "cargo test -p fidget-core";

function channel(color) {
  const text = String(color);
  const rgb = text.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  // Chrome serialises color-mix() as color(srgb …) with channels in 0..1.
  const srgb = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  assert.ok(srgb, `unparsed color ${color}`);
  return {
    r: Number(srgb[1]) * 255,
    g: Number(srgb[2]) * 255,
    b: Number(srgb[3]) * 255,
    a: srgb[4] === undefined ? 1 : Number(srgb[4]),
  };
}

function over(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function apart(fg, bg) {
  const a = over(channel(fg), channel(bg));
  const b = channel(bg);
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function paint(theme) {
  const opening = {
    name: "BMO",
    character: "Buddy Bot",
    configured: true,
    enabled: true,
    harness: { alive: true, missing: false, initializing: false },
    model: "",
    host: "",
    chat_ui: theme,
    login: null,
    harness_name: "Claude Code",
    instructions: "",
    personality: "",
    instance_prompt: "",
    prompt_limit: 2000,
  };
  const markdown = pathToFileURL(join(SRC, "markdown.js")).href;
  const stub = `
<script type="module">
  ${pageWait()}
  import { appendReply, drawReply } from ${JSON.stringify(markdown)};
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
  const full = ${JSON.stringify(REPLY)};
  const chunks = [
    "Run \`cargo",
    " test -p fidget-core\` in the repo root.\\n\\n\`\`\`bash\\ncargo test",
    " -p fidget-core -- --test-threads=1\\n\`\`\`",
  ];
  function paintOf(node) {
    const style = getComputedStyle(node);
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      fontFamily: style.fontFamily,
    };
  }
  async function drive() {
    console.log("__PROBE_READY__");
    await ready("chat");
    await until(() => !document.getElementById("line").disabled);
    document.getElementById("line").value = "how do I run the tests?";
    document.getElementById("composer").requestSubmit();
    await until(() => document.querySelector("#log .row.you"));
    handlers.chat({
      payload: {
        said: full,
        busy: false,
        reacting_to: null,
        you: false,
        at: null,
        error: null,
        superseded_by: null,
      },
    });
    await until(() => document.querySelector("#log .row.them .said"));
    const said = document.querySelector("#log .row.them .said");
    const one = document.createElement("div");
    drawReply(one, full);
    const streamed = document.createElement("div");
    for (const chunk of chunks) appendReply(streamed, chunk);
    const code = said.querySelector("p code");
    const pre = said.querySelector("pre");
    const fence = said.querySelector("pre code");
    const report = {
      scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      saidClass: said.className,
      backticksLeft: said.textContent.includes("\`"),
      inline: code ? code.textContent : null,
      fence: fence ? fence.textContent : null,
      panel: getComputedStyle(document.body).backgroundColor,
      inlineCode: paintOf(code),
      pre: paintOf(pre),
      fenceCode: paintOf(fence),
      streamFence: streamed.querySelector("pre code")?.textContent ?? null,
      oneShotFence: one.querySelector("pre code")?.textContent ?? null,
      streamInline: streamed.querySelector("p code")?.textContent ?? null,
    };
    console.log("__PROBE_RESULT__" + JSON.stringify(report));
  }
  window.addEventListener("load", drive);
</script>`;

  const html = readFileSync(join(SRC, "chat.html"), "utf8").replace(
    "<head>",
    `<head>${stub}`,
  );
  return probePage(html, { args: ["--force-dark-mode"] });
}

test(
  "a harness reply's inline and fenced code read apart from the panel",
  { skip: chromeSkip, timeout: 90000 },
  async () => {
    for (const theme of ["minimal", "terminal"]) {
      const report = await paint(theme);
      assert.equal(report.scheme, "dark", theme);
      assert.equal(report.saidClass, "said md", theme);
      assert.equal(report.backticksLeft, false, theme);
      assert.equal(report.inline, INLINE, theme);
      assert.equal(report.fence, FENCE, theme);
      assert.equal(report.streamInline, INLINE, `${theme} stream diverged from one shot`);
      assert.equal(report.streamFence, report.oneShotFence, `${theme} stream diverged from one shot`);
      assert.equal(report.streamFence, FENCE, theme);
      assert.equal(report.inlineCode.borderTopWidth, "1px", `${theme} inline has no edge`);
      assert.equal(report.pre.borderTopWidth, "1px", `${theme} fence has no edge`);
      assert.equal(report.fenceCode.borderTopWidth, "0px", `${theme} fence text is boxed twice`);
      assert.match(report.inlineCode.fontFamily, /mono/, theme);
      const inlineDelta = apart(report.inlineCode.backgroundColor, report.panel);
      const fenceDelta = apart(report.pre.backgroundColor, report.panel);
      assert.ok(
        inlineDelta >= 45,
        `${theme} inline code is ${inlineDelta.toFixed(1)} RGB steps from the panel`,
      );
      assert.ok(
        fenceDelta >= 32,
        `${theme} fence is ${fenceDelta.toFixed(1)} RGB steps from the panel`,
      );
    }
  },
);
