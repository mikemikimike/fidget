// The landing page's live playground: one Character and the windows it can
// perch on. step() is the whole behavior and touches no DOM, so node tests it.

// How long an untouched Character idles, then walks, in ms. The page's own
// numbers: in the app the Director picks what comes next.
const WANDER = { idle: [1500, 4000], walk: [1200, 3500] };

// Nobody has poked, thrown or scrolled for `after` ms: sit for `sit` ms, then
// sleep until woken. Page numbers too, shorter than the app's auto-sleep so a
// reader sees it.
const NAP = { after: 20000, sit: 4000 };

// A tab that was away for seconds comes back one short step later, not teleported.
const MAX_DT = 0.05;

const span = ([low, high], roll) => low + (high - low) * roll;

function wander(state, now, rand, still) {
  if (state.act === "idle" && !still) {
    return { ...state, act: "walk", facing: rand < 0.5 ? -1 : 1, until: now + span(WANDER.walk, (rand * 2) % 1) };
  }
  return { ...state, act: "idle", until: now + span(WANDER.idle, rand) };
}

function timeUp(state, now, rand, tuning, still) {
  if (state.act === "react") return { ...state, act: "idle", until: now + tuning.pokeCooldownMs - tuning.primitiveMs };
  if (state.act === "land" && state.on !== "floor") return { ...state, act: "sit", until: now + tuning.perchedIdleAfterMs };
  if (now - (state.quietSince ?? now) >= NAP.after) {
    return state.act === "sit" ? { ...state, act: "sleep", until: Infinity } : { ...state, act: "sit", until: now + NAP.sit };
  }
  return wander(state, now, rand, still);
}

function clampX(x, world) {
  const half = world.sprite.w / 2;
  return Math.min(world.width - half, Math.max(half, x));
}

const windowOf = (world, id) => world.windows.find((win) => win.id === id);

function walk(state, dt, world, tuning) {
  const vx = state.facing * tuning.walkSpeed;
  const x = state.x + vx * dt;
  const edge = windowOf(world, state.on);
  if (edge && (x < edge.x0 || x > edge.x1)) {
    return { mode: "falling", x, y: edge.y, vx, vy: 0, facing: state.facing, landing: null };
  }
  const clamped = clampX(x, world);
  const walked = { ...state, x: clamped, facing: clamped === x ? state.facing : -state.facing };
  return edge ? settle(walked, { x: state.x, y: edge.y }, world) : walked;
}

export function feet(state, world) {
  if (state.mode !== "standing") return { x: state.x, y: state.y };
  return { x: state.x, y: state.on === "floor" ? world.height + (state.sunk ?? 0) : windowOf(world, state.on).y };
}

// world.windows is frontmost first, as the Engine's snapshot is, and these
// follow its geometry.rs: a top edge is somewhere to stand only where no
// window in front covers it and the character has room above it.
const spans = (win, x) => x >= win.x0 && x <= win.x1;
const contains = (win, at) => spans(win, at.x) && win.y < at.y && at.y < win.y1;
function edgeVisible(world, index, x) {
  const win = world.windows[index];
  return spans(win, x) && win.y >= world.sprite.h && !world.windows.slice(0, index).some((front) =>
    spans(front, x) && win.y >= front.y && win.y <= front.y1);
}

// The nearest visible top edge the feet crossed going from fromY down to toY,
// else the floor once they reach it.
function ledgeCrossed(world, x, fromY, toY) {
  const crossed = world.windows
    .filter((edge, index) => edgeVisible(world, index, x) && fromY <= edge.y && toY >= edge.y)
    .sort((a, b) => a.y - b.y)[0];
  if (crossed) return crossed.id;
  return toY >= world.height ? "floor" : null;
}

// Where a perched character stands after it or a window moved: onto a window
// in front that has come to contain its feet (from the point it was at, against
// that window as it was), else on its own edge while that stays visible, else
// it falls. The floor is in front of every window, so it is exempt.
function settle(state, from, world, before = (win) => win) {
  const index = world.windows.findIndex((win) => win.id === state.on);
  if (index < 0) return state;
  const at = { x: state.x, y: world.windows[index].y };
  const lifted = world.windows.slice(0, index)
    .filter((win, front) => contains(win, at) && !contains(before(win), from) && edgeVisible(world, front, at.x))
    .sort((a, b) => a.y - b.y)[0];
  if (lifted) return { ...state, on: lifted.id };
  return edgeVisible(world, index, at.x) ? state : letGo(state, at.y);
}

