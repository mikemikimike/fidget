// Glass on macOS: the native window effect behind the webview blurs the
// desktop, so under data-platform="macos" the panel drops its CSS blur rather
// than blur that blur again. Elsewhere the CSS blur stays.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";

async function bodyBackdrops() {
  const html = `<!doctype html>
<html class="chat-ui-glass">
  <head><link rel="stylesheet" href="chat-ui.css"></head>
  <body>
    <script>
      const root = document.documentElement;
      const out = {};
      for (const platform of ["macos", null]) {
        if (platform) root.dataset.platform = platform; else delete root.dataset.platform;
        out[platform || "other"] = getComputedStyle(document.body).backdropFilter;
      }
      console.log("__PROBE_RESULT__" + JSON.stringify(out));
    </script>
  </body>
</html>`;
  return probePage(html);
}

test("Glass drops its CSS blur under the macOS flag and keeps it elsewhere", { skip: chromeSkip, timeout: 60000 }, async () => {
  assert.deepEqual(await bodyBackdrops(), {
    macos: "none",
    other: "blur(22px) saturate(1.5)",
  });
});
