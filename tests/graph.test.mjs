import test from "node:test";
import assert from "node:assert/strict";
import { recipeBindings, inputChoices } from "../frontend/graph.mjs";
import { buildRecipe } from "../adapters/recipes.mjs";
test("rewired prompt roles are blocked instead of writing negative conditioning", () => {
  const prompt = buildRecipe("sdxl", { prompt: "sun", negative: "rain" });
  const bindings = recipeBindings(prompt);
  const sampler = Object.values(prompt).find(
    (n) => n.class_type === "KSampler",
  );
  [sampler.inputs.positive, sampler.inputs.negative] = [
    sampler.inputs.negative,
    sampler.inputs.positive,
  ];
  const result = inspectBindings(prompt, bindings);
  assert.ok(result.blocked.prompt);
  assert.ok(result.blocked.negative);
  assert.equal(result.values.prompt, undefined);
});
test("new uploads are not rejected by the earlier image picker inventory", () => {
  const prompt = {
    1: { class_type: "LoadImage", inputs: { image: "just-uploaded.png" } },
  };
  assert.equal(
    validatePrompt(prompt, {
      LoadImage: {
        input: { required: { image: [["old.png"], { image_upload: true }] } },
      },
    }),
    prompt,
  );
});
test("identical positive and negative text remain independently bound", () => {
  for (const family of ["sdxl", "anima", "moss", "minimax-h3"]) {
    const graph = buildRecipe(family, { prompt: "", negative: "" });
    const bindings = recipeBindings(graph);
    const pos = bindings.find((b) => b.key === "prompt");
    assert.ok(pos);
    const neg = bindings.find((b) => b.key === "negative");
    if (family === "minimax-h3") assert.equal(neg, undefined);
    else {
      assert.ok(neg);
      assert.notEqual(pos.nodeId, neg.nodeId);
    }
  }
});
test("V3 COMBO choices reject unavailable model files", () => {
  const info = {
    Loader: { input: { required: { name: ["COMBO", { options: ["real"] }] } } },
  };
  assert.deepEqual(inputChoices(info, "Loader", "name"), ["real"]);
  assert.throws(() =>
    validatePrompt(
      { 1: { class_type: "Loader", inputs: { name: "missing" } } },
      info,
    ),
  );
});
import {
  patchGraph,
  discoverBindings,
  validatePrompt,
  maskAlpha,
  inspectBindings,
} from "../frontend/graph.mjs";
test("edits preserve custom nodes and links", () => {
  const g = {
    nodes: [
      { id: 1, type: "CLIPTextEncode", widgets_values: ["old"] },
      {
        id: 2,
        type: "CustomThing",
        widgets_values: [99],
        properties: { x: 1 },
      },
    ],
    links: [[1, 1, 0, 2, 0, "CONDITIONING"]],
    extra: { anything: true },
  };
  const out = patchGraph(
    g,
    [{ key: "prompt", nodeId: 1, type: "CLIPTextEncode", index: 0 }],
    { prompt: "new" },
  );
  assert.equal(out.nodes[0].widgets_values[0], "new");
  assert.deepEqual(out.nodes[1], g.nodes[1]);
  assert.deepEqual(out.links, g.links);
  assert.equal(g.nodes[0].widgets_values[0], "old");
});
test("deleted or changed binding fails without mutation", () => {
  assert.throws(() =>
    patchGraph(
      { nodes: [] },
      [{ key: "prompt", nodeId: 1, type: "CLIPTextEncode", index: 0 }],
      { prompt: "x" },
    ),
  );
});
test("ambiguous prompt bindings are not guessed", () => {
  assert.deepEqual(
    discoverBindings({
      1: { class_type: "CLIPTextEncode", inputs: { text: "a" } },
      2: { class_type: "CLIPTextEncode", inputs: { text: "b" } },
    }),
    [],
  );
});
test("capabilities prevent unknown nodes and missing model files", () => {
  assert.throws(() =>
    validatePrompt({ 1: { class_type: "Missing", inputs: {} } }, {}),
  );
  assert.throws(() =>
    validatePrompt(
      { 1: { class_type: "Loader", inputs: { name: "missing" } } },
      { Loader: { input: { required: { name: [["real"]] } } } },
    ),
  );
});
test("painted mask is transparent for Comfy LoadImage", () => {
  assert.equal(maskAlpha(255), 0);
  assert.equal(maskAlpha(0), 255);
});
test("only disconnected bindings are blocked; added nodes survive", () => {
  const graph = {
    1: { class_type: "Sampler", inputs: { seed: 99, steps: ["extra", 0] } },
    extra: { class_type: "Int", inputs: { value: 12 } },
  };
  const r = inspectBindings(graph, [
    { key: "seed", nodeId: 1, type: "Sampler", input: "seed" },
    { key: "steps", nodeId: 1, type: "Sampler", input: "steps" },
  ]);
  assert.deepEqual(r.values, { seed: 99 });
  assert.deepEqual(r.blocked, { steps: "ノードから制御中" });
});
