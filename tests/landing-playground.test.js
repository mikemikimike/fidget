// The playground desk on the landing page. step() is the
// whole behavior, so these drive it the way the page's pointer handlers do.

import assert from "node:assert/strict";
import { test } from "node:test";
import { animationOf, character, feet, pick, step } from "../docs/design/playground.js";

const TUNING = {
  gravity: 3600, walkSpeed: 120, primitiveMs: 600, pokeCooldownMs: 2500, perchedIdleAfterMs: 4000,
  rideAcceleration: 10000, yankWindowS: 0.1, throwMinSpeed: 80, velocityWindowMs: 60, doubleClickMs: 400,
};
const LIGHT = { id: "light", x0: 100, x1: 400, y: 150, y1: 300 };
const WORLD = { width: 600, height: 300, sprite: { w: 90, h: 90 }, windows: [LIGHT] };

function run(state, events, world = WORLD) {
  const cues = [];
  for (const event of events) {
    const out = step(state, event, world, TUNING);
    state = out.state;
    if (out.cue) cues.push(out.cue);
  }
  return { state, cues };
}

const standing = (on, x, act = "idle", until = Infinity, facing = 1) => ({ mode: "standing", on, x, facing, act, until });
const ticks = (from, count, dt = 0.016, rand = 0) =>
  Array.from({ length: count }, (_, i) => ({ type: "tick", now: from + (i + 1) * dt * 1000, dt, rand }));

test("a click on a standing character plays react, then stands still through the poke cooldown", () => {
  const poked = run(standing("floor", 300), [{ type: "poke", now: 1000 }]);
  assert.equal(animationOf(poked.state), "react");
  assert.deepEqual(poked.cues, ["poke"]);
  const after = run(poked.state, [{ type: "tick", now: 1601, dt: 0.016, rand: 0.9 }]);
  assert.equal(animationOf(after.state), "idle");
  const still = run(after.state, [{ type: "tick", now: 3499, dt: 0.016, rand: 0.9 }]);
  assert.equal(animationOf(still.state), "idle");
  const moving = run(still.state, [{ type: "tick", now: 3501, dt: 0.016, rand: 0.9 }]);
  assert.equal(animationOf(moving.state), "walk");
});

test("an untouched character walks at the app's walk speed and turns at the desk wall", () => {
  const set_off = run(standing("floor", 300, "idle", 1000), [{ type: "tick", now: 1001, dt: 0.05, rand: 0.25 }]);
  assert.equal(animationOf(set_off.state), "walk");
  const walked = run(set_off.state, [{ type: "tick", now: 1051, dt: 0.05, rand: 0 }]);
  assert.equal(walked.state.x, 294);
  const atWall = run(standing("floor", 50, "walk", Infinity, -1), [{ type: "tick", now: 1, dt: 0.05, rand: 0 }]);
  assert.deepEqual([atWall.state.x, atWall.state.facing], [45, 1]);
});

test("a fast release throws, falls, and lands once against the wall with the hard puff", () => {
  const held = run(standing("floor", 300), [
    { type: "grab", now: 0 },
    { type: "drag", x: 300, y: 250, now: 20 },
    { type: "drag", x: 340, y: 200, now: 40 },
    { type: "drag", x: 380, y: 150, now: 60 },
  ]);
  assert.equal(animationOf(held.state), "hold");
  assert.deepEqual(held.cues, ["pickup"]);
  const thrown = run(held.state, [{ type: "release", now: 60 }]);
  assert.equal(animationOf(thrown.state), "fall");
  const landed = run(thrown.state, ticks(60, 120));
  assert.deepEqual(landed.cues, ["throw"]);
  assert.deepEqual([landed.state.mode, landed.state.on, landed.state.x], ["standing", "floor", 555]);
});

test("a slow release over the window drops onto its top edge and sits", () => {
  const held = run(standing("floor", 250), [
    { type: "grab", now: 0 },
    { type: "drag", x: 250, y: 200, now: 100 },
    { type: "drag", x: 250, y: 100, now: 200 },
  ]);
  const dropped = run(held.state, [{ type: "release", now: 500 }, ...ticks(500, 30)]);
  assert.deepEqual(dropped.cues, ["drop"]);
  assert.deepEqual([dropped.state.on, dropped.state.x, animationOf(dropped.state)], ["light", 250, "land"]);
  const settled = run(dropped.state, [{ type: "tick", now: 2000, dt: 0.016, rand: 0 }]);
  assert.equal(animationOf(settled.state), "sit");
});

