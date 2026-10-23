//! The one `caffeinate` child this process runs, and the Caffeinate switch
//! the frame loop owns.
//!
//! `Child::kill` is SIGKILL. A child that ignores SIGTERM keeps the assertion
//! until `try_wait` says it left; `-w` is what releases it if this process
//! dies first. Quit signals the pid from another thread because
//! `process::exit` skips this thread's `Drop`. On Linux, [`Caffeinate`] drives
//! the inhibitors in `caffeinate_linux` instead, and on Windows the power
//! requests in `caffeinate_win`.

#[cfg(target_os = "macos")]
use std::process::{Child, Command};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(target_os = "linux")]
use crate::caffeinate_linux::OsSpawner;
#[cfg(windows)]
use crate::caffeinate_win::OsSpawner;
#[cfg(target_os = "macos")]
use fidget_core::caffeinate::{macos::Argv, OsCaffeinate, ALREADY_ON};
use fidget_core::caffeinate::{CaffeinateHandle, Empty, Fact, Flags, Machine, Note, Request, Tick};

/// The running child's pid, or 0. The quit paths call `process::exit`, which
/// skips `Drop`, so they read this to SIGTERM the child.
#[cfg(target_os = "macos")]
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

/// SIGTERM the child, if one is still running. Safe to call from Quit.
#[cfg(target_os = "macos")]
pub fn signal_child() {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        signal_term(pid);
    }
}

#[cfg(target_os = "macos")]
fn signal_term(pid: u32) {
    // SAFETY: SIGTERM to a pid we spawned. A recycled pid is the kernel's
    // to reject; we only store a pid we have not yet reaped.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(target_os = "macos")]
fn set_child_pid(pid: u32) {
    CHILD_PID.store(pid, Ordering::SeqCst);
}

/// Clears `CHILD_PID` only if it is still `pid`, so reaping an old child
/// never wipes the pid of the newer one a restart already stored.
#[cfg(target_os = "macos")]
fn clear_child_pid_if(pid: u32) {
    let _ = CHILD_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
pub struct OsSpawner {
    program: &'static str,
    child: Option<Child>,
}

#[cfg(target_os = "macos")]
impl OsSpawner {
    pub fn new() -> Self {
        Self::program("/usr/bin/caffeinate")
    }

    fn program(program: &'static str) -> Self {
        Self {
            program,
            child: None,
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for OsSpawner {
    fn drop(&mut self) {
        self.turn_off();
        if let Some(child) = self.child.as_mut() {
            let _ = child.wait();
        }
    }
}

#[cfg(target_os = "macos")]
impl OsCaffeinate for OsSpawner {
    fn turn_on(&mut self, flags: Flags) -> Result<(), String> {
        if self.child.is_some() {
            return Err(ALREADY_ON.to_string());
        }
        let child = Command::new(self.program)
            .args(Argv::new(flags, std::process::id()).args())
            .spawn()
            .map_err(|error| error.to_string())?;
        set_child_pid(child.id());
        self.child = Some(child);
        Ok(())
    }

    fn turn_off(&mut self) {
        if let Some(child) = self.child.as_ref() {
            signal_term(child.id());
        }
    }

    fn is_on(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        if let Ok(Some(_)) = child.try_wait() {
            clear_child_pid_if(child.id());
            self.child = None;
            return false;
        }
        true
    }
}

/// The frame loop's Caffeinate switch. Notes from tool calls wait here until
/// the frame loop posts them to Chat.
pub struct Caffeinate {
    machine: Machine<OsSpawner>,
    configured: Result<Flags, Empty>,
    pending: Vec<Note>,
}

impl Caffeinate {
    pub fn new() -> Self {
        Self {
            machine: Machine::new(OsSpawner::new()),
            configured: Ok(Flags::all()),
            pending: Vec::new(),
        }
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn a_missing_program_starts_nothing() {
        let mut spawner = OsSpawner::program("/no/such/caffeinate");
        let err = spawner.turn_on(Flags::all()).expect_err("missing program");
        assert!(!err.is_empty());
        assert!(!spawner.is_on());
    }

    #[test]
    fn a_real_caffeinate_leaves_when_signalled() {
        let mut spawner = OsSpawner::new();
        spawner.turn_on(Flags::all()).expect("caffeinate starts");
        assert!(spawner.is_on());
        let listed = Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset");
        let text = String::from_utf8_lossy(&listed.stdout);
        assert!(
            text.contains("caffeinate"),
            "pmset should name caffeinate while it is on: {text}"
        );
        let again = spawner.turn_on(Flags::all());
        assert!(again.is_err(), "a second child would hide the first");
        assert!(spawner.is_on());
        spawner.turn_off();
        let mut is_on = true;
        for _ in 0..50 {
            is_on = spawner.is_on();
            if !is_on {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!is_on);
        assert_eq!(CHILD_PID.load(Ordering::SeqCst), 0);
    }
}
