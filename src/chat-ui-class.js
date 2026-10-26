
// The Chat UI design class on the root element. Split from chat.js, which
// reads `window.__TAURI__` at import, so node can load this.
const DESIGNS = ["minimal", "terminal", "glass"];

// Allowlist known Chat UI designs. Unknown strings from settings or events
// must not become class names.
export function normalizeChatUi(value) {
  return DESIGNS.includes(value) ? value : "minimal";
}

export function applyChatUiClass(root, design) {
  root.classList.remove(...DESIGNS.map((name) => `chat-ui-${name}`));
  root.classList.add(`chat-ui-${normalizeChatUi(design)}`);
}

// Linux cannot blur the desktop behind Chat, so Glass paints a stronger tint
// there. macOS blurs with a native window effect instead of CSS.
export function applyPlatform(root, platform) {
  if (platform === "linux" || platform === "macos") {
    root.dataset.platform = platform;
  } else {
    delete root.dataset.platform;
  }
}
