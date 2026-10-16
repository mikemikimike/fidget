//! Give the keyboard back after a quick message pill closes (#1565).
//!
//! The pill takes focus with `set_focus`. Before it does, remember the window
//! that `_NET_ACTIVE_WINDOW` names; when the overlay's last pill closes, ask the
//! window manager to activate that window again. Source indication 2 (pager)
//! marks the request as user-driven, so focus-stealing prevention lets it through.

use std::sync::atomic::{AtomicU32, Ordering};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, Window};

use crate::pill_focus::{hand_back, HandBack};

/// Source indication 2: a pager or the user asked, not an application.
const SOURCE_PAGER: u32 = 2;
/// `CurrentTime`.
const CURRENT_TIME: u32 = 0;

/// The active window when a pill took the keyboard; 0 is none.
static ACTIVE_BEFORE_PILL: AtomicU32 = AtomicU32::new(0);

/// Payload for a `_NET_ACTIVE_WINDOW` client message from a pager.
pub(crate) fn net_active_window_payload() -> [u32; 5] {
    [SOURCE_PAGER, CURRENT_TIME, 0, 0, 0]
}

/// The window `_NET_ACTIVE_WINDOW` names on the root, if any.
pub(crate) fn active_window<C: Connection>(conn: &C, root: Window, atom: u32) -> Option<Window> {
    let reply = conn
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    reply.value32()?.next().filter(|&w| w != 0)
}

/// Hand the keyboard back to `previous` when `overlay` still holds it and
/// `previous` still exists. Returns what it decided.
pub(crate) fn hand_back_to<C: Connection>(
    conn: &C,
    root: Window,
    atom: u32,
    overlay: Window,
    previous: Window,
) -> Result<HandBack, String> {
    let holding = active_window(conn, root, atom) == Some(overlay);
    let alive = previous != 0
        && previous != overlay
        && conn
            .get_window_attributes(previous)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some();
    let decision = hand_back(holding, alive);
    // StepAside: the window manager picks the next window when focus leaves us.
    if decision == HandBack::Restore {
        let event = ClientMessageEvent::new(32, previous, atom, net_active_window_payload());
        conn.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
            event,
        )
        .map_err(|e| format!("could not send _NET_ACTIVE_WINDOW: {e}"))?;
        conn.flush()
            .map_err(|e| format!("could not flush X11: {e}"))?;
    }
    Ok(decision)
}

/// Remember the active window, unless it is the overlay itself.
pub fn remember_active_window(overlay: Window) {
    let Some(conn) = super::connection::connection() else {
        return;
    };
    let Some(atoms) = super::atoms::atoms() else {
        return;
    };
    let root = conn.setup().roots[0].root;
    if let Some(active) = active_window(conn, root, atoms.net_active_window) {
        if active != overlay {
            ACTIVE_BEFORE_PILL.store(active, Ordering::Relaxed);
        }
    }
}

/// The overlay's last pill closed: give the keyboard back.
pub fn return_keyboard(overlay: Window) -> Result<(), String> {
    let previous = ACTIVE_BEFORE_PILL.swap(0, Ordering::Relaxed);
    let conn = super::connection::connection().ok_or("no X11 connection")?;
    let atoms = super::atoms::atoms().ok_or("could not intern EWMH atoms")?;
    let root = conn.setup().roots[0].root;
    hand_back_to(conn, root, atoms.net_active_window, overlay, previous).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_comes_from_a_pager_at_current_time() {
        assert_eq!(net_active_window_payload(), [2, 0, 0, 0, 0]);
    }

    /// Run with: Xvfb :97 & DISPLAY=:97 xfwm4 & DISPLAY=:97 cargo test -- --ignored focus_return
    #[test]
    #[ignore = "needs an X server with an EWMH window manager, such as Xvfb with xfwm4"]
    fn the_editor_gets_the_keyboard_back_after_the_pill_closes() {
        use x11rb::protocol::xproto::{CreateWindowAux, WindowClass};
        use x11rb::COPY_DEPTH_FROM_PARENT;

        let (conn, screen) = x11rb::connect(None).expect("an X server on $DISPLAY");
        let root = conn.setup().roots[screen].root;
        let atom = conn
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")
            .unwrap()
            .reply()
            .unwrap()
            .atom;
        let open = |x: i16| {
            let w = conn.generate_id().unwrap();
            conn.create_window(
                COPY_DEPTH_FROM_PARENT,
                w,
                root,
                x,
                0,
                200,
                200,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new(),
            )
            .unwrap();
            conn.map_window(w).unwrap();
            conn.flush().unwrap();
            w
        };
        let activate = |w: Window| {
            let event = ClientMessageEvent::new(32, w, atom, net_active_window_payload());
            conn.send_event(
                false,
                root,
                EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
                event,
            )
            .unwrap();
            conn.flush().unwrap();
        };
        // Each wait is capped at 3 s; every check is a round trip to the server.
        let active_within_3s = |w: Window| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while std::time::Instant::now() < deadline {
                if active_window(&conn, root, atom) == Some(w) {
                    return true;
                }
            }
            false
        };

        let editor = open(0);
        let overlay = open(300);
        activate(editor);
        assert!(active_within_3s(editor), "the editor never took focus");
        let previous = active_window(&conn, root, atom).unwrap();
        activate(overlay);
        assert!(active_within_3s(overlay), "the pill never took focus");
        assert_eq!(
            hand_back_to(&conn, root, atom, overlay, previous).unwrap(),
            HandBack::Restore
        );
        assert!(
            active_within_3s(editor),
            "focus did not come back to the editor"
        );
    }
}
