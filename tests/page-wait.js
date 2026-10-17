// The handshake a probe waits on instead of polling: `ready` settles when the
// app registers a listener, `settle` is one drawn frame, and `until` waits for a
// condition. A probe that also installed pageClock steps that clock.
export function pageWait() {
  return `
  const listening = new Set();
  const awaiting = new Map();
  function listeningNow(name) {
    listening.add(name);
    const resolve = awaiting.get(name);
    if (resolve) {
      awaiting.delete(name);
      resolve();
    }
  }
  function ready(name) {
    if (listening.has(name)) return Promise.resolve();
    return new Promise((resolve) => awaiting.set(name, resolve));
  }
  const settle = () => new Promise((resolve) => requestAnimationFrame(resolve));
  async function until(pred) {
    for (let drawn = 0; ; drawn += 1) {
      // A frame first: a state that flips inside a task reaches the DOM on the
      // next drawn one. Then the clock steps over the timer the page waits on.
      await settle();
      if (pred()) return;
      // A stuck wait names what it wants: the probe's own timeout cannot say.
      if (drawn > 0 && drawn % 60 === 0) {
        console.log("__STUCK__ " + String(pred).replace(/\\s+/g, " "));
      }
      const next = window.__nextDue ? window.__nextDue() : null;
      if (next !== null) window.__advance(next);
    }
  }
`;
}
