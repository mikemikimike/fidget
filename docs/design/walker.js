// The landing page's own Character, along the bottom of the viewport. It is
// the playground's Character too, handed over while the playground is in view.
// update() decides and touches no DOM, so node tests it; step() moves it.

import { animationOf, character, decodePresses, feet, frameOf, step } from "./playground.js";

// The page origin is shared with other Pages sites, hence the prefix.
const HIDDEN_KEY = "fidget.hidden";

// When it next says a line, in ms: the first soon enough that a reader sees
// one, then a minute or two apart.
const LINES = { first: [6000, 15000], gap: [60000, 120000] };

const span = ([low, high], roll) => low + (high - low) * roll;

// phase is who has the Character:
//   page: the page, walking on and off below the bottom edge included;
//   away: nobody, as the hero's stage, with its own fidget, is on screen;
//   lent: the playground;
//   hidden: nobody, as the visitor hid it.
// The playground starts with it, and view stays null until the page knows
// whether the playground is in sight. It first walks up on a side the visit
// rolls.
export function start({ now, rand, width, hidden = false, still = false }) {
  return {
    phase: hidden ? "hidden" : "lent",
    sprite: { mode: "away", x: rand < 0.5 ? 0 : width, facing: rand < 0.5 ? 1 : -1 },
    still,
    view: null,
    speech: null,
    nextLine: now + span(LINES.first, rand),
  };
}

// It walks up in the `margin` beside the content column, or against the edge
// when the margin is narrower than it is, facing the page: never over text.
function inMargin(sprite, left, width, margin, spriteW) {
  const inset = Math.max(margin, spriteW) / 2;
  return { ...sprite, x: left ? inset : width - inset, facing: left ? 1 : -1 };
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
// the playground or the hero's stage is in view, on it otherwise. The
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
    const { width, sprite } = env.world;
    const from = next.sprite.mode === "away"
      ? inMargin(next.sprite, next.sprite.x < width / 2, width, env.margin(), sprite.w)
      : next.sprite;
    next = { ...next, phase: "page", sprite: move(from, { type: "enter" }) };
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

function remember(hidden) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage is off: Hide lasts this page.
  }
}

