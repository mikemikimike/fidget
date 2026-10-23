//! Caffeinate keeps this computer awake. [`Machine`] decides when it is on,
//! and the OS side behind [`OsCaffeinate`] does the keeping. [`macos`], [`linux`]
//! and [`windows`] name what each OS takes for a flag set. They are pure, so
//! every target builds and tests all three.

pub mod linux;
pub mod macos;
pub mod windows;

/// The empty flag set cannot be saved or turned on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Empty;

impl Empty {
    pub const REASON: &'static str = "At least one caffeinate flag has to stay on.";
}

/// One thing Caffeinate can keep awake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flag {
    Display,
    Idle,
    Disk,
    System,
}

impl Flag {
    pub const ALL: [Flag; 4] = [Flag::Display, Flag::Idle, Flag::Disk, Flag::System];
}

/// A non-empty set of flags. One bit per [`Flag`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags(u8);

impl Flags {
    pub fn new(flags: impl IntoIterator<Item = Flag>) -> Result<Self, Empty> {
        let bits = flags.into_iter().fold(0, |bits, flag| bits | bit(flag));
        if bits == 0 {
            Err(Empty)
        } else {
            Ok(Self(bits))
        }
    }

    /// Every flag, the default.
    pub fn all() -> Self {
        Self(Flag::ALL.iter().fold(0, |bits, flag| bits | bit(*flag)))
    }

    pub fn contains(self, flag: Flag) -> bool {
        self.0 & bit(flag) != 0
    }

    /// The words this OS uses for what Caffeinate keeps awake. Chat, the
    /// prompt line, the MCP answer and the Settings Command row show it.
    pub fn inhibitor_label(self) -> String {
        if cfg!(target_os = "linux") {
            linux::label(self)
        } else if cfg!(windows) {
            windows::label(self)
        } else {
            macos::label(self)
        }
    }
}

fn bit(flag: Flag) -> u8 {
    1 << flag as u8
}

/// Whether Caffeinate is on, and with which flags. Absence of the feature is
/// `None` at the prompt, not a third variant here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fact {
    Off,
    On(Flags),
}

impl Fact {
    pub fn on(self) -> bool {
        matches!(self, Fact::On(_))
    }

    /// `caffeinate: off` or `caffeinate: on (-dims)`, with [`Flags::inhibitor_label`].
    pub fn prompt_line(self) -> String {
        match self {
            Fact::Off => "caffeinate: off".to_string(),
            Fact::On(flags) => format!("caffeinate: on ({})", flags.inhibitor_label()),
        }
    }
}

/// A Chat note. Not a tool result and not the prompt line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Note {
    On(Flags),
    Off,
    /// The OS side turned off while Caffeinate was still on and nobody asked.
    Exited,
    Failed,
    /// A `Spawner` that works off the caller's thread could not turn Caffeinate
    /// on.
    Lost(String),
}

impl Note {
    pub fn text(&self) -> String {
        match self {
            Note::On(flags) => format!(
                "☕ Caffeinate on: keeping your computer awake ({})",
                flags.inhibitor_label()
            ),
            Note::Off => "Caffeinate off.".to_string(),
            Note::Exited => "Caffeinate off. It exited on its own.".to_string(),
            Note::Failed => "Caffeinate did not start.".to_string(),
            Note::Lost(reason) => format!("Caffeinate off. Could not take {reason}"),
        }
    }
}

/// Chat and the menu send [`Request::Toggle`]. The tool sends [`Request::Set`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Toggle,
    Set(bool),
}

/// What an OS side's `turn_on` says while it is already on.
pub const ALREADY_ON: &str = "Caffeinate is already on.";

/// The OS side. `turn_on` fails with [`ALREADY_ON`] while Caffeinate is on, so
/// a second start cannot hide the first.
pub trait OsCaffeinate {
    fn turn_on(&mut self, flags: Flags) -> Result<(), String>;
    fn turn_off(&mut self);
    /// Whether the OS side still keeps the computer awake.
    fn is_on(&mut self) -> bool;
    /// Why `is_on` just reported off: Caffeinate never came on. Only an OS side
    /// whose `turn_on` returns before the OS answers has one.
    fn failure(&mut self) -> Option<String> {
        None
    }
}

/// The frame loop's Caffeinate, as `dispatch` sees it. `None` reads. `Err` is a
/// failed start or an empty flag set.
pub trait CaffeinateHandle {
    fn call(&mut self, on: Option<bool>) -> Result<Fact, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tick {
    pub fact: Fact,
    pub notes: Vec<Note>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Off,
    On(Flags),
    /// Asked to turn off. Caffeinate still reads `flags`. Once the OS side is
    /// off it turns `flags` on if `restart`, or turns off with a note.
    TurningOff {
        flags: Flags,
        restart: bool,
    },
}

/// The only thing that turns Caffeinate on or off.
pub struct Machine<O: OsCaffeinate> {
    os: O,
    wanted: bool,
    phase: Phase,
}

impl<O: OsCaffeinate> Machine<O> {
    pub fn new(os: O) -> Self {
        Self {
            os,
            wanted: false,
            phase: Phase::Off,
        }
    }

