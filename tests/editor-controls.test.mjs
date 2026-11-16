import test from "node:test";
import assert from "node:assert/strict";
import {
  imageEditSettings,
  shortcutAction,
} from "../frontend/editor-controls.mjs";
test("image editing changes only untouched generation defaults", () => {
  const defaults = {
    steps: 25,
    cfg: 2.5,
    sampler_name: "er_sde",
    scheduler: "simple",
    editSteps: 30,
    editCfg: 4,
    editSamplerName: "euler",
    editScheduler: "normal",
  };
  assert.deepEqual(
    imageEditSettings(
      { steps: 25, cfg: 6, sampler_name: "er_sde", scheduler: "simple" },
      defaults,
    ),
    { steps: 30, cfg: 6, sampler_name: "euler", scheduler: "normal" },
  );
  assert.equal(
    imageEditSettings(
      { sampler_name: "er_sde" },
      { sampler_name: "er_sde", inpaintSamplerName: "euler" },
    ).sampler_name,
    "euler",
  );
});
test("shortcuts respect typing, composition, modifiers and repeated keys", () => {
  assert.equal(
    shortcutAction({ key: "b", target: { tagName: "TEXTAREA" } }),
    null,
  );
  assert.equal(
    shortcutAction({ key: "b", target: { isContentEditable: true } }),
    null,
  );
  assert.equal(shortcutAction({ key: "b", isComposing: true }), null);
  assert.equal(
    shortcutAction({ key: "Enter", ctrlKey: true, repeat: true }),
    null,
  );
  assert.equal(shortcutAction({ key: "b", altKey: true }), null);
  assert.equal(shortcutAction({ key: "b" }), "brush");
  assert.equal(
    shortcutAction({
      key: "Enter",
      ctrlKey: true,
      target: { tagName: "TEXTAREA" },
    }),
    "generate",
  );
  assert.equal(shortcutAction({ key: "s", ctrlKey: true }), "save");
});
