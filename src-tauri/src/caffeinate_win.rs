//! The one power request this process holds on Windows.
//!
//! Windows clears a power request when its handle closes, and it closes every
//! handle when the process ends. A crash, End task in Task Manager, or Quit's
//! `process::exit` (which skips `Drop`) leaves no request behind, so this side
//! needs no `HELD_PID`. `powercfg /requests` lists the request under the
//! process, with [`REASON`].

use std::io;

use fidget_core::caffeinate::{Argv, AssertedFlags, Flag, Spawner};
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

/// The request types a flag set asks for. Idle and System both keep the system
/// up. Windows has no disk request, so Disk adds nothing.
pub fn request_types(flags: AssertedFlags) -> Vec<POWER_REQUEST_TYPE> {
    let mut types = Vec::new();
    if flags.contains(Flag::Display) {
        types.push(PowerRequestDisplayRequired);
    }
    if flags.contains(Flag::Idle) || flags.contains(Flag::System) {
        types.push(PowerRequestSystemRequired);
    }
    types
}

struct Held {
    handle: HANDLE,
    types: Vec<POWER_REQUEST_TYPE>,
}

impl Held {
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
    held: Option<Held>,
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
        if self.held.is_some() {
            return Err("a power request is already held".to_string());
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
        let mut held = Held {
            handle,
            types: Vec::new(),
        };
        for kind in types {
            // SAFETY: `handle` is the live request created above.
            if unsafe { PowerSetRequest(handle, kind) } == 0 {
                let error = io::Error::last_os_error().to_string();
                held.release();
                return Err(error);
            }
            held.types.push(kind);
        }
        self.held = Some(held);
        Ok(())
    }

    /// Clears the request at once, so the next tick reads it as gone.
    fn kill(&mut self) {
        if let Some(held) = self.held.take() {
            held.release();
        }
    }

    fn alive(&mut self) -> bool {
        self.held.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(set: &[Flag]) -> AssertedFlags {
        AssertedFlags::new(set.iter().copied()).expect("a flag")
    }

    #[test]
    fn display_asks_for_the_display_and_idle_or_system_for_the_system() {
        assert_eq!(
            request_types(AssertedFlags::all()),
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
    fn disk_alone_holds_nothing() {
        let mut spawner = OsSpawner::new();
        let err = spawner
            .spawn(&flags(&[Flag::Disk]).argv(std::process::id()))
            .expect_err("no request type");
        assert!(!err.is_empty());
        assert!(!spawner.alive());
    }

    #[test]
    fn a_real_request_is_held_once_and_released_by_kill() {
        let mut spawner = OsSpawner::new();
        let argv = AssertedFlags::all().argv(std::process::id());
        spawner.spawn(&argv).expect("the request is created");
        assert!(spawner.alive());
        assert!(
            spawner.spawn(&argv).is_err(),
            "a second request would hide the first"
        );
        spawner.kill();
        assert!(!spawner.alive());
        spawner
            .spawn(&argv)
            .expect("a released request can be made again");
        assert!(spawner.alive());
    }
}
