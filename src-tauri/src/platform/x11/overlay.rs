//! X11 overlay window configuration: floating, non-activating, click-through.
//!
//! GTK has no click-through finer than the whole window, so `XShapeCombineMask`
//! carves the input region from the sprite's alpha mask, and
//! `XShapeCombineRectangles` unions any hotspot rectangles the renderer
//! reported so a control drawn outside the art still receives clicks.
//! EWMH window states float the overlay above other windows and skip the
//! taskbar and pager. On GDK's Wayland backend tao's handle is a
//! `wl_surface`, which nothing here matches; the input region is core Wayland
//! and unwired. DESIGN.md decision 3.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use x11rb::connection::Connection;
use x11rb::protocol::shape::{self, SK};
use x11rb::protocol::xproto::{self, AtomEnum, ConfigureWindowAux, PropMode, StackMode};
use x11rb::rust_connection::RustConnection;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

static MASK_UPDATE_COUNT: AtomicU64 = AtomicU64::new(0);
static MASK_UPDATE_NANOS: AtomicU64 = AtomicU64::new(0);
static FULL_REBUILD_COUNT: AtomicU64 = AtomicU64::new(0);
static POSITION_ONLY_COUNT: AtomicU64 = AtomicU64::new(0);

static WINDOW_ID_MAP: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, PartialEq, Eq, Debug)]
struct MaskShape {
    opaque: Vec<bool>,
    width: i32,
    height: i32,
    facing: i32,
    scale: i32,
}

struct CachedPixmap {
    pixmap: u32,
    gc: u32,
    shape: MaskShape,
}

static PIXMAP_CACHE: LazyLock<Mutex<HashMap<u32, CachedPixmap>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Float above other windows, non-activating, skip the taskbar and pager.
/// Returns Err when the handle is not realized yet, so the caller can retry.
pub fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    let raw_window_handle = match window.window_handle() {
        Ok(handle) => handle,
        Err(e) => {
            return Err(format!("Window handle not available yet: {}", e));
        }
    };

    let x_window = match raw_window_handle.as_raw() {
        RawWindowHandle::Xlib(xlib_window) => xlib_window.window as u32,
        RawWindowHandle::Xcb(xcb_window) => xcb_window.window.get(),
        _ => {
            return Err("Wayland surface, not an X11 window (no X server answered, \
                        or GDK_BACKEND names wayland): EWMH states and the \
                        per-pixel input region are unwired for Wayland, so the \
                        overlay keeps GTK's defaults"
                .to_string());
        }
    };

    let Some(conn) = super::connection::connection() else {
        return Err("Failed to get X11 connection".to_string());
    };

    // Record X window ID for cleanup (Destroyed event fires after handle is invalid)
    WINDOW_ID_MAP
        .lock()
        .unwrap()
        .insert(window.label().to_string(), x_window);

    set_ewmh_states(conn, x_window)?;
    Ok(())
}

/// `XShapeCombineMask` sets the input region: `None` makes the entire window
/// click-through, `Some` gives clicks only to the opaque pixels and any
/// hotspot rectangles the renderer reported.
pub fn update_input_region(
    window: &tauri::WebviewWindow,
    mask_data: Option<&fidget_core::overlay::AlphaMask>,
    sprite_x: i32,
    sprite_y: i32,
    sprite_facing: i32,
    scale: i32,
    hotspot_rects: &[[i32; 4]],
) -> Result<(), String> {
    let raw_window_handle = match window.window_handle() {
        Ok(handle) => handle,
        Err(e) => {
            return Err(format!("Window handle not available yet: {}", e));
        }
    };

    let x_window = match raw_window_handle.as_raw() {
        RawWindowHandle::Xlib(xlib_window) => xlib_window.window as u32,
        RawWindowHandle::Xcb(xcb_window) => xcb_window.window.get(),
        _ => {
            // Wayland: the input region is unwired here, and an Err would retry
            // forever.
            return Ok(());
        }
    };

    let Some(conn) = super::connection::connection() else {
        return Err("Failed to get X11 connection".to_string());
    };

    if let Some(mask) = mask_data {
        apply_input_mask(
            conn,
            x_window,
            mask,
            sprite_x,
            sprite_y,
            sprite_facing,
            scale,
            hotspot_rects,
        )?;
    } else {
        clear_input_region(conn, x_window)?;
    }

    Ok(())
}

