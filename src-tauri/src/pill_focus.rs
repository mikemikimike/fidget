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

    /// The Instance is gone: drop its pill from every overlay.
    pub fn forget(&mut self, instance: &str) -> Vec<(String, bool)> {
        let before = self.on();
        for pills in self.0.values_mut() {
            pills.remove(instance);
        }
        let after = self.on();
        let mut flips: Vec<(String, bool)> = before
            .difference(&after)
            .map(|label| (label.clone(), false))
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

/// What to do with the keyboard when an overlay's last pill closes.
// Linux has no hand-back yet: see overlay_report_qm_draft.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub enum HandBack {
    /// The user already moved on: leave the keyboard where it is.
    Stay,
    /// Give it back to the app or window in front when the pill took it.
    Restore,
    /// That app or window is gone: step Fidget aside for whatever is next.
    StepAside,
}

/// `holding`: Fidget's overlay still has the keyboard. `previous_alive`: the
/// app or window remembered at focus time still exists. Same on every OS.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn hand_back(holding: bool, previous_alive: bool) -> HandBack {
    match (holding, previous_alive) {
        (false, _) => HandBack::Stay,
        (true, true) => HandBack::Restore,
        (true, false) => HandBack::StepAside,
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

    #[test]
    fn a_removed_character_leaves_no_overlay_focusable() {
        let mut pills = OpenPills::default();
        pills.note("overlay-1", "a", true);
        // overlay-0 drops the Character; only the roster says it is gone.
        assert_eq!(pills.note("overlay-0", "a", false), flips(&[]));
        assert_eq!(pills.forget("a"), flips(&[("overlay-1", false)]));
        assert_eq!(pills.forget("a"), flips(&[]));
    }

    #[test]
    fn the_keyboard_goes_back_only_while_fidget_still_holds_it() {
        assert_eq!(hand_back(false, true), HandBack::Stay);
        assert_eq!(hand_back(false, false), HandBack::Stay);
        assert_eq!(hand_back(true, true), HandBack::Restore);
        assert_eq!(hand_back(true, false), HandBack::StepAside);
    }

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
