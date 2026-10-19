//! Shared X11 connection for all X11 platform modules.
//!
//! `RustConnection` is `Sync`, so the frame thread and the GTK main thread
//! share one process-lifetime connection.

use std::sync::OnceLock;
use x11rb::rust_connection::RustConnection;

/// Opened on first call and reused for the process lifetime. `None` if
/// connect fails or `DISPLAY` is unset. Failure is cached: X11 will not
/// appear later, and handles will be Wayland or unavailable.
pub fn connection() -> Option<&'static RustConnection> {
    static CONN: OnceLock<Option<RustConnection>> = OnceLock::new();
    CONN.get_or_init(|| RustConnection::connect(None).ok().map(|(conn, _)| conn))
        .as_ref()
}
