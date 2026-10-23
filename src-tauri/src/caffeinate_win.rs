//! The power requests this process takes on Windows.
//!
//! Windows drops the power requests when their handle closes, and it closes
//! every handle when the process ends. A crash, End task in Task Manager, or Quit's
//! `process::exit` (which skips `Drop`) leaves no request behind, so this side
//! needs no `CHILD_PID`. `powercfg /requests` lists the requests under
//! fidget.exe, with [`REASON`].

use std::io;

use fidget_core::caffeinate::macos::Argv;
use fidget_core::caffeinate::windows::{self, Request};
#[cfg(test)]
use fidget_core::caffeinate::Flag;
use fidget_core::caffeinate::{Flags, Spawner};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerRequestSystemRequired,
    PowerSetRequest, POWER_REQUEST_TYPE,
};
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

/// The reason `powercfg /requests` prints under fidget.exe.
pub const REASON: &str = "Fidget: keep my computer awake";

/// `POWER_REQUEST_CONTEXT_VERSION`, which windows-sys keeps behind a feature
/// this crate does not otherwise need.
const CONTEXT_VERSION: u32 = 0;

/// The `PowerSetRequest` types for a flag set. The core owns the flag map, so
/// the Settings Command row and the notes name exactly what this file takes.
pub fn request_types(flags: Flags) -> Vec<POWER_REQUEST_TYPE> {
    windows::requests(flags)
        .into_iter()
        .map(|request| match request {
            Request::Display => PowerRequestDisplayRequired,
            Request::System => PowerRequestSystemRequired,
        })
        .collect()
}

/// The `PowerCreateRequest` handle and each type `PowerSetRequest` turned on.
struct Requests {
    handle: HANDLE,
    types: Vec<POWER_REQUEST_TYPE>,
}

impl Requests {
    fn release(self) {
        // SAFETY: `handle` came from `PowerCreateRequest` and is closed once,
        // here, because `release` takes the only copy.
        unsafe {
            for kind in &self.types {
                PowerClearRequest(self.handle, *kind);
            }
            CloseHandle(self.handle);
        }
    }
}

#[derive(Default)]
pub struct OsSpawner {
    taken: Option<Requests>,
}

impl OsSpawner {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Drop for OsSpawner {
    fn drop(&mut self) {
        self.kill();
    }
}

impl Spawner for OsSpawner {
    fn spawn(&mut self, argv: &Argv) -> Result<(), String> {
        if self.taken.is_some() {
            return Err("the power requests are already taken".to_string());
        }
        let types = request_types(argv.flags());
        if types.is_empty() {
            return Err("no flag maps to a Windows power request".to_string());
        }
        let mut reason: Vec<u16> = REASON.encode_utf16().chain([0]).collect();
        let context = REASON_CONTEXT {
            Version: CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        // SAFETY: `context` and the string it points at outlive the call, and
        // Windows copies the reason before it returns.
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            return Err(io::Error::last_os_error().to_string());
        }
        let mut taken = Requests {
            handle,
            types: Vec::new(),
        };
        for kind in types {
            // SAFETY: `handle` is the live request created above.
            if unsafe { PowerSetRequest(handle, kind) } == 0 {
                let error = io::Error::last_os_error().to_string();
                taken.release();
                return Err(error);
            }
            taken.types.push(kind);
        }
        // scripts/verify-caffeinate-win.ps1 waits on this line.
        eprintln!(
            "caffeinate: power requests taken: {}",
            windows::label(argv.flags())
        );
        self.taken = Some(taken);
        Ok(())
    }

    /// Releases the power requests at once, so the next tick reads Caffeinate
    /// as off.
    fn kill(&mut self) {
        if let Some(taken) = self.taken.take() {
            taken.release();
            eprintln!("caffeinate: power requests released");
        }
    }

    fn alive(&mut self) -> bool {
        self.taken.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(set: &[Flag]) -> Flags {
        Flags::new(set.iter().copied()).expect("a flag")
    }

    #[test]
    fn display_asks_for_the_display_and_idle_or_system_for_the_system() {
        assert_eq!(
            request_types(Flags::all()),
            vec![PowerRequestDisplayRequired, PowerRequestSystemRequired]
        );
        assert_eq!(
            request_types(flags(&[Flag::Display])),
            vec![PowerRequestDisplayRequired]
        );
        assert_eq!(
            request_types(flags(&[Flag::Idle])),
            vec![PowerRequestSystemRequired]
        );
        assert_eq!(
            request_types(flags(&[Flag::System])),
            vec![PowerRequestSystemRequired]
        );
        assert!(request_types(flags(&[Flag::Disk])).is_empty());
    }

    #[test]
    fn disk_alone_takes_no_power_request() {
        let mut spawner = OsSpawner::new();
        let err = spawner
            .spawn(&Argv::new(flags(&[Flag::Disk]), std::process::id()))
            .expect_err("Disk maps to no power request");
        assert!(!err.is_empty());
        assert!(!spawner.alive());
    }

    #[test]
    fn a_real_power_request_is_taken_once_and_released_by_kill() {
        let mut spawner = OsSpawner::new();
        let argv = Argv::new(Flags::all(), std::process::id());
        spawner
            .spawn(&argv)
            .expect("Windows grants the power requests");
        assert!(spawner.alive());
        assert!(
            spawner.spawn(&argv).is_err(),
            "a second take would leak the first handle"
        );
        spawner.kill();
        assert!(!spawner.alive());
        spawner
            .spawn(&argv)
            .expect("released power requests can be taken again");
        assert!(spawner.alive());
    }
}