test("walking off the end of the window falls to the floor with no cue", () => {
  const off = run(standing("light", 398, "walk", Infinity, 1), [{ type: "tick", now: 1, dt: 0.05, rand: 0 }]);
  assert.equal(animationOf(off.state), "fall");
  const down = run(off.state, ticks(1, 40));
  assert.deepEqual(down.cues, []);
  assert.deepEqual([down.state.mode, down.state.on], ["standing", "floor"]);
});

test("moving the window slowly carries a perched character, and a yank drops it", () => {
  const moved = { ...WORLD, windows: [{ ...LIGHT, x0: 105, x1: 405 }] };
  const carried = run(standing("light", 250, "sit"), [{ type: "carry", id: "light", dx: 5, dy: 0, vx: 300, vy: 0, now: 1000 }], moved);
  assert.deepEqual([carried.state.mode, carried.state.x], ["standing", 255]);
  const yanked = { ...WORLD, windows: [{ ...LIGHT, x0: 135, x1: 435 }] };
  const dropped = run(carried.state, [{ type: "carry", id: "light", dx: 30, dy: 0, vx: 1800, vy: 0, now: 1016 }], yanked);
  assert.deepEqual([dropped.state.mode, dropped.state.x, dropped.state.y], ["falling", 255, 150]);
});

test("moving another window leaves a perched character where it is", () => {
  const carried = run(standing("light", 250, "sit"), [{ type: "carry", id: "dark", dx: 40, dy: 0, vx: 300, vy: 0, now: 1000 }]);
  assert.deepEqual([carried.state.mode, carried.state.on, carried.state.x], ["standing", "light", 250]);
});

test("a drop over two overlapping windows perches on the higher top edge", () => {
  const world = { ...WORLD, windows: [LIGHT, { id: "dark", x0: 200, x1: 500, y: 120, y1: 300 }] };
  const held = run(standing("floor", 300), [{ type: "grab", now: 0 }, { type: "drag", x: 300, y: 60, now: 100 }], world);
  const dropped = run(held.state, [{ type: "release", now: 500 }, ...ticks(500, 30)], world);
  assert.deepEqual([dropped.state.on, dropped.cues], ["dark", ["drop"]]);
});

test("closing the window it sits on drops it to the floor", () => {
  const closed = run(standing("light", 250, "sit"), [{ type: "close", id: "light", y: 150, now: 1000 }], { ...WORLD, windows: [] });
  const down = run(closed.state, ticks(1000, 40), { ...WORLD, windows: [] });
  assert.deepEqual([down.state.on, down.cues], ["floor", ["drop"]]);
});

test("a second click within the double-click time summons instead of poking, once per pair", () => {
  const clicks = (...times) => run(standing("floor", 300), times.map((now) => ({ type: "poke", now }))).cues;
  assert.deepEqual(clicks(1000, 1300), ["poke", "summon"]);
  assert.deepEqual(clicks(1000, 1300, 1500), ["poke", "summon", "poke"]);
  assert.deepEqual(clicks(1000, 1500), ["poke", "poke"]);
});

test("a held tick keeps a walking character in place while the quick-message pill is up", () => {
  const walking = standing("floor", 300, "walk");
  assert.equal(run(walking, [{ type: "tick", now: 1, dt: 0.05, rand: 0, hold: true }]).state.x, 300);
  assert.equal(run(walking, [{ type: "tick", now: 1, dt: 0.05, rand: 0 }]).state.x, 306);
});

// Windows are listed frontmost first, as the Engine's snapshot is. Here the
// chat sits in front of the light window and covers its top edge from x 300 on.
const CHAT = { id: "chat", x0: 300, x1: 550, y: 100, y1: 260 };
const STACKED = { ...WORLD, windows: [CHAT, LIGHT] };

test("a slow drop above the chat window perches on its top edge and sits", () => {
  const held = run(standing("floor", 450), [{ type: "grab", now: 0 }, { type: "drag", x: 450, y: 95, now: 100 }], STACKED);
  const dropped = run(held.state, [{ type: "release", now: 500 }, ...ticks(500, 10)], STACKED);
  const sat = run(dropped.state, ticks(1200, 1), STACKED);
  assert.deepEqual([dropped.state.on, dropped.cues, animationOf(sat.state)], ["chat", ["drop"], "sit"]);
});

test("a drop inside the front window does not land on an edge hidden behind it", () => {
  const held = run(standing("floor", 350), [{ type: "grab", now: 0 }, { type: "drag", x: 350, y: 130, now: 100 }], STACKED);
  const dropped = run(held.state, [{ type: "release", now: 500 }, ...ticks(500, 40)], STACKED);
  assert.equal(dropped.state.on, "floor");
});

