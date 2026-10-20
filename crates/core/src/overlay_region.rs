//! Which pixels an overlay draws and takes input on. Windows' `SetWindowRgn`
//! clips both, so the region must hold the sprite's swept art and every rect
//! the renderer draws outside it, clickable or not.

use serde::Deserialize;

/// Rectangle in overlay coordinates: `[left, top, right, bottom]`.
pub type RegionRect = [i32; 4];

/// Something the renderer draws outside the art, in overlay coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OverlayRect {
    /// `[x, y, width, height]`.
    pub rect: [i32; 4],
    /// "Open chat" and the quick pill take clicks. The bubble body and the
    /// thinking dots are only drawn, so clicks pass through them.
    pub clickable: bool,
    /// The sprite this rect rides with, and where that sprite was drawn when
    /// the rect was measured. `None` for a rect that stays put.
    #[serde(default)]
    pub follows: Option<Follows>,
}

/// Which Instance a rect is placed from, and that Instance's top-left, in
/// overlay coordinates, at the moment the renderer measured the rect.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Follows {
    pub instance: String,
    pub at: [i32; 2],
}

/// The rects a Windows region has to hold while the sprites they ride with
/// move. A rect reaches the Shell a frame or more after the renderer measured
/// it, and the region lands before or after the renderer draws the next
/// placement, so a bubble kept only where it was measured loses its leading
/// edge under a drag (#1568). Each following rect is stretched over every
/// spot it is drawn at as its sprite crosses `placements`, the same trail the
/// sprite's own ink is swept over (#1378). `placements` answers an Instance's
/// recent top-lefts in overlay coordinates, or `None` when it is not here.
pub fn follow_placements(
    rects: &[OverlayRect],
    placements: impl Fn(&str) -> Option<Vec<(i32, i32)>>,
) -> Vec<OverlayRect> {
    rects
        .iter()
        .map(|overlay_rect| {
            let Some(Follows { instance, at }) = &overlay_rect.follows else {
                return overlay_rect.clone();
            };
            let [x, y, width, height] = overlay_rect.rect;
            let (mut left, mut top) = (x, y);
            let (mut right, mut bottom) = (x + width, y + height);
            for (px, py) in placements(instance).unwrap_or_default() {
                let (dx, dy) = (px - at[0], py - at[1]);
                left = left.min(x + dx);
                top = top.min(y + dy);
                right = right.max(x + width + dx);
                bottom = bottom.max(y + height + dy);
            }
            OverlayRect {
                rect: [left, top, right - left, bottom - top],
                clickable: overlay_rect.clickable,
                follows: None,
            }
        })
        .collect()
}

impl OverlayRect {
    /// Whether a click at `(x, y)`, in overlay coordinates, lands on this.
    pub fn takes_click_at(&self, x: i32, y: i32) -> bool {
        let [left, top, width, height] = self.rect;
        self.clickable && x >= left && x < left + width && y >= top && y < top + height
    }
}

/// What a Windows overlay's `SetWindowRgn` gets this frame.
#[derive(Debug, PartialEq, Eq)]
pub enum RegionPlan {
    /// Nothing to draw: no region, and the window passes every click.
    Clear,
    Apply(Vec<RegionRect>),
}

/// Clears only when there is nothing at all to keep: no sprite and no rect.
/// `trail` is already `[left, top, right, bottom]`.
pub fn region_plan(trail: &[[i32; 4]], rects: &[OverlayRect]) -> RegionPlan {
    let bounds = rects.iter().map(|OverlayRect { rect, .. }| {
        let [x, y, width, height] = *rect;
        [x, y, x + width, y + height]
    });
    let region: Vec<RegionRect> = trail.iter().copied().chain(bounds).collect();
    if region.is_empty() {
        RegionPlan::Clear
    } else {
        RegionPlan::Apply(region)
    }
}

/// What an X11 overlay's bounding shape, which clips what it shows, needs.
#[derive(Debug, PartialEq, Eq)]
pub enum ShapeChange<'a> {
    /// Show only these `[left, top, right, bottom]` rects; none shows nothing.
    Clip(&'a [RegionRect]),
    /// Show the whole window: a compositor blends its transparent pixels.
    Unclip,
}

/// One X11 overlay's bounding shape, as last sent. With no compositor the
/// server fills transparent pixels with black, so the shape keeps only what
/// the renderer draws.
#[derive(Debug, Default)]
pub struct BoundingShape {
    clipped: Option<Vec<RegionRect>>,
}

impl BoundingShape {
    /// The change this frame needs, if any. `drawn` is what the renderer
    /// draws, and runs only when no compositor does.
    pub fn next(
        &mut self,
        composited: bool,
        drawn: impl FnOnce() -> Vec<RegionRect>,
    ) -> Option<ShapeChange<'_>> {
        let _ = (composited, drawn, &self.clipped);
        None
    }
}

