# X11 Click-Through Mask Rebuild Baseline

Benchmark for issue [#428](https://github.com/omesser/fidget/issues/428): per-pixel cost of rebuilding the X11 input region (XShapeCombineMask) when the sprite animation frame changes.

The older numbers below (10–15 ms for BMO) came from debug builds before the shape cache and the position-only update. A release build at `2355abcb` rebuilds BMO's mask in about 0.15 ms; see [Release build (2026-10-26)](#release-build-2026-10-26).

## Environment

### Grok Bot Linux desktop (GUI scenarios + remeasured idle)

- **Host**: Grok Bot box (`grok-bot-vm-429178738`)
- **OS**: Debian GNU/Linux 13 (trixie)
- **Kernel**: 6.12.94+
- **Display**: X11 on `DISPLAY=:5`, **1280×800**, depth 24
- **X server**: The X.Org Foundation version 21.1.16
- **Character**: BMO (126×128 px sprite, ~6231–7888 opaque mask cells depending on frame)
- **Binary**: `cargo build -p fidget` debug at tip `965e147`
- **Evidence**: `docs/research/mask-rebuild-baseline-x11/` (slim pack: environment, summaries, sample lines)

This is a real agent desktop with an X11 GUI (not a headless cloud run without pointer/window automation). Walking used a mapped `xmessage` perch and the app's loopback MCP `play_behavior`, with the **stationary** pointer left over the sprite. Shell `xdotool` was not used to drive clicks/drags.

### Prior cloud-VM idle (kept for comparison)

Earlier idle numbers on a headless cloud VM (Ubuntu 24.04.4, Xtigervnc 1920×1200) remain below under **Prior cloud-VM idle**. Prefer the Grok Bot desktop numbers for GUI scenarios; cloud idle is labeled when cited.

## Method

### Instrumentation

Timing in `src-tauri/src/platform/x11/overlay.rs`:

- Atomic counters for rebuild count and total nanoseconds
- Per-rebuild timing from start of `apply_input_mask()` to X11 flush completion
- Logging of sprite dimensions, scale, opaque pixel count, and rebuild time when `FIDGET_TRACE_MASK_REBUILD=1`

The rebuild happens in `apply_input_mask()`:

1. Create a 1-bit pixmap at `width * scale` by `height * scale`
2. Iterate every cell of the source mask
3. Call `poly_fill_rectangle` once per opaque source cell, as a `scale` by `scale` rectangle
4. Call `shape::mask` (XShapeCombineMask)
5. Optionally union hotspot rectangles with `shape::rectangles`
6. Flush X11

Scale multiplies rectangle size and pixmap size. It does not multiply the opaque source count.

### When rebuilds run

`frame_loop` only calls `update_input_region` while the overlay is not click-through-ignored — i.e. while the cursor is over the sprite (or a control / during a hold). `MaskParams` includes mask bits **and** sprite `x,y`, so walking under the cursor rebuilds at **motion rate**, not only when the animation frame's opaque set changes.

### Measurement

- Script: `scripts/bench-mask-rebuild-x11.sh` (idle / walk scenarios; walk still needs an interaction source)
- Box runs: app with `FIDGET_TRACE_MASK_REBUILD=1` (plus `TRACE_ENGINE` / `TRACE_FRAMES` for walk correlation)

## Release build (2026-10-26)

- **Build:** `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only cargo build --release -p fidget` at `2355abcb`. The line tables only add names for the profiler.
- **Box:** Debian 13, kernel 6.12, 8 cores, Xvfb `:1` at 1920×1200×24 with software rendering.
- **Scenario:** `scripts/flame-mask-rebuild-x11.sh` moves the pointer to the sprite centre on every frame line, so the cursor-over gate passes and the sprite mostly plays its hovered `talk` animation. This is not the walk scenario above.
- **What the time covers:** the `mask_rebuild:` trace, from the start of `apply_input_mask()` to the flush, on the client side. The X server handles the requests asynchronously, outside that window. The profile below covers both sides.
- **Evidence:** [`release-summary.txt`](./mask-rebuild-baseline-x11/release-summary.txt) and [`flamegraph-x11-mask.svg`](./mask-rebuild-baseline-x11/flamegraph-x11-mask.svg).

### Timings

There were five alternating rounds over four characters, 100 updates per run, without perf. Each "full" update rebuilds the mask. A "position-only" update keeps the cached pixmap and only moves the shape.

| Character | Opaque cells | Full: median per run (ms) | Full: pooled median / p95 (ms) | Position-only: pooled median (ms) |
|---|---|---|---|---|
| BMO 126×128@1x | 6219–7888 | 0.143–0.154 | 0.148 / 0.529 | 0.013 (n=161) |
| Black Mage 37×33@3x | 567–630 | 0.038–0.041 | 0.040 / 0.062 | 0.011 (n=161) |
| Nim 32×32@4x (shipped) | 278–350 | 0.034–0.035 | 0.035 / 0.054 | 0.011 (n=141) |
| Nim 32×32@1x | 278–350 | 0.033–0.036 | 0.034 / 0.046 | 0.011 (n=33) |

Every character had a few outliers between 5 and 6.4 ms, which looks like scheduling noise on the box. Updates arrived at about 4 per second.

### CPU profile

`perf record -e cpu-clock:u -F 4999 --call-graph dwarf` sampled fidget and Xvfb over 200 BMO updates in 69 s (user space only, since `perf_event_paranoid` is 2). `apply_input_mask()` is inlined, so `update_input_region` is the root of the mask path:

| Frame at or below `update_input_region` | On-CPU |
|---|---|
| `update_input_region` total | 25.8 ms (1.26% of fidget's 2054.8 ms, about 0.13 ms per update) |
| `x11rb` `poly_fill_rectangle` (mostly serializing the rectangles) | 8.2 ms |
| `mask_rects` (5.2 ms of it in `realloc`, from `Vec::new` growing) | 6.8 ms |
| tauri `window_handle` (event-loop round trip for the X window id) | 4.0 ms |
| `shape::mask` (the XShapeCombineMask request) | 1.4 ms |
| `_eprint` (the trace line itself) | 1.0 ms |
| `shape::rectangles` (hotspot union) | 0.6 ms |

On the server side, Xvfb spent 5405.9 ms on-CPU, and 4874.8 ms of that was pixman painting the webview into the software framebuffer. The shape-named server frames were `miSetShape` (3.2 ms) and `SendShapeNotify` (2.4 ms). The packaged Xvfb is partly stripped, so `ProcShapeMask` and its region conversion show up as `[Xvfb]`. Under perf, the trace mean rose to 0.248 ms.

The XShapeCombineMask call costs little on either side. What a mask rebuild does cost is building and sending one rectangle per opaque cell, plus the window-handle round trip. Even so, it stays near 1% of the app's CPU while the pointer is held on BMO.

## Results — Grok Bot desktop

### Idle perched (BMO, 126×128@1x), cursor not over sprite

**15-second measure window** (startup fall excluded):

- Total rebuilds: **0**
- Rate: **0.0 rebuilds/sec**

Startup fall briefly crossed the stationary pointer and logged 3 rebuilds (~16–18 ms, 7888 opaque) before the sprite perched on the floor away from the cursor. After that, idle animation continued with **no** mask rebuilds, matching the cursor-over gate.

### Walking (BMO walk/patrol), cursor over sprite on a perch

**Method:** Map a wide `xmessage` window (geometry ~900×80 at +190+480) so BMO perches with sprite rect covering the stationary pointer at (640,400). Trigger `walk` / `patrol` via loopback MCP `play_behavior` (and StaticDirector). Correlate `mask_rebuild:` lines with `TRACE_FRAMES` while `walk#*` and cursor-over.

**First perched walk bout under the cursor (~0.52 s of walk+over frames):**

- Total rebuilds: **14**
- Rate: **~26.7 rebuilds/sec** (motion-driven; `MaskParams` includes `x,y`)
- Average time: **15.002 ms/rebuild**
- Range: 12.332 – 18.646 ms
- Opaque pixels: **6231–6298** (matches walk-2 / walk-0 / walk-1 alpha masks)

Opaque set changed across the three walk frames; many rebuilds repeated the same opaque count while `x` advanced — expected with the position-inclusive cache key.

After the sprite walked off the perch (floor at y≈615), hundreds of further `walk#*` frames produced **no** rebuilds until/unless the cursor overlapped again.

### Fast Animation (BMO react, 10 fps)

**Status:** Measured (startup interactions, limited sample).

**Method:** BMO with `react` animation (2 frames at 10 fps, the fastest in BMO's manifest) triggered by poke interactions.

**Measurements (tip `6b4acbf`):**
- Sprite: BMO 126×128@1x
- Opaque pixels: **6360**
- Samples: **3 rebuilds** during react triggers
- Times: **9.611 ms, 9.354 ms, 9.724 ms**
- Average: **~9.6 ms/rebuild**

The fast animation frame rate (10 fps) doesn't increase per-rebuild cost — it remains driven by the opaque pixel count (~6360). At 10 fps with continuous cursor-over, the animation could trigger up to ~10 rebuilds/sec, but each rebuild costs the same ~10ms as other BMO frames with similar opaque counts.

### Large Sprite (Black Mage, scale=3)

**Status:** Measured (startup + limited interaction).

**Method:** Black Mage character package (`scale = 3` in manifest). The 3× scale renders the sprite larger on screen but does not multiply the source opaque cell count.

**Measurements (tip `6b4acbf`):**
- Sprite: **37×33@3x** (source 37×33, rendered 111×99)
- Opaque pixels: **477–579** (varies by frame)
- Samples: **3 rebuilds**
- Times: **0.970 ms, 1.937 ms, 1.263 ms**
- Average: **~1.4 ms/rebuild**

Black Mage rebuilds **much faster** than BMO (~1.4ms vs ~10-15ms) because it has far fewer opaque source pixels (477–579 vs 6231–7888). Scale affects rendered size and pixmap rectangle dimensions, but rebuild cost is dominated by the iteration over opaque source cells. A 3× scale means each source cell becomes a 3×3 rectangle in the pixmap, but the loop count is the source opaque count, not the rendered pixel count.

Black Mage is a genuinely smaller source sprite (37×33) scaled up to appear larger, not a large-source sprite. For measuring the cost of a large opaque count at higher scale, one would need a character with both large source dimensions and dense opaque regions — not present in the current shipped character set.

### Small Sprite

**Status:** Measured with a release build. Nim (`characters/Nim`, 32×32 source, `scale = 4`) is the smallest shipped source sprite. It has 278–350 opaque cells. For the 1x case, a temporary copy of the package with `scale = 1` was passed with `--characters`; it is not committed.

- **Nim 32×32@4x:** full rebuild median 0.035 ms (per-run medians 0.034–0.035)
- **Nim 32×32@1x:** full rebuild median 0.034 ms (per-run medians 0.033–0.036)

The cost is the same at both scales, so it tracks opaque source cells, not the pixel area. See [Release build (2026-10-26)](#release-build-2026-10-26).

## Prior cloud-VM idle

*(Headless cloud VM; Ubuntu 24.04.4; Xtigervnc 1920×1200; BMO.)*

### Idle Perched — 10-second sample

- Total rebuilds: 4
- Rate: 0.4 rebuilds/sec
- Average time: **13.119 ms/rebuild**
- Range: 9.7 – 15.3 ms
- Opaque pixels: 6360–7888

### Idle Perched — 60-second sample

- Total rebuilds: 3
- Rate: **0.05 rebuilds/sec**
- Average time: **11.412 ms/rebuild**
- Range: 9.5 – 13.5 ms
- Opaque pixels: 6360

Those cloud samples likely had occasional cursor-over or idle frame transitions that passed the gate; box idle with cursor away from the sprite measured **0**/sec.

### Per-Pixel Cost (from cloud 1x samples)

For ~6360–7888 opaque source cells at 1x:

- **~1.5–2.0 μs per opaque source cell at 1x**
- Not a scale law: 4x does not multiply the cell count.

## Findings

1. **Mask rebuilds are cheap in release builds:** about 0.15 ms for BMO and 0.035 ms for Nim or Black Mage, with position-only updates near 0.012 ms (release build, 2026-10-26). The debug-build figures that follow came from older code: ~10–15 ms for BMO (126×128, ~6300 opaque) at 1x on this box, ~1.4 ms for Black Mage (37×33, ~500 opaque) at 3x. Cost is dominated by opaque source pixel count, not rendered size or scale factor.

2. **Rebuilds are gated on cursor-over (and hold/control):** With the pointer elsewhere, idle and even long walk sequences log no `mask_rebuild` lines. Cost shows up when the user is interacting over the sprite.

3. **Walking under the cursor rebuilds at motion rate:** Because `MaskParams` includes position, expect tens of rebuilds/sec while walking under the pointer (measured ~27/s), not only the 8 fps walk animation rate.

4. **Scale multiplies rendered size, not opaque count:** Black Mage at scale=3 has a smaller source sprite (37×33) than BMO@1x (126×128), so despite the 3× scale it rebuilds much faster (~1.4ms vs ~10-15ms). The iteration count is the source opaque cells; scale only affects the rectangle dimensions in the pixmap. A 4× scale would cost 4²=16× the **pixels filled** (each `XFillRectangle` call fills a scale×scale rectangle), not 4× the call count.

5. **Fast animation FPS doesn't directly increase rebuild cost:** BMO `react` at 10 fps shows the same ~10ms rebuild time as other BMO animations with similar opaque counts. FPS affects how often rebuilds might fire (if cursor stays over sprite), but each rebuild's cost remains driven by the opaque pixel count.

## Evidence

### Grok Bot desktop

Slim evidence pack in [`docs/research/mask-rebuild-baseline-x11/`](./mask-rebuild-baseline-x11/):

- [`environment.txt`](./mask-rebuild-baseline-x11/environment.txt) — host/OS/display config
- [`idle-summary.txt`](./mask-rebuild-baseline-x11/idle-summary.txt) — idle measure summary (0 rebuilds in 15s window)
- [`walk-summary.txt`](./mask-rebuild-baseline-x11/walk-summary.txt) — walk under cursor summary (14 rebuilds)
- [`walk-mask-rebuild-sample.log`](./mask-rebuild-baseline-x11/walk-mask-rebuild-sample.log) — sample `mask_rebuild:` log lines from walk bout
- [`release-summary.txt`](./mask-rebuild-baseline-x11/release-summary.txt) — release-build timing series and CPU profile (2026-10-26)
- [`flamegraph-x11-mask.svg`](./mask-rebuild-baseline-x11/flamegraph-x11-mask.svg) — fidget stacks through `update_input_region`, 200 BMO updates
- [`README.md`](./mask-rebuild-baseline-x11/README.md) — pack provenance

Numbers and sample lines were extracted for publication; full TRACE logs remain on the measurement box.

### Instrumentation sample

**BMO walking under cursor** (matches `walk-mask-rebuild-sample.log`):
```
mask_rebuild: 126x128 @1x scale, 6251 opaque pixels, 13.908 ms
mask_rebuild: 126x128 @1x scale, 6298 opaque pixels, 15.328 ms
mask_rebuild: 126x128 @1x scale, 6231 opaque pixels, 12.332 ms
```

**BMO react (10 fps fast animation):**
```
mask_rebuild: 126x128 @1x scale, 6360 opaque pixels, 9.611 ms
mask_rebuild: 126x128 @1x scale, 6360 opaque pixels, 9.354 ms
mask_rebuild: 126x128 @1x scale, 6360 opaque pixels, 9.724 ms
```

**Black Mage (37×33 source @3x scale, large rendered sprite):**
```
mask_rebuild: 37x33 @3x scale, 477 opaque pixels, 0.970 ms
mask_rebuild: 37x33 @3x scale, 579 opaque pixels, 1.937 ms
mask_rebuild: 37x33 @3x scale, 579 opaque pixels, 1.263 ms
```

### Code

- `src-tauri/src/platform/x11/overlay.rs` — timing / counters
- `scripts/bench-mask-rebuild-x11.sh` — benchmark script
- `scripts/flame-mask-rebuild-x11.sh` — release timing (`--no-perf`) and the perf flamegraph
- `scripts/bench-mask-rebuild-windows-flame.ps1` — WPR CPU trace of the Windows region rebuild
- `src-tauri/src/frame_loop.rs` — `MaskParams` cache + cursor-over gate

## Comparison to Issue #432 (System Wakeups)

Issue #432 measured ~271 voluntary context switches/sec during idle perched on Linux (cloud). Mask rebuilds at 0/sec with the cursor away are **not** a contributor to that idle wakeup rate. The debug-build ~15 ms rebuild time (0.15 ms in release) matters when the cursor is over an animating/moving sprite.

## Recommendations for Follow-Up

1. **Longer sustained animation samples** under cursor for fast animation and scale scenarios — current measurements are from startup interactions. Extended cursor-over sessions (e.g., via perch + MCP behavior triggers, or computerUse drag) would provide more stable rate and timing data.
2. **Separate counters** for "opaque set changed" vs "position-only" rebuilds if optimizing the cache key — the position-inclusive `MaskParams` drives high rebuild rates during motion even when the mask bits don't change.
3. **Windows baseline** — X11 measurements complete for shipped character scenarios. A Windows release run of `scripts/bench-mask-rebuild-windows-flame.ps1` measured a median 2.42 ms per `SetWindowRgn` rebuild; see [`mask-rebuild-baseline-windows.md`](./mask-rebuild-baseline-windows.md#release-build-2026-10-26). Its WPR trace has not been exported as a flamegraph yet.
4. **`perf` flamegraph** for rebuild hotspots — collected for X11 (see [CPU profile](#cpu-profile)). If rebuilds ever become hot, the leads are reserving `mask_rects` capacity and caching the window handle. At about 0.13 ms per update, neither is worth doing yet.
