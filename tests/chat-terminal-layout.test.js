import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function chromeBin() {
  if (process.env.FIDGET_CHROME) return process.env.FIDGET_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    const path = found.stdout.trim();
    if (found.status === 0 && path) return path;
  }
  return null;
}

function paint() {
  const chrome = chromeBin();
  assert.ok(chrome, "headless Chromium is not installed");
  const dir = mkdtempSync(join(tmpdir(), "chat-terminal-layout-"));
  const page = join(dir, "harness.html");
  const html = `<!doctype html>
<html class="chat-ui-terminal">
  <head>
    <base href="${pathToFileURL(SRC).href}">
    <link rel="stylesheet" href="chat-ui.css">
  </head>
  <body>
    <div class="log">
      <div class="row them" id="turn" data-t="4">
        <div class="who"><span class="who-label">trump</span><time class="when">11:29</time></div>
        <div class="said">They said hi while I am on the Dock. Fourteen windows, and the Dock is number one.</div>
      </div>
      <div class="row thinking" id="fold">
        <button class="who thinking-toggle" type="button">
          <span class="who-label">thinking</span><time class="when">11:30</time>
        </button>
        <div class="said" hidden>folded body</div>
      </div>
      <div class="row ask" id="ask" data-t="4">
        <div class="head">pick one</div>
        <div class="what">Which window?</div>
      </div>
    </div>
    <form class="composer">
      <textarea id="line">Ask Trump</textarea>
      <button type="submit">Send</button>
    </form>
    <footer class="bar"><span class="plain">Thinking...</span></footer>
    <script>
      const line = document.getElementById("line");
      line.focus();
      const row = document.getElementById("turn");
      const when = row.querySelector(".when").getBoundingClientRect();
      const label = row.querySelector(".who-label").getBoundingClientRect();
      const said = row.querySelector(".said").getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const fold = document.getElementById("fold");
      const foldWhen = fold.querySelector(".when").getBoundingClientRect();
      const foldLabel = fold.querySelector(".who-label").getBoundingClientRect();
      const foldSaid = fold.querySelector(".said").getBoundingClientRect();
      const ta = line.getBoundingClientRect();
      const field = getComputedStyle(line);
      const bar = document.querySelector(".bar").getBoundingClientRect();
      const ask = document.getElementById("ask");
      const offset = parseFloat(field.outlineOffset) || 0;
      const width = parseFloat(field.outlineWidth) || 0;
      const pre = document.createElement("pre");
      pre.id = "probe";
      pre.textContent = JSON.stringify({
        focused: document.activeElement === line,
        outlineOuterBottom: ta.bottom + offset + width,
        barTop: bar.top,
        gutter: getComputedStyle(row, "::before").content,
        whenLeft: when.left - rowBox.left,
        whenWidth: when.width,
        timeBeforeTitle: when.right <= label.left + 1,
        textUnderTitle: label.bottom <= said.top + 1 && Math.abs(said.left - label.left) < 4,
        foldHidden: fold.querySelector(".said").hidden,
        foldSameBand: Math.abs(foldWhen.top - foldLabel.top) < 4,
        foldTimeBeforeTitle: foldWhen.right <= foldLabel.left + 1,
        foldBodyHidden: foldSaid.height === 0,
        foldSaidHeight: foldSaid.height,
        foldSaidDisplay: getComputedStyle(fold.querySelector(".said")).display,
        askGutter: getComputedStyle(ask, "::before").content,
        askPadLeft: parseFloat(getComputedStyle(ask).paddingLeft) || 0,
      });
      document.body.append(pre);
    </script>
  </body>
</html>`;
  writeFileSync(page, html);
  const run = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${join(dir, "profile")}`,
      "--allow-file-access-from-files",
      "--virtual-time-budget=3000",
      "--window-size=420,640",
      "--dump-dom",
      pathToFileURL(page).href,
    ],
    { encoding: "utf8", maxBuffer: 1 << 24, timeout: 40000, killSignal: "SIGKILL" },
  );
  const match = run.stdout.match(/<pre id="probe"[^>]*>(.*?)<\/pre>/s);
  assert.ok(match, `the page did not report. ${run.stderr?.slice(-400) ?? ""}`);
  return JSON.parse(
    match[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

const browser = { skip: chromeBin() ? false : "headless Chromium is not installed", timeout: 60000 };

test("the terminal log gives the words the width, and the focus ring stays clear of the status bar", browser, () => {
  const painted = paint();

  assert.equal(painted.focused, true);
  assert.ok(
    painted.outlineOuterBottom <= painted.barTop + 0.5,
    `focus ring bottom ${painted.outlineOuterBottom} crosses the status bar at ${painted.barTop}`,
  );
  assert.equal(painted.gutter, "none");
  assert.equal(painted.askGutter, "none");
  assert.ok(painted.askPadLeft < 16, `ask indent ${painted.askPadLeft}`);
  assert.ok(painted.whenLeft < 2, `time gutter starts at ${painted.whenLeft}`);
  assert.ok(painted.whenWidth < 72, `time column is ${painted.whenWidth}`);
  assert.equal(painted.timeBeforeTitle, true);
  assert.equal(painted.textUnderTitle, true);
  assert.equal(painted.foldHidden, true);
  assert.equal(
    painted.foldBodyHidden,
    true,
    `folded body height ${painted.foldSaidHeight} display ${painted.foldSaidDisplay}`,
  );
  assert.equal(painted.foldSameBand, true);
  assert.equal(painted.foldTimeBeforeTitle, true);
});