// Velocity over the last velocityWindowMs of the drag, as input.rs measures a Throw.
function releaseVelocity(samples, now, tuning) {
  const recent = samples.filter((sample) => sample.t >= now - tuning.velocityWindowMs);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const seconds = (last.t - first.t) / 1000;
  return seconds > 0 ? { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds } : { x: 0, y: 0 };
}

function fall(state, event, world, tuning) {
  const dt = Math.min(event.dt, MAX_DT);
  let vx = state.vx;
  let vy = state.vy + tuning.gravity * dt;
  const free = state.x + vx * dt;
  const x = clampX(free, world);
  if (x !== free) vx = 0;
  let y = state.y + vy * dt;
  if (y < world.sprite.h) {
    y = world.sprite.h;
    vy = Math.max(vy, 0);
  }
  const on = vy > 0 ? ledgeCrossed(world, x, state.y, y) : null;
  if (on) {
    const landed = { mode: "standing", on, x, facing: state.facing, act: "land", until: event.now + tuning.primitiveMs,
      quietSince: event.now };
    return { state: landed, cue: state.landing };
  }
  return { state: { ...state, x, y, vx, vy }, cue: null };
}

const letGo = (state, y) => ({ mode: "falling", x: state.x, y, vx: 0, vy: 0, facing: state.facing, landing: "drop" });

// The engine's yank gate: a change in the window's speed larger than
// rideAcceleration * yankWindowS, against its speed about yankWindowS ago, drops the sprite.
function carry(state, event, world, tuning) {
  const windowMs = tuning.yankWindowS * 1000;
  const ride = (state.ride ?? []).filter((sample) => sample.t >= event.now - windowMs);
  const reference = ride[0] ?? { vx: 0, vy: 0 };
  if (Math.hypot(event.vx - reference.vx, event.vy - reference.vy) > tuning.rideAcceleration * tuning.yankWindowS) {
    return letGo(state, windowOf(world, event.id).y - event.dy);
  }
  const carried = { ...state, x: clampX(state.x + event.dx, world), ride: [...ride, { t: event.now, vx: event.vx, vy: event.vy }] };
  return settle(carried, { x: state.x, y: windowOf(world, event.id).y - event.dy }, world);
}

// A second click within doubleClickMs is a Summon in place of its Poke, and a
// third starts a new pair, as input.rs decodes them. Both play react.
function poke(state, now, tuning) {
  const summon = now - (state.pokedAt ?? -Infinity) <= tuning.doubleClickMs && !state.summoned;
  const reacting = { ...state, act: "react", until: now + tuning.primitiveMs, pokedAt: now, summoned: summon, quietSince: now };
  return { state: reacting, cue: summon ? "summon" : "poke" };
}

function start(world, now) {
  return { mode: "standing", on: "floor", x: world.width / 2, facing: 1, act: "idle", until: now + WANDER.idle[0], quietSince: now };
}

// A scroll is not a click: it plays react with no cue and never pairs into a
// Summon. Only a napping character startles, as a reader scrolls for seconds
// and a react every cooldown reads as a twitch. Every scroll keeps it awake.
function startle(state, now, tuning) {
  const awake = { ...state, quietSince: now };
  if (state.act !== "sit" && state.act !== "sleep") return awake;
  return { ...awake, act: "react", until: now + tuning.primitiveMs };
}

export const away = ({ x, facing }) => ({ mode: "away", x, facing });

// Leaving walks in place down past the floor until out of sight, and entering
// walks back up. The page character hands over to the playground this way, as
// the playground's desk and the viewport both clip below their floor.
const passing = (state) => state.act === "leave" || state.act === "enter";

const arrived = (state, now) => {
  const { sunk, ...standing } = state;
  return { ...standing, act: "idle", until: now + WANDER.idle[0] };
};

