//! How long a speech bubble stays up, and how the two Speech channels share it.
//!
//! The overlay times its own bubble. The shell keeps this clock so a resting
//! stroll can stop while that bubble is showing. The engine only hears a bool.
//!
//! A line reaches the bubble through the turn's reply or through MCP `speak`.
//! `Voice` holds the rules between them; `docs/harness.md` (Speech channels)
//! states them.

use std::time::{Duration, Instant};

use crate::director::Wake;
use crate::engine::BehaviorProposal;

/// What one Instance's open turn has already said through `speak`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Voice {
    said: Vec<String>,
}

/// Where a `speak` line lands, from the Shell's side of that Instance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moment {
    /// A Fidget turn is on the wire for this Instance.
    pub turn_open: bool,
    pub do_not_disturb: bool,
    /// The bubble still holds a line or an ask for its reading time.
    pub bubble_held: bool,
}

/// What became of one `speak` line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Heard {
    Said,
    /// Not shown, and answered as success: an error would invite a retry or
    /// the same line in the reply. The reason goes to the Action Log.
    Declined(Declined),
}

/// Why a `speak` line was not shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Declined {
    DoNotDisturb,
    /// The bubble still holds a line or an ask for its reading time.
    BubbleHeld,
}

impl Declined {
    /// The Action Log's spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DoNotDisturb => "do_not_disturb",
            Self::BubbleHeld => "bubble_held",
        }
    }
}

impl Voice {
    /// A wake started a turn. Lines from the turn it replaced are not this
    /// turn's to repeat.
    pub fn opened(&mut self) {
        self.said.clear();
    }

    /// Decide one `speak` line. Inside a turn it is the turn's own speech and
    /// newest wins. Outside one it is unprompted, so Do Not Disturb silences
    /// it and it never cuts short a line still being read.
    pub fn heard(&mut self, line: &str, at: Moment) -> Heard {
        if at.turn_open {
            self.said.push(line.trim().to_string());
            return Heard::Said;
        }
        if at.do_not_disturb {
            return Heard::Declined(Declined::DoNotDisturb);
        }
        if at.bubble_held {
            return Heard::Declined(Declined::BubbleHeld);
        }
        Heard::Said
    }

    /// Settle the turn's reply against what the turn said through `speak`.
    /// A reply line the turn already said is not said again; its Behavior
    /// still plays. An empty reply after `speak` is a turn that spoke, not a
    /// failure.
    pub fn settle(&mut self, wake: Wake, silent: bool) -> Wake {
        let said = std::mem::take(&mut self.said);
        match wake {
            Wake::Failed if silent && !said.is_empty() => Wake::Proposed(BehaviorProposal {
                behavior: String::new(),
                dialogue: None,
            }),
            Wake::Proposed(mut proposal) => {
                // ponytail: exact match after trimming, so a reworded or
                // repunctuated repeat still shows twice. Normalise if that
                // shows up in the Action Log.
                if proposal
                    .dialogue
                    .as_deref()
                    .is_some_and(|line| said.iter().any(|spoken| spoken == line.trim()))
                {
                    proposal.dialogue = None;
                }
                Wake::Proposed(proposal)
            }
            failed => failed,
        }
    }

    /// Whether a reply still streaming is so far a line the turn already
    /// said through `speak`, so the bubble does not say it a second time.
    pub fn repeats(&self, so_far: &str) -> bool {
        let so_far = so_far.trim();
        !so_far.is_empty() && self.said.iter().any(|spoken| spoken.starts_with(so_far))
    }
}

/// A hold on a spoken line or an ask, owned by the shell.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechBubble {
    until: Option<Instant>,
}

impl SpeechBubble {
    /// Whether the bubble is still showing at `now`.
    pub fn visible_at(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }

