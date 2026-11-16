import test from "node:test";
import assert from "node:assert/strict";
import {
  imageTools,
  toolFields,
  buildImageTool,
  controlGroups,
  matchingControls,
} from "../frontend/custom-tools.mjs";

const info = {
  LoadImage: { input: { required: { image: ["STRING", {}] } } },
  SaveImage: {
    input: {
      required: {
        images: ["IMAGE"],
        filename_prefix: ["STRING", { default: "ComfyUI" }],
      },
    },
  },
  CannyEdgePreprocessor: {
    input: {
      required: {
        image: ["IMAGE"],
        low_threshold: ["INT", { default: 100, min: 0, max: 255 }],
        high_threshold: ["INT", { default: 200, min: 0, max: 255 }],
        resolution: ["INT", { default: 512, min: 64, max: 4096, step: 64 }],
      },
    },
    output: ["IMAGE"],
  },
  DepthAnythingV2Preprocessor: {
    input: {
      required: {
        image: ["IMAGE"],
        ckpt_name: [
          ["depth_anything_v2_vitl.pth", "depth_anything_v2_vits.pth"],
          { default: "depth_anything_v2_vitl.pth" },
        ],
        resolution: ["INT", { default: 512, min: 64, max: 4096 }],
      },
    },
    output: ["IMAGE"],
  },
};
test("tools derive defaults and bounds from installed schemas; small depth is preferred", () => {
  assert.ok(imageTools.length >= 6);
  assert.equal(
    toolFields("canny", info).find((f) => f.key === "low_threshold").value,
    100,
  );
  assert.equal(
    toolFields("depth", info).find((f) => f.key === "ckpt_name").value,
    "depth_anything_v2_vits.pth",
  );
  assert.throws(() => toolFields("resize", info), /未導入/);
});
test("tool graphs require image, reject invalid values and unexpected required sockets", () => {
  assert.throws(() => buildImageTool("canny", info, "", {}), /画像/);
  assert.throws(
    () => buildImageTool("canny", info, "in.png", { resolution: NaN }),
    /resolution/,
  );
  assert.throws(
    () => buildImageTool("canny", info, "in.png", { low_threshold: 256 }),
    /low_threshold/,
  );
  assert.throws(
    () => buildImageTool("canny", info, "in.png", { resolution: 512.5 }),
    /resolution/,
  );
  assert.throws(
    () => buildImageTool("depth", info, "in.png", { ckpt_name: "missing" }),
    /ckpt_name/,
  );
  const newer = structuredClone(info);
  newer.CannyEdgePreprocessor.input.required.model = ["MODEL"];
  assert.throws(() => buildImageTool("canny", newer, "in.png", {}), /model/);
  const g = buildImageTool("canny", info, "in.png", { low_threshold: 80 });
  assert.equal(g["2"].inputs.low_threshold, 80);
  assert.deepEqual(g["2"].inputs.image, ["1", 0]);
  assert.equal(g["3"].class_type, "SaveImage");
  assert.equal(
    info.CannyEdgePreprocessor.input.required.low_threshold[1].default,
    100,
  );
});
test("curated controls match exact node types and preserve linked fields as read-only", () => {
  const c = [
    {
      key: "1.denoise",
      type: "FaceDetailer",
      input: "denoise",
      label: "顔",
      linked: false,
    },
    {
      key: "2.weight",
      type: "IPAdapterAdvanced",
      input: "weight",
      label: "参照",
      linked: true,
    },
    {
      key: "3.denoise",
      type: "UnknownFaceDetailer",
      input: "denoise",
      label: "別",
    },
  ];
  assert.deepEqual(
    controlGroups(c).map((g) => g.id),
    ["detail", "reference"],
  );
  assert.deepEqual(
    matchingControls(c, "顔").map((c) => c.key),
    ["1.denoise"],
  );
  assert.deepEqual(controlGroups(c)[1].keys, ["2.weight"]);
});

test("changed output type or new required mask cannot silently build an incompatible graph", () => {
  const changed = structuredClone(info);
  changed.CannyEdgePreprocessor.output = ["MASK"];
  assert.throws(() => buildImageTool("canny", changed, "in.png"), /出力/);
  changed.CannyEdgePreprocessor.output = ["IMAGE"];
  changed.CannyEdgePreprocessor.input.required.mask = ["MASK"];
  assert.throws(() => buildImageTool("canny", changed, "in.png"), /mask/);
});