/// The rects that take clicks, as `[x, y, width, height]`. X11's input shape
/// gets only these: it clips clicks and not drawing, so a drawn-only rect in
/// it would catch clicks meant for the window underneath.
pub fn clickable_rects(rects: &[OverlayRect]) -> Vec<[i32; 4]> {
    rects
        .iter()
        .filter(|rect| rect.clickable)
        .map(|rect| rect.rect)
        .collect()
}

#[cfg(test)]
#[allow(non_upper_case_globals)]
mod tests {
    use super::*;

    /// (name, art LTRB, overlay rects, region LTRB; empty is `Clear`)
    type Row<'a> = (&'a str, &'a [[i32; 4]], &'a [OverlayRect], &'a [[i32; 4]]);

    /// (name, overlay rects, clickable XYWH)
    type ClickRow<'a> = (&'a str, &'a [OverlayRect], &'a [[i32; 4]]);

    const fn clickable(rect: [i32; 4]) -> OverlayRect {
        OverlayRect {
            rect,
            clickable: true,
            follows: None,
        }
    }

    const fn drawn(rect: [i32; 4]) -> OverlayRect {
        OverlayRect {
            rect,
            clickable: false,
            follows: None,
        }
    }

    fn riding(rect: [i32; 4], instance: &str, at: [i32; 2]) -> OverlayRect {
        OverlayRect {
            follows: Some(Follows {
                instance: instance.to_string(),
                at,
            }),
            ..drawn(rect)
        }
    }

    /// #1568: a bubble measured with its sprite at (100, 200) while the drag
    /// has since carried the sprite to (130, 190) is drawn 30px right and 10px
    /// up. The region must hold it there and where it was measured, or Windows
    /// clips the bubble's leading edge.
    #[test]
    fn a_bubble_is_kept_over_every_spot_its_dragged_sprite_puts_it() {
        let bubble = riding([120, 80, 200, 90], "buddy", [100, 200]);
        const parked: OverlayRect = drawn([0, 0, 40, 20]);
        let elsewhere = riding([500, 80, 200, 90], "gone", [480, 200]);
        let trail = |id: &str| (id == "buddy").then(|| vec![(110, 200), (120, 195), (130, 190)]);

        let got = follow_placements(&[bubble, parked.clone(), elsewhere], trail);

        assert_eq!(
            got,
            vec![
                drawn([120, 70, 230, 100]),
                parked,
                drawn([500, 80, 200, 90]),
            ],
        );
        let RegionPlan::Apply(region) = region_plan(&[], &got) else {
            panic!("a bubble keeps a region");
        };
        let at_drag_tip = [150, 70, 350, 160];
        assert!(
            region.iter().any(|[l, t, r, b]| *l <= at_drag_tip[0]
                && *t <= at_drag_tip[1]
                && *r >= at_drag_tip[2]
                && *b >= at_drag_tip[3]),
            "the bubble where the drag has taken it is outside {region:?}"
        );
    }

    /// Only a clickable rect stops the overlay passing a click, over its
    /// pixels and not one past them.
    #[test]
    fn only_a_clickable_rect_takes_a_click() {
        const open_chat: OverlayRect = clickable([220, 140, 72, 18]);
        const qm_pill: OverlayRect = clickable([130, 60, 160, 36]);
        const bubble: OverlayRect = drawn([120, 80, 200, 90]);
        const thinking: OverlayRect = drawn([150, 100, 48, 24]);

        let rows = [
            ("Open chat, top left", open_chat, (220, 140), true),
            ("Open chat, bottom right", open_chat, (291, 157), true),
            (
                "Open chat, past the far edges",
                open_chat,
                (292, 158),
                false,
            ),
            ("the quick pill", qm_pill, (200, 70), true),
            ("the bubble body", bubble, (200, 120), false),
            ("the thinking dots", thinking, (170, 110), false),
        ];
        for (name, rect, (x, y), takes) in &rows {
            let (x, y, takes) = (*x, *y, *takes);
            assert_eq!(rect.takes_click_at(x, y), takes, "{name}");
        }
    }

    /// What X11's input shape gets. Only the rects that take clicks go in;
    /// the bubble body and the thinking dots stay out so clicks pass them.
    #[test]
    fn clickable_rects_table() {
        const open_chat: OverlayRect = clickable([220, 140, 72, 18]);
        const qm_pill: OverlayRect = clickable([130, 60, 160, 36]);
        const bubble: OverlayRect = drawn([120, 80, 200, 90]);
        const thinking: OverlayRect = drawn([150, 100, 48, 24]);

        let rows: &[ClickRow] = &[
            ("nothing reported", &[], &[]),
            ("bubble only", &[bubble], &[]),
            ("thinking only", &[thinking], &[]),
            (
                "truncated speech: Open chat + bubble",
                &[bubble, open_chat],
                &[[220, 140, 72, 18]],
            ),
            (
                "QM pill + bubble",
                &[qm_pill, bubble],
                &[[130, 60, 160, 36]],
            ),
            ("QM pill alone", &[qm_pill], &[[130, 60, 160, 36]]),
            (
                "everything at once keeps its order",
                &[bubble, open_chat, thinking, qm_pill],
                &[[220, 140, 72, 18], [130, 60, 160, 36]],
            ),
        ];
        for (name, rects, expect) in rows {
            assert_eq!(clickable_rects(rects), *expect, "{name}");
        }
    }

    /// The plan `apply_input_mask` carries out. An overlay without the sprite
    /// still keeps a bubble straddling the seam, or a control, in its region.
    #[test]
    fn region_plan_table() {
        let art = [[100, 200, 180, 328]]; // sprite swept bounds
        const open_chat: OverlayRect = clickable([220, 140, 72, 18]);
        const bubble: OverlayRect = drawn([120, 80, 200, 90]);
        const thinking: OverlayRect = drawn([150, 100, 48, 24]);
        const qm_pill: OverlayRect = clickable([130, 60, 160, 36]);

        let rows: &[Row] = &[
            ("nothing to draw clears", &[], &[], &[]),
            (
                "bubble fully on owner",
                &art,
                &[bubble],
                &[[100, 200, 180, 328], [120, 80, 320, 170]],
            ),
            (
                "thinking only",
                &art,
                &[thinking],
                &[[100, 200, 180, 328], [150, 100, 198, 124]],
            ),
            (
                "QM pill + bubble",
                &art,
                &[qm_pill, bubble],
                &[
                    [100, 200, 180, 328],
                    [130, 60, 290, 96],
                    [120, 80, 320, 170],
                ],
            ),
            (
                "truncated speech: Open chat + bubble",
                &art,
                &[open_chat, bubble],
                &[
                    [100, 200, 180, 328],
                    [220, 140, 292, 158],
                    [120, 80, 320, 170],
                ],
            ),
            ("bubble hidden", &art, &[], &[[100, 200, 180, 328]]),
            (
                "no sprite, bubble straddling the seam",
                &[],
                &[bubble],
                &[[120, 80, 320, 170]],
            ),
            (
                "no sprite, a control still on this display",
                &[],
                &[open_chat],
                &[[220, 140, 292, 158]],
            ),
        ];

        for (name, trail, rects, expect) in rows {
            let plan = region_plan(trail, rects);
            if expect.is_empty() {
                assert_eq!(plan, RegionPlan::Clear, "{name}");
                continue;
            }
            let RegionPlan::Apply(got) = plan else {
                panic!("{name}: cleared, want a region of {expect:?}");
            };
            assert_eq!(got.len(), expect.len(), "{name}: rect count");
            for rect in *expect {
                assert!(got.contains(rect), "{name}: missing {rect:?} in {got:?}");
            }
        }
    }
    /// Frames of a walk: the sprite's ink one step further right each time.
    fn walk() -> impl Iterator<Item = Vec<RegionRect>> {
        (0..5).map(|step| vec![[100 + step * 4, 200, 180 + step * 4, 328]])
    }

    /// With a compositor the shape is never touched, and what is drawn is
    /// never even worked out, however the sprite moves.
    #[test]
    fn a_composited_overlay_sends_no_shape_while_its_sprite_walks() {
        let mut shape = BoundingShape::default();
        for _ in walk() {
            let change = shape.next(true, || panic!("drawn worked out under a compositor"));
            assert_eq!(change, None);
        }
    }

    /// #1699: with no compositor the overlay shows what is drawn and nothing
    /// else, and an overlay drawing nothing shows nothing rather than black.
    #[test]
    fn without_a_compositor_the_shape_follows_what_is_drawn() {
        let mut shape = BoundingShape::default();
        for drawn in walk() {
            let sent = drawn.clone();
            assert_eq!(shape.next(false, || sent), Some(ShapeChange::Clip(&drawn)));
        }
        let last = walk().last().unwrap();
        assert_eq!(
            shape.next(false, || last),
            None,
            "a still sprite resends nothing"
        );
        assert_eq!(shape.next(false, Vec::new), Some(ShapeChange::Clip(&[])));
    }

    /// A compositor starting clears the clip once; stopping brings it back.
    #[test]
    fn the_shape_follows_the_compositor_both_ways() {
        let drawn = vec![[100, 200, 180, 328]];
        let mut shape = BoundingShape::default();
        assert_eq!(
            shape.next(false, || drawn.clone()),
            Some(ShapeChange::Clip(&drawn))
        );
        assert_eq!(shape.next(true, || panic!()), Some(ShapeChange::Unclip));
        assert_eq!(shape.next(true, || panic!()), None);
        assert_eq!(
            shape.next(false, || drawn.clone()),
            Some(ShapeChange::Clip(&drawn))
        );
    }
}