    /// Apply requests, then bring the OS side to what they want.
    pub fn tick(&mut self, flags: Result<Flags, Empty>, requests: &[Request]) -> Tick {
        let is_on = self.os.is_on();
        let failure = self.os.failure();
        let mut tick = Tick {
            fact: Fact::Off,
            notes: Vec::new(),
            error: None,
        };
        let restarted = self.finish_turning_off(is_on, &mut tick);

        let was = self.wanted;
        for request in requests {
            let want = match request {
                Request::Toggle => !self.wanted,
                Request::Set(on) => *on,
            };
            if want && flags.is_err() {
                tick.error = Some(Empty::REASON.to_string());
            }
            self.wanted = want && flags.is_ok();
        }
        let announce = !was && self.wanted;
        let asked_on = requests
            .iter()
            .any(|request| matches!(request, Request::Set(true) | Request::Toggle));

        // `is_on` described the old one if a restart just turned on a new one.
        if let (false, false, Phase::On(current)) = (restarted, is_on, self.phase) {
            self.phase = Phase::Off;
            let changed = flags.is_ok_and(|next| next != current);
            if !self.wanted {
                tick.notes.push(Note::Off);
            } else if let Some(reason) = failure {
                tick.notes.push(Note::Lost(reason));
                self.wanted = false;
            } else if self.wanted && !changed && !asked_on {
                tick.notes.push(Note::Exited);
                self.wanted = false;
            }
        }

        match (self.wanted, self.phase, flags) {
            (true, Phase::Off, Ok(flags)) => self.turn_on(flags, announce, &mut tick),
            (true, Phase::Off, Err(Empty)) => {
                self.wanted = false;
                tick.error = Some(Empty::REASON.to_string());
            }
            (false, Phase::On(flags), _) => {
                self.os.turn_off();
                self.phase = Phase::TurningOff {
                    flags,
                    restart: false,
                };
            }
            (true, Phase::On(current), Ok(next)) if next != current => {
                self.os.turn_off();
                self.phase = Phase::TurningOff {
                    flags: next,
                    restart: true,
                };
            }
            (true, Phase::TurningOff { restart: false, .. }, Ok(next)) => {
                self.phase = Phase::TurningOff {
                    flags: next,
                    restart: true,
                };
            }
            (
                false,
                Phase::TurningOff {
                    flags,
                    restart: true,
                    ..
                },
                _,
            ) => {
                self.phase = Phase::TurningOff {
                    flags,
                    restart: false,
                };
            }
            _ => {}
        }

        tick.fact = match self.phase {
            Phase::Off => Fact::Off,
            Phase::On(flags) | Phase::TurningOff { flags, .. } => Fact::On(flags),
        };
        tick
    }

    /// Asks again while the OS side is still on. Returns whether this call
    /// turned the next one on.
    fn finish_turning_off(&mut self, is_on: bool, tick: &mut Tick) -> bool {
        let Phase::TurningOff { flags, restart } = self.phase else {
            return false;
        };
        if is_on {
            self.os.turn_off();
            return false;
        }
        self.phase = Phase::Off;
        if restart {
            self.turn_on(flags, false, tick);
            return true;
        }
        self.wanted = false;
        tick.notes.push(Note::Off);
        false
    }

