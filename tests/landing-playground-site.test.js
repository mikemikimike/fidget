// The published landing page, assembled the way the Pages job assembles
// `_site/`, played with in headless Chrome: a throw lands with the hard puff,
// a slow drop perches on the window, the desk stops painting while scrolled out
// of view, reduced motion keeps the still tiles, a double-click opens the chat
// mock, hovering opens the quick-message pill, and the picker swaps the sprite.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromeSkip, chromePath, launchWithPipe, createPageTarget, captureConsoleLog, cleanupChrome } from "./chrome-cdp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE_MS = 30000;

// The page character is hidden, so the desk keeps its Character the whole run.
// tests/landing-walker-site.test.js plays the handover.
const helpers = `
  localStorage.setItem("fidget.hidden", "1");
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
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (what, check, ms) => {
    const end = performance.now() + ms;
    while (!check()) {
      if (performance.now() > end) throw new Error("timed out waiting for " + what);
      await frame();
    }
  };
  // Resolves with the first attribute write under target, or 0 after ms.
  const written = (target, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(0), ms);
    new MutationObserver((records, observer) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(records.length);
    }).observe(target, { attributes: true, subtree: true });
  });
  const castLoops = () => Object.values(JSON.parse(document.getElementById("play-data").textContent).cast)
    .find((one) => one.name === document.querySelector("#play-sprite img").alt).loops;
  const playing = (name) => castLoops()[name].frames.includes(document.querySelector("#play-sprite img").getAttribute("src"));
  const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
  }));
`;

const probe = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      await frame(); await frame();
      const desk = document.getElementById("play-desk");
      const sprite = document.getElementById("play-sprite");
      const layer = document.getElementById("play-cues");
      if (desk.hidden) {
        console.log("__PROBE_RESULT__" + JSON.stringify({ errors, tiles: !document.getElementById("play-tiles").hidden,
          picker: document.getElementById("play-picker").getClientRects().length > 0 }));
        return;
      }
      desk.scrollIntoView({ block: "center" });
      await frame(); await frame();
      const inner = () => { const box = desk.getBoundingClientRect(); return { x: box.left + desk.clientLeft, y: box.top + desk.clientTop }; };
      const feetY = () => sprite.getBoundingClientRect().bottom - inner().y;
      let x, y;
      const fire = (type) => pointer(sprite, type, x, y);
      const press = () => { const box = sprite.getBoundingClientRect(); x = box.left + box.width / 2; y = box.top + box.height / 2; fire("pointerdown"); };

      press();
      for (const [dx, dy] of [[-10, 0], [-40, 0], [-40, 0], [-40, 0]]) { await frame(); x += dx; y += dy; fire("pointermove"); }
      const hard = cueIn(layer, ".cue-puff.hard");
      fire("pointerup");
      await hard;
      const thrown = { feetY: feetY(), floor: desk.clientHeight };

      await until("the end of land", () => !playing("land"), 1000);
      const win = document.querySelector('[data-win="light"]').getBoundingClientRect();
      const windowTop = win.top - inner().y;
      press();
      const box = sprite.getBoundingClientRect();
      const goal = { x: win.left + win.width / 2, y: win.top - 40 - box.height / 2 };
      const start = { x, y };
      for (let i = 1; i <= 10; i++) { await frame(); x = start.x + (goal.x - start.x) * i / 10; y = start.y + (goal.y - start.y) * i / 10; fire("pointermove"); }
      // A pointer still past velocityWindowMs lets go with no speed: a drop, not a throw.
      await wait(200);
      const soft = cueIn(layer, ".cue-puff:not(.hard)");
      fire("pointerup");
      await soft;
      const dropped = { feetY: feetY(), windowTop };

      const repaints = async (ms) => {
        let count = 0;
        const observer = new MutationObserver((records) => { count += records.length; });
        observer.observe(sprite, { attributes: true, subtree: true });
        await new Promise((resolve) => setTimeout(resolve, ms));
        observer.disconnect();
        return count;
      };
      window.scrollTo(0, 0);
      await frame(); await frame();
      const before = feetY();
      // Waits for something that must not happen: a repaint out of view.
      const offscreen = await repaints(1000);
      desk.scrollIntoView({ block: "center" });
      const back = await written(sprite, 1000);
      const paused = { offscreen, back, moved: Math.abs(feetY() - before) };
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors, tiles: false, thrown, dropped, paused }));
    } catch (err) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)] }));
    }
  });