test("walking along a window into one stacked in front climbs onto the front one, not through it", () => {
  const walked = run(standing("light", 290, "walk"), ticks(0, 10, 0.05), STACKED);
  assert.deepEqual([walked.state.mode, walked.state.on], ["standing", "chat"]);
  const behind = run(standing("light", 290, "walk"), ticks(0, 10, 0.05), { ...WORLD, windows: [LIGHT, CHAT] });
  assert.deepEqual([behind.state.on, behind.state.x], ["light", 350], "a chat behind the light window is no obstacle");
});

test("a perch whose edge a window in front now covers drops the character", () => {
  const covered = run(standing("light", 350, "sit"), ticks(0, 1), STACKED);
  assert.equal(covered.state.mode, "falling");
});

test("dragging a window up under a perched character's feet takes it onto that window", () => {
  // The chat came up 40px, from a top edge at 180, below the feet, to one at 140.
  const raised = { ...WORLD, windows: [{ ...CHAT, y: 140, y1: 300 }, LIGHT] };
  const moved = run(standing("light", 350, "sit"), [{ type: "carry", id: "chat", dx: 0, dy: -40, vx: 0, vy: -200, now: 1000 }], raised);
  assert.deepEqual([moved.state.mode, moved.state.on], ["standing", "chat"]);
});

test("a window dragged up too close to the desk top to stand on drops the character", () => {
  const high = { ...WORLD, windows: [{ ...LIGHT, y: 60 }] };
  const moved = run(standing("light", 250, "sit"), [{ type: "carry", id: "light", dx: 0, dy: -90, vx: 0, vy: -300, now: 1000 }], high);
  assert.equal(moved.state.mode, "falling");
});

test("a character nobody touches for the nap delay sits, then sleeps until a poke wakes it", () => {
  const quiet = { ...standing("floor", 300, "idle", 20_000), quietSince: 0 };
  const sat = run(quiet, [{ type: "tick", now: 20_001, dt: 0.016, rand: 0 }]);
  assert.equal(animationOf(sat.state), "sit");
  const asleep = run(sat.state, [{ type: "tick", now: 30_000, dt: 0.016, rand: 0 }, { type: "tick", now: 900_000, dt: 0.016, rand: 0 }]);
  assert.equal(animationOf(asleep.state), "sleep");
  const woken = run(asleep.state, [{ type: "poke", now: 900_001 }]);
  assert.deepEqual([animationOf(woken.state), woken.cues], ["react", ["poke"]]);
});

test("a recent touch keeps the character wandering instead of napping", () => {
  const touched = { ...standing("floor", 300, "idle", 20_000), quietSince: 15_000 };
  assert.equal(animationOf(run(touched, [{ type: "tick", now: 20_001, dt: 0.016, rand: 0 }]).state), "walk");
});

test("a scroll startles a napping character into react with no cue, and never pairs into a summon", () => {
  const asleep = { ...standing("floor", 300, "sleep"), quietSince: 0 };
  const startled = run(asleep, [{ type: "startle", now: 1000 }]);
  assert.deepEqual([animationOf(startled.state), startled.cues], ["react", []]);
  const sitting = { ...standing("floor", 300, "sit", 5000), quietSince: 0 };
  assert.equal(animationOf(run(sitting, [{ type: "startle", now: 1000 }]).state), "react");
  assert.deepEqual(run(asleep, [{ type: "startle", now: 1000 }, { type: "poke", now: 1200 }]).cues, ["poke"]);
});

test("a long scroll past an awake character never startles it, so it keeps idling and walking", () => {
  const scrolls = (from, ms) => Array.from({ length: ms / 16 }, (_, i) => [
    { type: "startle", now: from + i * 16 }, { type: "tick", now: from + i * 16, dt: 0.016, rand: 0.9 }]).flat();
  for (const act of ["idle", "walk"]) {
    const awake = { ...standing("floor", 300, act, 2000), quietSince: 0 };
    const seen = new Set();
    let state = awake;
    for (const event of scrolls(0, 10_000)) {
      state = step(state, event, WORLD, TUNING).state;
      seen.add(animationOf(state));
    }
    assert.ok(!seen.has("react"), `scrolling past a character that is ${act} played ${[...seen]}`);
  }
});

test("a scroll keeps the character awake for another nap delay", () => {
  const quiet = { ...standing("floor", 300, "idle", 20_000), quietSince: 0 };
  const scrolled = run(quiet, [{ type: "startle", now: 19_000 }, { type: "tick", now: 25_000, dt: 0.016, rand: 0.9 }]);
  assert.notEqual(animationOf(scrolled.state), "sit");
});

