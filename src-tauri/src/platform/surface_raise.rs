//! How a shell surface meets the overlay when it needs the keyboard.
//!
//! Settings must sit above the overlay (#799). Chat must not: the overlay draws
//! the Character, and a Chat raised into the status band leaves the application
//! layer (`perch_eligible` keeps only layer 0), so the sprite cannot land on it
//! and paints behind it (#1498).

/// Whether opening or focusing the surface lifts it above the overlay's band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceRaise {
    /// Sit above the overlay so the overlay cannot cover the surface.
    AboveOverlay,
    /// Take the keyboard at the normal window level. The overlay stays on top.
    KeyAtNormalLevel,
}

/// How Chat meets the overlay when Summoned or focused.
pub fn chat_surface_raise() -> SurfaceRaise {
    SurfaceRaise::KeyAtNormalLevel
}

/// How Settings meets the overlay when opened or raised.
pub fn settings_surface_raise() -> SurfaceRaise {
    SurfaceRaise::AboveOverlay
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Focused Chat used to call the same raise as Settings. That put Chat at
    /// NSStatusWindowLevel (CGWindow layer 25), which `perch_eligible` drops,
    /// and stacked Chat above the overlay so the sprite drew behind the ledge.
    #[test]
    fn chat_stays_under_the_overlay_so_it_can_be_a_perch() {
        assert_eq!(chat_surface_raise(), SurfaceRaise::KeyAtNormalLevel);
    }

    #[test]
    fn settings_still_clears_the_overlay() {
        assert_eq!(settings_surface_raise(), SurfaceRaise::AboveOverlay);
    }
}