</script>`;

const gestures = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      const desk = document.getElementById("play-desk");
      const sprite = document.getElementById("play-sprite");
      const layer = document.getElementById("play-cues");
      const chat = document.getElementById("play-chat");
      const pill = document.getElementById("play-qm");
      const field = pill.querySelector("input");
      const tuning = JSON.parse(document.getElementById("play-data").textContent).tuning;
      desk.scrollIntoView({ block: "center" });
      await frame(); await frame();
      const center = () => { const box = sprite.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; };

      const closedAtFirst = chat.hidden;
      const summon = cueIn(layer, ".cue-ring.in");
      for (let i = 0; i < 2; i++) { pointer(sprite, "pointerdown", ...center()); pointer(sprite, "pointerup", ...center()); }
      await summon;
      const rings = { summon: layer.querySelectorAll(".cue-ring.in").length, poke: layer.querySelectorAll(".cue-ring:not(.in)").length };
      const opened = !chat.hidden;
      const composer = chat.querySelector(".composer textarea");
      const sendButton = chat.querySelector(".composer button");
      const look = { panel: getComputedStyle(chat).backgroundColor, composer: !composer.disabled && composer.placeholder,
        send: !sendButton.disabled && getComputedStyle(sendButton).borderRadius };
      composer.focus();
      document.execCommand("insertText", false, "hi there");
      const typedInChat = composer.value;
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const afterEnter = composer.value;
      document.execCommand("insertText", false, "again");
      sendButton.click();
      const talk = { typed: typedInChat, afterEnter, afterSend: composer.value, stillOpen: !chat.hidden,
        replies: chat.querySelectorAll(".log .row").length };
      const bar = chat.querySelector(".bar").getBoundingClientRect();
      const from = chat.getBoundingClientRect();
      const grip = [bar.left + 40, bar.top + bar.height / 2];
      pointer(chat.querySelector(".bar"), "pointerdown", ...grip);
      pointer(chat.querySelector(".bar"), "pointermove", grip[0] - 60, grip[1] + 30);
      pointer(chat.querySelector(".bar"), "pointerup", grip[0] - 60, grip[1] + 30);
      const to = chat.getBoundingClientRect();
      chat.querySelector(".close").click();
      const chatResult = { closedAtFirst, opened, rings, moved: [to.left - from.left, to.top - from.top], closed: chat.hidden, look, talk };

      sprite.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", pointerId: 1 }));
      // Waits for something that must not happen: the pill before hoverDelayMs.
      await wait(tuning.hoverDelayMs - 300);
      const early = pill.classList.contains("visible");
      await until("the pill", () => pill.classList.contains("visible"), 1000);
      const shown = document.activeElement === field;
      document.execCommand("insertText", false, "hello there");
      const typed = field.value;
      const box = desk.getBoundingClientRect();
      pointer(desk, "pointerdown", box.right - 10, box.bottom - 10);
      const dismissed = !pill.classList.contains("visible");
      sprite.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", pointerId: 1 }));
      await until("the pill again", () => pill.classList.contains("visible"), tuning.hoverDelayMs + 1000);
      const again = pill.classList.contains("visible");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const sent = !pill.classList.contains("visible") && field.value === "";
      sprite.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", pointerId: 1 }));
      await until("the pill a third time", () => pill.classList.contains("visible"), tuning.hoverDelayMs + 1000);
      document.execCommand("insertText", false, "never mind");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const escaped = !pill.classList.contains("visible") && field.value === "";
      const pillResult = { early, shown, typed, dismissed, again, sent, escaped };
      const lightBar = document.querySelector('[data-win="light"] .bar');
      const handle = lightBar.getBoundingClientRect();
      pointer(lightBar, "pointerdown", handle.left + 30, handle.top + 10);
      pointer(lightBar, "pointermove", handle.left + 30, desk.getBoundingClientRect().top - 200);
      pointer(lightBar, "pointerup", handle.left + 30, desk.getBoundingClientRect().top - 200);
      const raisedTop = lightBar.parentElement.getBoundingClientRect().top - desk.getBoundingClientRect().top - desk.clientTop;
      const moved = lightBar.getBoundingClientRect();
      pointer(lightBar, "pointerdown", moved.left + 30, moved.top + 10);
      pointer(lightBar, "pointermove", moved.left + 30 + 2000, moved.top + 10);
      pointer(lightBar, "pointerup", moved.left + 30 + 2000, moved.top + 10);
      const deskBox = desk.getBoundingClientRect();
      const pushedRight = Math.round(deskBox.left + desk.clientLeft + desk.clientWidth - lightBar.parentElement.getBoundingClientRect().right);
      const gestureBox = document.querySelector(".play-gestures").getBoundingClientRect(), panelBox = document.getElementById("play-panel").getBoundingClientRect();
      const beside = gestureBox.right < panelBox.left && gestureBox.top === panelBox.top;
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors, chat: chatResult, pill: pillResult, raisedTop, pushedRight, beside,
        name: sprite.querySelector("img").alt }));
    } catch (err) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)] }));
    }
  });
</script>`;

