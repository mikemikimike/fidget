// Glass on Linux: WebKitGTK cannot blur the desktop behind Chat, so
// under data-platform="linux" the panel's tint rises; elsewhere it is the mockup's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeSkip, probePage } from "./chrome-cdp.js";

async function bodyTints() {
  const html = `<!doctype html>
<html class="chat-ui-glass">
  <head><link rel="stylesheet" href="chat-ui.css"></head>
  <body>
    <script>
      const root = document.documentElement;
      const alphas = () => [...getComputedStyle(document.body).backgroundImage.matchAll(/rgba\\([^)]*,\\s*([\\d.]+)\\)/g)].map((m) => Number(m[1]));
      const out = {};
      for (const platform of ["linux", null]) {
        for (const palette of ["dark", "light"]) {
          if (platform) root.dataset.platform = platform; else delete root.dataset.platform;
          root.dataset.chatPalette = palette;
          out[(platform || "other") + " " + palette] = alphas();
        }
      }
      console.log("__PROBE_RESULT__" + JSON.stringify(out));
    </script>
  </body>
</html>`;
  return probePage(html);
}

test("Glass raises its tint under the Linux flag and keeps the mockup's elsewhere", { skip: chromeSkip, timeout: 60000 }, async () => {
  assert.deepEqual(await bodyTints(), {
    "linux dark": [0.92, 0.93],
    "linux light": [0.93, 0.95],
    "other dark": [0.62, 0.74],
    "other light": [0.85, 0.92],
  });
});
