//! A mouse-only, listen-only `CGEventTap`, so an idle frame loop is woken by
//! the mouse rather than by its own timer.
//!
//! What it buys is reaction time, not wakeups: the idle poll already backs off
//! to the sense interval, and that tick still runs. Without the tap a poke or
//! the cursor arriving over the art waits for it — up to a second.
//!
//! macOS gates this tap behind Input Monitoring, which DESIGN.md decision 9
//! forbids asking for at launch. So nothing here starts until the user checks
//! the Input Monitoring row in settings and macOS grants it.
//!
//! The mask carries six mouse types and no key event, and a listen-only tap
//! "receives events but cannot modify or divert them" — the character hears
//! that the mouse moved, never what was typed.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread;
use std::time::Duration;

use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRetained, CFRunLoop};
use objc2_core_graphics::{
    CGEvent, CGEventMask, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType,
};

use crate::consent;

/// The events the frame loop cares about: a button edge, and motion that can
/// bring the cursor over the art. `CGEventMask` is a bitmap indexed by
/// `CGEventType`, and every bit left clear is an event the tap never sees.
const MOUSE_EVENTS: CGEventMask = (1 << CGEventType::LeftMouseDown.0)
    | (1 << CGEventType::LeftMouseUp.0)
    | (1 << CGEventType::RightMouseDown.0)
    | (1 << CGEventType::RightMouseUp.0)
    | (1 << CGEventType::MouseMoved.0)
    | (1 << CGEventType::LeftMouseDragged.0);

/// How long `spawn_listener` waits for the tap thread to report. Creating a
/// tap is a handful of Mach calls; a machine that cannot do them in this long
/// is one the frame loop should stop waiting for.
const SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// What the callback needs: somewhere to report, and the tap itself, which
/// macOS can disable under load and only the callback hears about.
struct Tap {
    wake: SyncSender<()>,
    /// `None` until `tap_create` returns. Written and read only on the tap
    /// thread, so it needs no lock.
    port: Option<CFRetained<CFMachPort>>,
}

/// The frame loop's handle on a running tap. Drop stops the tap thread from
/// this side, so uncheck does not wait for a mouse event the tap may never
/// see (a disabled tap delivers no callback, including `Disconnected`).
pub struct EventTap {
    events: Receiver<()>,
    stop: StopHandle,
}

impl EventTap {
    pub fn recv_timeout(&self, timeout: Duration) -> Result<(), RecvTimeoutError> {
        self.events.recv_timeout(timeout).map(|_| ())
    }
}

impl Drop for EventTap {
    fn drop(&mut self) {
        // `stop` alone stays queued until the loop next wakes. A disabled tap
        // never wakes. `wake_up` is the other half of the pair Apple documents
        // for stopping a run loop from another thread.
        self.stop.0.stop();
        self.stop.0.wake_up();
    }
}

/// `CFRunLoop` is `!Send` because `run()` belongs on the tap thread. `stop`
/// and `wake_up` are the documented cross-thread pair, so the frame thread
/// may hold this and only call those two.
struct StopHandle(CFRetained<CFRunLoop>);

// SAFETY: the handle is used only for `stop` and `wake_up`, which Core
// Foundation documents as safe from any thread. Nothing here calls `run`.
unsafe impl Send for StopHandle {}

/// Start listening, or `None` when the setting is off, the grant is missing, or
/// the tap will not start. One coalesced wake per event: the loop reads the
/// cursor itself and only needs to know that something moved.
pub fn spawn_listener() -> Option<EventTap> {
    // The setting is this session's intent. The OS grant can remain after
    // uncheck, and a leftover grant must not start a tap on launch.
    if !consent::wanted(consent::CapabilityId::InputMonitoring) {
        return None;
    }
    // Asked rather than assumed from a successful create: an ungranted tap can
    // come back as a port that never delivers. The consent probe is the one
    // place that reads the grant, so settings and the tap cannot disagree.
    if !consent::live().granted(consent::CapabilityId::InputMonitoring) {
        return None;
    }

    // One slot, and a full one is a wake already pending: the loop needs the
    // fact that input happened, not every event, and an unbounded queue would
    // grow for as long as the sprite stays hidden.
    let (wake, woken) = mpsc::sync_channel(1);
    let (ready, started) = mpsc::channel();

    thread::Builder::new()
        .name("mouse-tap".to_string())
        .spawn(move || listen(wake, &ready))
        .ok()?;

    // A failed tap must report, not leave a closed channel: `recv_timeout` on
    // one returns at once, a spin. Bounded because the frame loop is the
    // caller, so a hung setup costs a late tap, never a frozen sprite.
    let stop = started.recv_timeout(SETUP_TIMEOUT).ok()??;
    Some(EventTap {
        events: woken,
        stop,
    })
}

/// Create the tap and park on this thread's run loop until `EventTap`'s Drop
/// stops it. The callback also stops it on `Disconnected`, so a hang-up without
/// Drop still ends the thread.
fn listen(wake: SyncSender<()>, ready: &mpsc::Sender<Option<StopHandle>>) {
    let mut tap = Box::new(Tap { wake, port: None });
    let context: *mut c_void = std::ptr::from_mut(tap.as_mut()).cast();

    // SAFETY: `heard` has the callback's declared shape, and `context` points
    // at a `Tap` that outlives the run loop below — the box is dropped only
    // after `CFRunLoop::run` returns, and the tap is invalidated with it.
    let port = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            MOUSE_EVENTS,
            Some(heard),
            context,
        )
    };

    let Some(port) = port else {
        let _ = ready.send(None);
        return;
    };

    // A tap is created enabled, unless the grant went away between the check
    // above and here. Then it is a port that never speaks, and the frame
    // loop is better off with the poll it already has.
    CGEvent::tap_enable(&port, true);
    if !CGEvent::tap_is_enabled(&port) {
        let _ = ready.send(None);
        return;
    }

    let source = CFMachPort::new_run_loop_source(None, Some(&port), 0);
    let (Some(source), Some(run_loop)) = (source, CFRunLoop::current()) else {
        let _ = ready.send(None);
        return;
    };

    // SAFETY: the constant is a CoreFoundation string the dynamic linker binds
    // before any CFRunLoop entry point can run.
    let modes = unsafe { kCFRunLoopCommonModes };
    run_loop.add_source(Some(&source), modes);
    tap.port = Some(port);

    if ready.send(Some(StopHandle(run_loop.clone()))).is_err() {
        return;
    }
    CFRunLoop::run();
}

