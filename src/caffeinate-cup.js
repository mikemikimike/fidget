
// The caffeinate button in the Chat header.

// `null` hides the button. A `reason` disables it, which is every flag off,
// and becomes the tooltip. `label` shows only while on.
export function cupModel(field) {
  if (field == null) return null;
  const disabled = Boolean(field.reason);
  const on = Boolean(field.on) && !disabled;
  return {
    disabled,
    on,
    title: field.reason || "keep my computer awake",
    label: on ? "caffeinated" : null,
  };
}
