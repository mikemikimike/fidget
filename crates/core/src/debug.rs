//! Debug tooling for test automation.
//!
//! File-based IPC paths that scenario scripts use to place the character and
//! read its state without modifying the binary under test.

use std::path::PathBuf;

use crate::memory;

/// Debug IPC command path for test scripts to place commands.
pub fn debug_cmd_path() -> Option<PathBuf> {
    Some(debug_dir()?.join(".fidget-debug-cmd"))
}

/// Debug IPC result path where fidget writes responses.
pub fn debug_result_path() -> Option<PathBuf> {
    Some(debug_dir()?.join(".fidget-debug-result"))
}

fn debug_dir() -> Option<PathBuf> {
    memory::data_dir_override().or_else(memory::home_dir)
}
