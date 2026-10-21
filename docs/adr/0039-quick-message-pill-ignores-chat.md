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
not resolve that.

An opening pill takes the keyboard. If the pointer rests on the Character for
the hover delay while the user types in Chat, the caret moves to the pill and
the next word lands there. The gate this decision removes was what kept the pill
down while Chat was up, so that caret move is the cost it accepts.

Closing a pill opened over Chat returns the keyboard to that window when it
still exists, and steps aside when it does not. macOS, Windows and X11
remember the window that was in front, and the overlay is the only one of
Fidget's windows they skip. Wayland cannot activate another client's surface,
so there the compositor keeps the keyboard.

The dismissal latch clears only on pointer leave, which the Shell sees from its
own hit test even when the page's `:hover` sticks. Chat closing no longer clears
it. A Summon or Send with the pointer still resting on the Character keeps the
pill down until the pointer moves off, and that is the intended pointer rule
rather than a cost.

Reversing this means pushing Chat's window state back onto every overlay, and a
hover again doing different things depending on a window elsewhere.

## Considered Options

- **Keep the gate and hide the pill while Chat is up (#1243).** Two composers
  that exclude each other, and a user hovering to type a short line is sent to a
  window instead. It also asks the overlay to track another window's state
  forever.
- **Keep Chat state only to clear the Summon latch on Chat close (#1489).** The
  latch is about the pointer, and its only tie to Chat was a macOS case where a
  stuck `:hover` left it set. Keeping the state for one reset keeps the coupling
  and its sync work alive for a rare path, and it can clear a latch the pointer
  never left.
- **Put a timer on the dismissal latch.** A hover would reopen the pill while
  the pointer still rests on the Character, which is the very hover that just
  sent or summoned. A guessed interval replaces an observable event.
