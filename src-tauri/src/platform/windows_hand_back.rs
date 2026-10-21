//! Windows keyboard hand-back choices, pure so they test on every OS.

/// Where a step aside hands the keyboard: the first window, front to back,
/// that `skip` keeps (not Fidget's, not minimized, not cloaked).
pub(super) fn step_aside_target(front_to_back: &[u64], skip: impl Fn(u64) -> bool) -> Option<u64> {
    front_to_back.iter().copied().find(|&w| !skip(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_aside_picks_the_frontmost_window_not_skipped() {
        let skip = |w: u64| w == 30 || w == 40;
        assert_eq!(step_aside_target(&[30, 10, 40, 20], skip), Some(10));
        assert_eq!(step_aside_target(&[30, 40], skip), None);
        assert_eq!(step_aside_target(&[], skip), None);
    }
}