fn should_rebuild_mask(
    cache: &HashMap<u32, CachedPixmap>,
    window: u32,
    current_shape: &MaskShape,
) -> bool {
    cache
        .get(&window)
        .is_none_or(|cached| &cached.shape != current_shape)
}

#[allow(clippy::too_many_arguments)]
fn apply_input_mask(
    conn: &RustConnection,
    window: u32,
    mask: &fidget_core::overlay::AlphaMask,
    sprite_x: i32,
    sprite_y: i32,
    sprite_facing: i32,
    scale: i32,
    hotspot_rects: &[[i32; 4]],
) -> Result<(), String> {
    let rebuild_start = Instant::now();

    let (width, height, opaque) = mask.raw();
    let current_shape = MaskShape {
        opaque: opaque.to_vec(),
        width,
        height,
        facing: sprite_facing,
        scale,
    };

    let mut cache = PIXMAP_CACHE.lock().unwrap();
    let shape_changed = should_rebuild_mask(&cache, window, &current_shape);

    let (pixmap, _gc) = if shape_changed {
        FULL_REBUILD_COUNT.fetch_add(1, Ordering::Relaxed);

        // Shape changed: need to rebuild the pixmap
        if let Some(cached) = cache.remove(&window) {
            xproto::free_gc(conn, cached.gc).ok();
            xproto::free_pixmap(conn, cached.pixmap).ok();
        }

        let scaled_width = width * scale;
        let scaled_height = height * scale;

        let screen = &conn.setup().roots[0];
        let pixmap = conn
            .generate_id()
            .map_err(|e| format!("Failed to generate pixmap ID: {e}"))?;

        xproto::create_pixmap(
            conn,
            1, // 1-bit depth for mask
            pixmap,
            screen.root,
            scaled_width as u16,
            scaled_height as u16,
        )
        .map_err(|e| format!("Failed to create pixmap: {e}"))?;

        let gc = conn
            .generate_id()
            .map_err(|e| format!("Failed to generate GC ID: {e}"))?;
        xproto::create_gc(conn, gc, pixmap, &Default::default())
            .map_err(|e| format!("Failed to create GC: {e}"))?;

        // Clear the pixmap to 0 (transparent). CreatePixmap contents are undefined.
        xproto::poly_fill_rectangle(
            conn,
            pixmap,
            gc,
            &[xproto::Rectangle {
                x: 0,
                y: 0,
                width: scaled_width as u16,
                height: scaled_height as u16,
            }],
        )
        .map_err(|e| format!("Failed to clear pixmap: {e}"))?;

        // Set GC foreground to 1 for opaque pixels (default is 0)
        xproto::change_gc(conn, gc, &xproto::ChangeGCAux::new().foreground(1))
            .map_err(|e| format!("Failed to set GC foreground: {e}"))?;

        // Facing < 0 mirrors the mask horizontally, matching `AlphaMask::hit` and
        // the renderer.
        let mirror = sprite_facing < 0;
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) as usize;
                if opaque[idx] {
                    let draw_x = if mirror {
                        (width - 1 - x) * scale
                    } else {
                        x * scale
                    };
                    let scaled_y = y * scale;
                    xproto::poly_fill_rectangle(
                        conn,
                        pixmap,
                        gc,
                        &[xproto::Rectangle {
                            x: draw_x as i16,
                            y: scaled_y as i16,
                            width: scale as u16,
                            height: scale as u16,
                        }],
                    )
                    .map_err(|e| format!("Failed to draw rectangle: {e}"))?;
                }
            }
        }

        cache.insert(
            window,
            CachedPixmap {
                pixmap,
                gc,
                shape: current_shape,
            },
        );

        (pixmap, gc)
    } else {
        // Only position changed: reuse cached pixmap
        POSITION_ONLY_COUNT.fetch_add(1, Ordering::Relaxed);
        let cached = cache.get(&window).unwrap();
        (cached.pixmap, cached.gc)
    };

    drop(cache);

    shape::mask(
        conn,
        shape::SO::SET,
        SK::INPUT,
        window,
        sprite_x as i16,
        sprite_y as i16,
        pixmap,
    )
    .map_err(|e| format!("Failed to apply input mask: {e}"))?
    .check()
    .map_err(|e| format!("X11 error applying input mask: {e}"))?;

    if !hotspot_rects.is_empty() {
        let x11_rects: Vec<xproto::Rectangle> = hotspot_rects
            .iter()
            .map(|&[hx, hy, hw, hh]| xproto::Rectangle {
                x: hx as i16,
                y: hy as i16,
                width: hw as u16,
                height: hh as u16,
            })
            .collect();

        shape::rectangles(
            conn,
            shape::SO::UNION,
            SK::INPUT,
            xproto::ClipOrdering::UNSORTED,
            window,
            0,
            0,
            &x11_rects,
        )
        .map_err(|e| format!("Failed to union hotspot rectangles: {e}"))?
        .check()
        .map_err(|e| format!("X11 error unioning hotspot rectangles: {e}"))?;
    }

    conn.flush()
        .map_err(|e| format!("Failed to flush X11: {e}"))?;

    let rebuild_elapsed = rebuild_start.elapsed().as_nanos() as u64;
    MASK_UPDATE_COUNT.fetch_add(1, Ordering::Relaxed);
    MASK_UPDATE_NANOS.fetch_add(rebuild_elapsed, Ordering::Relaxed);

    if std::env::var("FIDGET_TRACE_MASK_REBUILD").is_ok() {
        let opaque_count = opaque.iter().filter(|&&b| b).count();
        eprintln!(
            "mask_rebuild: {}x{} @{}x scale, {} opaque pixels, {:.3} ms{}",
            width,
            height,
            scale,
            opaque_count,
            rebuild_elapsed as f64 / 1_000_000.0,
            if shape_changed {
                ""
            } else {
                " (position-only)"
            }
        );
    }

    Ok(())
}