/// Report that input happened. Runs on the tap thread, once per mouse event,
/// so it does nothing that can block: a slow callback is how macOS decides to
/// disable a tap.
unsafe extern "C-unwind" fn heard(
    _proxy: CGEventTapProxy,
    kind: CGEventType,
    event: NonNull<CGEvent>,
    context: *mut c_void,
) -> *mut CGEvent {
    // SAFETY: `context` is the non-null `Tap` handed to `tap_create`, owned by
    // the thread still parked in `CFRunLoop::run`, and this is its only reader.
    let tap = unsafe { &*context.cast::<Tap>() };

    // macOS disables a tap that was too slow, and disables every tap while the
    // user is entering a password. Re-enabling is the only way back; without
    // it the loop would idle on a listener that never speaks again.
    if kind == CGEventType::TapDisabledByTimeout || kind == CGEventType::TapDisabledByUserInput {
        if let Some(port) = tap.port.as_deref() {
            CGEvent::tap_enable(port, true);
        }
        return event.as_ptr();
    }

    match tap.wake.try_send(()) {
        // Full is the wake the loop has not taken yet, which says everything
        // this one would.
        Ok(()) | Err(TrySendError::Full(())) => {}
        // The frame loop let the receiver go: the setting went off, or the app
        // is shutting down. Leaving the run loop drops the tap with the thread.
        Err(TrySendError::Disconnected(())) => {
            if let Some(run_loop) = CFRunLoop::current() {
                run_loop.stop();
            }
        }
    }

    // A listen-only tap cannot modify or divert; the answer is ignored.
    event.as_ptr()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_graphics::CGMouseButton;
    use std::sync::Mutex;

    /// Serializes the tests that write the wanted flag, one process-wide atomic.
    /// On a Mac that holds the grant, a race starts a real tap.
    static INTENT: Mutex<()> = Mutex::new(());

    /// Run `check` with the setting at `on`, alone, and put back whatever the
    /// flag held before. A poisoned lock is a test that already failed while
    /// holding it; the flag still needs setting, so take it anyway.
    fn with_setting(on: bool, check: impl FnOnce()) {
        let _held = INTENT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = consent::wanted(consent::CapabilityId::InputMonitoring);
        consent::set_wanted(consent::CapabilityId::InputMonitoring, on);
        check();
        consent::set_wanted(consent::CapabilityId::InputMonitoring, before);
    }

    /// The mask is the whole privacy claim the settings row makes: six mouse
    /// types, and no key event. A bit added by hand would otherwise be a
    /// keyboard tap the copy still calls mouse-only.
    #[test]
    fn the_mask_holds_mouse_events_and_no_key_event() {
        for kind in [
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGEventType::MouseMoved,
            CGEventType::LeftMouseDragged,
        ] {
            assert!(
                MOUSE_EVENTS & (1 << kind.0) != 0,
                "the loop needs {kind:?} to know input happened"
            );
        }

        for kind in [
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
            CGEventType::ScrollWheel,
            CGEventType::TabletPointer,
        ] {
            assert!(
                MOUSE_EVENTS & (1 << kind.0) == 0,
                "{kind:?} is not the character's business"
            );
        }
    }

    /// The setting is on so the wanted gate does not answer `None` before the
    /// grant check this test is about.
    #[test]
    fn an_ungranted_mac_starts_no_tap() {
        with_setting(true, || {
            if consent::live().granted(consent::CapabilityId::InputMonitoring) {
                return;
            }
            assert!(spawn_listener().is_none());
        });
    }

    #[test]
    fn a_cleared_setting_starts_no_tap() {
        with_setting(false, || {
            assert!(
                spawn_listener().is_none(),
                "a leftover TCC grant must not start a tap the setting did not ask for"
            );
        });
    }

    #[test]
    fn the_frame_thread_can_hold_the_stop_handle() {
        fn assert_send<T: Send>() {}
        assert_send::<EventTap>();
    }

    /// Tap to channel, end to end. Posts one mouse-moved event at the cursor's
    /// own position, so the desk does not move. Ignored because it needs the
    /// grant and a session to post to.
    #[test]
    #[ignore = "needs the Input Monitoring grant; run by hand"]
    fn a_mouse_event_wakes_the_loop() {
        with_setting(true, || {
            let Some(woken) = spawn_listener() else {
                println!("  no Input Monitoring grant here: nothing to listen with");
                return;
            };

            let here = CGEvent::location(CGEvent::new(None).as_deref());
            let moved =
                CGEvent::new_mouse_event(None, CGEventType::MouseMoved, here, CGMouseButton::Left)
                    .expect("a mouse event has to be constructible");
            CGEvent::post(CGEventTapLocation::SessionEventTap, Some(&moved));

            assert!(
                woken.recv_timeout(Duration::from_secs(3)).is_ok(),
                "the tap heard nothing; the frame loop would have slept through the mouse"
            );
            println!("  the tap woke the loop at {here:?}");
        });
    }
}
