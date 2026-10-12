// A Harness's thinking as Chat log entries, as a rule rather than DOM, so node
// can drive the orderings a window cannot reproduce (ADR-0034). A thought is
// the whole text so far; an empty one says the turn stopped thinking.

// streaming: open and filling. collapsed: the title and a handle. expanded:
// opened again by the user. A user may collapse or reopen a row that is still
// filling; the reply collapses it either way.
const TOGGLED = { streaming: "collapsed", collapsed: "expanded", expanded: "collapsed" };

export function createThinking(draw) {
  const entries = new Map();
  let live = null;
  // Empty settle collapses the row; peeled planning may still join before the reply.
  let reopenable = null;
  let next = 1;

  function open(text, state, at) {
    const entry = { id: next++, text, state, at };
    entries.set(entry.id, entry);
    return entry;
  }

  function landed() {
    if (live) {
      // Whatever the user did while it filled, the reply closes it.
      live.state = "collapsed";
      draw({ ...live });
      live = null;
    }
    reopenable = null;
  }

  return {
    thought(text) {
      if (!text) {
        if (!live) return;
        live.state = "collapsed";
        draw({ ...live });
        reopenable = live;
        live = null;
        return;
      }
      if (live) {
        live.text = text;
      } else if (reopenable && text.startsWith(reopenable.text)) {
        // Same-turn peel: wire sends the whole thought so far.
        live = reopenable;
        live.text = text;
        live.state = "streaming";
        reopenable = null;
      } else {
        reopenable = null;
        live = open(text, "streaming");
      }
      draw({ ...live });
    },

    // The reply, a refusal, or the user's next line: the turn's thinking is over.
    landed,

    // Thinking the Shell kept from before this window was listening.
    kept(text, at) {
      draw({ ...open(text, "collapsed", at) });
    },

    toggle(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.state = TOGGLED[entry.state];
      draw({ ...entry });
    },

    clear() {
      entries.clear();
      live = null;
      reopenable = null;
    },
  };
}
