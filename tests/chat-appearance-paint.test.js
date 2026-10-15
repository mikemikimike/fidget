import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CSS = readFileSync(new URL("../src/chat-ui.css", import.meta.url), "utf8");
const DESIGNS = ["minimal", "terminal", "glass"];

function declaredToken(selector, name) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(block, `no block for ${selector}`);
  const decl = block[1].match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(decl, `${selector} has no ${name}`);
  return resolveToken(decl[1].trim());
}

function resolveToken(value) {
  const compact = value.replace(/\s+/g, "");
  const ref = compact.match(/^var\((--[A-Za-z0-9-]+)\)$/);
  if (!ref) {
    return compact;
  }
  const snippet = readFileSync(new URL("../src/chat-shared.css", import.meta.url), "utf8");
  const decl = snippet.match(new RegExp(`${ref[1]}\\s*:\\s*([^;]+);`));
  assert.ok(decl, `${ref[1]} is not in chat-shared.css`);
  return decl[1].trim().replace(/\s+/g, "");
}

function chromeBin() {
  if (process.env.FIDGET_CHROME) {
    return process.env.FIDGET_CHROME;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    const path = found.stdout.trim();
    if (found.status === 0 && path) {
      return path;
    }
  }
  return null;
}

const chrome = chromeBin();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One Chrome launch per test: `body` runs once per design on the same page and
// returns that design's readings. A launch costs seconds, the loop costs nothing.
async function probe(body, forceDark, preferredColorScheme) {
  const dir = mkdtempSync(join(tmpdir(), "chat-appearance-paint-"));
  const startMs = Date.now();
  try {
    const page = join(dir, "harness.html");
    const appearance = pathToFileURL(join(SRC, "chat-appearance.js")).href;
    const html = `<!doctype html>
<html>
  <head>
    <base href="${pathToFileURL(SRC).href}">
    <link rel="stylesheet" href="chat-ui.css">
  </head>
  <body>
    <script type="module">
      import { mountChatAppearance } from ${JSON.stringify(appearance)};
      const html = document.documentElement;
      const panel = () => getComputedStyle(html).getPropertyValue("--chat-panel").trim();
      const read = (extra) => ({
        panel: panel(),
        colorScheme: getComputedStyle(html).colorScheme,
        palette: html.dataset.chatPalette,
        ...extra,
      });
      const out = {};
      for (const design of ${JSON.stringify(DESIGNS)}) {
        html.className = "chat-ui-" + design;
        out[design] = (() => {
          ${body}
        })();
      }
      window.__probe = out;
    </script>
  </body>
</html>`;
    writeFileSync(page, html);
    const port = await freePort();
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${join(dir, "profile")}`,
      "--allow-file-access-from-files",
      `--remote-debugging-port=${port}`,
    ];
    if (forceDark) {
      args.push("--force-dark-mode");
    }
    if (preferredColorScheme !== undefined) {
      args.push(`--blink-settings=preferredColorScheme=${preferredColorScheme}`);
    }
    args.push(pathToFileURL(page).href);

    const child = spawn(chrome, args, { stdio: "ignore" });
    try {
      let wsUrl = null;
      const href = pathToFileURL(page).href;
      const deadline = Date.now() + 10000;
      while (!wsUrl && Date.now() < deadline) {
        try {
          const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          wsUrl = pages.find((item) => item.type === "page" && item.url === href)?.webSocketDebuggerUrl;
        } catch {}
        if (!wsUrl) await sleep(100);
      }
      const elapsedMs = Date.now() - startMs;
      assert.ok(wsUrl, `Chrome did not open the page after ${elapsedMs} ms`);

      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });

      let seq = 0;
      const pending = new Map();
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      });

      const send = (method, params = {}) =>
        new Promise((resolve) => {
          const id = ++seq;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ id, method, params }));
        });

      let result = null;
      const probeDeadline = startMs + 3000;
      while (!result && Date.now() < probeDeadline) {
        const msg = await send("Runtime.evaluate", {
          expression: "window.__probe",
          returnByValue: true,
        });
        if (msg.result?.result?.value) {
          result = msg.result.result.value;
        } else {
          await sleep(50);
        }
      }
      
      ws.close();
      const totalMs = Date.now() - startMs;
      assert.ok(result, `window.__probe not set after ${totalMs} ms`);
      return result;
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const flat = (value) => value.replace(/\s+/g, "");
const browser = { skip: chrome ? false : "headless Chromium is not installed", timeout: 60000 };

test("forced light paints each design's light panel and pins color-scheme", browser, async () => {
  const reports = await probe(
    `
    mountChatAppearance(html)("light");
    return read();
  `,
    true,
  );
  for (const design of DESIGNS) {
    const expected = declaredToken(`[data-chat-palette="light"].chat-ui-${design}`, "--chat-panel");
    assert.equal(reports[design].colorScheme, "light", design);
    assert.equal(flat(reports[design].panel), expected, design);
  }
});

test("system and dark under force-dark-mode keep the dark panel", browser, async () => {
  const reports = await probe(
    `
    mountChatAppearance(html)("dark");
    const dark = read();
    mountChatAppearance(html)("system");
    return { dark, system: read() };
  `,
    true,
  );
  for (const design of DESIGNS) {
    const expected = declaredToken(`.chat-ui-${design}`, "--chat-panel");
    const { dark, system } = reports[design];
    assert.equal(dark.colorScheme, "dark", design);
    assert.equal(flat(dark.panel), expected, `${design} dark`);
    assert.equal(system.palette, "dark", `${design} system`);
    assert.equal(flat(system.panel), expected, `${design} system panel`);
  }
});

test("changing data-chat-palette from dark to light repaints the panel", browser, async () => {
  const reports = await probe(
    `
    const apply = mountChatAppearance(html);
    apply("dark");
    const before = panel();
    apply("light");
    return read({ before });
  `,
    true,
  );
  for (const design of DESIGNS) {
    const report = reports[design];
    assert.equal(flat(report.before), declaredToken(`.chat-ui-${design}`, "--chat-panel"), design);
    assert.equal(
      flat(report.panel),
      declaredToken(`[data-chat-palette="light"].chat-ui-${design}`, "--chat-panel"),
      design,
    );
    assert.equal(report.colorScheme, "light", design);
  }
});

test("system follows browser preference and dark forces dark panel", browser, async () => {
  for (const [schemeName, schemeValue] of [["light", 1], ["dark", 0]]) {
    const reports = await probe(
      `
      const apply = mountChatAppearance(html);
      apply("system");
      const systemPalette = html.dataset.chatPalette;
      const systemPanel = panel();
      const systemScheme = getComputedStyle(html).colorScheme;
      apply("dark");
      const darkPanel = panel();
      const darkScheme = getComputedStyle(html).colorScheme;
      apply("light");
      return read({ systemPalette, systemPanel, systemScheme, darkPanel, darkScheme });
    `,
      false,
      schemeValue,
    );
    for (const design of DESIGNS) {
      const darkPanel = declaredToken(`.chat-ui-${design}`, "--chat-panel");
      const lightPanel = declaredToken(`[data-chat-palette="light"].chat-ui-${design}`, "--chat-panel");
      const systemPanel = schemeName === "light" ? lightPanel : darkPanel;
      const report = reports[design];
      assert.equal(report.systemPalette, schemeName, `${schemeName} ${design} system palette`);
      assert.equal(flat(report.systemPanel), systemPanel, `${schemeName} ${design} system panel`);
      assert.equal(report.systemScheme, schemeName, `${schemeName} ${design} system scheme`);
      assert.equal(flat(report.darkPanel), darkPanel, `${schemeName} ${design} dark panel`);
      assert.equal(report.darkScheme, "dark", `${schemeName} ${design} dark scheme`);
      assert.equal(flat(report.panel), lightPanel, `${schemeName} ${design} light panel`);
      assert.equal(report.colorScheme, "light", `${schemeName} ${design} light scheme`);
    }
  }
});