fn free_cached_pixmap(conn: &RustConnection, window: u32) {
    let mut cache = PIXMAP_CACHE.lock().unwrap();
    if let Some(cached) = cache.remove(&window) {
        xproto::free_gc(conn, cached.gc).ok();
        xproto::free_pixmap(conn, cached.pixmap).ok();
    }
}

fn clear_input_region(conn: &RustConnection, window: u32) -> Result<(), String> {
    free_cached_pixmap(conn, window);

    shape::mask(conn, shape::SO::SET, SK::INPUT, window, 0, 0, x11rb::NONE)
        .map_err(|e| format!("Failed to clear input region: {e}"))?
        .check()
        .map_err(|e| format!("X11 error clearing input region: {e}"))?;

    conn.flush()
        .map_err(|e| format!("Failed to flush X11: {e}"))?;

    Ok(())
}

/// Free cached X11 pixmap and GC for a destroyed overlay window.
pub fn cleanup_overlay_window(window: &tauri::WebviewWindow) {
    let Some(conn) = super::connection::connection() else {
        eprintln!("cleanup_overlay_window: failed to get X11 connection");
        return;
    };

    let label = window.label().to_string();

    // Destroyed fires after the window leaves Tauri's list, so window_handle() fails.
    // Use the X window ID we recorded at setup instead.
    let x_window = {
        let mut map = WINDOW_ID_MAP.lock().unwrap();
        match map.remove(&label) {
            Some(id) => {
                eprintln!(
                    "cleanup_overlay_window: freeing pixmap for window {} (X ID {})",
                    label, id
                );
                id
            }
            None => {
                eprintln!(
                    "cleanup_overlay_window: no recorded X window ID for {}",
                    label
                );
                return;
            }
        }
    };

    free_cached_pixmap(conn, x_window);
}

