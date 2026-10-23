//! The power requests this process takes on Windows.
//!
//! Windows drops the power requests when their handle closes, and it closes
//! every handle when the process ends. A crash, End task in Task Manager, or Quit's
//! `process::exit` (which skips `Drop`) leaves no request behind, so this side
//! needs no `CHILD_PID`. `powercfg /requests` lists the requests under
//! fidget.exe, with [`REASON`].

use std::io;

use fidget_core::caffeinate::windows::{self, PowerRequest};
#[cfg(test)]
use fidget_core::caffeinate::Flag;
use fidget_core::caffeinate::{Flags, OsCaffeinate, ALREADY_ON};
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
fn request_types(flags: Flags) -> Vec<POWER_REQUEST_TYPE> {
    windows::requests(flags)
        .into_iter()
        .map(|request| match request {
            PowerRequest::Display => PowerRequestDisplayRequired,
            PowerRequest::System => PowerRequestSystemRequired,
        })
        .collect()
}

/// The `PowerCreateRequest` handle and each type `PowerSetRequest` turned on.
struct Requests {
    handle: HANDLE,
    types: Vec<POWER_REQUEST_TYPE>,
}

impl Requests {
    fn clear(self) {
        // SAFETY: `handle` came from `PowerCreateRequest` and is closed once,
        // here, because `clear` takes the only copy.
        unsafe {
            for kind in &self.types {
                PowerClearRequest(self.handle, *kind);
            }
            CloseHandle(self.handle);
        }
    }
}

#[derive(Default)]
pub struct PowerRequests {
    requests: Option<Requests>,
}

impl PowerRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every Windows has power requests.
    pub fn unavailable() -> Option<&'static str> {
        None
    }

    /// Windows clears the requests when the process ends.
    pub fn on_quit() {}
}

impl Drop for PowerRequests {
    fn drop(&mut self) {
        self.turn_off();
    }
}

impl OsCaffeinate for PowerRequests {
    fn turn_on(&mut self, flags: Flags) -> Result<(), String> {
        if self.requests.is_some() {
            return Err(ALREADY_ON.to_string());
        }
        let types = request_types(flags);
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
        let mut requests = Requests {
            handle,
            types: Vec::new(),
        };
        for kind in types {
            // SAFETY: `handle` is the live request created above.
            if unsafe { PowerSetRequest(handle, kind) } == 0 {
                let error = io::Error::last_os_error().to_string();
                requests.clear();
                return Err(error);
            }
            requests.types.push(kind);
        }
        // scripts/verify-caffeinate-win.ps1 waits on this line.
        eprintln!("caffeinate: on ({})", windows::label(flags));
        self.requests = Some(requests);
        Ok(())
    }

    /// Clears the power requests at once, so the next tick reads Caffeinate
    /// as off.
    fn turn_off(&mut self) {
        if let Some(requests) = self.requests.take() {
            requests.clear();
            eprintln!("caffeinate: off");
        }
    }

    fn is_on(&mut self) -> bool {
        self.requests.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(set: &[Flag]) -> Flags {
        Flags::new(set.iter().copied()).expect("a flag")
    }

    #[test]
    fn disk_alone_takes_no_power_request() {
        let mut requests = PowerRequests::new();
        let err = requests
            .turn_on(flags(&[Flag::Disk]))
            .expect_err("Disk maps to no power request");
        assert!(!err.is_empty());
        assert!(!requests.is_on());
    }

    #[test]
    fn a_real_power_request_is_taken_once_and_released_by_kill() {
        let mut requests = PowerRequests::new();
        requests
            .turn_on(Flags::all())
            .expect("Windows grants the power requests");
        assert!(requests.is_on());
        assert!(
            requests.turn_on(Flags::all()).is_err(),
            "a second take would leak the first handle"
        );
        requests.turn_off();
        assert!(!requests.is_on());
        requests
            .turn_on(Flags::all())
            .expect("released power requests can be taken again");
        assert!(requests.is_on());
    }
}
