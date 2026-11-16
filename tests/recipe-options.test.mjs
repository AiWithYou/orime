import test from "node:test";
import assert from "node:assert/strict";
import { augmentRecipe } from "../frontend/recipe-options.mjs";
const graph = {
  1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a" } },
  2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "p" } },
  3: {
    class_type: "KSampler",
    inputs: { model: ["1", 0], positive: ["2", 0] },
  },
  4: {
    class_type: "SaveImage",
    inputs: { images: ["5", 0], filename_prefix: "out" },
  },
  5: { class_type: "VAEDecode", inputs: {} },
};
test("LoRA chain changes declared recipe inputs without mutating source", () => {
  const out = augmentRecipe(
    graph,
    {
      loras: [
        { name: "a.safetensors", strength: 0.8 },
        { name: "b.safetensors", strength: 0.4 },
      ],
    },
    "sdxl",
  );
  const nodes = Object.entries(out).filter(
    ([, n]) => n.class_type === "LoraLoader",
  );
  assert.equal(nodes.length, 2);
  assert.deepEqual(out["3"].inputs.model, [nodes[1][0], 0]);
  assert.deepEqual(out["2"].inputs.clip, [nodes[1][0], 1]);
  assert.deepEqual(graph["3"].inputs.model, ["1", 0]);
});
test("no options preserve graph; upscale routes final output", () => {
  assert.deepEqual(augmentRecipe(graph, {}, "sdxl"), graph);
  const out = augmentRecipe(graph, { scale: 2 }, "sdxl");
  const [id, n] = Object.entries(out).find(
    ([, n]) => n.class_type === "ImageScaleBy",
  );
  assert.equal(n.inputs.scale_by, 2);
  assert.deepEqual(out["4"].inputs.images, [id, 0]);
});
test("invalid strength and unknown insertion point fail", () => {
  assert.throws(() =>
    augmentRecipe(graph, { loras: [{ name: "a", strength: NaN }] }, "sdxl"),
  );
  assert.throws(() =>
    augmentRecipe({}, { loras: [{ name: "a", strength: 1 }] }, "sdxl"),
  );
});

test("masked output keeps source and mask separate and composites every saved image", async () => {
  const { compositeMasked } = await import("../frontend/recipe-options.mjs");
  const out = compositeMasked(graph, {
    image: "source.png",
    mask: "mask.png",
    width: 320,
    height: 256,
  });
  const composite = Object.entries(out).find(
    ([, n]) => n.class_type === "ImageCompositeMasked",
  );
  assert.ok(composite);
  const source = out[composite[1].inputs.destination[0]];
  assert.equal(source.inputs.image, "source.png");
  const mask = out[composite[1].inputs.mask[0]];
  assert.equal(mask.inputs.image, "mask.png");
  assert.equal(composite[1].inputs.mask[1], 1);
  assert.deepEqual(out["4"].inputs.images, [composite[0], 0]);
  assert.deepEqual(graph["4"].inputs.images, ["5", 0]);
});
