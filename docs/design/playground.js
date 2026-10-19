// The desk under "Things you can do to it": one Character and one window to
// perch on. step() is the whole behavior and touches no DOM, so node tests it.

// How long an untouched Character idles, then walks, in ms. The page's own
// numbers: in the app the Director picks what comes next.
const WANDER = { idle: [1500, 4000], walk: [1200, 3500] };

// A tab that was away for seconds comes back one short step later, not teleported.
const MAX_DT = 0.05;

const span = ([low, high], roll) => low + (high - low) * roll;

function wander(state, now, rand) {
  if (state.act === "idle") {
    return { ...state, act: "walk", facing: rand < 0.5 ? -1 : 1, until: now + span(WANDER.walk, (rand * 2) % 1) };
  }
  return { ...state, act: "idle", until: now + span(WANDER.idle, rand) };
}

function timeUp(state, now, rand, tuning) {
  if (state.act === "react") return { ...state, act: "idle", until: now + tuning.pokeCooldownMs - tuning.primitiveMs };
  if (state.act === "land" && state.on === "window") return { ...state, act: "sit", until: now + tuning.perchedIdleAfterMs };
  return wander(state, now, rand);
}

function clampX(x, world) {
  const half = world.sprite.w / 2;
  return Math.min(world.width - half, Math.max(half, x));
}

function walk(state, dt, world, tuning) {
  const vx = state.facing * tuning.walkSpeed;
  const x = state.x + vx * dt;
  const edge = world.window;
  if (state.on === "window" && (x < edge.x0 || x > edge.x1)) {
    return { mode: "falling", x, y: edge.y, vx, vy: 0, facing: state.facing, landing: null };
  }
  const clamped = clampX(x, world);
  return { ...state, x: clamped, facing: clamped === x ? state.facing : -state.facing };
}

function ledgeY(world, on) {
  return on === "window" ? world.window.y : world.height;
}

function feet(state, world) {
  return state.mode === "standing" ? { x: state.x, y: ledgeY(world, state.on) } : { x: state.x, y: state.y };
}

// The ledge the feet crossed going from fromY down to toY: the window's top
// edge only when the feet started above it.
function ledgeCrossed(world, x, fromY, toY) {
  const edge = world.window;
  if (x >= edge.x0 && x <= edge.x1 && fromY <= edge.y && toY >= edge.y) return "window";
  return toY >= world.height ? "floor" : null;
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
    const landed = { mode: "standing", on, x, facing: state.facing, act: "land", until: event.now + tuning.primitiveMs };
    return { state: landed, cue: state.landing };
  }
  return { state: { ...state, x, y, vx, vy }, cue: null };
}

// The engine's yank gate: a change in the window's speed larger than
// rideAcceleration * yankWindowS, against its speed about yankWindowS ago, drops the sprite.
function carry(state, event, world, tuning) {
  const windowMs = tuning.yankWindowS * 1000;
  const ride = (state.ride ?? []).filter((sample) => sample.t >= event.now - windowMs);
  const reference = ride[0] ?? { vx: 0, vy: 0 };
  if (Math.hypot(event.vx - reference.vx, event.vy - reference.vy) > tuning.rideAcceleration * tuning.yankWindowS) {
    const y = world.window.y - event.dy;
    return { mode: "falling", x: state.x, y, vx: 0, vy: 0, facing: state.facing, landing: "drop" };
  }
  return { ...state, x: clampX(state.x + event.dx, world), ride: [...ride, { t: event.now, vx: event.vx, vy: event.vy }] };
}

function start(world, now) {
  return { mode: "standing", on: "floor", x: world.width / 2, facing: 1, act: "idle", until: now + WANDER.idle[0] };
}

export function animationOf(state) {
  if (state.mode === "held") return "hold";
  if (state.mode === "falling") return "fall";
  return state.act;
}

