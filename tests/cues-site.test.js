// The published cues page, assembled the way the Pages job assembles `_site/`,
// thrown at a wall in headless Chrome: the wall ripple is drawn by the same
// `cue.js` the overlay runs, flush against the wall and centred on it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findChrome, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const PROBE_MS = 3000;

const chrome = findChrome();

const probe = `
<script>
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
  const puffIn = (desk) => new Promise((resolve) => {
    new MutationObserver((_, observer) => {
      const puff = desk.querySelector(".cue-puff");
      if (!puff) return;
      observer.disconnect();
      resolve(puff);
    }).observe(desk, { childList: true, subtree: true });
  });
  (async function runProbe() {
    await new Promise(resolve => {
      if (document.readyState === "complete") {
        resolve();
      } else {
        window.addEventListener("load", resolve, { once: true });
      }
    });
    const desk = document.getElementById("desk");
    const sprite = document.getElementById("sprite");
    if (!desk || !sprite) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: ["missing desk or sprite"] }));
      return;
    }
    const drawn = puffIn(desk);
    const start = sprite.getBoundingClientRect();
    let x = start.left + start.width / 2;
    let y = start.top + start.height / 2;
    const fire = (type) => sprite.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
    }));
    fire("pointerdown");
    for (const [dx, dy] of [[5, 0], [0, -150], [0, 0], [40, 0], [40, 0], [40, 0], [40, 0]]) {
      await new Promise(requestAnimationFrame);
      x += dx;
      y += dy;
      fire("pointermove");
    }
    fire("pointerup");
    console.log("__PROBE_READY__");
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error("no puff within 3s")), ${PROBE_MS});
    });
    try {
      const puff = await Promise.race([drawn, timeout]);
      clearTimeout(timerId);
      const [animation] = puff.getAnimations();
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration;
      const box = puff.getBoundingClientRect();
      const style = getComputedStyle(puff);
      const spread = parseFloat(style.getPropertyValue("--puff-shadow") || "0");
      const origin = desk.getBoundingClientRect();
      const ox = origin.left + desk.clientLeft;
      const oy = origin.top + desk.clientTop;
      console.log("__PROBE_RESULT__" + JSON.stringify({
        errors,
        left: box.left - ox,
        right: box.right - ox,
        top: box.top - oy,
        bottom: box.bottom - oy,
        shadow: spread * new DOMMatrix(style.transform).d,
        width: desk.clientWidth,
        height: desk.clientHeight,
      }));
    } catch (err) {
      clearTimeout(timerId);
      console.log("PROBE_ERROR:", String(err));
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)] }));
    }
  })();
</script>`;

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "cues-site-"));
  const site = join(dir, "_site");
  // The real build, so a page import the script forgets to copy fails here.
  const built = spawnSync("bash", ["scripts/assemble-site.sh", site, "/dev/null"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(built.status, 0, `assemble-site.sh failed: ${built.stderr}`);
  const html = readFileSync(join(site, "cues.html"), "utf8")
    .replace("<head>", `<head>${probe}`);
  writeFileSync(join(site, "cues.html"), html);

  const cdp = launchWithPipe(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--mute-audio",
    `--user-data-dir=${join(dir, "profile")}`,
    "--allow-file-access-from-files",
    "--window-size=1400,900",
  ]);

  try {
    const { sessionId, navigate, blockURLs } = await createPageTarget(cdp);
    await blockURLs(["*fonts.googleapis.com*", "*fonts.gstatic.com*"]);
    const result = await captureConsoleLog(
      cdp,
      sessionId,
      "__PROBE_RESULT__",
      PROBE_MS,
      () => navigate(pathToFileURL(join(site, "cues.html")).href)
    );
    return result;
  } finally {
    await cleanupChrome(cdp);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const skip = chrome ? false : "headless Chromium is not installed";

test("a throw into the desk's right wall puffs flush against it, centred on the wall", async () => {
  const puff = await launch();
  assert.deepEqual(puff.errors, [], "the page threw nothing");
  const gap = puff.width - (puff.right + puff.shadow);
  const drift = (puff.top + puff.bottom) / 2 - puff.height / 2;
  assert.ok(Math.abs(gap) <= 0.01, `flush against the wall: ${gap}px off in ${JSON.stringify(puff)}`);
  assert.ok(Math.abs(drift) <= 0.01, `centred on the wall: ${drift}px off in ${JSON.stringify(puff)}`);
  assert.ok(puff.bottom - puff.top > puff.right - puff.left, `stands along the wall: ${JSON.stringify(puff)}`);
});
