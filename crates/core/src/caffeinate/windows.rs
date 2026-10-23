//! The power requests a flag set asks Windows for.

use super::{Flag, Flags};

/// A Windows power request type. The shell maps each to the OS value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerRequest {
    Display,
    System,
}

impl PowerRequest {
    /// The section `powercfg /requests` lists it under.
    fn name(self) -> &'static str {
        match self {
            PowerRequest::Display => "DISPLAY",
            PowerRequest::System => "SYSTEM",
        }
    }
}

/// In `powercfg` order. Idle and System both keep the system up, and Windows
/// has no disk request.
pub fn requests(flags: Flags) -> Vec<PowerRequest> {
    let mut requests = Vec::new();
    if flags.contains(Flag::Display) {
        requests.push(PowerRequest::Display);
    }
    if flags.contains(Flag::Idle) || flags.contains(Flag::System) {
        requests.push(PowerRequest::System);
    }
    requests
}

/// `DISPLAY, SYSTEM`, the sections `powercfg /requests` lists Fidget under.
pub fn label(flags: Flags) -> String {
    let names: Vec<&str> = requests(flags)
        .into_iter()
        .map(PowerRequest::name)
        .collect();
    if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caffeinate::flags;

    #[test]
    fn power_requests_follow_the_flags() {
        assert_eq!(
            requests(Flags::all()),
            vec![PowerRequest::Display, PowerRequest::System]
        );
        assert_eq!(
            requests(flags(&[Flag::Display])),
            vec![PowerRequest::Display]
        );
        assert_eq!(requests(flags(&[Flag::Idle])), vec![PowerRequest::System]);
        assert_eq!(
            requests(flags(&[Flag::System, Flag::Idle])),
            vec![PowerRequest::System]
        );
        assert!(requests(flags(&[Flag::Disk])).is_empty());
        assert_eq!(label(Flags::all()), "DISPLAY, SYSTEM");
        assert_eq!(label(flags(&[Flag::Idle])), "SYSTEM");
        assert_eq!(label(flags(&[Flag::Disk])), "none");
    }
}