function pass(state, event, world, tuning) {
  const sunk = state.sunk + (state.act === "leave" ? 1 : -1) * tuning.walkSpeed * Math.min(event.dt, MAX_DT);
  if (sunk >= world.sprite.h) return away(state);
  return sunk <= 0 ? arrived(state, event.now) : { ...state, sunk };
}

function leave(state, event) {
  if (state.mode !== "standing" || state.on !== "floor" || state.act === "leave") return state;
  if (event.still) return away(state);
  return { ...state, act: "leave", sunk: state.sunk ?? 0, until: Infinity };
}

function enter(state, event, world) {
  if (state.mode === "away") {
    const below = { mode: "standing", on: "floor", x: state.x, facing: state.facing, act: "enter", sunk: world.sprite.h,
      until: Infinity, quietSince: event.now };
    return event.still ? arrived(below, event.now) : below;
  }
  return state.act === "leave" ? { ...state, act: "enter" } : state;
}

// The visit's Character, which the playground and the page character both
// play. A picker is its one writer; until a pick, `fallback` plays. Session
// storage, as a pick lasts the visit.
const CHARACTER_KEY = "fidget.character";
let current = null;

export function pick(id) {
  current = id;
  try {
    sessionStorage.setItem(CHARACTER_KEY, id);
  } catch {
    // Storage is off: the pick still holds for this page.
  }
}

export function character(cast, fallback) {
  let picked = current;
  if (picked === null) {
    try {
      picked = sessionStorage.getItem(CHARACTER_KEY);
    } catch {
      // Storage is off: nothing was picked.
    }
  }
  return picked !== null && Object.hasOwn(cast, picked) ? picked : fallback;
}

export function animationOf(state) {
  if (state.mode === "held") return "hold";
  if (state.mode === "falling") return "fall";
  if (state.mode === "away" || passing(state)) return "walk";
  return state.act;
}

export function step(state, event, world, tuning) {
  const unchanged = { state, cue: null };
  if (event.type === "away") return { state: away(state), cue: null };
  if (event.type === "leave") return { state: leave(state, event), cue: null };
  if (event.type === "enter") return { state: enter(state, event, world), cue: null };
  if (state.mode === "away") return unchanged;
  if (passing(state)) return event.type === "tick" ? { state: pass(state, event, world, tuning), cue: null } : unchanged;
  if (event.type === "poke") {
    if (state.mode !== "standing") return unchanged;
    return poke(state, event.now, tuning);
  }
  if (event.type === "startle") {
    return state.mode === "standing" ? { state: startle(state, event.now, tuning), cue: null } : unchanged;
  }
  if (event.type === "grab") {
    const at = feet(state, world);
    const held = { mode: "held", x: at.x, y: at.y, facing: state.facing, samples: [{ t: event.now, ...at }] };
    return { state: held, cue: "pickup" };
  }
  if (event.type === "drag" && state.mode === "held") {
    const x = clampX(event.x, world);
    const y = Math.min(world.height, Math.max(world.sprite.h, event.y));
    const samples = [...state.samples, { t: event.now, x, y }].filter((s) => s.t >= event.now - tuning.velocityWindowMs);
    return { state: { ...state, x, y, samples }, cue: null };
  }
  if (event.type === "release" && state.mode === "held") {
    const v = releaseVelocity([...state.samples, { t: event.now, x: state.x, y: state.y }], event.now, tuning);
    const thrown = Math.hypot(v.x, v.y) >= tuning.throwMinSpeed;
    const facing = thrown && v.x !== 0 ? Math.sign(v.x) : state.facing;
    const falling = { mode: "falling", x: state.x, y: state.y, vx: thrown ? v.x : 0, vy: thrown ? v.y : 0,
      facing, landing: thrown ? "throw" : "drop" };
    return { state: falling, cue: null };
  }
  const perchedOn = (id) => state.mode === "standing" && state.on === id;
  if (event.type === "carry") {
    if (perchedOn(event.id)) return { state: carry(state, event, world, tuning), cue: null };
    if (state.mode !== "standing" || state.on === "floor") return unchanged;
    // Another window moved: it may have come up under the feet or over them.
    const moved = (win) => (win.id === event.id ? { ...win, x0: win.x0 - event.dx, x1: win.x1 - event.dx,
      y: win.y - event.dy, y1: win.y1 - event.dy } : win);
    return { state: settle(state, feet(state, world), world, moved), cue: null };
  }
  if (event.type === "close") {
    return perchedOn(event.id) ? { state: letGo(state, event.y), cue: null } : unchanged;
  }
  if (event.type === "tick" && state.mode === "falling") return fall(state, event, world, tuning);
  if (event.type === "tick" && state.mode === "standing" && !event.hold) {
    // A window raised over the perch hides its edge.
    if (state.on !== "floor") {
      const settled = settle(state, feet(state, world), world);
      if (settled !== state) return { state: settled, cue: null };
    }
    if (event.now >= state.until) return { state: timeUp(state, event.now, event.rand, tuning, event.still), cue: null };
    if (state.act === "walk") return { state: walk(state, Math.min(event.dt, MAX_DT), world, tuning), cue: null };
  }
  return unchanged;
}

