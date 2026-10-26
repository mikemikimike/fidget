

// The agent's plan, as the rows above the composer. Split from chat.js, which
// reads `window.__TAURI__` at import, so node can load this.

// `content` is untrusted Harness text and gets the same `stripUnsafe` an ask
// does. `status` and `priority` pass through as the wire spells them, so CSS
// owns how a status looks.
import { stripUnsafe } from "./markdown.js";

export function planSteps(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => ({
    text: stripUnsafe(entry.content ?? ""),
    status: entry.status ?? "",
    priority: entry.priority ?? "",
  }));
}
