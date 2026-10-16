//! Give the keyboard back after a quick message pill closes (#1565): to the
//! window `_NET_ACTIVE_WINDOW` named before, or the topmost other client, sent
//! as a pager request (source 2) so focus-stealing prevention lets it through.

use std::sync::atomic::{AtomicU32, Ordering};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, Window,
};

use crate::pill_focus::{hand_back, HandBack};

/// Source indication 2: a pager or the user asked, not an application.
const SOURCE_PAGER: u32 = 2;
/// `CurrentTime`.
const CURRENT_TIME: u32 = 0;

/// The active window when a pill took the keyboard; 0 is none.
static ACTIVE_BEFORE_PILL: AtomicU32 = AtomicU32::new(0);

/// The EWMH atoms the hand-back reads and sends.
pub(crate) struct FocusAtoms {
    pub active: Atom,
    pub stacking: Atom,
    pub pid: Atom,
}

impl FocusAtoms {
    pub(crate) fn intern<C: Connection>(conn: &C) -> Option<Self> {
        let intern = |name: &[u8]| Some(conn.intern_atom(false, name).ok()?.reply().ok()?.atom);
        Some(Self {
            active: intern(b"_NET_ACTIVE_WINDOW")?,
            stacking: intern(b"_NET_CLIENT_LIST_STACKING")?,
            pid: intern(b"_NET_WM_PID")?,
        })
    }
}

/// Payload for a `_NET_ACTIVE_WINDOW` client message from a pager.
pub(crate) fn net_active_window_payload() -> [u32; 5] {
    [SOURCE_PAGER, CURRENT_TIME, 0, 0, 0]
}

/// Where a step aside sends the keyboard: the topmost window that is not
/// Fidget's. `stacking` runs bottom to top, as `_NET_CLIENT_LIST_STACKING` does.
pub(crate) fn step_aside_target(
    stacking: &[Window],
    ours: impl Fn(Window) -> bool,
) -> Option<Window> {
    stacking.iter().rev().copied().find(|&w| !ours(w))
}

fn window_property<C: Connection>(
    conn: &C,
    window: Window,
    atom: Atom,
    kind: AtomEnum,
    len: u32,
) -> Vec<u32> {
    conn.get_property(false, window, atom, kind, 0, len)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| reply.value32().map(|values| values.collect()))
        .unwrap_or_default()
}

/// The window `_NET_ACTIVE_WINDOW` names on the root, if any.
pub(crate) fn active_window<C: Connection>(conn: &C, root: Window, atom: Atom) -> Option<Window> {
    window_property(conn, root, atom, AtomEnum::WINDOW, 1)
        .first()
        .copied()
        .filter(|&w| w != 0)
}

fn activate<C: Connection>(
    conn: &C,
    root: Window,
    atom: Atom,
    window: Window,
) -> Result<(), String> {
    let event = ClientMessageEvent::new(32, window, atom, net_active_window_payload());
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
        event,
    )
    .map_err(|e| format!("could not send _NET_ACTIVE_WINDOW: {e}"))?;
    conn.flush()
        .map_err(|e| format!("could not flush X11: {e}"))
}

