// Where the sprite is drawn, between the two placements the renderer holds.
// Arithmetic rather than rendering, so it lives on its own and is unit tested.

/** Draw one sample behind so the sprite moves at a constant rate instead of
 * jumping when a sample lands. The Engine ticks slower than the display;
 * measure scripts/bench-frame-cadence-macos.sh before changing this. */
export function interpolate(previous, latest, now) {
  const span = latest.at - previous.at;
  if (!(span > 0)) {
    // A resumed app, or two placements in the same millisecond, has nothing
    // to interpolate across, so draw the placement last reported.
    return { x: latest.x, y: latest.y };
  }

  // Clamped, so a late frame draws the latest placement rather than
  // extrapolating past it. Overshoot puts the sprite somewhere the Engine
  // never reported, and a landing reads as a bounce.
  const t = Math.min(Math.max((now - latest.at) / span, 0), 1);
  return {
    x: previous.x + (latest.x - previous.x) * t,
    y: previous.y + (latest.y - previous.y) * t,
  };
}

/** Whether the sprite has reached `latest`. The frame loop arms from this,
 * and it stays false while the span is unfinished. */
export function arrived(previous, latest, now) {
  if (!previous) return true;
  if (previous.x === latest.x && previous.y === latest.y) return true;
  return now >= latest.at + (latest.at - previous.at);
}

function reaches(at, bounds, margin) {
  return (
    at.x - margin < bounds.width &&
    at.x + at.width + margin > 0 &&
    at.y - margin < bounds.height &&
    at.y + at.height + margin > 0
  );
}

/** Whether the sprite is on this display across the drawn span. Tests both
 * placements, or the last frame of an exit is never drawn. `margin` covers
 * the pixel two scale factors can round apart at a seam. */
export function onDisplay(previous, latest, bounds, margin) {
  return (
    reaches(latest, bounds, margin) ||
    (Boolean(previous) && reaches(previous, bounds, margin))
  );
}
