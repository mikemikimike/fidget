// The published landing page's character art, assembled the way the Pages job
// builds `_site/`, laid out in headless Chrome at a phone's width and a
// desktop's: each sprite is painted at its own aspect ratio, never stretched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, test } from "node:test";
import { chromeSkip, chromePath, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";
import { tempDir } from "./temp-path.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE_MS = 5000;

// The painted picture's size: `fill` stretches it to the box, `contain`
// letterboxes it. Any other object-fit is new to the page, so it throws.
const probe = `
<script>
  window.addEventListener("load", () => {
    console.log("__PROBE_READY__");
    const painted = (img, box) => {
      const fit = getComputedStyle(img).objectFit;
      if (fit === "fill") return box;
      if (fit !== "contain") throw new Error("unmodelled object-fit " + fit);
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
      return { width: img.naturalWidth * scale, height: img.naturalHeight * scale };
    };
    try {
      const sprites = [...document.querySelectorAll(".cast .art img, .moment-art img, .twist-art img")]
        .filter((img) => img.getClientRects().length > 0)
        .map((img) => {
          const box = img.getBoundingClientRect();
          const art = painted(img, box);
          return { alt: img.alt, pixel: img.classList.contains("pixel"), natural: img.naturalWidth / img.naturalHeight,
            drawn: art.width / art.height, height: art.height, inside: box.width <= img.parentElement.clientWidth + 0.5 };
        });
      console.log("__PROBE_RESULT__" + JSON.stringify({ sprites }));
    } catch (err) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ error: String(err) }));
    }
  });
</script>`;

let site;
before((t) => {
  site = join(tempDir(t, "landing-cast-aspect-"), "_site");
  const built = spawnSync("bash", ["scripts/assemble-site.sh", site, "/dev/null"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(built.status, 0, `assemble-site.sh failed: ${built.stderr}`);
  writeFileSync(join(site, "probe.html"), readFileSync(join(site, "index.html"), "utf8").replace("<head>", `<head>${probe}`));
});

async function layOut(width, height) {
  const cdp = launchWithPipe(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--allow-file-access-from-files", `--window-size=${width},${height}`,
  ]);
  try {
    const { sessionId, navigate, blockURLs } = await createPageTarget(cdp);
    await blockURLs(["http://*", "https://*"]);
    // A headless window is no narrower than 500px, so a phone is emulated.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 }, sessionId);
    return await captureConsoleLog(cdp, sessionId, "__PROBE_RESULT__", PROBE_MS,
      () => navigate(pathToFileURL(join(site, "probe.html")).href));
  } finally {
    await cleanupChrome(cdp);
  }
}

for (const [label, width, height] of [["a 412px phone", 412, 915], ["a 1280px desktop", 1280, 800]]) {
  test(`on ${label}, every character sprite keeps its own aspect ratio`, { skip: chromeSkip }, async () => {
    const { error, sprites } = await layOut(width, height);
    assert.equal(error, undefined);
    assert.ok(sprites.some((s) => s.pixel), `a pixel-art Character is on the page: ${JSON.stringify(sprites)}`);
    for (const s of sprites) {
      assert.ok(Math.abs(s.drawn / s.natural - 1) <= 0.02, `${s.alt} is drawn ${s.drawn.toFixed(3)} wide per tall, not ${s.natural.toFixed(3)}`);
      assert.ok(s.inside, `${s.alt} fits its card`);
      assert.ok(s.height <= 96.5, `${s.alt} is at most 96px tall, not ${s.height}`);
    }
  });
}
