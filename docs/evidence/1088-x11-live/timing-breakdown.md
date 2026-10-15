# X11 Live Scenario Timing Breakdown

## Environment
- VM: Cursor Cloud Agent headless
- Display: Xvfb :99 @ 1920x1080x24
- D-Bus: session bus via dbus-launch
- AT-SPI: python3-pyatspi
- Binaries: Pre-built release (target/release)

## Results

### thinking-row

**Elapsed**: 3.7s (average of 3 runs: 3739ms, 3705ms, 3698ms)

**Phase breakdown**:
1. Binary check: ~200ms (cargo reports "Finished in 0.19-0.24s")
2. Fidget startup: ~500ms (overlay init, harness attach)
3. Scenario execution: ~3000ms
   - Wait for "asked" mark: <50ms (immediate)
   - Wait for "thought 1", "thought 2": ~600ms (harness 300ms sleep × 2)
   - Wait for thinking row in AX dump: ~400ms (UI render + AT-SPI poll at 200ms)
   - First AX dump: ~50ms
   - Wait for thoughts 3, 4, replied: ~1200ms (harness 300ms sleep × 4)
   - Wait for collapsed thinking row: ~400ms (UI render + poll)
   - Second AX dump: ~50ms

**vs. Original (before #1552)**:
- Before: 26.8s (cold) / 20.3s (warm)
  - 6s director ambient delay
  - 3s fixture sleep after ask
  - 4.8s fixture thinking (1.2s × 4)
  - 1.5s fixed script sleep
  - Build + startup: ~5-7s
- After: 3.7s
  - 1s director ambient delay
  - 0.3s fixture sleep after ask  
  - 1.2s fixture thinking (0.3s × 4)
  - Event-based waits (no fixed sleeps)
  - Build check: ~0.2s

**Improvement**: 85% faster (26.8s → 3.7s)

### chat-header-narrow

**Elapsed**: 4.5s

**Phase breakdown**:
1. Binary check: ~200ms
2. Fidget startup: ~500ms
3. Scenario execution: ~3800ms
   - Wait for "asked" mark: <50ms
   - Wait for session line in AX: ~600ms (permission answered + render)
   - Resize to 420px: ~50ms
   - AX dump + frame check: ~300ms
   - Resize to 360px: ~50ms
   - AX dump + frame check: ~300ms
   - Resize to 320px: ~50ms
   - AX dump + frame check: ~300ms

**vs. Original (before #1552)**:
- Before: 12.3s
- After: 4.5s

**Improvement**: 63% faster (12.3s → 4.5s)

## Key Changes from #1552

1. **Fixture timing reduced**: 3s+4.8s → 0.3s+1.2s in harness.rs
2. **Director wake**: 6s → 1s ambient delay
3. **Event-based waits**: `wait_for_marks` polls at 50ms, returns immediately when mark appears
4. **AX polling**: `wait_for_ax_dump` polls at 200ms for UI render
5. **Auto-answer permission**: First turn auto-answers its own ask in 300ms

## Fix Applied

thinking-row.x11.sh was failing because it waited for harness marks (which appear instantly) but dumped before Chat rendered the UI changes. Added `wait_for_ax_dump` calls to wait for the actual UI state before dumping.

This exposed that marks != UI state:
- Marks appear when harness sends data (immediate)
- UI appears when WebKit renders + AT-SPI updates (~400ms)

The fix makes the waits properly synchronize with UI rendering.
