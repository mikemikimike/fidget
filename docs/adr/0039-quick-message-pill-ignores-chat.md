# The quick-message pill opens on hover whatever Chat is doing

**Status:** Accepted.

## Context

The pill is the hover composer on the Character: rest the pointer on the sprite
and it appears, so a short line does not need a window. Chat is a second
composer, in a window of its own.

Chat's window state used to be pushed to every overlay on every frame, so a
hover could be told to do nothing while Chat was up. That coupled two
composers. Whether a hover opened a field depended on a window the
user may not be looking at, and every overlay had to keep its copy of another
surface's state current.

## Decision

The pill's visibility depends only on the pointer, the pill's own state, and its
dismissal latch. Chat being open, visible, or minimized changes nothing. The
placement wire carries no Chat-window state.

A Summon or a Send still dismisses the pill and holds it down until the pointer
leaves the sprite. That is a dismissal rule, not a Chat rule: the gesture that
used the pill is over, so the pill gets out of the way.

## Consequences

Hovering the Character while Chat is open opens the pill, so the user can choose
either composer. Two fields can be up with a draft in each; this decision does
not resolve that. Closing a pill opened over Chat returns the keyboard to Chat:
the hand-back remembers the window that was in front, not just the app.

The dismissal latch now clears only on pointer leave. The reset that ran when
Chat closed existed for a macOS case where a Summon left the hover stuck with no
pointer-leave, so the latch never cleared (#1489). That reset goes away with the
Chat input. Where a leave is observed the latch clears as it always did; where a
hover sticks with no leave, the pill stays down until the pointer moves off and
back. That is the accepted cost.

Reversing this means pushing Chat's window state back onto every overlay, and a
hover again doing different things depending on a window elsewhere.

## Considered Options

- **Keep the gate and hide the pill while Chat is up (#1243).** Two composers
  that exclude each other, and a user hovering to type a short line is sent to a
  window instead. It also asks the overlay to track another window's state
  forever.
- **Keep Chat state only to clear the Summon latch on Chat close (#1489).** The
  latch is about the pointer, and its only tie to Chat was the macOS focus case
  above. Keeping the state for one reset keeps the coupling and its sync work
  alive for a rare path, and it can clear a latch the pointer never left.
- **Put a timer on the dismissal latch.** A hover would reopen the pill while
  the pointer still rests on the Character, which is the very hover that just
  sent or summoned. A guessed interval replaces an observable event.
