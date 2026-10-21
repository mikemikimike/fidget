//! Windows keyboard hand-back choices, pure so they test on every OS.

/// Whether the foreground window at pill-open is worth remembering: a real
/// window that is not the overlay. Chat and Settings are Fidget's too, and
/// closing the pill has to be able to return the keyboard to them.
pub(super) fn worth_remembering(foreground: u64, overlay: u64) -> bool {
    foreground != 0 && foreground != overlay
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
        assert!(worth_remembering(0x10, 0x20), "another app");
        assert!(
            worth_remembering(0x30, 0x20),
            "Fidget's own Chat, which is not the overlay"
        );
        assert!(!worth_remembering(0x20, 0x20), "the overlay");
        assert!(!worth_remembering(0, 0x20), "no foreground window");
    }

    #[test]
    fn a_step_aside_picks_the_frontmost_window_not_skipped() {
        let skip = |w: u64| w == 30 || w == 40;
        assert_eq!(step_aside_target(&[30, 10, 40, 20], skip), Some(10));
        assert_eq!(step_aside_target(&[30, 40], skip), None);
        assert_eq!(step_aside_target(&[], skip), None);
    }
}