    /// Start a hold for `line`, replacing any hold already running.
    pub fn show_line(&mut self, now: Instant, line: &str) {
        let units = line.encode_utf16().count() as u64;
        let ms = 900u64.saturating_add(55u64.saturating_mul(units));
        let ms = ms.clamp(2000, 8000);
        self.until = Some(now + Duration::from_millis(ms));
    }

    /// Start the ask hold.
    pub fn show_ask(&mut self, now: Instant) {
        self.until = Some(now + Duration::from_millis(8000));
    }

    /// Drop the hold.
    pub fn hide(&mut self) {
        self.until = None;
    }
}

/// Apply one tick's speech to `bubble`.
pub fn note_speech(
    bubble: &mut SpeechBubble,
    now: Instant,
    line: Option<&str>,
    asking: bool,
    character_visible: bool,
    instant_hide: bool,
) {
    if instant_hide {
        bubble.hide();
        return;
    }
    if !character_visible {
        return;
    }
    if let Some(line) = line {
        bubble.show_line(now, line);
    } else if asking {
        bubble.show_ask(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const IN_TURN: Moment = Moment {
        turn_open: true,
        do_not_disturb: false,
        bubble_held: false,
    };

    fn reply(behavior: &str, line: Option<&str>) -> Wake {
        Wake::Proposed(BehaviorProposal {
            behavior: behavior.to_string(),
            dialogue: line.map(str::to_string),
        })
    }

    #[test]
    fn a_reply_repeating_the_turns_speak_line_is_not_said_twice() {
        let mut voice = Voice::default();
        voice.opened();
        assert_eq!(voice.heard("Tests pass!", IN_TURN), Heard::Said);
        let settled = voice.settle(reply("Celebrate", Some(" Tests pass!")), false);
        assert_eq!(
            settled,
            reply("Celebrate", None),
            "the Behavior plays, the line is not repeated"
        );
    }

    #[test]
    fn a_streaming_reply_is_held_back_while_it_repeats_a_speak_line() {
        let mut voice = Voice::default();
        voice.heard("Tests pass!", IN_TURN);
        assert!(voice.repeats("Tests pa"));
        assert!(!voice.repeats("Tests passed, all"));
        assert!(!voice.repeats(" "));
    }

    #[test]
    fn a_reply_with_a_new_line_still_says_it() {
        let mut voice = Voice::default();
        voice.heard("Running the tests", IN_TURN);
        let settled = voice.settle(reply("Celebrate", Some("All green")), false);
        assert_eq!(settled, reply("Celebrate", Some("All green")));
    }

    #[test]
    fn a_line_from_a_replaced_turn_does_not_swallow_the_next_reply() {
        let mut voice = Voice::default();
        voice.heard("hi", IN_TURN);
        voice.opened();
        assert_eq!(
            voice.settle(reply("", Some("hi")), false),
            reply("", Some("hi"))
        );
    }

    #[test]
    fn a_late_line_does_not_cut_short_the_reply_being_read() {
        let mut voice = Voice::default();
        voice.settle(reply("", Some("Done.")), false);
        let late = Moment {
            turn_open: false,
            do_not_disturb: false,
            bubble_held: true,
        };
        assert_eq!(
            voice.heard("Still working", late),
            Heard::Declined(Declined::BubbleHeld)
        );
    }

    #[test]
    fn a_line_outside_a_turn_shows_once_the_bubble_is_free() {
        let mut voice = Voice::default();
        assert_eq!(voice.heard("Build done", Moment::default()), Heard::Said);
    }

    #[test]
    fn do_not_disturb_silences_a_line_outside_a_turn_only() {
        let mut voice = Voice::default();
        let quiet = Moment {
            do_not_disturb: true,
            ..Moment::default()
        };
        assert_eq!(
            voice.heard("psst", quiet),
            Heard::Declined(Declined::DoNotDisturb)
        );
        let answering = Moment {
            turn_open: true,
            ..quiet
        };
        assert_eq!(
            voice.heard("you poked me", answering),
            Heard::Said,
            "a turn's speak obeys what its reply obeys"
        );
    }

    #[test]
    fn an_empty_reply_after_speak_is_a_turn_that_spoke() {
        let mut voice = Voice::default();
        voice.heard("Tests pass!", IN_TURN);
        assert_eq!(voice.settle(Wake::Failed, true), reply("", None));
    }

    #[test]
    fn an_empty_reply_with_no_speak_still_fails() {
        let mut voice = Voice::default();
        assert_eq!(voice.settle(Wake::Failed, true), Wake::Failed);
    }

    #[test]
    fn a_failed_call_after_speak_still_fails() {
        let mut voice = Voice::default();
        voice.heard("On it", IN_TURN);
        assert_eq!(
            voice.settle(Wake::Failed, false),
            Wake::Failed,
            "a timeout or a lost Harness is not a reply"
        );
    }
    #[test]
    fn a_short_line_stays_up_for_two_seconds() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some("hi"), false, true, false);
        assert!(bubble.visible_at(now + Duration::from_millis(1999)));
        assert!(!bubble.visible_at(now + Duration::from_millis(2000)));
    }

    #[test]
    fn a_thirty_character_line_lasts_until_the_unclamped_duration() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some(&"a".repeat(30)), false, true, false);
        assert!(bubble.visible_at(now + Duration::from_millis(2549)));
        assert!(!bubble.visible_at(now + Duration::from_millis(2550)));
    }

    #[test]
    fn a_long_line_is_clamped_to_eight_seconds() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some(&"a".repeat(200)), false, true, false);
        assert!(bubble.visible_at(now + Duration::from_millis(7999)));
        assert!(!bubble.visible_at(now + Duration::from_millis(8000)));
    }

    #[test]
    fn an_ask_with_no_line_stays_up_for_eight_seconds() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, None, true, true, false);
        assert!(bubble.visible_at(now + Duration::from_millis(7999)));
        assert!(!bubble.visible_at(now + Duration::from_millis(8000)));
    }

    #[test]
    fn instant_hide_clears_even_when_a_line_arrives() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some("hi"), false, true, false);
        assert!(bubble.visible_at(now));
        note_speech(&mut bubble, now, Some("hi"), false, true, true);
        assert!(!bubble.visible_at(now));
    }

    #[test]
    fn a_hidden_character_does_not_start_a_hold() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some("hi"), false, false, false);
        assert!(!bubble.visible_at(now));
        assert!(!bubble.visible_at(now + Duration::from_millis(1999)));
    }

    #[test]
    fn a_quiet_tick_leaves_a_hold_to_expire() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some("hi"), false, true, false);
        let later = now + Duration::from_millis(100);
        note_speech(&mut bubble, later, None, false, true, false);
        assert!(bubble.visible_at(now + Duration::from_millis(1999)));
        assert!(!bubble.visible_at(now + Duration::from_millis(2000)));
    }

    #[test]
    fn a_second_line_replaces_the_deadline() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        note_speech(&mut bubble, now, Some("hi"), false, true, false);
        let now2 = now + Duration::from_millis(500);
        note_speech(
            &mut bubble,
            now2,
            Some(&"a".repeat(200)),
            false,
            true,
            false,
        );
        assert!(bubble.visible_at(now2 + Duration::from_millis(7999)));
        assert!(!bubble.visible_at(now2 + Duration::from_millis(8000)));
    }

    #[test]
    fn a_line_counts_utf16_units_the_way_the_overlay_does() {
        let now = Instant::now();
        let mut bubble = SpeechBubble::default();
        let line = format!("{}👍", "a".repeat(20));
        note_speech(&mut bubble, now, Some(&line), false, true, false);
        // 22 UTF-16 units: 900 + 55 * 22. `chars` would count the emoji as one.
        assert!(bubble.visible_at(now + Duration::from_millis(2109)));
        assert!(!bubble.visible_at(now + Duration::from_millis(2110)));
    }
}
