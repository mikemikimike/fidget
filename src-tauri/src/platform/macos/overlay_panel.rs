//! Turning a Tauri window into a non-activating overlay panel.

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::{
    NSFloatingWindowLevel, NSWindowCollectionBehavior, NSWindowLevel, NSWindowSharingType,
    NSWindowStyleMask,
};

/// An `NSPanel` subclass that never becomes main and becomes key only while
/// tao's `focusable` is set, so a sprite click leaves the keyboard where it was
/// but the quick message pill can take it.
fn overlay_panel_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    CLASS.get_or_init(|| {
        let superclass = AnyClass::get(c"NSPanel").expect("AppKit always defines NSPanel");
        let mut builder = ClassBuilder::new(c"FidgetOverlayPanel", superclass)
            .expect("the class name is ours and registered once");
        // Tauri's window is tao's `TaoWindow`, an NSWindow plus this BOOL. Where
        // NSWindow's ivars end 8-aligned the BOOL grows the instance, so the swap
        // needs the same ivar to keep sizes equal, and tao still reads it by name.
        builder.add_ivar::<Bool>(c"focusable");

        extern "C" fn refuse(_this: &AnyObject, _sel: Sel) -> Bool {
            Bool::NO
        }

        extern "C" fn focusable(this: &AnyObject, _sel: Sel) -> Bool {
            let ivar = this.class().instance_variable(c"focusable").unwrap();
            // SAFETY: the class declares `focusable` as a BOOL.
            unsafe { *ivar.load::<Bool>(this) }
        }

        // SAFETY: both selectors return BOOL and take no arguments, which is
        // what `refuse` is declared as.
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                focusable as extern "C" fn(_, _) -> Bool,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                refuse as extern "C" fn(_, _) -> Bool,
            );
        }

        builder.register()
    })
}

/// Make the overlay a floating, non-activating panel that follows the user
/// across Spaces and stays out of the application switcher. Capturable by
/// default (ADR-0024); Presence or `FIDGET_CAPTURABLE=0` excludes it.
pub fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ptr = window
        .ns_window()
        .map_err(|e| format!("overlay has no native window handle: {e}"))?
        as *mut AnyObject;

    // SAFETY: Tauri hands us a live NSWindow for a window it is still holding.
    let ns_window = unsafe { &*ptr };

    // Re-class to our NSPanel subclass: NSPanel adds no ivars beyond NSWindow,
    // so with tao's ivar mirrored only the method table moves.
    let (from, to) = (ns_window.class(), overlay_panel_class());
    if from.instance_size() != to.instance_size() {
        return Err(format!(
            "cannot re-class {} ({} bytes) as {} ({} bytes)",
            from.name().to_string_lossy(),
            from.instance_size(),
            to.name().to_string_lossy(),
            to.instance_size()
        ));
    }
    // SAFETY: the new class is an NSPanel, hence an NSWindow, of the same size;
    // toolkit messages stay valid.
    unsafe { AnyObject::set_class(ns_window, to) };
    // tao built it focusable; only the pill's focus request turns that on.
    // SAFETY: the class declares `focusable` as a BOOL.
    unsafe {
        *to.instance_variable(c"focusable")
            .unwrap()
            .load_ptr::<Bool>(ns_window) = Bool::NO
    };

    let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle
        | NSWindowCollectionBehavior::FullScreenAuxiliary;

    // SAFETY: all four are plain AppKit setters on NSWindow/NSPanel, called on
    // the main thread from Tauri's setup hook.
    unsafe {
        let style: NSWindowStyleMask = msg_send![ns_window, styleMask];
        let _: () = msg_send![
            ns_window,
            setStyleMask: style | NSWindowStyleMask::NonactivatingPanel
        ];
        // The style alone still lets a sprite click activate Fidget, and the
        // public way, configuring before the first show, does not stop it. So
        // this private setter stays, guarded.
        let prevents = sel!(_setPreventsActivation:);
        let responds: bool = msg_send![ns_window, respondsToSelector: prevents];
        if responds {
            let _: () = msg_send![ns_window, _setPreventsActivation: Bool::YES];
        }
        let _: () = msg_send![ns_window, setLevel: NSFloatingWindowLevel as NSWindowLevel];
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        let _: () = msg_send![ns_window, setHidesOnDeactivate: false];
        // AppKit warns that an uncapturable window cannot take part in some
        // system services. The overlay uses none of them: it draws a sprite,
        // takes no focus, and prints nothing.
        let _: () = msg_send![ns_window, setSharingType: sharing_type()];
    }

    Ok(())
}

