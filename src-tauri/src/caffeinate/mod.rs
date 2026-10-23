//! The Caffeinate switch the frame loop owns, over this OS's side of it:
//! [`macos`] runs a `caffeinate` child, [`linux`] takes logind and screen
//! saver inhibitors, and [`windows`] makes power requests.

use fidget_core::caffeinate::{CaffeinateHandle, Empty, Fact, Flags, Machine, Note, Request, Tick};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
type Os = linux::Inhibitors;
#[cfg(target_os = "macos")]
type Os = macos::CaffeinateChild;
#[cfg(windows)]
type Os = windows::PowerRequests;

/// Turns this OS's side off before `process::exit`, which skips `Drop`. Safe
/// to call from Quit.
pub fn on_quit() {
    Os::on_quit();
}

/// The frame loop's Caffeinate switch. Notes from tool calls wait here until
/// the frame loop posts them to Chat.
pub struct Caffeinate {
    machine: Machine<Os>,
    configured: Result<Flags, Empty>,
    pending: Vec<Note>,
}

impl Caffeinate {
    pub fn new() -> Self {
        Self {
            machine: Machine::new(Os::new()),
            configured: Ok(Flags::all()),
            pending: Vec::new(),
        }
    }

    /// Why the cup and the menu row are disabled when this OS has nothing to
    /// keep the computer awake with. `None` while that is still unknown.
    pub fn unavailable() -> Option<&'static str> {
        Os::unavailable()
    }

    pub fn set_flags(&mut self, configured: Result<Flags, Empty>) {
        self.configured = configured;
    }

    pub fn tick(&mut self, requests: &[Request]) -> Tick {
        let tick = self.machine.tick(self.configured, requests);
        self.pending.extend(tick.notes.iter().cloned());
        tick
    }

    pub fn take_notes(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.pending)
    }
}

impl CaffeinateHandle for Caffeinate {
    fn call(&mut self, on: Option<bool>) -> Result<Fact, String> {
        let requests: Vec<Request> = on.map(Request::Set).into_iter().collect();
        let tick = self.tick(&requests);
        match tick.error {
            Some(error) => Err(error),
            None => Ok(tick.fact),
        }
    }
}
