// The playground desk on the landing page. step() is the
// whole behavior, so these drive it the way the page's pointer handlers do.

import assert from "node:assert/strict";
import { test } from "node:test";
import { animationOf, step } from "../docs/design/playground.js";

const TUNING = {
  gravity: 3600, walkSpeed: 120, primitiveMs: 600, pokeCooldownMs: 2500, perchedIdleAfterMs: 4000,
  rideAcceleration: 10000, yankWindowS: 0.1, throwMinSpeed: 80, velocityWindowMs: 60, doubleClickMs: 400,
};
const LIGHT = { id: "light", x0: 100, x1: 400, y: 150 };
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
  const world = { ...WORLD, windows: [LIGHT, { id: "dark", x0: 200, x1: 500, y: 120 }] };
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
