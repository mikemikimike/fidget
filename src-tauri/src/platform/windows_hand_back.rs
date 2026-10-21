//! Windows keyboard hand-back choices, pure so they test on every OS.

/// Whether the foreground window at pill-open is worth remembering: a real
/// window that is not one of Fidget's overlays. Chat and Settings are
/// remembered, so the close can return the keyboard to them.
pub(super) fn worth_remembering(foreground: u64, overlays: &[u64]) -> bool {
    foreground != 0 && !overlays.contains(&foreground)
}

/// Where a step aside hands the keyboard: the first window, front to back,
/// that `skip` keeps (not Fidget's, not minimized, not cloaked).
pub(super) fn step_aside_target(front_to_back: &[u64], skip: impl Fn(u64) -> bool) -> Option<u64> {
    front_to_back.iter().copied().find(|&w| !skip(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_overlay_or_no_window_is_never_remembered() {
        let overlays = &[0x20, 0x21];
        assert!(worth_remembering(0x10, overlays), "another app");
        assert!(worth_remembering(0x30, overlays), "Fidget's own Chat");
        assert!(!worth_remembering(0x20, overlays), "the overlay that asked");
        assert!(
            !worth_remembering(0x21, overlays),
            "the other display's overlay"
        );
        assert!(!worth_remembering(0, overlays), "no foreground window");
    }

    #[test]
    fn a_step_aside_picks_the_frontmost_window_not_skipped() {
        let skip = |w: u64| w == 30 || w == 40;
        assert_eq!(step_aside_target(&[30, 10, 40, 20], skip), Some(10));
        assert_eq!(step_aside_target(&[30, 40], skip), None);
        assert_eq!(step_aside_target(&[], skip), None);
    }
}
