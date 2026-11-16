import { inputChoices } from "./graph.mjs";
const aux = "https://github.com/Fannovel16/comfyui_controlnet_aux";
const kj = "https://github.com/kijai/ComfyUI-KJNodes";
export const imageTools = [
  {
    id: "canny",
    label: "輪郭抽出",
    type: "CannyEdgePreprocessor",
    pack: "ControlNet Aux",
    url: aux,
  },
  {
    id: "lineart",
    label: "線画抽出",
    type: "LineartStandardPreprocessor",
    pack: "ControlNet Aux",
    url: aux,
  },
  {
    id: "depth",
    label: "深度抽出",
    type: "DepthAnythingV2Preprocessor",
    pack: "ControlNet Aux",
    url: aux,
    download: true,
    defaults: { ckpt_name: "depth_anything_v2_vits.pth" },
  },
  {
    id: "pose",
    label: "ポーズ抽出",
    type: "DWPreprocessor",
    pack: "ControlNet Aux",
    url: aux,
    download: true,
  },
  {
    id: "resize",
    label: "画像サイズ変更",
    type: "ImageResizeKJv2",
    pack: "KJNodes",
    url: kj,
    defaults: { upscale_method: "lanczos", keep_proportion: "resize" },
  },
  {
    id: "pad",
    label: "余白追加",
    type: "ImagePadForOutpaintMasked",
    pack: "KJNodes",
    url: kj,
  },
  {
    id: "mask",
    label: "マスク拡張・ぼかし",
    type: "GrowMaskWithBlur",
    pack: "KJNodes",
    url: kj,
    mask: true,
  },
];
export const labels = {
  resolution: "処理解像度",
  low_threshold: "輪郭・下限",
  high_threshold: "輪郭・上限",
  guassian_sigma: "線のなめらかさ",
  intensity_threshold: "線のしきい値",
  ckpt_name: "モデル",
  width: "幅",
  height: "高さ",
  upscale_method: "補間方法",
  keep_proportion: "縦横比の扱い",
  pad_color: "余白の色",
  crop_position: "切り抜き位置",
  divisible_by: "寸法の倍数",
  device: "処理装置",
  left: "左の余白",
  right: "右の余白",
  top: "上の余白",
  bottom: "下の余白",
  feathering: "境界ぼかし",
  expand: "拡張量",
  blur_radius: "ぼかし半径",
  incremental_expandrate: "連続画像の増分",
  tapered_corners: "角を丸める",
  flip_input: "マスク反転",
  lerp_alpha: "混合率",
  decay_factor: "減衰率",
  fill_holes: "穴を埋める",
  detect_hand: "手の検出",
  detect_body: "体の検出",
  detect_face: "顔の検出",
  bbox_detector: "人物検出モデル",
  pose_estimator: "ポーズモデル",
  scale_stick_for_xinsr_cn: "Xinsir用の線幅",
};
export function toolFields(id, info) {
  const tool = imageTools.find((t) => t.id === id);
  if (!tool || !info[tool.type]) throw Error("必要なノードが未導入です");
  if (info[tool.type].output?.[0] !== (tool.mask ? "MASK" : "IMAGE"))
    throw Error(
      "ノードの出力仕様が変わっています。ノード画面で確認してください",
    );
  const def = info[tool.type].input || {};
  return Object.entries({ ...def.required, ...def.optional }).flatMap(
    ([key, spec]) => {
      if (["IMAGE", "MASK"].includes(spec[0])) return [];
      const choices = inputChoices(info, tool.type, key),
        opt = spec[1] || {};
      if (
        !choices.length &&
        !["STRING", "INT", "FLOAT", "BOOLEAN"].includes(spec[0])
      ) {
        if (key in (def.required || {}))
          throw Error(`追加の接続が必要です: ${key}`);
        return [];
      }
      const preferred = tool.defaults?.[key] ?? opt.default;
      const value = choices.length
        ? choices.includes(preferred)
          ? preferred
          : choices[0]
        : (preferred ??
          (spec[0] === "BOOLEAN" ? false : spec[0] === "STRING" ? "" : 0));
      return [
        {
          key,
          label: labels[key] || key,
          type: spec[0],
          choices: choices.length ? choices : null,
          value,
          min: opt.min,
          max: opt.max,
          step: opt.step ?? (spec[0] === "INT" ? 1 : "any"),
        },
      ];
    },
  );
}
export function buildImageTool(id, info, image, values = {}, mask) {
  if (!image) throw Error("先に画像を読み込んでください");
  const fields = toolFields(id, info),
    tool = imageTools.find((t) => t.id === id),
    inputs = {};
  if (tool.mask && !mask) throw Error("先にブラシで範囲を塗ってください");
  for (const f of fields) {
    const v = values[f.key] ?? f.value;
    if (
      f.choices
        ? !f.choices.includes(v)
        : f.type === "STRING"
          ? typeof v !== "string"
          : f.type === "BOOLEAN"
            ? typeof v !== "boolean"
            : typeof v !== "number" ||
              !Number.isFinite(v) ||
              (f.type === "INT" && !Number.isInteger(v)) ||
              (f.min !== undefined && v < f.min) ||
              (f.max !== undefined && v > f.max)
    )
      throw Error(`設定値を確認してください: ${f.key}`);
    inputs[f.key] = v;
  }
  const sockets = {
    ...info[tool.type].input?.required,
    ...info[tool.type].input?.optional,
  };
  for (const [key, spec] of Object.entries(
    info[tool.type].input?.required || {},
  )) {
    if (spec[0] === "IMAGE" && key !== "image")
      throw Error(`追加の接続が必要です: ${key}`);
    if (spec[0] === "MASK" && (key !== "mask" || !tool.mask))
      throw Error(`追加の接続が必要です: ${key}`);
  }
  const g = {
    1: { class_type: "LoadImage", inputs: { image } },
    2: { class_type: tool.type, inputs },
  };
  if (sockets.image) inputs.image = ["1", 0];
  if (tool.mask) {
    g["4"] = { class_type: "LoadImage", inputs: { image: mask } };
    inputs.mask = ["4", 1];
    g["5"] = { class_type: "MaskToImage", inputs: { mask: ["2", 0] } };
  }
  g["3"] = {
    class_type: "SaveImage",
    inputs: {
      images: tool.mask ? ["5", 0] : ["2", 0],
      filename_prefix: `orime_${id}`,
    },
  };
  return g;
}
const groups = [
  {
    id: "detail",
    label: "顔・部分補修",
    types: [
      "FaceDetailer",
      "FaceDetailerPipe",
      "DetailerForEach",
      "DetailerForEachPipe",
    ],
    inputs: [
      "guide_size",
      "max_size",
      "seed",
      "steps",
      "cfg",
      "denoise",
      "feather",
      "bbox_threshold",
      "bbox_dilation",
      "bbox_crop_factor",
      "cycle",
      "wildcard",
    ],
  },
  {
    id: "reference",
    label: "参照画像",
    types: [
      "IPAdapter",
      "IPAdapterAdvanced",
      "IPAdapterStyleComposition",
      "IPAdapterTiled",
    ],
    inputs: [
      "weight",
      "weight_type",
      "start_at",
      "end_at",
      "embeds_scaling",
      "combine_embeds",
      "weight_style",
      "weight_composition",
    ],
  },
  {
    id: "upscale",
    label: "高解像度化",
    types: [
      "UltimateSDUpscale",
      "UltimateSDUpscaleNoUpscale",
      "UltimateSDUpscaleCustomSample",
    ],
    inputs: [
      "upscale_by",
      "seed",
      "steps",
      "cfg",
      "denoise",
      "tile_width",
      "tile_height",
      "tile_padding",
      "mask_blur",
      "seam_fix_mode",
      "seam_fix_denoise",
    ],
  },
  {
    id: "control",
    label: "ControlNet",
    types: [
      "ControlNetApplyAdvanced",
      "ACN_AdvancedControlNetApply",
      "ControlNetApply",
    ],
    inputs: ["strength", "start_percent", "end_percent"],
  },
  {
    id: "image",
    label: "画像・マスク処理",
    types: imageTools.map((t) => t.type),
    inputs: null,
  },
  {
    id: "lora",
    label: "LoRA",
    types: ["LoraLoader", "LoraLoaderModelOnly", "LoraLoaderStack (rgthree)"],
    inputs: null,
  },
];
export function controlGroups(controls) {
  return groups
    .map((g) => ({
      ...g,
      keys: controls
        .filter(
          (c) =>
            g.types.includes(c.type) &&
            (!g.inputs || g.inputs.includes(c.input)),
        )
        .map((c) => c.key),
    }))
    .filter((g) => g.keys.length);
}
export function matchingControls(controls, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return controls.filter((c) =>
    words.every((w) =>
      `${c.label} ${c.type} ${c.input} ${labels[c.input] || ""}`
        .toLowerCase()
        .includes(w),
    ),
  );
}