/// Whether `window` still exists on the server.
fn exists<C: Connection>(conn: &C, window: Window) -> bool {
    conn.get_window_attributes(window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some()
}

/// Hand the keyboard on when `overlay` still holds it: back to `previous` if it
/// still exists, else to the topmost window that is not Fidget's. Returns what
/// it decided.
pub(crate) fn hand_back_to<C: Connection>(
    conn: &C,
    root: Window,
    atoms: &FocusAtoms,
    overlay: Window,
    previous: Window,
) -> Result<HandBack, String> {
    let holding = active_window(conn, root, atoms.active) == Some(overlay);
    let alive = previous != 0 && previous != overlay && exists(conn, previous);
    let decision = hand_back(holding, alive);
    match decision {
        HandBack::Restore => activate(conn, root, atoms.active, previous)?,
        HandBack::StepAside => {
            let stacking = window_property(conn, root, atoms.stacking, AtomEnum::WINDOW, 4096);
            let me = std::process::id();
            // The stacking list can still name a window that was just destroyed.
            let ours = |w: Window| {
                w == overlay
                    || !exists(conn, w)
                    || window_property(conn, w, atoms.pid, AtomEnum::CARDINAL, 1).first()
                        == Some(&me)
            };
            if let Some(next) = step_aside_target(&stacking, ours) {
                activate(conn, root, atoms.active, next)?;
            }
        }
        HandBack::Stay => {}
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
    let atoms = FocusAtoms::intern(conn).ok_or("could not intern EWMH atoms")?;
    let root = conn.setup().roots[0].root;
    hand_back_to(conn, root, &atoms, overlay, previous).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use x11rb::protocol::xproto::{
        ChangeWindowAttributesAux, CreateWindowAux, PropMode, WindowClass,
    };
    use x11rb::protocol::Event;
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _;
    use x11rb::COPY_DEPTH_FROM_PARENT;

    #[test]
    fn the_request_comes_from_a_pager_at_current_time() {
        assert_eq!(net_active_window_payload(), [2, 0, 0, 0, 0]);
    }

    #[test]
    fn a_step_aside_picks_the_topmost_window_that_is_not_fidgets() {
        let ours = |w: Window| w == 30 || w == 40;
        assert_eq!(step_aside_target(&[10, 20, 30, 40], ours), Some(20));
        assert_eq!(step_aside_target(&[30, 40], ours), None);
        assert_eq!(step_aside_target(&[], ours), None);
    }

    struct Display {
        conn: RustConnection,
        root: Window,
        atoms: FocusAtoms,
    }

    impl Display {
        fn connect() -> Self {
            let (conn, screen) = x11rb::connect(None).expect("an X server on $DISPLAY");
            let root = conn.setup().roots[screen].root;
            // Hear every change to the root's properties, _NET_ACTIVE_WINDOW among them.
            conn.change_window_attributes(
                root,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .unwrap();
            let atoms = FocusAtoms::intern(&conn).unwrap();
            Self { conn, root, atoms }
        }

        fn open(&self, x: i16, fidgets: bool) -> Window {
            let w = self.conn.generate_id().unwrap();
            self.conn
                .create_window(
                    COPY_DEPTH_FROM_PARENT,
                    w,
                    self.root,
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
            if fidgets {
                self.conn
                    .change_property32(
                        PropMode::REPLACE,
                        w,
                        self.atoms.pid,
                        AtomEnum::CARDINAL,
                        &[std::process::id()],
                    )
                    .unwrap();
            }
            self.conn.map_window(w).unwrap();
            self.conn.flush().unwrap();
            w
        }

        fn activate(&self, w: Window) {
            activate(&self.conn, self.root, self.atoms.active, w).unwrap();
        }

        fn active(&self) -> Option<Window> {
            active_window(&self.conn, self.root, self.atoms.active)
        }

        /// Block until `w` is the active window, at most 3 s: wait on the
        /// connection for PropertyNotify of _NET_ACTIVE_WINDOW, then re-read it.
        fn active_within_3s(&self, w: Window) -> bool {
            use std::os::fd::AsRawFd;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let fd = self.conn.stream().as_raw_fd();
            loop {
                if self.active() == Some(w) {
                    return true;
                }
                loop {
                    match self.conn.poll_for_event().unwrap() {
                        Some(Event::PropertyNotify(e)) if e.atom == self.atoms.active => break,
                        Some(_) => continue,
                        None => {}
                    }
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        return false;
                    }
                    let mut pfd = libc::pollfd {
                        fd,
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    // SAFETY: one pollfd on the live connection's socket.
                    unsafe { libc::poll(&mut pfd, 1, left.as_millis().max(1) as i32) };
                }
            }
        }
    }

    /// Run with: Xvfb :97 & DISPLAY=:97 xfwm4 &
    /// DISPLAY=:97 cargo test --bin fidget focus_return -- --include-ignored --test-threads=1
    #[test]
    #[ignore = "needs an X server with an EWMH window manager, such as Xvfb with xfwm4"]
    fn the_editor_gets_the_keyboard_back_after_the_pill_closes() {
        let x = Display::connect();
        let editor = x.open(0, false);
        x.activate(editor);
        assert!(x.active_within_3s(editor), "the editor never took focus");
        let previous = x.active().unwrap();
        let overlay = x.open(300, true);
        x.activate(overlay);
        assert!(x.active_within_3s(overlay), "the pill never took focus");
        assert_eq!(
            hand_back_to(&x.conn, x.root, &x.atoms, overlay, previous).unwrap(),
            HandBack::Restore
        );
        assert!(
            x.active_within_3s(editor),
            "focus did not come back to the editor"
        );
    }

    #[test]
    #[ignore = "needs an X server with an EWMH window manager, such as Xvfb with xfwm4"]
    fn the_next_window_gets_the_keyboard_when_the_editor_is_gone() {
        let x = Display::connect();
        let other = x.open(0, false);
        x.activate(other);
        assert!(
            x.active_within_3s(other),
            "the other window never took focus"
        );
        let editor = x.open(100, false);
        x.activate(editor);
        assert!(x.active_within_3s(editor), "the editor never took focus");
        let previous = x.active().unwrap();
        let overlay = x.open(300, true);
        x.activate(overlay);
        assert!(x.active_within_3s(overlay), "the pill never took focus");
        x.conn.destroy_window(editor).unwrap();
        x.conn.flush().unwrap();
        assert_eq!(
            hand_back_to(&x.conn, x.root, &x.atoms, overlay, previous).unwrap(),
            HandBack::StepAside
        );
        assert!(
            x.active_within_3s(other),
            "focus did not go to the other window"
        );
    }
}
