//! The power requests a flag set asks Windows for.

use super::{Flag, Flags};

/// A Windows power request type. The shell maps each to the OS value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Display,
    System,
}

impl Request {
    /// The section `powercfg /requests` lists it under.
    fn name(self) -> &'static str {
        match self {
            Request::Display => "DISPLAY",
            Request::System => "SYSTEM",
        }
    }
}

/// In `powercfg` order. Idle and System both keep the system up, and Windows
/// has no disk request.
pub fn requests(flags: Flags) -> Vec<Request> {
    let mut requests = Vec::new();
    if flags.contains(Flag::Display) {
        requests.push(Request::Display);
    }
    if flags.contains(Flag::Idle) || flags.contains(Flag::System) {
        requests.push(Request::System);
    }
    requests
}

/// `DISPLAY, SYSTEM`, the sections `powercfg /requests` lists Fidget under.
pub fn label(flags: Flags) -> String {
    let names: Vec<&str> = requests(flags).into_iter().map(Request::name).collect();
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
            vec![Request::Display, Request::System]
        );
        assert_eq!(requests(flags(&[Flag::Display])), vec![Request::Display]);
        assert_eq!(requests(flags(&[Flag::Idle])), vec![Request::System]);
        assert_eq!(
            requests(flags(&[Flag::System, Flag::Idle])),
            vec![Request::System]
        );
        assert!(requests(flags(&[Flag::Disk])).is_empty());
        assert_eq!(label(Flags::all()), "DISPLAY, SYSTEM");
        assert_eq!(label(flags(&[Flag::Idle])), "SYSTEM");
        assert_eq!(label(flags(&[Flag::Disk])), "none");
    }
}
