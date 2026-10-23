//! The one `caffeinate` child this process runs.
//!
//! `Child::kill` is SIGKILL. A child that ignores SIGTERM stays on until
//! `try_wait` says it left. `-w` ends it if this process dies first. Quit
//! signals the pid from another thread because `process::exit` skips this
//! thread's `Drop`.

use std::process::{Child, Command};
use std::sync::atomic::{AtomicU32, Ordering};

use fidget_core::caffeinate::macos::Argv;
use fidget_core::caffeinate::{Flags, OsCaffeinate, ALREADY_ON};

/// The running child's pid, or 0. The quit paths call `process::exit`, which
/// skips `Drop`, so they read this to SIGTERM the child.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

/// SIGTERM the child, if one is still running. Safe to call from Quit.
fn signal_child() {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        signal_term(pid);
    }
}

fn signal_term(pid: u32) {
    // SAFETY: SIGTERM to a pid we spawned. A recycled pid is the kernel's
    // to reject; we only store a pid we have not yet reaped.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

fn set_child_pid(pid: u32) {
    CHILD_PID.store(pid, Ordering::SeqCst);
}

/// Clears `CHILD_PID` only if it is still `pid`, so reaping an old child
/// never wipes the pid of the newer one a restart already stored.
fn clear_child_pid_if(pid: u32) {
    let _ = CHILD_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
}

pub struct CaffeinateChild {
    program: &'static str,
    child: Option<Child>,
}

impl CaffeinateChild {
    pub fn new() -> Self {
        Self::program("/usr/bin/caffeinate")
    }

    /// `/usr/bin/caffeinate` ships with macOS.
    pub fn unavailable() -> Option<&'static str> {
        None
    }

    pub fn on_quit() {
        signal_child();
    }

    fn program(program: &'static str) -> Self {
        Self {
            program,
            child: None,
        }
    }
}

impl Drop for CaffeinateChild {
    fn drop(&mut self) {
        self.turn_off();
        if let Some(child) = self.child.as_mut() {
            let _ = child.wait();
        }
    }
}

impl OsCaffeinate for CaffeinateChild {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn a_missing_program_starts_nothing() {
        let mut child = CaffeinateChild::program("/no/such/caffeinate");
        let err = child.turn_on(Flags::all()).expect_err("missing program");
        assert!(!err.is_empty());
        assert!(!child.is_on());
    }

    #[test]
    fn a_real_caffeinate_leaves_when_signalled() {
        let mut child = CaffeinateChild::new();
        child.turn_on(Flags::all()).expect("caffeinate starts");
        assert!(child.is_on());
        let listed = Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset");
        let text = String::from_utf8_lossy(&listed.stdout);
        assert!(
            text.contains("caffeinate"),
            "pmset should name caffeinate while it is on: {text}"
        );
        let again = child.turn_on(Flags::all());
        assert!(again.is_err(), "a second child would hide the first");
        assert!(child.is_on());
        child.turn_off();
        let mut is_on = true;
        for _ in 0..50 {
            is_on = child.is_on();
            if !is_on {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!is_on);
        assert_eq!(CHILD_PID.load(Ordering::SeqCst), 0);
    }
}