// The frame a loop shows `elapsed` ms after it started: a `once` loop holds
// its last frame, any other wraps.
export function frameOf(loop, elapsed) {
  const index = Math.floor((elapsed * loop.fps) / 1000);
  return loop.frames[loop.once ? Math.min(index, loop.frames.length - 1) : index % loop.frames.length];
}

// Press decoding as in input.rs: a Grab once a press moves dragThreshold or
// is held dragDelayMs, else a Poke on release. A drag keeps the feet's offset
// from the press point, taken at the Grab. Returns a check for a press
// under way.
export function decodePresses(target, tuning, { local, feetNow, apply, grabbable = () => true, onPress = () => {} }) {
  let press = null;
  const grab = () => {
    if (!press || press.held) return;
    clearTimeout(press.timer);
    const at = feetNow();
    press = { ...press, held: true, dx: at.x - press.from.x, dy: at.y - press.from.y };
    apply({ type: "grab", now: performance.now() });
  };
  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    const at = local(event);
    const timer = grabbable() ? setTimeout(grab, tuning.dragDelayMs) : 0;
    press = { from: at, last: at, held: false, timer };
    onPress();
  });
  target.addEventListener("pointermove", (event) => {
    if (!press) return;
    press.last = local(event);
    const moved = Math.hypot(press.last.x - press.from.x, press.last.y - press.from.y);
    if (!press.held && grabbable() && moved >= tuning.dragThreshold) grab();
    if (press.held) apply({ type: "drag", x: press.last.x + press.dx, y: press.last.y + press.dy, now: performance.now() });
  });
  const letGo = (poke) => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.held) apply({ type: "release", now: performance.now() });
    else if (poke) apply({ type: "poke", now: performance.now(), rand: Math.random() });
    press = null;
  };
  target.addEventListener("pointerup", () => letGo(true));
  target.addEventListener("pointercancel", () => letGo(false));
  target.addEventListener("contextmenu", (event) => event.preventDefault());
  return () => press !== null;
}

