// "Give it your own twist" on the built landing page: the README's Instance
// Prompts word for word, each prompt's one wake and every Character's line
// for it from docs/design/twists.json, and the pickers, clicked in headless
// Chrome.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromeSkip, probePage } from "./chrome-cdp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TWISTS = JSON.parse(readFileSync(join(ROOT, "docs", "design", "twists.json"), "utf8"));
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const PROMPTS = [...README.split("### Give It an Instance Prompt")[1].split("\n## ")[0]
  .matchAll(/^\| `([^`]+)` \|/gm)].map((row) => row[1]);
const ANY_MODEL = "Works with any attached model.";
const CONSENT = "Needs window names consent.";
const LABEL = "Examples pre-generated with real in-app and character prompts. The site isn't connected to an LLM. "
  + "Download Fidget to try the real thing.";

let scratch;
let page;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "landing-twist-"));
  execFileSync("python3", [join(ROOT, "scripts", "make-landing-page.py"), "--out", scratch],
    { cwd: ROOT, stdio: "pipe" });
  page = readFileSync(join(scratch, "index.html"), "utf8");
});

after(() => rmSync(scratch, { recursive: true, force: true }));

const section = () => page.match(/<section id="twist">([\s\S]*?)<\/section>/)[1];
const data = () => JSON.parse(section().match(/<script type="application\/json" id="twist-data">([\s\S]*?)<\/script>/)[1]);
const escaped = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

test("each prompt is the README's, word for word", () => {
  const shown = data().prompts.map((p) => p.text);
  assert.equal(shown.length, 4);
  for (const text of shown) assert.ok(PROMPTS.includes(text), `the README holds: ${text}`);
  assert.deepEqual(data().prompts.map((p) => p.name), TWISTS.prompts.map((p) => p.name));
});

test("each prompt carries one wake that every Character answers", () => {
  assert.deepEqual(data().prompts.map((p) => p.wake), [
    "Thrown across the screen.", 'You said: "Leftover pizza."', "Perched on Spotify, playing Dancing Queen.",
    'You said: "Three meetings, then the dentist."',
  ]);
  const cast = data().characters;
  assert.deepEqual(cast.map((c) => c.character), ["bmo", "black-mage", "cat", "trump", "buddy-bot"]);
  for (const one of cast) {
    assert.equal(one.lines.length, 4);
    one.lines.forEach((said, p) => {
      assert.equal(said.line, TWISTS.prompts[p].lines[one.character].line);
      assert.ok(said.loop.frames[0].startsWith(`characters/${one.character}/`));
      assert.deepEqual(Object.keys(said).sort(), ["line", "loop"], "a Character's line carries no wake of its own");
    });
  }
});

test("without JavaScript BMO answers the stunt double wake, and nothing shows a Before", () => {
  const body = section();
  assert.ok(body.includes(`<p class="twist-prompt" id="twist-prompt">${escaped(data().prompts[0].text)}</p>`));
  assert.ok(body.includes(`<p class="twist-when" id="twist-when">Thrown across the screen.</p>`));
  assert.ok(body.includes(`<div class="say" id="twist-say">${escaped(TWISTS.prompts[0].lines.bmo.line)}</div>`));
  assert.doesNotMatch(body, /Before|Personality only|twist-before|twist-arrow/);
  assert.match(body, /<div class="twist-pick" id="twist-pick" hidden>/, "the pickers wait for JavaScript");
});

test("only Theatre critic asks for window names consent in the small print", () => {
  assert.deepEqual(data().prompts.map((p) => [p.name, p.needs]), [
    ["Stunt double", ANY_MODEL], ["Food critic", ANY_MODEL], ["Theatre critic", CONSENT], ["Forecast", ANY_MODEL],
  ]);
  assert.ok(section().includes(`<p class="twist-needs" id="twist-needs">${ANY_MODEL}</p>`));
});

test("the label and the README link are always on show", () => {
  const body = section();
  assert.ok(body.includes(`<p class="twist-label">${escaped(LABEL)}</p>`));
  assert.ok(body.includes('<a href="https://github.com/omesser/fidget#give-it-an-instance-prompt">Write your own: how →</a>'));
});

const pickEverything = `
  const say = (id) => document.getElementById(id).textContent;
  const typed = (line) => new Promise((done) => {
    const target = document.getElementById("twist-say");
    if (target.textContent === line) return done();
    const watch = new MutationObserver(() => {
      if (target.textContent === line) { watch.disconnect(); done(); }
    });
    watch.observe(target, { childList: true, characterData: true, subtree: true });
  });
  window.addEventListener("load", async () => {
    const twist = JSON.parse(document.getElementById("twist-data").textContent);
    const seen = [];
    for (const one of twist.characters) {
      document.querySelector('#twist-pick [data-character="' + one.character + '"]').click();
      for (let p = 0; p < twist.prompts.length; p++) {
        document.querySelector('#twist-pick [data-prompt="' + p + '"]').click();
        const line = one.lines[p].line;
        const partial = say("twist-say");
        await typed(line);
        seen.push({
          prefix: line.startsWith(partial),
          prompt: say("twist-prompt") === twist.prompts[p].text,
          needs: say("twist-needs") === twist.prompts[p].needs,
          wake: say("twist-when") === twist.prompts[p].wake,
          sprite: one.lines[p].loop.frames.includes(document.getElementById("twist-sprite").getAttribute("src")),
          pressed: [...document.querySelectorAll("#twist-pick [aria-pressed=true]")].map((b) => b.textContent),
          partial: partial === line,
        });
      }
    }
    console.log("__PROBE_RESULT__" + JSON.stringify({ shown: !document.getElementById("twist-pick").hidden, seen }));
  });`;

async function pick(args) {
  return probePage(page.replace("</body>", `<script>${pickEverything}</script></body>`),
    { srcHref: pathToFileURL(ROOT).href, timeout: 60000, args });
}

function expected(typedIn) {
  return TWISTS.characters.flatMap((one, i) => TWISTS.prompts.map((prompt) => ({
    prefix: true, prompt: true, needs: true, wake: true, sprite: true,
    pressed: [data().characters[i].name, prompt.name], partial: !typedIn,
  })));
}

test("every Character and prompt pair shows its lines, the line typing in", { skip: chromeSkip }, async () => {
  assert.deepEqual(await pick([]), { shown: true, seen: expected(true) });
});

test("under reduced motion the line lands whole", { skip: chromeSkip }, async () => {
  assert.deepEqual(await pick(["--force-prefers-reduced-motion"]), { shown: true, seen: expected(false) });
});
