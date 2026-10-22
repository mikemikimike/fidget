// The page character on the published landing page, played in headless
// Chrome: it walks up onto the page, a poke plays react with a ring and a line,
// a throw lands on the bottom edge, it hands over to the playground and back
// without two on screen, resting at the threshold does not bounce it, Hide
// survives a reload, and reduced motion keeps it still.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromeSkip, chromePath, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE_MS = 30000;

const helpers = `
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  const frame = () => new Promise(requestAnimationFrame);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (what, check, ms) => {
    const end = performance.now() + ms;
    while (!check()) {
      if (performance.now() > end) throw new Error("timed out waiting for " + what);
      await frame();
    }
  };
  const cueIn = (layer, name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no " + name + " cue")), 3000);
    new MutationObserver((_, observer) => {
      if (!layer.querySelector(name)) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }).observe(layer, { childList: true, subtree: true });
  });
  const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
  }));
  const done = (result) => console.log("__PROBE_RESULT__" + JSON.stringify({ errors, ...result }));
`;

const probe = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    const at = document.getElementById("fidget-at");
    const sprite = document.getElementById("fidget-sprite");
    const back = document.getElementById("fidget-back");
    if (sessionStorage.getItem("probe-first")) {
      await frame(); await frame();
      done({ ...JSON.parse(sessionStorage.getItem("probe-first")),
        reloaded: { hidden: at.hidden, back: !back.hidden, layerEmpty: !document.querySelector("#fidget-say.visible") } });
      return;
    }
    try {
      const layer = document.getElementById("fidget-cues");
      const say = document.getElementById("fidget-say");
      const desk = document.getElementById("play-desk");
      const playSprite = document.getElementById("play-sprite");
      const img = sprite.querySelector("img");
      const data = JSON.parse(document.getElementById("play-data").textContent);
      const member = Object.values(data.cast).find((one) => one.name === img.alt);
      const feetY = () => sprite.getBoundingClientRect().bottom;
      const onPage = () => !at.hidden && Math.abs(feetY() - innerHeight) < 1;
      const center = () => { const box = sprite.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; };

      await until("the walk onto the page", onPage, 4000);
      const ring = cueIn(layer, ".cue-ring");
      pointer(sprite, "pointerdown", ...center());
      pointer(sprite, "pointerup", ...center());
      await ring;
      await frame();
      const reacted = member.loops.react.frames.some((src) => img.getAttribute("src") === src);
      await until("the bubble", () => say.classList.contains("visible"), 1000);
      const poke = { reacted, said: member.lines.includes(say.textContent), title: say.title };

      await wait(700);
      let [x, y] = center();
      pointer(sprite, "pointerdown", x, y);
      for (const [dx, dy] of [[10, -10], [40, -60], [40, -60], [40, -60]]) { await frame(); x += dx; y += dy; pointer(sprite, "pointermove", x, y); }
      const hard = cueIn(layer, ".cue-puff.hard");
      pointer(sprite, "pointerup", x, y);
      await hard;
      const thrown = { feetY: feetY(), floor: innerHeight };

      let both = 0;
      const deskShows = () => { const box = desk.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; };
      const watch = () => { if (!at.hidden && !playSprite.hidden && deskShows()) both++; };
      desk.scrollIntoView({ block: "center" });
      await until("the playground's Character", () => { watch(); return at.hidden && !playSprite.hidden; }, 6000);
      await wait(1500);
      const arrived = { playFeet: playSprite.getBoundingClientRect().bottom, deskFloor: desk.getBoundingClientRect().top + desk.clientTop + desk.clientHeight };
      window.scrollTo(0, 0);
      await until("the walk back onto the page", () => { watch(); return onPage(); }, 6000);
      const handoff = { both, arrived };

      // Most of the way to the threshold and back over it, a few px at a time.
      const edge = window.scrollY + desk.getBoundingClientRect().top - innerHeight + desk.offsetHeight * 0.4;
      let flips = 0;
      let wasHidden = at.hidden;
      for (let i = 0; i < 40; i++) {
        window.scrollTo(0, edge + (i % 2 ? 30 : -30));
        await wait(50);
        if (at.hidden !== wasHidden) { flips++; wasHidden = at.hidden; }
      }
      const bounce = { flips, stayed: !at.hidden };

      document.getElementById("fidget-hide").click();
      await frame(); await frame();
      const hid = { hidden: at.hidden, back: !back.hidden, stored: localStorage.getItem("fidget.hidden") };
      sessionStorage.setItem("probe-first", JSON.stringify({ alt: img.alt, poke, thrown, handoff, bounce, hid }));
      location.reload();
    } catch (err) {
      done({ errors: [...errors, String(err)] });
    }
  });
