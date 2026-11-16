export function imageEditSettings(settings, defaults = {}) {
  const next = { ...settings };
  for (const [key, editKey] of Object.entries({
    steps: "editSteps",
    cfg: "editCfg",
    sampler_name: defaults.editSamplerName
      ? "editSamplerName"
      : "inpaintSamplerName",
    scheduler: "editScheduler",
  })) {
    if (
      defaults[editKey] !== undefined &&
      (settings[key] === undefined || settings[key] === defaults[key])
    )
      next[key] = defaults[editKey];
  }
  return next;
}
export function shortcutAction(event) {
  if (event.repeat || event.isComposing || event.altKey) return null;
  const key = event.key?.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && key === "enter") return "generate";
  if (modifier && key === "s") return "save";
  const target = event.target;
  if (
    target?.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)
  )
    return null;
  if (modifier) return key === "z" && !event.shiftKey ? "undo" : null;
  return (
    { b: "brush", e: "erase", f: "fit", "[": "smaller", "]": "larger" }[key] ||
    null
  );
}