export function step(state, event, world, tuning) {
  const unchanged = { state, cue: null };
  if (event.type === "poke") {
    if (state.mode !== "standing") return unchanged;
    return { state: { ...state, act: "react", until: event.now + tuning.primitiveMs }, cue: "poke" };
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
  if (event.type === "carry") {
    if (state.mode !== "standing" || state.on !== "window") return unchanged;
    return { state: carry(state, event, world, tuning), cue: null };
  }
  if (event.type === "tick" && state.mode === "falling") return fall(state, event, world, tuning);
  if (event.type === "tick" && state.mode === "standing") {
    if (event.now >= state.until) return { state: timeUp(state, event.now, event.rand, tuning), cue: null };
    if (state.act === "walk") return { state: walk(state, Math.min(event.dt, MAX_DT), world, tuning), cue: null };
    return unchanged;
  }
  return unchanged;
}

// The page half: pointer events in, frames and cues out. `cueIo` is the app's
// own src/cue.js, which the site publishes beside this file.
export function mount(section, data, cueIo) {
  const desk = section.querySelector("#play-desk");
  const win = section.querySelector("#play-win");
  const bar = section.querySelector("#play-bar");
  const sprite = section.querySelector("#play-sprite");
  const img = sprite.querySelector("img");
  const hint = section.querySelector("#play-hint");
  const { loops, tuning } = data;
  const [w, h] = data.size;
  section.querySelector("#play-tiles").hidden = true;
  desk.hidden = false;
  sprite.style.width = `${w}px`;
  sprite.style.height = `${h}px`;
  Object.values(loops).flatMap((loop) => loop.frames).forEach((src) => { new Image().src = src; });

  // The window's top-left corner, as a share of the desk, so a resize keeps it in view.
  let corner = { x: 0.1, y: 0.42 };
  const world = () => {
    const x0 = corner.x * desk.clientWidth;
    return { width: desk.clientWidth, height: desk.clientHeight, sprite: { w, h },
      window: { x0, x1: x0 + win.offsetWidth, y: corner.y * desk.clientHeight } };
  };
  const anchor = () => {
    const at = feet(state, world());
    return { x: at.x, y: at.y - h / 2, feetX: at.x, feetY: at.y };
  };
  const cues = cueIo(section.querySelector("#play-cues"), anchor);
  let state = start(world(), performance.now());
  const apply = (event) => {
    const out = step(state, event, world(), tuning);
    state = out.state;
    if (out.cue) cues.draw(out.cue);
  };
  const local = (event) => {
    const box = desk.getBoundingClientRect();
    return { x: event.clientX - box.left - desk.clientLeft, y: event.clientY - box.top - desk.clientTop };
  };

  // The same press decoding as input.rs: a press becomes a Grab once it moves
  // dragThreshold or is held dragDelayMs, and a press released before either is a Poke.
  let press = null;
  const grab = () => {
    if (!press || press.held) return;
    clearTimeout(press.timer);
    const at = feet(state, world());
    press = { ...press, held: true, dx: at.x - press.last.x, dy: at.y - press.last.y };
    apply({ type: "grab", now: performance.now() });
    hint.classList.add("tried");
  };
  sprite.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sprite.setPointerCapture(event.pointerId);
    const at = local(event);
    press = { from: at, last: at, held: false, timer: setTimeout(grab, tuning.dragDelayMs) };
  });
  sprite.addEventListener("pointermove", (event) => {
    if (!press) return;
    press.last = local(event);
    if (!press.held && Math.hypot(press.last.x - press.from.x, press.last.y - press.from.y) >= tuning.dragThreshold) grab();
    if (press.held) apply({ type: "drag", x: press.last.x + press.dx, y: press.last.y + press.dy, now: performance.now() });
  });
  const letGo = (poke) => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.held) apply({ type: "release", now: performance.now() });
    else if (poke) {
      apply({ type: "poke", now: performance.now() });
      hint.classList.add("tried");
    }
    press = null;
  };
  sprite.addEventListener("pointerup", () => letGo(true));
  sprite.addEventListener("pointercancel", () => letGo(false));
  sprite.addEventListener("contextmenu", (event) => event.preventDefault());

  let moving = null;
  const placeWindow = () => {
    win.style.left = `${corner.x * 100}%`;
    win.style.top = `${corner.y * 100}%`;
  };
  bar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    bar.setPointerCapture(event.pointerId);
    const at = local(event);
    const before = world();
    moving = { dx: before.window.x0 - at.x, dy: before.window.y - at.y, t: performance.now() };
  });
  bar.addEventListener("pointermove", (event) => {
    if (!moving) return;
    const at = local(event);
    const before = world();
    const room = before.width - win.offsetWidth;
    corner = {
      x: Math.min(room, Math.max(0, at.x + moving.dx)) / before.width,
      y: Math.min(before.height - 40, Math.max(h, at.y + moving.dy)) / before.height,
    };
    placeWindow();
    const after = world();
    const dx = after.window.x0 - before.window.x0;
    const dy = after.window.y - before.window.y;
    const now = performance.now();
    const seconds = Math.max(now - moving.t, 1) / 1000;
    moving.t = now;
    if (dx || dy) apply({ type: "carry", dx, dy, vx: dx / seconds, vy: dy / seconds, now });
  });
  bar.addEventListener("pointerup", () => { moving = null; });
  bar.addEventListener("pointercancel", () => { moving = null; });
  placeWindow();

  let playing = null;
  let since = 0;
  let last = performance.now();
  const frame = (now) => {
    apply({ type: "tick", now, dt: (now - last) / 1000, rand: Math.random() });
    last = now;
    const name = animationOf(state);
    if (name !== playing) {
      playing = name;
      since = now;
    }
    const loop = loops[name];
    const index = Math.floor(((now - since) * loop.fps) / 1000);
    const src = loop.frames[loop.once ? Math.min(index, loop.frames.length - 1) : index % loop.frames.length];
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    const at = feet(state, world());
    sprite.style.transform = `translate(${at.x - w / 2}px, ${at.y - h}px)${state.facing < 0 ? " scaleX(-1)" : ""}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