function hiddenBefore() {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

// The page half: one frame loop, which a hidden tab does not run, pointer
// events in, and frames, cues and the bubble out. `play` is the playground's
// handle, or null when it is not mounted.
export function mount(doc, data, { cue, bubble, play, still }) {
  const layer = doc.getElementById("fidget");
  const at = doc.getElementById("fidget-at");
  const sprite = doc.getElementById("fidget-sprite");
  const img = sprite.querySelector("img");
  const say = doc.getElementById("fidget-say");
  const back = doc.getElementById("fidget-back");
  const stage = doc.querySelector(".stage");
  const narrow = matchMedia("(max-width: 480px)");
  const me = data.cast[character(data.cast, data.hero)];
  const { loops } = me;
  const [w, h] = me.size;
  Object.assign(img, { alt: me.name, width: w, height: h });
  img.classList.toggle("pixel", me.pixel);
  sprite.style.width = `${w}px`;
  sprite.style.height = `${h}px`;
  if (!still) Object.values(loops).flatMap((loop) => loop.frames).forEach((src) => { new Image().src = src; });
  layer.hidden = false;

  const world = () => ({ width: doc.documentElement.clientWidth, height: innerHeight, sprite: { w, h }, windows: [] });
  const column = doc.querySelector(".wrap");
  const margin = () => column.getBoundingClientRect().left + parseFloat(getComputedStyle(column).paddingLeft);
  const env = () => ({ world: world(), tuning: data.tuning, lines: me.lines, sayMs: bubble.bubbleDuration, margin });
  const feetNow = () => feet(state.sprite, world());
  const io = cue.cueIo(doc.getElementById("fidget-cues"), () => {
    const f = feetNow();
    return { x: f.x, y: f.y - h / 2, feetX: f.x, feetY: f.y };
  });
  // Visual only, as on the desk.
  const cues = cue.createCueMachine({ draw: io.draw, sound: () => () => {} });
  let state = start({ now: performance.now(), rand: Math.random(), width: world().width,
    hidden: hiddenBefore(), still });
  back.hidden = state.phase !== "hidden";
  let pending = 0;
  const apply = (event) => {
    const out = update(state, event, env());
    state = out.state;
    if (out.cue) cues.event({ cue: out.cue, visible: true, sound: false });
    if (out.handoff === "arrive") play?.arrive();
    if (out.handoff === "depart") play?.depart();
  };

  // Where the playground and the hero's stage are. Without a playground it is
  // never in view. The stage counts until it is scrolled away above, so the
  // page's fidget first shows below it and never beside the hero's.
  const view = { play: play ? null : false, blocked: false };
  const report = () => {
    if (view.play !== null) apply({ type: "view", ...view });
  };
  const desk = doc.getElementById("play-desk");
  if (play && desk) {
    // In once most of the desk shows, out only once none does: between the two
    // nothing changes, so a reader resting at the edge does not bounce it.
    new IntersectionObserver(([entry]) => {
      const next = entry.intersectionRatio >= 0.6 ? true : entry.isIntersecting ? view.play : false;
      if (next === view.play) return;
      view.play = next;
      report();
    }, { threshold: [0, 0.6] }).observe(desk);
  }

  let touched = 0;
  decodePresses(sprite, data.tuning, {
    local: (event) => ({ x: event.clientX, y: event.clientY }),
    feetNow,
    apply,
    grabbable: () => !still && !narrow.matches,
    // A finger has no hover to show the Hide chip, so a press shows it a while.
    onPress: () => {
      at.classList.add("touched");
      clearTimeout(touched);
      touched = setTimeout(() => at.classList.remove("touched"), 4000);
    },
  });
  addEventListener("scroll", () => apply({ type: "startle", now: performance.now() }), { passive: true });

  doc.getElementById("fidget-hide").addEventListener("click", () => {
    apply({ type: "hide" });
    remember(true);
    back.hidden = false;
  });
  back.addEventListener("click", () => {
    apply({ type: "show" });
    remember(false);
    back.hidden = true;
    if (!pending) pending = requestAnimationFrame(frame);
  });

  let playing = null;
  let since = 0;
  let last = null;
  let shown = null;
  let size = null;
  function draw(now) {
    const away = state.sprite.mode === "away";
    if (at.hidden !== away) at.hidden = away;
    const line = state.speech?.line ?? null;
    if (line !== shown) {
      shown = line;
      say.classList.toggle("visible", line !== null);
      if (line !== null) {
        say.querySelector(".bubble-content").textContent = line;
        size = { width: say.offsetWidth, height: say.offsetHeight };
      }
    }
    if (away) return;
    const name = animation(state, now);
    if (name !== playing) {
      playing = name;
      since = now;
    }
    // Reduced motion shows each animation's first frame and does not cycle it.
    const src = frameOf(loops[name], still ? 0 : now - since);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    const f = feetNow();
    // Written only on change, so a Character standing still costs no style work.
    const moved = `translate(${f.x - w / 2}px, ${f.y - h}px)`;
    if (at.style.transform !== moved) at.style.transform = moved;
    const facing = state.sprite.facing < 0 ? "scaleX(-1)" : "";
    if (sprite.style.transform !== facing) sprite.style.transform = facing;
    if (line !== null) {
      const room = world();
      const spot = bubble.placeBubble({ x: f.x - w / 2, y: f.y - h, width: w, height: h }, size,
        { x: 0, y: 0, width: room.width, height: room.height });
      say.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
      say.style.setProperty("--tail-offset", `${spot.tailOffset}px`);
      say.classList.toggle("inverted", spot.inverted);
    }
  }
  function frame(now) {
    if (stage) {
      const blocked = stage.getBoundingClientRect().bottom > 0;
      if (blocked !== view.blocked) {
        view.blocked = blocked;
        report();
      }
    }
    apply({ type: "tick", now, dt: last === null ? 0 : (now - last) / 1000, rand: Math.random() });
    last = now;
    draw(now);
    // A hidden Character needs no frames until it is brought back.
    pending = state.phase === "hidden" ? 0 : requestAnimationFrame(frame);
  }
  report();
  pending = requestAnimationFrame(frame);
}
