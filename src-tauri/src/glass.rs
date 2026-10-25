//! Glass's blur on macOS: a native `NSVisualEffectView` behind the webview.
//! CSS `backdrop-filter` alone can stop sampling the desktop once the window
//! is inactive; AppKit's view is told outright to stay active.

#[cfg(any(target_os = "macos", test))]
use tauri::utils::config::WindowEffectsConfig;

/// The window effect a Chat UI design wears. Today none does.
#[cfg(any(target_os = "macos", test))]
fn effects(_chat_ui: &str) -> Option<WindowEffectsConfig> {
    None
}

#[cfg(test)]
mod tests {
    use super::effects;
    use tauri::window::EffectState;

    #[test]
    fn glass_blur_stays_active_when_its_window_loses_focus() {
        let glass = effects("glass").expect("Glass wears a window effect");
        assert_eq!(glass.state, Some(EffectState::Active));
    }

    #[test]
    fn designs_that_paint_their_own_panel_wear_no_effect() {
        for design in ["minimal", "terminal", "", "Glass"] {
            assert_eq!(effects(design), None, "{design:?}");
        }
    }
}
