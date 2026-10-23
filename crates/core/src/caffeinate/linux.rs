//! What a flag set asks Linux to inhibit.

use super::{Flag, Flags};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    /// The logind `what`: Idle is `idle`, System is `sleep`.
    pub logind: Option<&'static str>,
    /// Display is a screen saver inhibit.
    pub display: bool,
}

impl Plan {
    /// Disk has no Linux equivalent, so it adds nothing.
    pub fn of(flags: Flags) -> Self {
        let logind = match (flags.contains(Flag::Idle), flags.contains(Flag::System)) {
            (true, true) => Some("idle:sleep"),
            (true, false) => Some("idle"),
            (false, true) => Some("sleep"),
            (false, false) => None,
        };
        Self {
            logind,
            display: flags.contains(Flag::Display),
        }
    }

    pub fn is_empty(self) -> bool {
        self.logind.is_none() && !self.display
    }
}

/// The inhibitors a flag set takes, such as
/// `logind inhibit idle:sleep + screen saver inhibit`.
pub fn label(flags: Flags) -> String {
    let plan = Plan::of(flags);
    let mut parts = Vec::new();
    if let Some(what) = plan.logind {
        parts.push(format!("logind inhibit {what}"));
    }
    if plan.display {
        parts.push("screen saver inhibit".to_string());
    }
    parts.join(" + ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(set: &[Flag]) -> Flags {
        Flags::new(set.iter().copied()).expect("a flag")
    }

    #[test]
    fn idle_and_system_are_one_logind_inhibitor_and_display_the_screen_saver() {
        assert_eq!(
            Plan::of(Flags::all()),
            Plan {
                logind: Some("idle:sleep"),
                display: true
            }
        );
        assert_eq!(Plan::of(flags(&[Flag::Idle])).logind, Some("idle"));
        assert_eq!(Plan::of(flags(&[Flag::System])).logind, Some("sleep"));
        assert_eq!(
            Plan::of(flags(&[Flag::Display])),
            Plan {
                logind: None,
                display: true
            }
        );
        assert!(Plan::of(flags(&[Flag::Disk])).is_empty());
    }

    #[test]
    fn the_label_names_each_inhibitor() {
        assert_eq!(
            label(Flags::all()),
            "logind inhibit idle:sleep + screen saver inhibit"
        );
        assert_eq!(label(flags(&[Flag::System])), "logind inhibit sleep");
        assert_eq!(label(flags(&[Flag::Display])), "screen saver inhibit");
    }
}