// A finger taps Nim in the picker, with the desk in view: the desk wears Nim
// before the next frame, the pick is stored, and the desk then animates Nim.
const picker = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      const data = JSON.parse(document.getElementById("play-data").textContent);
      const desk = document.getElementById("play-desk");
      const sprite = document.getElementById("play-sprite");
      const img = sprite.querySelector("img");
      const buttons = [...document.querySelectorAll("#play-picker button")];
      const pressed = () => buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.id);
      desk.scrollIntoView({ block: "center" });
      await until("Buddy Bot standing", () => playing("idle"), 2000);
      const before = { names: buttons.map((b) => b.getAttribute("aria-label")), pressed: pressed() };
      const nim = buttons.find((b) => b.dataset.id === "nim").getBoundingClientRect();
      const tapped = new Promise((resolve) => buttons.find((b) => b.dataset.id === "nim")
        .addEventListener("click", () => resolve({ alt: img.alt, width: sprite.style.width,
          idle: data.cast.nim.loops.idle.frames.includes(img.getAttribute("src")) }), { once: true }));
      tapAt(JSON.stringify([nim.left + nim.width / 2, nim.top + nim.height / 2]));
      const swapped = await tapped;
      await frame(); await frame();
      const after = { pressed: pressed(), stored: sessionStorage.getItem("fidget.character"),
        nimFrame: Object.values(data.cast.nim.loops).some((loop) => loop.frames.includes(img.getAttribute("src"))) };
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors, before, swapped, after,
        cast: Object.values(data.cast).map((one) => one.name), nimWidth: data.cast.nim.size[0] + "px" }));
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

// Each cast Character in turn, picked in the picker, is dragged from wherever
// it stands to just above a window's top edge and let go slowly.
const perches = `
<script>${helpers}
  window.addEventListener("load", async () => {
    console.log("__PROBE_READY__");
    try {
      const ids = Object.keys(JSON.parse(document.getElementById("play-data").textContent).cast);
      const desk = document.getElementById("play-desk");
      const sprite = document.getElementById("play-sprite");
      const layer = document.getElementById("play-cues");
      const painting = written(sprite, 1000);
      desk.scrollIntoView({ block: "center" });
      await painting;
      const all = {};
      for (const id of ids) {
        document.querySelector('#play-picker button[data-id="' + id + '"]').click();
        const perched = {};
        for (const name of ["light", "dark"]) {
          // The last landing's puff would end this drop's wait early.
          await until("the last puff gone", () => !layer.querySelector(".cue-puff"), 3000);
          await until("it standing", () => playing("idle") || playing("sit"), 2000);
          const win = document.querySelector('[data-win="' + name + '"]').getBoundingClientRect();
          const box = sprite.getBoundingClientRect();
          let x = box.left + box.width / 2;
          let y = box.top + box.height / 2;
          pointer(sprite, "pointerdown", x, y);
          pointer(sprite, "pointermove", x, y - 5);
          const from = { x, y: y - 5 };
          const goal = { x: win.left + win.width * 0.75, y: win.top - 20 - box.height / 2 };
          for (let i = 1; i <= 10; i++) {
            await frame();
            x = from.x + (goal.x - from.x) * i / 10;
            y = from.y + (goal.y - from.y) * i / 10;
            pointer(sprite, "pointermove", x, y);
          }
          // A pointer still past velocityWindowMs lets go with no speed: a drop, not a throw.
          await wait(200);
          const soft = cueIn(layer, ".cue-puff:not(.hard)");
          pointer(sprite, "pointerup", x, y);
          await soft;
          await frame();
          perched[name] = Math.round(sprite.getBoundingClientRect().bottom - win.top);
        }
        all[id] = perched;
      }
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors, perched: all, desk: desk.clientHeight }));
    } catch (err) {
      console.log("__PROBE_RESULT__" + JSON.stringify({ errors: [...errors, String(err)] }));
    }
  });
</script>`;

