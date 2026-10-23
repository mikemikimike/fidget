//! What `/usr/bin/caffeinate` is given for a flag set.
//!
//! `-w` is mandatory. A macOS child is reparented to `launchd` when fidget
//! dies, so a crash would leave the Mac awake without it.

use super::{Flag, Flags};

/// The one map from flag to its `caffeinate` letter, in argv order.
const LETTERS: [(Flag, char); 4] = [
    (Flag::Display, 'd'),
    (Flag::Idle, 'i'),
    (Flag::Disk, 'm'),
    (Flag::System, 's'),
];

fn letters(flags: Flags) -> impl Iterator<Item = char> {
    LETTERS
        .into_iter()
        .filter_map(move |(flag, letter)| flags.contains(flag).then_some(letter))
}

/// The flag cluster, such as `-dims`.
pub fn label(flags: Flags) -> String {
    std::iter::once('-').chain(letters(flags)).collect()
}

/// Closed argv. There is no utility slot, because `caffeinate` ignores `-w`
/// when a utility is also present.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Argv {
    flags: Flags,
    pid: u32,
}

impl Argv {
    /// `pid` is the process the child waits on with `-w`.
    pub fn new(flags: Flags, pid: u32) -> Self {
        Self { flags, pid }
    }

    /// The tokens `Command` is given.
    pub fn args(self) -> Vec<String> {
        letters(self.flags)
            .map(|letter| format!("-{letter}"))
            .chain(["-w".to_string(), self.pid.to_string()])
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caffeinate::{flags, Empty};

    fn args(flags: Flags) -> Vec<String> {
        Argv::new(flags, 42).args()
    }

    #[test]
    fn argv_is_flag_tokens_then_wait_pid() {
        assert_eq!(args(Flags::all()), ["-d", "-i", "-m", "-s", "-w", "42"]);
        assert_eq!(args(flags(&[Flag::Display])), ["-d", "-w", "42"]);
        assert_eq!(args(flags(&[Flag::System])), ["-s", "-w", "42"]);
        assert_eq!(label(Flags::all()), "-dims");
        assert_eq!(label(flags(&[Flag::System, Flag::Display])), "-ds");
        assert_eq!(label(flags(&[Flag::Disk])), "-m");
        assert_eq!(Flags::new([]), Err(Empty));
    }
}
