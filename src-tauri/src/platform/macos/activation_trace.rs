//! Bubble trace: when Fidget becomes the active app, log the key window and
//! each overlay's style mask and key status, to show what a click activated.

use std::sync::Once;

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;

/// NSWindowStyleMaskNonactivatingPanel.
const NONACTIVATING: usize = 1 << 7;

fn class_name(object: &AnyObject) -> String {
    object.class().name().to_string_lossy().into_owned()
}

extern "C" fn became_active(_this: &AnyObject, _sel: Sel, _note: *mut AnyObject) {
    let application = AnyClass::get(c"NSApplication").expect("AppKit defines NSApplication");
    // SAFETY: AppKit getters on the main thread, where notifications arrive.
    unsafe {
        let app: *mut AnyObject = msg_send![application, sharedApplication];
        let key: *mut AnyObject = msg_send![app, keyWindow];
        let key = if key.is_null() {
            "none".to_string()
        } else {
            class_name(&*key)
        };
        let windows: *mut AnyObject = msg_send![app, windows];
        let count: usize = msg_send![windows, count];
        let mut overlays = Vec::new();
        for i in 0..count {
            let window: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if class_name(&*window) != "FidgetOverlayPanel" {
                continue;
            }
            let mask: usize = msg_send![window, styleMask];
            let can_key: Bool = msg_send![window, canBecomeKeyWindow];
            let is_key: Bool = msg_send![window, isKeyWindow];
            overlays.push(format!(
                "mask=0x{mask:x} nonactivating={} canBecomeKey={} key={}",
                mask & NONACTIVATING != 0,
                can_key.as_bool(),
                is_key.as_bool()
            ));
        }
        eprintln!(
            "app: became active key={key} overlays=[{}]",
            overlays.join("; ")
        );
    }
}

/// Start logging activations, once, when the bubble trace is on. Main thread.
pub fn start() {
    static STARTED: Once = Once::new();
    if !crate::dev_flags::TRACE_BUBBLE.is_on() {
        return;
    }
    STARTED.call_once(|| {
        let superclass = AnyClass::get(c"NSObject").expect("Foundation defines NSObject");
        let Some(mut builder) = ClassBuilder::new(c"FidgetActivationTrace", superclass) else {
            return;
        };
        // SAFETY: a notification handler takes the NSNotification and returns nothing.
        unsafe {
            builder.add_method(sel!(becameActive:), became_active as extern "C" fn(_, _, _));
        }
        let class = builder.register();
        let center = AnyClass::get(c"NSNotificationCenter").expect("Foundation defines it");
        let name = NSString::from_str("NSApplicationDidBecomeActiveNotification");
        // SAFETY: the observer is never released, so the center never holds a
        // dangling pointer.
        unsafe {
            let observer: *mut AnyObject = msg_send![class, new];
            let center: *mut AnyObject = msg_send![center, defaultCenter];
            let _: () = msg_send![
                center,
                addObserver: observer,
                selector: sel!(becameActive:),
                name: &*name,
                object: std::ptr::null::<AnyObject>()
            ];
        }
    });
}