async function play(flags = [], script = probe, size = "1280,900") {
  const page = join(site, "probe.html");
  writeFileSync(page, readFileSync(join(site, "index.html"), "utf8").replace("<head>", `<head>${script}`));
  const cdp = launchWithPipe(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    `--user-data-dir=${mkdtempSync(join(dir, "profile-"))}`, "--allow-file-access-from-files", `--window-size=${size}`,
    ...flags,
  ]);
  try {
    const { sessionId, navigate, blockURLs } = await createPageTarget(cdp);
    // The page plays from file://. The README's video, fetched from GitHub, can
    // take seconds under load and hold up a reload, so nothing goes to the network.
    await blockURLs(["http://*", "https://*"]);
    // A probe's tapAt sends a real touch, which a synthetic event is not.
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, sessionId);
    await cdp.send("Runtime.addBinding", { name: "tapAt" }, sessionId);
    cdp.on(sessionId, "Runtime.bindingCalled", async ({ name, payload }) => {
      if (name !== "tapAt") return;
      const [x, y] = JSON.parse(payload);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }, sessionId);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
    });
    return await captureConsoleLog(cdp, sessionId, "__PROBE_RESULT__", PROBE_MS, () => navigate(pathToFileURL(page).href));
  } finally {
    await cleanupChrome(cdp);
  }
}

test("every frame the desk plays is in the assembled site", () => {
  const page = readFileSync(join(site, "index.html"), "utf8");
  const desk = JSON.parse(page.match(/<script type="application\/json" id="play-data">([\s\S]*?)<\/script>/)[1]);
  const frames = Object.values(desk.cast).flatMap((member) => Object.values(member.loops)).flatMap((loop) => loop.frames);
  assert.ok(frames.length > 7, `the desk plays ${frames.length} frames`);
  for (const frame of frames) assert.ok(existsSync(join(site, frame)), `${frame} is published`);
});

test("the desk replaces the still tiles: a throw lands with the hard puff, a slow drop perches, offscreen pauses, reduced motion keeps the tiles", { skip: chromeSkip }, async () => {
  const result = await play();
  assert.deepEqual([result.errors, result.tiles], [[], false], "the desk mounted and the page threw nothing");
  assert.ok(Math.abs(result.thrown.feetY - result.thrown.floor) < 1, `landed on the floor: ${JSON.stringify(result.thrown)}`);
  assert.ok(Math.abs(result.dropped.feetY - result.dropped.windowTop) < 1, `perched on the window: ${JSON.stringify(result.dropped)}`);
  assert.equal(result.paused.offscreen, 0, `scrolled out of view, the desk painted nothing: ${JSON.stringify(result.paused)}`);
  assert.ok(result.paused.back > 0, `scrolled back, the desk animates again: ${JSON.stringify(result.paused)}`);
  assert.deepEqual(await play(["--force-prefers-reduced-motion"]), { errors: [], tiles: true, picker: false });
});