test("a still tick, for reduced motion, idles instead of walking and still naps", () => {
  const idle = { ...standing("floor", 300, "idle", 1000), quietSince: 0 };
  assert.equal(animationOf(run(idle, [{ type: "tick", now: 1001, dt: 0.016, rand: 0.9, still: true }]).state), "idle");
  assert.equal(animationOf(run(idle, [{ type: "tick", now: 20_001, dt: 0.016, rand: 0.9, still: true }]).state), "sit");
});

// The page character hands over to the playground by walking down past the
// floor, and comes back the same way. A floor-only world, as the page's.
const PAGE = { width: 1200, height: 800, sprite: { w: 90, h: 90 }, windows: [] };

test("leaving walks down past the floor at walk speed and ends away, where nothing reaches it", () => {
  const leaving = run(standing("floor", 300, "walk"), [{ type: "leave", now: 0 }], PAGE);
  assert.equal(animationOf(leaving.state), "walk");
  const sinking = run(leaving.state, ticks(0, 5, 0.05), PAGE);
  assert.deepEqual([feet(sinking.state, PAGE).y, feet(sinking.state, PAGE).x], [830, 300], "walks in place, 30px under the floor");
  const away = run(sinking.state, ticks(250, 20, 0.05), PAGE);
  assert.equal(away.state.mode, "away");
  const ignored = run(away.state, [{ type: "poke", now: 2000 }, { type: "grab", now: 2001 }, { type: "startle", now: 2002 },
    ...ticks(2002, 3)], PAGE);
  assert.deepEqual([ignored.state, ignored.cues], [away.state, []]);
});

test("entering walks up from under the floor where it left, then idles awake", () => {
  const entering = run({ mode: "away", x: 300, facing: -1 }, [{ type: "enter", now: 0 }], PAGE);
  assert.deepEqual([animationOf(entering.state), feet(entering.state, PAGE).y], ["walk", 890]);
  const up = run(entering.state, ticks(0, 20, 0.05), PAGE);
  assert.deepEqual([animationOf(up.state), feet(up.state, PAGE).y, up.state.x], ["idle", 800, 300]);
});

test("a character passing the floor shrugs off pokes, grabs and scrolls, and an enter turns a leave around", () => {
  const leaving = run(standing("floor", 300), [{ type: "leave", now: 0 }, ...ticks(0, 5, 0.05)], PAGE);
  const poked = run(leaving.state, [{ type: "poke", now: 300 }, { type: "grab", now: 301 }, { type: "startle", now: 302 }], PAGE);
  assert.deepEqual([poked.state, poked.cues], [leaving.state, []]);
  const back = run(leaving.state, [{ type: "enter", now: 300 }, ...ticks(300, 10, 0.05)], PAGE);
  assert.deepEqual([animationOf(back.state), feet(back.state, PAGE).y], ["idle", 800]);
});

test("a held, falling or perched character does not leave until it stands on the floor", () => {
  const held = run(standing("floor", 300), [{ type: "grab", now: 0 }, { type: "leave", now: 1 }], PAGE);
  assert.equal(held.state.mode, "held");
  assert.equal(run(standing("light", 250, "sit"), [{ type: "leave", now: 1 }]).state.act, "sit");
});

test("under reduced motion, leaving and entering skip the walk", () => {
  assert.equal(run(standing("floor", 300), [{ type: "leave", now: 0, still: true }], PAGE).state.mode, "away");
  const back = run({ mode: "away", x: 300, facing: 1 }, [{ type: "enter", now: 0, still: true }], PAGE);
  assert.deepEqual([animationOf(back.state), feet(back.state, PAGE).y], ["idle", 800]);
});

test("away puts any character out of sight at once, wherever it was", () => {
  const held = run(standing("floor", 300), [{ type: "grab", now: 0 }, { type: "away", now: 1 }]);
  assert.deepEqual(held.state, { mode: "away", x: 300, facing: 1 });
});

test("Buddy Bot plays until a pick, with no random draw, and every reader gets the pick", () => {
  const cast = { "buddy-bot": {}, nim: {}, "timber-wolf": {} };
  assert.equal(character(cast, "buddy-bot"), "buddy-bot");
  assert.equal(character(cast, "buddy-bot"), "buddy-bot", "a second reader gets the same Character");
  pick("timber-wolf");
  assert.equal(character(cast, "buddy-bot"), "timber-wolf");
  pick("not-in-the-cast");
  assert.equal(character(cast, "buddy-bot"), "buddy-bot", "a pick the cast lacks falls back to Buddy Bot");
});