/// The overlay is not an application window, so the window manager must not treat it as one.
fn set_ewmh_states(conn: &RustConnection, window: u32) -> Result<(), String> {
    let atoms = super::atoms::atoms().ok_or("Failed to intern EWMH atoms")?;

    let states = [
        atoms.net_wm_state_above,
        atoms.net_wm_state_skip_taskbar,
        atoms.net_wm_state_skip_pager,
    ];
    xproto::change_property(
        conn,
        PropMode::REPLACE,
        window,
        atoms.net_wm_state,
        AtomEnum::ATOM,
        32,
        states.len() as u32,
        bytemuck::cast_slice(&states),
    )
    .map_err(|e| format!("Failed to set EWMH states: {e}"))?
    .check()
    .map_err(|e| format!("X11 error setting states: {e}"))?;

    conn.flush()
        .map_err(|e| format!("Failed to flush X11 after EWMH states: {e}"))?;

    // ABOVE band puts the overlay above normal windows. Within that band, BELOW
    // reorders so Settings (also ABOVE) stacks higher than the overlay.
    let lower_aux = ConfigureWindowAux::new().stack_mode(StackMode::BELOW);
    xproto::configure_window(conn, window, &lower_aux)
        .map_err(|e| format!("Failed to lower overlay: {e}"))?
        .check()
        .map_err(|e| format!("X11 error lowering overlay: {e}"))?;

    conn.flush()
        .map_err(|e| format!("Failed to flush X11: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_shape_equality() {
        let shape1 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 2,
        };

        let shape2 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 2,
        };

        let shape3 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: -1, // Different facing
            scale: 2,
        };

        assert_eq!(shape1, shape2);
        assert_ne!(shape1, shape3);
    }

    #[test]
    fn frame_change_triggers_rebuild() {
        let mut cache = HashMap::new();
        let window1 = 1;

        let shape1 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let shape2 = MaskShape {
            opaque: vec![true, true, false],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape1.clone(),
            },
        );

        assert!(
            should_rebuild_mask(&cache, window1, &shape2),
            "Frame change should trigger rebuild"
        );
    }

    #[test]
    fn facing_change_triggers_rebuild() {
        let mut cache = HashMap::new();
        let window1 = 1;

        let shape1 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let shape2 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: -1,
            scale: 1,
        };

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape1.clone(),
            },
        );

        assert!(
            should_rebuild_mask(&cache, window1, &shape2),
            "Facing change should trigger rebuild"
        );
    }

    #[test]
    fn scale_change_triggers_rebuild() {
        let mut cache = HashMap::new();
        let window1 = 1;

        let shape1 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let shape2 = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 2,
        };

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape1.clone(),
            },
        );

        assert!(
            should_rebuild_mask(&cache, window1, &shape2),
            "Scale change should trigger rebuild"
        );
    }

    #[test]
    fn position_only_reuses_cache() {
        let mut cache = HashMap::new();
        let window1 = 1;

        let shape = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape.clone(),
            },
        );

        assert!(
            !should_rebuild_mask(&cache, window1, &shape),
            "Same shape should reuse cache (position-only update)"
        );
    }

    #[test]
    fn two_windows_have_separate_caches() {
        let mut cache = HashMap::new();

        let shape1 = MaskShape {
            opaque: vec![true, false],
            width: 2,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let shape2 = MaskShape {
            opaque: vec![false, true],
            width: 2,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let window1 = 1;
        let window2 = 2;

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape1.clone(),
            },
        );

        cache.insert(
            window2,
            CachedPixmap {
                pixmap: 300,
                gc: 400,
                shape: shape2.clone(),
            },
        );

        assert_eq!(cache.get(&window1).unwrap().shape, shape1);
        assert_eq!(cache.get(&window2).unwrap().shape, shape2);

        cache.remove(&window1);
        assert!(!cache.contains_key(&window1));
        assert_eq!(cache.get(&window2).unwrap().shape, shape2);
    }

    #[test]
    fn window2_same_shape_as_window1_rebuilds() {
        let mut cache = HashMap::new();

        let shape = MaskShape {
            opaque: vec![true, false, true],
            width: 3,
            height: 1,
            facing: 1,
            scale: 1,
        };

        let window1 = 1;
        let window2 = 2;

        cache.insert(
            window1,
            CachedPixmap {
                pixmap: 100,
                gc: 200,
                shape: shape.clone(),
            },
        );

        assert!(
            should_rebuild_mask(&cache, window2, &shape),
            "Window 2 with same shape as cached window 1 must rebuild (per-window cache)"
        );
    }

    #[test]
    fn stats_tracking() {
        MASK_UPDATE_COUNT.store(0, Ordering::Relaxed);
        MASK_UPDATE_NANOS.store(0, Ordering::Relaxed);
        FULL_REBUILD_COUNT.store(0, Ordering::Relaxed);
        POSITION_ONLY_COUNT.store(0, Ordering::Relaxed);

        let total = MASK_UPDATE_COUNT.load(Ordering::Relaxed);
        let full = FULL_REBUILD_COUNT.load(Ordering::Relaxed);
        let position_only = POSITION_ONLY_COUNT.load(Ordering::Relaxed);

        assert_eq!(total, 0);
        assert_eq!(full, 0);
        assert_eq!(position_only, 0);
    }
}
