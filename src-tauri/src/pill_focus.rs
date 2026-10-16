//! Which overlay windows hold an open quick message pill. An overlay takes the
//! keyboard only while one of its own pills is open (#1565).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// Open pills by overlay window label, each a set of Instance ids.
#[derive(Default)]
pub struct OpenPills(HashMap<String, HashSet<String>>);

impl OpenPills {
    /// Record `instance`'s pill on `window` as open or closed. Returns each
    /// window whose "any pill open" state flipped, with its new state.
    pub fn note(&mut self, window: &str, instance: &str, open: bool) -> Vec<(String, bool)> {
        let before = self.on();
        if open {
            // One pill per Instance: opening here closes it on any other overlay.
            for (label, pills) in &mut self.0 {
                if label != window {
                    pills.remove(instance);
                }
            }
            self.0
                .entry(window.to_string())
                .or_default()
                .insert(instance.to_string());
        } else if let Some(pills) = self.0.get_mut(window) {
            pills.remove(instance);
        }
        let after = self.on();
        let mut flips: Vec<(String, bool)> = before
            .difference(&after)
            .map(|label| (label.clone(), false))
            .chain(after.difference(&before).map(|label| (label.clone(), true)))
            .collect();
        flips.sort();
        flips
    }

    fn on(&self) -> HashSet<String> {
        self.0
            .iter()
            .filter(|(_, pills)| !pills.is_empty())
            .map(|(label, _)| label.clone())
            .collect()
    }
}

/// The process-wide record the overlay commands share.
pub fn shared() -> &'static Mutex<OpenPills> {
    static PILLS: OnceLock<Mutex<OpenPills>> = OnceLock::new();
    PILLS.get_or_init(Mutex::default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flips(pairs: &[(&str, bool)]) -> Vec<(String, bool)> {
        pairs.iter().map(|(w, o)| (w.to_string(), *o)).collect()
    }

    #[test]
    fn one_pill_turns_its_overlay_on_and_off() {
        let mut pills = OpenPills::default();
        assert_eq!(
            pills.note("overlay-0", "a", true),
            flips(&[("overlay-0", true)])
        );
        assert_eq!(pills.note("overlay-0", "a", true), flips(&[]));
        assert_eq!(
            pills.note("overlay-0", "a", false),
            flips(&[("overlay-0", false)])
        );
    }

    #[test]
    fn an_overlay_stays_on_while_any_of_its_pills_is_open() {
        let mut pills = OpenPills::default();
        pills.note("overlay-0", "a", true);
        assert_eq!(pills.note("overlay-0", "b", true), flips(&[]));
        assert_eq!(pills.note("overlay-0", "a", false), flips(&[]));
        assert_eq!(
            pills.note("overlay-0", "b", false),
            flips(&[("overlay-0", false)])
        );
    }

    #[test]
    fn a_pill_carried_to_another_display_turns_the_old_overlay_off() {
        let mut pills = OpenPills::default();
        pills.note("overlay-0", "a", true);
        assert_eq!(
            pills.note("overlay-1", "a", true),
            flips(&[("overlay-0", false), ("overlay-1", true)])
        );
    }

    #[test]
    fn a_late_close_from_the_old_overlay_leaves_the_new_one_on() {
        let mut pills = OpenPills::default();
        pills.note("overlay-0", "a", true);
        pills.note("overlay-1", "a", true);
        assert_eq!(pills.note("overlay-0", "a", false), flips(&[]));
        assert_eq!(
            pills.note("overlay-1", "a", false),
            flips(&[("overlay-1", false)])
        );
    }

    #[test]
    fn a_carried_pill_keeps_the_old_overlay_on_for_its_other_pill() {
        let mut pills = OpenPills::default();
        pills.note("overlay-0", "a", true);
        pills.note("overlay-0", "b", true);
        assert_eq!(
            pills.note("overlay-1", "a", true),
            flips(&[("overlay-1", true)])
        );
    }
}