</script>`;

const still = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      const at = document.getElementById("fidget-at");
      const sprite = document.getElementById("fidget-sprite");
      const img = sprite.querySelector("img");
      const say = document.getElementById("fidget-say");
      await until("the Character on the page", () => !at.hidden, 1000);
      const first = { src: img.getAttribute("src"), left: sprite.getBoundingClientRect().left };
      let changes = 0;
      const observer = new MutationObserver((records) => { changes += records.length; });
      observer.observe(at, { attributes: true, subtree: true });
      await wait(1500);
      observer.disconnect();
      const box = sprite.getBoundingClientRect();
      pointer(sprite, "pointerdown", box.left + box.width / 2, box.top + box.height / 2);
      pointer(sprite, "pointerup", box.left + box.width / 2, box.top + box.height / 2);
      await until("the bubble", () => say.classList.contains("visible"), 1000);
      done({ changes, moved: sprite.getBoundingClientRect().left - first.left, tiles: !document.getElementById("play-tiles").hidden,
        idle: Object.values(JSON.parse(document.getElementById("play-data").textContent).cast)
          .some((one) => one.name === img.alt && one.loops.idle.frames[0] === first.src) });
    } catch (err) {
      done({ errors: [...errors, String(err)] });
    }
  });
</script>`;

let dir;
let site;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-walker-"));
  site = join(dir, "_site");
  const built = spawnSync("bash", ["scripts/assemble-site.sh", site, "/dev/null"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(built.status, 0, `assemble-site.sh failed: ${built.stderr}`);
});

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

async function play(script, flags = []) {
  const page = join(site, "probe.html");
  writeFileSync(page, readFileSync(join(site, "index.html"), "utf8").replace("<head>", `<head>${script}`));
  const cdp = launchWithPipe(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    `--user-data-dir=${mkdtempSync(join(dir, "profile-"))}`, "--allow-file-access-from-files", "--window-size=1280,900",
    ...flags,
  ]);
  try {
    const { sessionId, navigate } = await createPageTarget(cdp);
    return await captureConsoleLog(cdp, sessionId, "__PROBE_RESULT__", PROBE_MS, () => navigate(pathToFileURL(page).href));
  } finally {
    await cleanupChrome(cdp);
  }
}

test("the page character walks on, reacts, lands a throw, hands over to the playground and back, and Hide survives a reload", { skip: chromeSkip }, async () => {
  const result = await play(probe);
  assert.deepEqual(result.errors, [], "the page threw nothing");
  assert.ok(["Buddy Bot", "Nim", "Timber Wolf"].includes(result.alt), `one of the project's own plays: ${result.alt}`);
  assert.deepEqual(result.poke, { reacted: true, said: true, title: "A line from its personality file." },
    "a poke plays react and says a line from the Character's personality.txt");
  assert.ok(Math.abs(result.thrown.feetY - result.thrown.floor) < 1, `landed on the bottom edge: ${JSON.stringify(result.thrown)}`);
  assert.equal(result.handoff.both, 0, "the page never showed two at once");
  assert.ok(Math.abs(result.handoff.arrived.playFeet - result.handoff.arrived.deskFloor) < 1,
    `the playground's Character walked up onto the desk floor: ${JSON.stringify(result.handoff.arrived)}`);
  assert.deepEqual(result.bounce, { flips: 0, stayed: true }, "resting at the threshold does not bounce it");
  assert.deepEqual(result.hid, { hidden: true, back: true, stored: "1" });
  assert.deepEqual(result.reloaded, { hidden: true, back: true, layerEmpty: true }, "Hide is remembered across a reload");
});

test("under reduced motion the page character stays put on its first frame, and a poke still shows a bubble", { skip: chromeSkip }, async () => {
  const result = await play(still, ["--force-prefers-reduced-motion"]);
  assert.deepEqual(result, { errors: [], changes: 0, moved: 0, tiles: true, idle: true });
});
