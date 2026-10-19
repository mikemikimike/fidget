// The published landing page, assembled the way the Pages job assembles
// `_site/`, played with in headless Chrome: a throw lands with the hard puff,
// a slow drop perches on the window, and reduced motion keeps the still tiles.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromeSkip, chromePath, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE_MS = 4000;

const probe = `
<script>
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  const frame = () => new Promise(requestAnimationFrame);
  const cueIn = (layer, name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no " + name + " cue")), 3000);
    new MutationObserver((_, observer) => {
      const cue = layer.querySelector(name);
      if (!cue) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(cue);
    }).observe(layer, { childList: true, subtree: true });
  });
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      await frame(); await frame();
      const desk = document.getElementById("play-desk");
      const sprite = document.getElementById("play-sprite");
      const layer = document.getElementById("play-cues");
      if (desk.hidden) {
        console.log("__PROBE_RESULT__" + JSON.stringify({ errors, tiles: !document.getElementById("play-tiles").hidden }));
        return;
      }
      const inner = () => { const box = desk.getBoundingClientRect(); return { x: box.left + desk.clientLeft, y: box.top + desk.clientTop }; };
      const feetY = () => sprite.getBoundingClientRect().bottom - inner().y;
      let x, y;
      const fire = (type) => sprite.dispatchEvent(new PointerEvent(type, {
        bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
      }));
      const press = () => { const box = sprite.getBoundingClientRect(); x = box.left + box.width / 2; y = box.top + box.height / 2; fire("pointerdown"); };

      press();
      for (const [dx, dy] of [[0, -10], [0, -40], [40, -40], [40, -40], [40, -40]]) { await frame(); x += dx; y += dy; fire("pointermove"); }
      const hard = cueIn(layer, ".cue-puff.hard");
      fire("pointerup");
      await hard;
      const thrown = { feetY: feetY(), floor: desk.clientHeight };

      await new Promise((resolve) => setTimeout(resolve, 700));
      const win = document.getElementById("play-win").getBoundingClientRect();
      const windowTop = win.top - inner().y;
      press();
      const box = sprite.getBoundingClientRect();
      const goal = { x: win.left + win.width / 2, y: win.top - 40 - box.height / 2 };
      const start = { x, y };
      for (let i = 1; i <= 10; i++) { await frame(); x = start.x + (goal.x - start.x) * i / 10; y = start.y + (goal.y - start.y) * i / 10; fire("pointermove"); }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const soft = cueIn(layer, ".cue-puff:not(.hard)");
      fire("pointerup");
      await soft;
      const dropped = { feetY: feetY(), windowTop };
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors, tiles: false, thrown, dropped }));
    } catch (err) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)] }));
    }
  });
</script>`;

let dir;
let site;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-playground-"));
  site = join(dir, "_site");
  const built = spawnSync("bash", ["scripts/assemble-site.sh", site, "/dev/null"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(built.status, 0, `assemble-site.sh failed: ${built.stderr}`);
});

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

async function play(flags = []) {
  const page = join(site, "probe.html");
  writeFileSync(page, readFileSync(join(site, "index.html"), "utf8").replace("<head>", `<head>${probe}`));
  const cdp = launchWithPipe(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    `--user-data-dir=${join(dir, `profile-${flags.length}`)}`, "--allow-file-access-from-files", "--window-size=1280,900",
    ...flags,
  ]);
  try {
    const { sessionId, navigate } = await createPageTarget(cdp);
    return await captureConsoleLog(cdp, sessionId, "__PROBE_RESULT__", PROBE_MS, () => navigate(pathToFileURL(page).href));
  } finally {
    await cleanupChrome(cdp);
  }
}

test("every frame the desk plays is in the assembled site", () => {
  const page = readFileSync(join(site, "index.html"), "utf8");
  const desk = JSON.parse(page.match(/<script type="application\/json" id="play-data">([\s\S]*?)<\/script>/)[1]);
  const frames = Object.values(desk.loops).flatMap((loop) => loop.frames);
  assert.ok(frames.length > 7, `the desk plays ${frames.length} frames`);
  for (const frame of frames) assert.ok(existsSync(join(site, frame)), `${frame} is published`);
});

test("the desk replaces the still tiles: a throw lands with the hard puff, a slow drop perches, reduced motion keeps the tiles", { skip: chromeSkip }, async () => {
  const result = await play();
  assert.deepEqual([result.errors, result.tiles], [[], false], "the desk mounted and the page threw nothing");
  assert.ok(Math.abs(result.thrown.feetY - result.thrown.floor) < 1, `landed on the floor: ${JSON.stringify(result.thrown)}`);
  assert.ok(Math.abs(result.dropped.feetY - result.dropped.windowTop) < 1, `perched on the window: ${JSON.stringify(result.dropped)}`);
  assert.deepEqual(await play(["--force-prefers-reduced-motion"]), { errors: [], tiles: true });
});