// The page half: pointer events in, frames and cues out. `cue` is the app's
// own src/cue.js, which the site publishes beside this file.
export function mount(section, data, cue) {
  const desk = section.querySelector("#play-desk");
  const sprite = section.querySelector("#play-sprite");
  const img = sprite.querySelector("img");
  const hint = section.querySelector("#play-hint");
  const pill = section.querySelector("#play-qm");
  const field = pill.querySelector("input");
  const { tuning } = data;
  const me = data.cast[character(data.cast, data.hero)];
  const { loops } = me;
  const [w, h] = me.size;
  section.querySelector("#play-tiles").hidden = true;
  desk.hidden = false;
  sprite.style.width = `${w}px`;
  sprite.style.height = `${h}px`;
  Object.assign(img, { src: loops.idle.frames[0], alt: me.name, width: w, height: h });
  img.classList.toggle("pixel", me.pixel);
  section.querySelector("#play-chat .composer textarea").placeholder = `Ask ${me.name}…`;
  Object.values(loops).flatMap((loop) => loop.frames).forEach((src) => { new Image().src = src; });

  // Each window keeps its top-left corner as a share of the desk, so a resize
  // keeps it in view.
  const wins = [...desk.querySelectorAll("[data-win]")].map((el) => {
    const [x, y] = el.dataset.at.split(" ").map(Number);
    return { id: el.dataset.win, el, bar: el.querySelector(".bar"), corner: { x, y } };
  });
  const edgeOf = (win) => {
    const x0 = Math.min(win.corner.x * desk.clientWidth, desk.clientWidth - win.el.offsetWidth);
    const y = win.corner.y * desk.clientHeight;
    return { id: win.id, x0, x1: x0 + win.el.offsetWidth, y, y1: y + win.el.offsetHeight };
  };
  // Back to front, as the desk paints them; the model takes them frontmost first.
  const stack = [...wins];
  const world = () => ({ width: desk.clientWidth, height: desk.clientHeight, sprite: { w, h },
    windows: stack.filter((win) => !win.el.hidden).map(edgeOf).reverse() });
  // A closing window drops whoever sits on it before it hides, so state.on
  // always names an open window or the floor.
  const feetNow = () => feet(state, world());
  const anchor = () => {
    const at = feetNow();
    return { x: at.x, y: at.y - h / 2, feetX: at.x, feetY: at.y };
  };
  const io = cue.cueIo(section.querySelector("#play-cues"), anchor);
  // Visual only: the playground plays no sound. The machine lets a Summon cut the Poke ring.
  const cues = cue.createCueMachine({ draw: io.draw, sound: () => () => {} });
  let state = start(world(), performance.now());
  const apply = (event) => {
    const out = step(state, event, world(), tuning);
    state = out.state;
    if (out.cue) cues.event({ cue: out.cue, visible: true, sound: false });
    if (out.cue === "summon") {
      hidePill();
      openChat();
    }
  };
  const local = (event) => {
    const box = desk.getBoundingClientRect();
    return { x: event.clientX - box.left - desk.clientLeft, y: event.clientY - box.top - desk.clientTop };
  };

  // The quick-message pill, as cues.html specifies it: resting on the sprite
  // for hoverDelayMs opens it focused, whatever the chat mock does; leaving
  // the sprite does not dismiss, and Enter sends.
  let dwell = 0;
  let pillUp = false;
  const placePill = () => {
    const at = feetNow();
    const left = Math.min(desk.clientWidth - pill.offsetWidth - 4, Math.max(4, at.x - pill.offsetWidth / 2));
    pill.style.transform = `translate(${left}px, ${Math.max(4, at.y - h - pill.offsetHeight - 6)}px)`;
  };
  const showPill = () => {
    if (state.mode !== "standing") return;
    pillUp = true;
    pill.classList.add("visible");
    pill.setAttribute("aria-hidden", "false");
    placePill();
    field.focus({ preventScroll: true });
  };
  function hidePill() {
    clearTimeout(dwell);
    if (!pillUp) return;
    pillUp = false;
    pill.classList.remove("visible");
    pill.setAttribute("aria-hidden", "true");
    field.value = "";
    field.blur();
  }
  sprite.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || pillUp || pressing()) return;
    clearTimeout(dwell);
    dwell = setTimeout(showPill, tuning.hoverDelayMs);
  });
  sprite.addEventListener("pointerleave", () => clearTimeout(dwell));
  field.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === "Escape") && !event.isComposing) {
      event.preventDefault();
      hidePill();
    }
  });
  pill.querySelector("button").addEventListener("click", hidePill);
  document.addEventListener("pointerdown", (event) => {
    if (pillUp && !sprite.contains(event.target) && !pill.contains(event.target)) hidePill();
  });

  // The chat mock's composer takes typing and sends to nowhere: Enter or Send
  // clears it, as the pill's Enter does, and nothing answers.
  const line = section.querySelector("#play-chat .composer textarea");
  const send = () => {
    line.value = "";
    line.focus({ preventScroll: true });
  };
  section.querySelector("#play-chat .composer button").addEventListener("click", send);
  line.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  const pressing = decodePresses(sprite, tuning, {
    local,
    feetNow,
    onPress: () => clearTimeout(dwell),
    apply: (event) => {
      if (event.type === "grab") hidePill();
      if (event.type === "grab" || event.type === "poke") hint.classList.add("tried");
      apply(event);
    },
  });

  const placeWindow = (win) => {
    win.el.style.left = `${edgeOf(win).x0}px`;
    win.el.style.top = `${win.corner.y * 100}%`;
  };
  // A pressed window comes to the front, under the sprite, as on a desktop. By
  // z-index, as moving the node mid-press would swallow the click on its close.
  const raise = (win) => {
    stack.splice(stack.indexOf(win), 1);
    stack.push(win);
    stack.forEach((one, i) => { one.el.style.zIndex = i + 1; });
  };
  function openChat() {
    const win = wins.find((one) => one.id === "chat");
    if (!win.el.hidden) return;
    win.el.hidden = false;
    raise(win);
    placeWindow(win);
  }
  for (const win of wins) {
    let moving = null;
    win.el.addEventListener("pointerdown", () => raise(win));
    win.bar.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".close")) return;
      event.preventDefault();
      raise(win);
      win.bar.setPointerCapture(event.pointerId);
      const at = local(event);
      const before = edgeOf(win);
      moving = { dx: before.x0 - at.x, dy: before.y - at.y, t: performance.now() };
    });
    win.bar.addEventListener("pointermove", (event) => {
      if (!moving) return;
      const at = local(event);
      const before = edgeOf(win);
      const room = desk.clientWidth - win.el.offsetWidth;
      win.corner = {
        x: Math.min(room, Math.max(0, at.x + moving.dx)) / desk.clientWidth,
        y: Math.min(desk.clientHeight - 40, Math.max(0, at.y + moving.dy)) / desk.clientHeight,
      };
      placeWindow(win);
      const after = edgeOf(win);
      const dx = after.x0 - before.x0;
      const dy = after.y - before.y;
      const now = performance.now();
      const seconds = Math.max(now - moving.t, 1) / 1000;
      moving.t = now;
      if (dx || dy) apply({ type: "carry", id: win.id, dx, dy, vx: dx / seconds, vy: dy / seconds, now });
    });
    win.bar.addEventListener("pointerup", () => { moving = null; });
    win.bar.addEventListener("pointercancel", () => { moving = null; });
    win.el.querySelector(".close")?.addEventListener("click", () => {
      apply({ type: "close", id: win.id, y: edgeOf(win).y, now: performance.now() });
      win.el.hidden = true;
    });
    placeWindow(win);
  }

  let playing = null;
  let since = 0;
  let last = null;
  let pending = 0;
  const frame = (now) => {
    const hold = pillUp && document.activeElement === field;
    apply({ type: "tick", now, dt: last === null ? 0 : (now - last) / 1000, rand: Math.random(), hold });
    last = now;
    const name = animationOf(state);
    if (name !== playing) {
      playing = name;
      since = now;
    }
    const src = frameOf(loops[name], now - since);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    const gone = state.mode === "away";
    if (sprite.hidden !== gone) sprite.hidden = gone;
    const at = feetNow();
    sprite.style.transform = `translate(${at.x - w / 2}px, ${at.y - h}px)${state.facing < 0 ? " scaleX(-1)" : ""}`;
    if (pillUp) placePill();
    pending = requestAnimationFrame(frame);
  };
  // Out of view, no frames are scheduled. Back in view, the first tick has no
  // elapsed time, so nothing jumps by the time spent away.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !pending) {
      last = null;
      pending = requestAnimationFrame(frame);
    } else if (!entry.isIntersecting && pending) {
      cancelAnimationFrame(pending);
      pending = 0;
    }
  }).observe(desk);

  // The page character hands the Character over while the desk is in view: it
  // walks up from under the desk's floor. It leaves out of sight, at once, and
  // hides here because a desk out of view draws no frame to hide it.
  return {
    arrive: () => apply({ type: "enter", now: performance.now() }),
    depart: () => {
      apply({ type: "away", now: performance.now() });
      sprite.hidden = true;
    },
  };
}
