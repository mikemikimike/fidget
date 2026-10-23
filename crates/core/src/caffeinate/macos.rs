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

    /// The flags alone, for a `Spawner` that takes no argv.
    pub fn flags(self) -> Flags {
        self.flags
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
    use crate::caffeinate::Empty;

    #[test]
    fn argv_is_flag_tokens_then_wait_pid() {
        let args = Argv::new(Flags::all(), 42).args();
        assert_eq!(
            args,
            vec!["-d", "-i", "-m", "-s", "-w", "42"]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );
        assert_eq!(label(Flags::all()), "-dims");
        assert_eq!(
            label(Flags::new([Flag::System, Flag::Display]).unwrap()),
            "-ds"
        );
        assert_eq!(label(Flags::new([Flag::Disk]).unwrap()), "-m");
        assert_eq!(Flags::new([]), Err(Empty));
    }
}