    fn turn_on(&mut self, flags: Flags, announce: bool, tick: &mut Tick) {
        match self.os.turn_on(flags) {
            Ok(()) => {
                self.phase = Phase::On(flags);
                self.wanted = true;
                if announce {
                    tick.notes.push(Note::On(flags));
                }
            }
            Err(reason) => {
                self.phase = Phase::Off;
                self.wanted = false;
                tick.notes.push(Note::Failed);
                tick.error = Some(reason);
            }
        }
    }
}

/// A flag set for tests. `expect`s at least one flag.
#[cfg(test)]
fn flags(set: &[Flag]) -> Flags {
    Flags::new(set.iter().copied()).expect("a flag")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An OS side whose `is_on` answers what the test scripts next.
    struct ScriptedOs {
        on: bool,
        next: Option<bool>,
        turned_on: Vec<Flags>,
        turn_offs: usize,
        fail: bool,
        failure: Option<String>,
    }

    impl ScriptedOs {
        fn new() -> Self {
            Self {
                on: false,
                next: None,
                turned_on: Vec::new(),
                turn_offs: 0,
                fail: false,
                failure: None,
            }
        }
    }

    impl OsCaffeinate for ScriptedOs {
        fn turn_on(&mut self, flags: Flags) -> Result<(), String> {
            if self.on {
                return Err(ALREADY_ON.to_string());
            }
            if self.fail {
                return Err("caffeinate missing".to_string());
            }
            self.on = true;
            self.turned_on.push(flags);
            Ok(())
        }

        fn turn_off(&mut self) {
            if self.on {
                self.turn_offs += 1;
            }
        }

        fn is_on(&mut self) -> bool {
            let is_on = self.next.take().unwrap_or(self.on);
            self.on &= is_on;
            is_on
        }

        fn failure(&mut self) -> Option<String> {
            self.failure.take()
        }
    }

    fn dims() -> Flags {
        Flags::all()
    }

    fn drive(
        machine: &mut Machine<ScriptedOs>,
        flags: Result<Flags, Empty>,
        requests: &[Request],
        is_on: bool,
    ) -> Tick {
        machine.os.next = Some(is_on);
        machine.tick(flags, requests)
    }

    /// `inhibitor_label` for every flag on this OS.
    const DIMS_LABEL: &str = if cfg!(target_os = "linux") {
        "logind inhibit idle:sleep + screen saver inhibit"
    } else if cfg!(windows) {
        "DISPLAY, SYSTEM"
    } else {
        "-dims"
    };

    #[test]
    fn the_inhibitor_label_is_the_name_each_os_uses() {
        assert_eq!(dims().inhibitor_label(), DIMS_LABEL);
    }

    #[test]
    fn prompt_and_note_text_are_the_issue_sentences() {
        assert_eq!(Fact::Off.prompt_line(), "caffeinate: off");
        assert_eq!(
            Fact::On(dims()).prompt_line(),
            format!("caffeinate: on ({DIMS_LABEL})")
        );
        assert_eq!(
            Note::On(dims()).text(),
            format!("☕ Caffeinate on: keeping your computer awake ({DIMS_LABEL})")
        );
        assert_eq!(Note::Off.text(), "Caffeinate off.");
        assert_eq!(Note::Exited.text(), "Caffeinate off. It exited on its own.");
        assert_eq!(Note::Failed.text(), "Caffeinate did not start.");
        assert_eq!(
            Note::Lost("logind inhibit sleep: Access denied".to_string()).text(),
            "Caffeinate off. Could not take logind inhibit sleep: Access denied"
        );
    }

    /// An OS side that works off the caller's thread reports a refusal after
    /// `turn_on` returned Ok. Chat hears why, and Caffeinate stays off.
    #[test]
    fn caffeinate_that_could_not_turn_on_says_why_and_stays_off() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        machine.os.failure = Some("logind inhibit sleep: denied".to_string());
        let lost = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(lost.fact, Fact::Off);
        assert_eq!(
            lost.notes,
            vec![Note::Lost("logind inhibit sleep: denied".to_string())]
        );
        let after = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(after.fact, Fact::Off);
        assert!(after.notes.is_empty());
        assert_eq!(machine.os.turned_on.len(), 1);
    }

