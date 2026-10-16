// Review follow-ups on the cues playground (#1557): the mock Chat must never
// sit over BMO's walk, and the showQuick why-comment and spec prose stay.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../docs/design/cues.html", import.meta.url), "utf8");

test("the mock Chat sits outside the desk, so it cannot cover BMO", () => {
  const deskStart = html.indexOf('<div class="desk" id="desk"');
  const chat = html.indexOf('id="mock-chat"');
  const toast = html.indexOf('<div class="toast" id="toast"');
  assert.ok(deskStart > 0 && chat > 0 && toast > 0);
  assert.ok(chat > toast, "mock Chat markup should follow the desk, not live inside it");
  const css = html.match(/\.mock-chat \{([^}]*)\}/)[1];
  assert.doesNotMatch(css, /position:\s*absolute/);
});

test("showQuick keeps the why-comment on claiming composing", () => {
  assert.match(html, /Claimed with the pill, not on the later focus event, so the slide\s*\n\s*\/\/ stops on the frame the field appears\./);
});

test("spec prose keeps 'not a link' and the desktop walk note", () => {
  assert.match(html, /with a dark triangle — not a link\./);
  assert.match(html, /on the desktop the pet can keep walking through that wait\./);
});
