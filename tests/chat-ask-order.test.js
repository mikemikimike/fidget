// A typed turn opens its caret row on send. An ask raised mid-turn is appended
// below it, so the answer after Yes fills the row above the ask and reads as
// if the reply came first. The caret has to move under the ask.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createChatTurns } from "../src/chat-settle.js";

test("the newest waiting turn is the one an ask lands under", () => {
  const turns = createChatTurns();
  assert.equal(turns.newest(), null);
  const first = turns.typed();
  const second = turns.typed();
  assert.equal(turns.newest(), second);
  turns.drop(second);
  assert.equal(turns.newest(), first);
  turns.settle({ said: "hi" });
  assert.equal(turns.newest(), null);
});
