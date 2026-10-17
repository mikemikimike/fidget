// The page's own timers and clock readings, on a clock the test steps: probePage
// runs the page for real, so a delay the page schedules costs wall time. Only
// what the page schedules is queued; requestAnimationFrame stays real.
export function pageClock() {
  return `
  const timers = new Map();
  let now = 0;
  let nextId = 1;
  const read = () => now;
  Date.now = read;
  performance.now = read;
  window.setTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms || 0), fn, every: null });
    return id;
  };
  window.setInterval = (fn, ms) => {
    const id = nextId++;
    const every = Math.max(1, ms || 0);
    timers.set(id, { at: now + every, fn, every });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);
  // The delay until the page's next timer, so a poll can step over exactly what
  // the page is waiting on instead of guessing a period. Null when none waits.
  window.__nextDue = () => {
    let next = null;
    for (const item of timers.values()) {
      if (next === null || item.at < next) next = item.at;
    }
    return next === null ? null : Math.max(0, next - now);
  };
  window.__advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let dueId = null;
      let due = null;
      for (const [id, item] of timers) {
        if (item.at <= target && (!due || item.at < due.at)) {
          dueId = id;
          due = item;
        }
      }
      if (!due) break;
      now = due.at;
      if (due.every === null) timers.delete(dueId);
      else due.at = now + due.every;
      due.fn();
    }
    now = target;
  };
`;
}
