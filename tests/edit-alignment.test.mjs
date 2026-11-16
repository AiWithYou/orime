import test from "node:test";
import assert from "node:assert/strict";
import { buildRecipe } from "../adapters/recipes.mjs";
test("MOSS explicit edit dimensions align conditioning with output at non-default sizes", () => {
  const g = buildRecipe("moss", {
    image: "source.png",
    width: 768,
    height: 512,
  });
  const text = Object.values(g).find(
    (n) => n.class_type === "TextEncodeMOSSImageEdit",
  );
  const resize = g[text.inputs["images.image_0"][0]];
  assert.equal(resize.class_type, "ImageScale");
  assert.deepEqual(
    [resize.inputs.width, resize.inputs.height, resize.inputs.crop],
    [768, 512, "disabled"],
  );
});