/// Whether this run allows itself to be captured. See `configure_overlay`.
fn sharing_type() -> NSWindowSharingType {
    if crate::dev_flags::CAPTURABLE.is_on() {
        NSWindowSharingType::ReadOnly
    } else {
        NSWindowSharingType::None
    }
}

/// The app that was in front when a pill took the keyboard, by pid; 0 is none.
static FRONT_BEFORE_PILL: AtomicI32 = AtomicI32::new(0);

/// Remember the frontmost app before the pill activates Fidget. Main thread.
pub fn remember_front_app() {
    let workspace = AnyClass::get(c"NSWorkspace").expect("AppKit defines NSWorkspace");
    // SAFETY: plain NSWorkspace / NSRunningApplication getters.
    unsafe {
        let shared: *mut AnyObject = msg_send![workspace, sharedWorkspace];
        let front: *mut AnyObject = msg_send![shared, frontmostApplication];
        if front.is_null() {
            return;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        if pid != std::process::id() as i32 {
            FRONT_BEFORE_PILL.store(pid, Ordering::Relaxed);
        }
    }
}

/// The last pill on `window` closed: give up key status and hand activation
/// back to the remembered app, unless the user already moved to another
/// window. Main thread.
pub fn hand_back_keyboard(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = window
        .ns_window()
        .map_err(|e| format!("overlay has no native window handle: {e}"))?
        as *mut AnyObject;
    let application = AnyClass::get(c"NSApplication").expect("AppKit defines NSApplication");
    let running = AnyClass::get(c"NSRunningApplication").expect("AppKit defines it");
    // SAFETY: AppKit getters and one action on live objects, on the main thread.
    unsafe {
        let app: *mut AnyObject = msg_send![application, sharedApplication];
        let active: bool = msg_send![app, isActive];
        let key: *mut AnyObject = msg_send![app, keyWindow];
        let holding = active && (key.is_null() || key == ns_window);
        // Only the hand-back spends the remembered app. A Stay (the user moved
        // on while the last pill closed) leaves it for the next pill to hand
        // to; an unconditional drain turned the final close into a step
        // aside to nothing on two displays. The gate in `overlay_report_qm_draft`
        // keeps a mid-session close from reaching here, but it only sees
        // reports that arrived: a close that slips past its report-order
        // re-check still lands here, and keeping the pid is what lets the
        // eventual last close restore instead of step aside.
        let pid = if holding {
            FRONT_BEFORE_PILL.swap(0, Ordering::Relaxed)
        } else {
            FRONT_BEFORE_PILL.load(Ordering::Relaxed)
        };
        let previous: *mut AnyObject = if pid == 0 {
            std::ptr::null_mut()
        } else {
            msg_send![running, runningApplicationWithProcessIdentifier: pid]
        };
        let alive = !previous.is_null() && {
            let gone: bool = msg_send![previous, isTerminated];
            !gone
        };
        let decision = crate::pill_focus::hand_back(holding, alive);
        match decision {
            crate::pill_focus::HandBack::Stay => {}
            crate::pill_focus::HandBack::Restore => {
                let _: bool = msg_send![previous, activateWithOptions: 0usize];
            }
            // Nothing to give it back to. macOS 14 can ignore `deactivate`, so
            // activate the next app in front; deactivate only when there is
            // none. Hiding would hide the sprite too.
            crate::pill_focus::HandBack::StepAside => {
                let next = crate::pill_focus::next_app_in_front(
                    &app_windows(),
                    std::process::id() as i32,
                    regular_app,
                );
                let target: *mut AnyObject = match next {
                    Some(next) => msg_send![running, runningApplicationWithProcessIdentifier: next],
                    None => std::ptr::null_mut(),
                };
                if target.is_null() {
                    let _: () = msg_send![app, deactivate];
                } else {
                    let _: bool = msg_send![target, activateWithOptions: 0usize];
                }
            }
        }
        if crate::dev_flags::TRACE_BUBBLE.is_on() {
            eprintln!(
                "app: hand back {decision:?} holding={holding} remembered={pid} alive={alive}"
            );
        }
    }
    Ok(())
}

/// On-screen windows front to back, each with its owner's pid and layer.
/// No permission needed.
fn app_windows() -> Vec<crate::pill_focus::AppWindow> {
    use objc2_foundation::{ns_string, NSNumber};
    super::window_source::walk_visible(|e| {
        let number = |key| {
            e.objectForKey(key)
                .and_then(|o| o.downcast::<NSNumber>().ok())
                .map(|n| n.as_i64())
        };
        Some(crate::pill_focus::AppWindow {
            pid: number(ns_string!("kCGWindowOwnerPID"))? as i32,
            layer: number(ns_string!("kCGWindowLayer"))?,
        })
    })
}

/// Whether `pid` is a regular app, one with a Dock icon.
fn regular_app(pid: i32) -> bool {
    let running = AnyClass::get(c"NSRunningApplication").expect("AppKit defines it");
    // SAFETY: plain NSRunningApplication getters; 0 is Regular.
    unsafe {
        let owner: *mut AnyObject =
            msg_send![running, runningApplicationWithProcessIdentifier: pid];
        !owner.is_null() && {
            let policy: isize = msg_send![owner, activationPolicy];
            policy == 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `tao` registers as `TaoWindow`: an NSWindow plus one BOOL.
    fn tao_window_shape() -> &'static AnyClass {
        let superclass = AnyClass::get(c"NSWindow").expect("AppKit always defines NSWindow");
        let mut builder = ClassBuilder::new(c"FidgetTaoWindowShape", superclass)
            .expect("registered once per test binary");
        builder.add_ivar::<Bool>(c"focusable");
        builder.register()
    }

    #[test]
    fn the_panel_keeps_the_tao_window_layout_it_replaces() {
        let tao = tao_window_shape();
        let panel = overlay_panel_class();

        let focusable = panel
            .instance_variable(c"focusable")
            .expect("tao still reads its focusable ivar after the swap");
        let tao_focusable = tao.instance_variable(c"focusable").unwrap();
        assert_eq!(focusable.offset(), tao_focusable.offset());
        assert_eq!(focusable.type_encoding(), tao_focusable.type_encoding());
        assert_eq!(panel.instance_size(), tao.instance_size());
    }

    extern "C" {
        fn class_createInstance(class: &AnyClass, extra: usize) -> *mut AnyObject;
        fn object_dispose(object: *mut AnyObject) -> *mut AnyObject;
    }

    /// The pill takes the keyboard by making the overlay key, so
    /// `canBecomeKeyWindow` must follow tao's ivar. Main stays refused.
    #[test]
    fn the_panel_becomes_key_only_while_focusable() {
        let panel = overlay_panel_class();
        let ivar = panel.instance_variable(c"focusable").unwrap();
        // SAFETY: a bare instance, never initialised; only our two methods and
        // the ivar are touched before it is disposed.
        unsafe {
            let raw = class_createInstance(panel, 0);
            let object = &*raw;
            for focusable in [false, true, false] {
                *ivar.load_ptr::<Bool>(object) = Bool::new(focusable);
                let key: Bool = msg_send![object, canBecomeKeyWindow];
                let main: Bool = msg_send![object, canBecomeMainWindow];
                assert_eq!(key.as_bool(), focusable);
                assert!(!main.as_bool());
            }
            object_dispose(raw);
        }
    }
}
