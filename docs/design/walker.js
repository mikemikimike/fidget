// The landing page's own Character, along the bottom of the viewport. It is
// the playground's Character too, handed over while the playground is in view.
// update() decides and touches no DOM, so node tests it; step() moves it.

import { animationOf, step } from "./playground.js";

// When it next says a line, in ms: the first soon enough that a reader sees
// one, then a minute or two apart.
const LINES = { first: [6000, 15000], gap: [60000, 120000] };

const span = ([low, high], roll) => low + (high - low) * roll;

// phase is who has the Character:
//   page: the page, walking on and off below the bottom edge included;
//   away: nobody, as the download buttons sit in its band;
//   lent: the playground;
//   hidden: nobody, as the visitor hid it.
// The playground starts with it, and view stays null until the page knows
// whether the playground is in sight.
export function start({ now, rand, width, hidden = false, still = false }) {
  return {
    phase: hidden ? "hidden" : "lent",
    sprite: { mode: "away", x: width * (0.2 + 0.6 * rand), facing: rand < 0.5 ? -1 : 1 },
    still,
    view: null,
    speech: null,
    nextLine: now + span(LINES.first, rand),
  };
}

const speaking = (state, now) => state.speech !== null && now < state.speech.until;
const talkable = (sprite) => sprite.mode === "standing" && (sprite.act === "idle" || sprite.act === "walk");

export function animation(state, now) {
  return speaking(state, now) && talkable(state.sprite) ? "talk" : animationOf(state.sprite);
}

function say(state, now, rand, env) {
  const line = env.lines[Math.floor(rand * env.lines.length)];
  const until = now + env.sayMs(line);
  return { ...state, speech: { line, until }, nextLine: until + span(LINES.gap, rand) };
}

// Each tick walks the Character toward where it is wanted: off the page while
// the playground or the download buttons are in view, on it otherwise. The
// page hands it to the playground only once it is out of sight, so the page
// never shows two.
function tick(state, event, env) {
  const { now, rand } = event;
  const move = (sprite, extra) => step(sprite, { now, still: state.still, ...extra }, env.world, env.tuning).state;
  let next = speaking(state, now) ? state : { ...state, speech: null };
  const hold = speaking(next, now) && talkable(next.sprite);
  const out = step(next.sprite, { ...event, still: state.still, hold }, env.world, env.tuning);
  next = { ...next, sprite: out.state };
  if (state.view === null || state.phase === "hidden") return { state: next, cue: out.cue, handoff: null };

  const wanted = state.view.play || state.view.blocked ? "leave" : "enter";
  let handoff = null;
  if (next.phase === "page") {
    next = { ...next, sprite: move(next.sprite, { type: wanted }) };
    if (next.sprite.mode === "away") {
      next = { ...next, phase: state.view.play ? "lent" : "away", speech: null };
      handoff = state.view.play ? "arrive" : null;
    }
  } else if (next.phase === "away" && state.view.play) {
    next = { ...next, phase: "lent" };
    handoff = "arrive";
  } else if (wanted === "enter") {
    next = { ...next, phase: "page", sprite: move(next.sprite, { type: "enter" }) };
    handoff = state.phase === "lent" ? "depart" : null;
  }
  if (next.phase === "page" && !speaking(next, now) && now >= next.nextLine && talkable(next.sprite)) {
    next = say(next, now, rand, env);
  }
  return { state: next, cue: out.cue, handoff };
}

export function update(state, event, env) {
  const unchanged = { state, cue: null, handoff: null };
  if (event.type === "view") return { ...unchanged, state: { ...state, view: { play: event.play, blocked: event.blocked } } };
  if (event.type === "hide") {
    const lend = state.phase === "page" || state.phase === "away";
    const hidden = { ...state, phase: "hidden", speech: null, sprite: { mode: "away", x: state.sprite.x, facing: state.sprite.facing } };
    return { state: hidden, cue: null, handoff: lend ? "arrive" : null };
  }
  if (event.type === "show") return state.phase === "hidden" ? { ...unchanged, state: { ...state, phase: "lent" } } : unchanged;
  if (event.type === "tick") return tick(state, event, env);
  if (state.phase !== "page") return unchanged;
  const out = step(state.sprite, event, env.world, env.tuning);
  let next = { ...state, sprite: out.state };
  if (event.type === "grab") next = { ...next, speech: null };
  // The page has no chat to summon, so a double click is two pokes.
  const cue = out.cue === "summon" ? "poke" : out.cue;
  if (cue === "poke" && !speaking(next, event.now)) next = say(next, event.now, event.rand ?? 0, env);
  return { state: next, cue, handoff: null };
}