test("a double-click opens the chat mock, which moves by its bar and closes; a hover opens the pill, which takes typing; a window drags to the desk top", { skip: chromeSkip }, async () => {
  const result = await play([], gestures);
  assert.deepEqual(result.errors, [], "the page threw nothing");
  assert.equal(result.name, "Buddy Bot", "with no pick, the desk plays Buddy Bot");
  const hex = readFileSync(join(ROOT, "src/chat-shared.css"), "utf8").match(/--shared-panel: #(\w{6});/)[1];
  const panel = `rgb(${hex.match(/../g).map((pair) => parseInt(pair, 16)).join(", ")})`;
  assert.deepEqual(result.chat, { closedAtFirst: true, opened: true, rings: { summon: 2, poke: 0 }, moved: [-60, 30], closed: true,
    look: { panel, composer: `Ask ${result.name}…`, send: "10px" },
    talk: { typed: "hi there", afterEnter: "", afterSend: "", stillOpen: true, replies: 0 } },
    "the Summon replaced the poke ring and opened a chat in the app's Chat panel, whose active composer takes typing and sends to nowhere, and it moves and closes");
  assert.deepEqual(result.pill, { early: false, shown: true, typed: "hello there", dismissed: true, again: true, sent: true, escaped: true },
    "the pill waits out the hover delay, focuses, types, and an outside click, Enter, or Escape dismisses it");
  assert.equal(result.raisedTop, 0, "a window drags all the way up to the desk's top edge");
  assert.ok(result.beside, "at 1280px the gestures sit to the left of the panel, top-aligned with it");
  assert.equal(result.pushedRight, 0, "beside the gestures, a window drags right up to the narrower desk's right edge");
});

test("a tap on a Character in the picker swaps the desk's sprite at once, and the pick is stored", { skip: chromeSkip }, async () => {
  const result = await play([], picker);
  assert.deepEqual(result.errors, [], "the page threw nothing");
  assert.deepEqual(result.before, { names: result.cast, pressed: ["buddy-bot"] },
    "the picker lists every cast Character, Buddy Bot pressed");
  assert.deepEqual(result.swapped, { alt: "Nim", width: result.nimWidth, idle: true }, "the tap swapped the desk to Nim before any frame");
  assert.deepEqual(result.after, { pressed: ["nim"], stored: "nim", nimFrame: true }, "Nim stays pressed, stored and animating");
});

for (const size of ["1512,945", "1280,800"]) {
  test(`at ${size}, every cast Character drags onto both windows' top edges and perches`, { skip: chromeSkip }, async () => {
    const result = await play([], perches, size);
    assert.deepEqual(result.errors, [], "the page threw nothing");
    const flat = { light: 0, dark: 0 };
    const ids = readdirSync(join(ROOT, "characters")).filter((id) => existsSync(join(ROOT, "characters", id, "character.manifest")));
    assert.deepEqual(result.perched, Object.fromEntries(ids.map((id) => [id, flat])),
      `each Character's feet rest on each window's top edge, in a ${result.desk}px desk`);
  });
}

test("the playground reads as Oded asked: its title and gestures, two windows that say drag me, Download below the desk, then the sections in order", () => {
  const page = readFileSync(join(site, "index.html"), "utf8");
  const play = page.match(/<section id="play">([\s\S]*?)<\/section>/)[1];
  assert.match(play, /<div class="play-panel" id="play-panel">\s*<p class="play-title">Try it here<\/p>\s*<div class="play-picker" id="play-picker"[^>]*><\/div>\s*<div class="play-desk" id="play-desk"/,
    "the desk sits in a panel whose title bar is the invite, with no period, then the picker, both outside the desk the physics bounds");
  const order = ['id="play-desk"', '<h3 class="play-sub">Fidget gestures</h3>\n    <ul class="play-how">', 'class="play-get"']
    .map((mark) => play.indexOf(mark));
  assert.ok(order.every((at, i) => at > (order[i - 1] ?? play.indexOf('class="play-title"'))),
    `the titled panel, desk, Fidget gestures over the bullets, then the Download line: ${order}`);
  assert.ok(!play.includes("cues.html"), "the playground no longer links Fidget Cues");
  const gestures = [...play.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1].replace(/<\/?b>/g, ""));
  assert.deepEqual(gestures, ["Left-click to poke", "Click and hold to drag it around and drop it",
    "Hover on Fidget to get the quick-message pill and type something, even while Chat is open", "Double-click to summon chat"]);
  const windows = [...play.matchAll(/data-win="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(windows, ["dark", "light", "chat"]);
  assert.equal(play.match(/<span class="drag-me">drag me<\/span>/g).length, 3, "every window's bar says drag me");
  const chatBar = play.match(/data-win="chat"[^>]*>\s*<div class="bar">(.*?)<\/div>/)[1];
  assert.match(chatBar, /^<button class="close"[^>]*>&times;<\/button><i><\/i><i><\/i><span class="drag-me">drag me<\/span>$/,
    "the chat closes from its leftmost circle, with no × at the right");
  const cta = '<p class="play-get"><a href="#get">Download Fidget</a> to try it for real.</p>';
  assert.equal(play.split("Download Fidget").length - 1, 1, "one Download line in the playground, and no button");
  assert.ok(play.indexOf(cta) > play.indexOf('id="play-cues"'), "the linked Download line sits below the desk, not in the chat");
  const titles = [...page.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]);
  const at = titles.indexOf("Live Playground");
  assert.deepEqual(titles.slice(at, at + 4),
    ["Live Playground", "Packaged Fidgets", "Talks to the agent you already use", "How it works"]);
});