    /// A refusal that lands after the user turned it off is just Off.
    #[test]
    fn a_refusal_while_stopping_is_only_off() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        drive(&mut machine, Ok(dims()), &[Request::Set(false)], true);
        machine.os.failure = Some("denied".to_string());
        let done = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(done.fact, Fact::Off);
        assert_eq!(done.notes, vec![Note::Off]);
        assert!(machine.os.failure.is_none());
    }

    #[test]
    fn set_on_spawns_once_and_a_repeat_does_not() {
        let mut machine = Machine::new(ScriptedOs::new());
        let first = drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        assert_eq!(first.fact, Fact::On(dims()));
        assert_eq!(first.notes, vec![Note::On(dims())]);
        assert_eq!(machine.os.turned_on.len(), 1);

        let second = drive(&mut machine, Ok(dims()), &[Request::Set(true)], true);
        assert_eq!(second.fact, Fact::On(dims()));
        assert!(second.notes.is_empty());
        assert_eq!(machine.os.turned_on.len(), 1);
        assert_eq!(machine.os.turn_offs, 0);
    }

    #[test]
    fn set_off_stays_on_until_the_child_exits() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);

        let stopping = drive(&mut machine, Ok(dims()), &[Request::Set(false)], true);
        assert_eq!(stopping.fact, Fact::On(dims()));
        assert!(stopping.notes.is_empty());
        assert_eq!(machine.os.turn_offs, 1);

        let done = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(done.fact, Fact::Off);
        assert_eq!(done.notes, vec![Note::Off]);
        assert_eq!(machine.os.turned_on.len(), 1);
    }

    #[test]
    fn a_second_set_off_does_nothing() {
        let mut machine = Machine::new(ScriptedOs::new());
        let tick = drive(&mut machine, Ok(dims()), &[Request::Set(false)], false);
        assert_eq!(tick.fact, Fact::Off);
        assert!(tick.notes.is_empty());
        assert!(machine.os.turned_on.is_empty());
        assert_eq!(machine.os.turn_offs, 0);
    }

    #[test]
    fn flag_change_restarts_without_an_off_or_a_second_on() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        let display = flags(&[Flag::Display]);

        let stopping = drive(&mut machine, Ok(display), &[], true);
        assert_eq!(stopping.fact, Fact::On(display));
        assert!(stopping.notes.is_empty());
        assert_eq!(machine.os.turn_offs, 1);
        assert_eq!(machine.os.turned_on.len(), 1);

        let restarted = drive(&mut machine, Ok(display), &[], false);
        assert_eq!(restarted.fact, Fact::On(display));
        assert!(restarted.notes.is_empty());
        assert_eq!(machine.os.turned_on[1], display);
    }

    #[test]
    fn off_in_the_tick_a_restart_spawns_waits_for_the_new_child() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        let display = flags(&[Flag::Display]);
        drive(&mut machine, Ok(display), &[], true);

        let off = drive(&mut machine, Ok(display), &[Request::Set(false)], false);
        assert_eq!(off.fact, Fact::On(display));
        assert!(off.notes.is_empty());
        assert_eq!(machine.os.turned_on.len(), 2);

        let done = drive(&mut machine, Ok(display), &[], false);
        assert_eq!(done.fact, Fact::Off);
        assert_eq!(done.notes, vec![Note::Off]);

        let again = drive(&mut machine, Ok(display), &[Request::Set(true)], false);
        assert_eq!(again.fact, Fact::On(display));
        assert_eq!(again.notes, vec![Note::On(display)]);
        assert!(again.error.is_none());
        assert_eq!(machine.os.turned_on.len(), 3);
    }

    #[test]
    fn a_flag_change_in_the_tick_a_restart_spawns_waits_for_the_new_child() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        let display = flags(&[Flag::Display]);
        let system = flags(&[Flag::System]);
        drive(&mut machine, Ok(display), &[], true);

        let changed = drive(&mut machine, Ok(system), &[], false);
        assert_eq!(changed.fact, Fact::On(system));
        assert!(changed.notes.is_empty());
        assert!(changed.error.is_none());

        let restarted = drive(&mut machine, Ok(system), &[], false);
        assert_eq!(restarted.fact, Fact::On(system));
        assert!(restarted.notes.is_empty());
        assert_eq!(machine.os.turned_on[2], system);
    }

    #[test]
    fn a_child_that_exits_on_its_own_turns_caffeinate_off() {
        let mut machine = Machine::new(ScriptedOs::new());
        drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        let exited = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(exited.fact, Fact::Off);
        assert_eq!(exited.notes, vec![Note::Exited]);
        assert_eq!(machine.os.turn_offs, 0);
    }

    #[test]
    fn a_failed_spawn_stays_off() {
        let mut os = ScriptedOs::new();
        os.fail = true;
        let mut machine = Machine::new(os);
        let tick = drive(&mut machine, Ok(dims()), &[Request::Set(true)], false);
        assert_eq!(tick.fact, Fact::Off);
        assert_eq!(tick.notes, vec![Note::Failed]);
        assert_eq!(tick.error.as_deref(), Some("caffeinate missing"));
        assert!(machine.os.turned_on.is_empty());
    }

    #[test]
    fn empty_flags_refuse_a_start() {
        let mut machine = Machine::new(ScriptedOs::new());
        let tick = drive(&mut machine, Err(Empty), &[Request::Set(true)], false);
        assert_eq!(tick.fact, Fact::Off);
        assert_eq!(tick.error.as_deref(), Some(Empty::REASON));
        assert!(tick.notes.is_empty());
        assert!(machine.os.turned_on.is_empty());
    }

    #[test]
    fn toggle_tracks_set() {
        let mut machine = Machine::new(ScriptedOs::new());
        let on = drive(&mut machine, Ok(dims()), &[Request::Toggle], false);
        assert_eq!(on.fact, Fact::On(dims()));
        assert_eq!(on.notes, vec![Note::On(dims())]);

        let off = drive(&mut machine, Ok(dims()), &[Request::Toggle], true);
        assert_eq!(off.fact, Fact::On(dims()));
        assert!(off.notes.is_empty());
        let done = drive(&mut machine, Ok(dims()), &[], false);
        assert_eq!(done.notes, vec![Note::Off]);
        assert_eq!(done.fact, Fact::Off);
    }
}
