import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasInputs,
  recipeImageBindings,
} from "../frontend/canvas-inputs.mjs";
test("draft images resolve only to matching declared image nodes", () => {
  const prompt = {
    1: { class_type: "LoadImage", inputs: { image: "folder/base.png" } },
    2: { class_type: "LoadImage", inputs: { image: "mask.png" } },
  };
  const bindings = recipeImageBindings(prompt, "folder/base.png", "mask.png");
  assert.deepEqual(canvasInputs(prompt, bindings), {
    image: "folder/base.png",
    mask: "mask.png",
  });
  prompt[1].class_type = "Other";
  assert.deepEqual(canvasInputs(prompt, bindings), { mask: "mask.png" });
});
test("source dimensions bind only to the final compositor scale", () => {
  const prompt = {
    1: { class_type: "ImageScale", inputs: { width: 64, height: 64 } },
    2: { class_type: "ImageCompositeMasked", inputs: { source: ["1", 0] } },
    3: { class_type: "ImageScale", inputs: { width: 512, height: 512 } },
  };
  const bindings = recipeImageBindings(prompt, "a.png", "b.png");
  assert.deepEqual(
    bindings.map((b) => [b.key, b.nodeId]),
    [
      ["imageWidth", "1"],
      ["imageHeight", "1"],
    ],
  );
});
