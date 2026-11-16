import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRecipe,
  recipeCapabilities,
  requiredNodes,
  getRequiredNodes,
} from "../adapters/recipes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = path.resolve(__dirname, "../adapters/recipes.mjs");

const ALL_FAMILY_KEYS = [
  "sdxl",
  "anima",
  "anima-base-v1",
  "anima-base",
  "anima-base-v1.0",
  "anima-preview",
  "anima-preview3",
  "minimax-h3",
  "minimax-h3-image",
  "moss",
  "moss-image",
  "moss-base",
  "moss-image-base",
];

function findNodesByClass(prompt, classType) {
  return Object.entries(prompt)
    .filter(([, node]) => node.class_type === classType)
    .map(([id, node]) => ({ id, ...node }));
}

function findSingleNode(prompt, classType) {
  const matches = findNodesByClass(prompt, classType);
  assert.equal(
    matches.length,
    1,
    `Expected exactly 1 ${classType} node, found ${matches.length}`,
  );
  return matches[0];
}

function assertValidPromptGraph(prompt, family, settings = {}) {
  assert.equal(typeof prompt, "object");
  assert.notEqual(prompt, null);
  assert.ok(!Array.isArray(prompt));

  const nodeIds = new Set(Object.keys(prompt));
  assert.ok(nodeIds.size > 0, "Prompt graph must not be empty");

  const expectedFamilyNodes = new Set(requiredNodes[family]);
  const usedClasses = new Set();

  for (const [id, node] of Object.entries(prompt)) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
    assert.equal(typeof node.class_type, "string");
    assert.ok(node.class_type.length > 0);
    assert.equal(typeof node.inputs, "object");
    assert.notEqual(node.inputs, null);

    usedClasses.add(node.class_type);
    assert.ok(
      expectedFamilyNodes.has(node.class_type),
      `Node class_type ${node.class_type} missing from requiredNodes[${family}]`,
    );

    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) {
        assert.equal(
          value.length,
          2,
          `Link ${id}.${inputName} must be [nodeId, slotIndex]`,
        );
        const [targetId, slot] = value;
        assert.equal(typeof targetId, "string");
        assert.ok(
          nodeIds.has(targetId),
          `Dangling node reference ${id}.${inputName} -> ${targetId}`,
        );
        assert.ok(
          Number.isInteger(slot) && slot >= 0,
          `Invalid output slot index on ${id}.${inputName}: ${slot}`,
        );
      }
    }
  }

  const exactNodes = getRequiredNodes(family, settings);
  assert.deepEqual(new Set(exactNodes), usedClasses);
  for (const cls of exactNodes) {
    assert.ok(
      expectedFamilyNodes.has(cls),
      `getRequiredNodes returned ${cls} not present in requiredNodes[${family}]`,
    );
  }
}

test("module exports expected API and stays dependency-free browser-compatible ESM", async () => {
  assert.equal(typeof buildRecipe, "function");
  assert.equal(typeof getRequiredNodes, "function");
  assert.equal(typeof recipeCapabilities, "object");
  assert.equal(typeof requiredNodes, "object");

  const source = await fs.readFile(RECIPES_PATH, "utf8");
  const forbiddenPatterns = [
    /node:/,
    /\brequire\s*\(/,
    /\bprocess\./,
    /\bBuffer\./,
    /\b__dirname\b/,
    /\b__filename\b/,
    /from\s+['"](fs|path|os|child_process|crypto)['"]/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.equal(
      pattern.test(source),
      false,
      `Forbidden Node-only API pattern matched: ${pattern}`,
    );
  }
});

test("recipeCapabilities and requiredNodes expose consistent entries for all families and aliases", () => {
  for (const key of ALL_FAMILY_KEYS) {
    assert.ok(
      Object.hasOwn(recipeCapabilities, key),
      `Missing recipeCapabilities entry for ${key}`,
    );
    assert.ok(
      Object.hasOwn(requiredNodes, key),
      `Missing requiredNodes entry for ${key}`,
    );
    assert.ok(Array.isArray(requiredNodes[key]));
    assert.ok(requiredNodes[key].length > 0);
    assert.equal(
      new Set(requiredNodes[key]).size,
      requiredNodes[key].length,
      `Duplicate node entries in requiredNodes[${key}]`,
    );
  }

  assert.deepEqual(recipeCapabilities.sdxl.modes, {
    t2i: true,
    img2img: true,
    edit: false,
    inpaint: true,
  });
  assert.equal(recipeCapabilities.sdxl.supportsNegativePrompt, true);
  assert.equal(recipeCapabilities.sdxl.supportsMask, true);

  assert.deepEqual(recipeCapabilities.anima.modes, {
    t2i: true,
    img2img: false,
    edit: false,
    inpaint: true,
  });
  assert.equal(recipeCapabilities.anima.supportsNegativePrompt, true);
  assert.equal(recipeCapabilities.anima.supportsMask, true);
  assert.equal(recipeCapabilities.anima, recipeCapabilities["anima-base-v1"]);

  assert.deepEqual(recipeCapabilities["anima-preview"].modes, {
    t2i: true,
    img2img: false,
    edit: false,
    inpaint: false,
  });
  assert.equal(recipeCapabilities["anima-preview"].supportsImageInput, false);
  assert.equal(recipeCapabilities["anima-preview"].supportsMask, false);
  assert.equal(
    recipeCapabilities["anima-preview"].requiredNodes ?? undefined,
    undefined,
  );
  assert.equal(
    requiredNodes["anima-preview"].includes("AnimaLLLiteApply"),
    false,
  );

  assert.deepEqual(recipeCapabilities["minimax-h3"].modes, {
    t2i: true,
    img2img: false,
    edit: true,
    inpaint: false,
  });
  assert.equal(recipeCapabilities["minimax-h3"].supportsNegativePrompt, false);
  assert.equal(recipeCapabilities["minimax-h3"].supportsMask, false);
  assert.equal(
    recipeCapabilities["minimax-h3"],
    recipeCapabilities["minimax-h3-image"],
  );

  assert.deepEqual(recipeCapabilities.moss.modes, {
    t2i: true,
    img2img: false,
    edit: true,
    inpaint: false,
  });
  assert.equal(recipeCapabilities.moss.supportsNegativePrompt, true);
  assert.equal(recipeCapabilities.moss.supportsMask, false);
  assert.equal(recipeCapabilities.moss, recipeCapabilities["moss-image"]);
  assert.equal(
    recipeCapabilities["moss-base"],
    recipeCapabilities["moss-image-base"],
  );
});

test("SDXL baseline t2i builds official CheckpointLoaderSimple graph and preserves custom filenames", () => {
  const inputSettings = { prompt: "alpine lake at dawn" };
  const prompt = buildRecipe("sdxl", inputSettings);
  assert.deepEqual(inputSettings, { prompt: "alpine lake at dawn" });
  assertValidPromptGraph(prompt, "sdxl", inputSettings);

  const ckpt = findSingleNode(prompt, "CheckpointLoaderSimple");
  assert.equal(ckpt.inputs.ckpt_name, "sd_xl_base_1.0.safetensors");

  const encodes = findNodesByClass(prompt, "CLIPTextEncode");
  assert.equal(encodes.length, 2);

  const latent = findSingleNode(prompt, "EmptyLatentImage");
  assert.deepEqual(latent.inputs, { width: 1024, height: 1024, batch_size: 1 });

  const sampler = findSingleNode(prompt, "KSampler");
  assert.deepEqual(sampler.inputs.model, [ckpt.id, 0]);
  assert.deepEqual(sampler.inputs.latent_image, [latent.id, 0]);
  assert.equal(sampler.inputs.steps, 25);
  assert.equal(sampler.inputs.cfg, 7);
  assert.equal(sampler.inputs.sampler_name, "dpmpp_2m");
  assert.equal(sampler.inputs.scheduler, "karras");
  assert.equal(sampler.inputs.denoise, 1);

  const positive = prompt[sampler.inputs.positive[0]];
  const negative = prompt[sampler.inputs.negative[0]];
  assert.equal(positive.class_type, "CLIPTextEncode");
  assert.equal(negative.class_type, "CLIPTextEncode");
  assert.equal(positive.inputs.text, "alpine lake at dawn");
  assert.equal(negative.inputs.text, "");
  assert.deepEqual(positive.inputs.clip, [ckpt.id, 1]);
  assert.deepEqual(negative.inputs.clip, [ckpt.id, 1]);

  const decode = findSingleNode(prompt, "VAEDecode");
  assert.deepEqual(decode.inputs.samples, [sampler.id, 0]);
  assert.deepEqual(decode.inputs.vae, [ckpt.id, 2]);

  const save = findSingleNode(prompt, "SaveImage");
  assert.deepEqual(save.inputs.images, [decode.id, 0]);

  const customSettings = {
    prompt: "cyberpunk street",
    negative: "blurry, lowres",
    width: 1216,
    height: 832,
    seed: 123456,
    steps: 32,
    cfg: 5.5,
    checkpoint: "custom/juggernautXL.safetensors",
    vae: "sdxl_vae_fp16fix.safetensors",
    sampler: "euler",
    scheduler: "normal",
    denoise: 0.9,
  };
  const custom = buildRecipe(" SDXL ", customSettings);
  assertValidPromptGraph(custom, "sdxl", customSettings);

  const customCkpt = findSingleNode(custom, "CheckpointLoaderSimple");
  assert.equal(customCkpt.inputs.ckpt_name, "custom/juggernautXL.safetensors");
  const customVae = findSingleNode(custom, "VAELoader");
  assert.equal(customVae.inputs.vae_name, "sdxl_vae_fp16fix.safetensors");
  const customSampler = findSingleNode(custom, "KSampler");
  assert.equal(customSampler.inputs.seed, 123456);
  assert.equal(customSampler.inputs.steps, 32);
  assert.equal(customSampler.inputs.cfg, 5.5);
  assert.equal(customSampler.inputs.sampler_name, "euler");
  assert.equal(customSampler.inputs.scheduler, "normal");
  assert.equal(customSampler.inputs.denoise, 0.9);
  assert.deepEqual(findSingleNode(custom, "VAEDecode").inputs.vae, [
    customVae.id,
    0,
  ]);
});

test("SDXL img2img and mask inpaint wire LoadImage, VAEEncode, and SetLatentNoiseMask", () => {
  const img2imgSettings = {
    prompt: "oil painting style",
    negative: "photo",
    image: "input_photo.png",
  };
  const img2img = buildRecipe("sdxl", img2imgSettings);
  assertValidPromptGraph(img2img, "sdxl", img2imgSettings);
  assert.equal(findNodesByClass(img2img, "EmptyLatentImage").length, 0);
  assert.equal(findNodesByClass(img2img, "SetLatentNoiseMask").length, 0);

  const load = findSingleNode(img2img, "LoadImage");
  assert.equal(load.inputs.image, "input_photo.png");
  const ckpt = findSingleNode(img2img, "CheckpointLoaderSimple");
  const encode = findSingleNode(img2img, "VAEEncode");
  assert.deepEqual(encode.inputs.pixels, [load.id, 0]);
  assert.deepEqual(encode.inputs.vae, [ckpt.id, 2]);
  const sampler = findSingleNode(img2img, "KSampler");
  assert.deepEqual(sampler.inputs.latent_image, [encode.id, 0]);
  assert.equal(sampler.inputs.denoise, 0.75);

  const inpaintBoolSettings = {
    prompt: "red sunglasses",
    image: "portrait_rgba.png",
    mask: true,
    denoise: 0.85,
  };
  const inpaintBool = buildRecipe("sdxl", inpaintBoolSettings);
  assertValidPromptGraph(inpaintBool, "sdxl", inpaintBoolSettings);
  const boolLoad = findSingleNode(inpaintBool, "LoadImage");
  const boolEncode = findSingleNode(inpaintBool, "VAEEncode");
  const boolMask = findSingleNode(inpaintBool, "SetLatentNoiseMask");
  assert.deepEqual(boolMask.inputs.samples, [boolEncode.id, 0]);
  assert.deepEqual(boolMask.inputs.mask, [boolLoad.id, 1]);
  const boolSampler = findSingleNode(inpaintBool, "KSampler");
  assert.deepEqual(boolSampler.inputs.latent_image, [boolMask.id, 0]);
  assert.equal(boolSampler.inputs.denoise, 0.85);

  const inpaintFileSettings = {
    prompt: "blue hat",
    image: "base.png",
    mask: "mask_overlay.png",
    vae: "custom_vae.safetensors",
  };
  const inpaintFile = buildRecipe("sdxl", inpaintFileSettings);
  assertValidPromptGraph(inpaintFile, "sdxl", inpaintFileSettings);
  const loads = findNodesByClass(inpaintFile, "LoadImage");
  assert.equal(loads.length, 2);
  const baseLoad = loads.find((n) => n.inputs.image === "base.png");
  const maskLoad = loads.find((n) => n.inputs.image === "mask_overlay.png");
  assert.ok(baseLoad);
  assert.ok(maskLoad);
  const fileVae = findSingleNode(inpaintFile, "VAELoader");
  const fileEncode = findSingleNode(inpaintFile, "VAEEncode");
  assert.deepEqual(fileEncode.inputs.pixels, [baseLoad.id, 0]);
  assert.deepEqual(fileEncode.inputs.vae, [fileVae.id, 0]);
  const fileSetMask = findSingleNode(inpaintFile, "SetLatentNoiseMask");
  assert.deepEqual(fileSetMask.inputs.mask, [maskLoad.id, 1]);
});

test("Anima Base v1 and Preview variants build verified split-loader graphs with stable_diffusion CLIPLoader type", () => {
  for (const variant of [
    "anima",
    "anima-base-v1",
    "anima-base",
    "anima-base-v1.0",
  ]) {
    const prompt = buildRecipe(variant, { prompt: "anime girl in rain" });
    assertValidPromptGraph(prompt, variant, { prompt: "anime girl in rain" });

    const unet = findSingleNode(prompt, "UNETLoader");
    assert.deepEqual(unet.inputs, {
      unet_name: "anima-base-v1.0.safetensors",
      weight_dtype: "default",
    });

    const clip = findSingleNode(prompt, "CLIPLoader");
    assert.deepEqual(clip.inputs, {
      clip_name: "qwen_3_06b_base.safetensors",
      type: "stable_diffusion",
      device: "default",
    });

    const vae = findSingleNode(prompt, "VAELoader");
    assert.deepEqual(vae.inputs, {
      vae_name: "qwen_image_vae.safetensors",
    });

    const latent = findSingleNode(prompt, "EmptyLatentImage");
    assert.deepEqual(latent.inputs, {
      width: 1024,
      height: 1024,
      batch_size: 1,
    });

    const sampler = findSingleNode(prompt, "KSampler");
    assert.deepEqual(sampler.inputs.model, [unet.id, 0]);
    assert.equal(sampler.inputs.steps, 30);
    assert.equal(sampler.inputs.cfg, 4);
    assert.equal(sampler.inputs.sampler_name, "er_sde");
    assert.equal(sampler.inputs.scheduler, "simple");
    assert.equal(sampler.inputs.denoise, 1);

    const decode = findSingleNode(prompt, "VAEDecode");
    assert.deepEqual(decode.inputs.samples, [sampler.id, 0]);
    assert.deepEqual(decode.inputs.vae, [vae.id, 0]);
  }

  for (const previewVariant of ["anima-preview", "anima-preview3"]) {
    const prompt = buildRecipe(previewVariant, {
      prompt: "cyberpunk robotic eye",
    });
    assertValidPromptGraph(prompt, previewVariant, {
      prompt: "cyberpunk robotic eye",
    });
    const unet = findSingleNode(prompt, "UNETLoader");
    assert.equal(unet.inputs.unet_name, "anima-preview3-base.safetensors");
    const clip = findSingleNode(prompt, "CLIPLoader");
    assert.equal(clip.inputs.type, "stable_diffusion");
  }

  const ckptSettings = {
    prompt: "forest spirit",
    checkpoint: "Anima-3.8B-v1.1-int8-convrot.safetensors",
    seed: 77,
  };
  const ckptGraph = buildRecipe("anima", ckptSettings);
  assertValidPromptGraph(ckptGraph, "anima", ckptSettings);
  assert.equal(findNodesByClass(ckptGraph, "UNETLoader").length, 0);
  assert.equal(findNodesByClass(ckptGraph, "CLIPLoader").length, 0);
  assert.equal(findNodesByClass(ckptGraph, "VAELoader").length, 0);
  const ckptNode = findSingleNode(ckptGraph, "CheckpointLoaderSimple");
  assert.equal(
    ckptNode.inputs.ckpt_name,
    "Anima-3.8B-v1.1-int8-convrot.safetensors",
  );
  const ckptSampler = findSingleNode(ckptGraph, "KSampler");
  assert.deepEqual(ckptSampler.inputs.model, [ckptNode.id, 0]);
  assert.deepEqual(findSingleNode(ckptGraph, "VAEDecode").inputs.vae, [
    ckptNode.id,
    2,
  ]);
});

test("Anima Base v1 mask inpainting wires ModelPatchLoader and AnimaLLLiteApply", () => {
  const settings = {
    prompt: "girl with red eyes",
    negative: "worst quality, low quality",
    image: "spirit_girl.png",
    mask: true,
    modelPatch: "custom-lllite-inpaint.safetensors",
  };
  const prompt = buildRecipe("anima", settings);
  assertValidPromptGraph(prompt, "anima", settings);

  const unet = findSingleNode(prompt, "UNETLoader");
  const patch = findSingleNode(prompt, "ModelPatchLoader");
  assert.equal(patch.inputs.name, "custom-lllite-inpaint.safetensors");
  const load = findSingleNode(prompt, "LoadImage");
  assert.equal(load.inputs.image, "spirit_girl.png");

  const apply = findSingleNode(prompt, "AnimaLLLiteApply");
  assert.deepEqual(apply.inputs, {
    model: [unet.id, 0],
    model_patch: [patch.id, 0],
    image: [load.id, 0],
    mask: [load.id, 1],
    strength: 1,
    start_percent: 0,
    end_percent: 1,
  });

  const sampler = findSingleNode(prompt, "KSampler");
  assert.deepEqual(sampler.inputs.model, [apply.id, 0]);
  assert.equal(sampler.inputs.sampler_name, "euler");
  assert.equal(sampler.inputs.scheduler, "simple");
  assert.equal(sampler.inputs.steps, 30);
  assert.equal(sampler.inputs.cfg, 4);
  assert.equal(sampler.inputs.denoise, 1);

  const defaultPatchPrompt = buildRecipe("anima-base-v1", {
    prompt: "fix hands",
    image: "img.png",
    mask: "mask.png",
  });
  assertValidPromptGraph(defaultPatchPrompt, "anima-base-v1", {
    prompt: "fix hands",
    image: "img.png",
    mask: "mask.png",
  });
  assert.equal(
    findSingleNode(defaultPatchPrompt, "ModelPatchLoader").inputs.name,
    "anima-lllite-inpainting-v2.safetensors",
  );
  const apply2 = findSingleNode(defaultPatchPrompt, "AnimaLLLiteApply");
  const maskLoad = findNodesByClass(defaultPatchPrompt, "LoadImage").find(
    (n) => n.inputs.image === "mask.png",
  );
  assert.ok(maskLoad);
  assert.deepEqual(apply2.inputs.mask, [maskLoad.id, 1]);
});

test("MiniMax-H3-Image builds verified MiniMaxH3ImageConditioning + ConditioningZeroOut graphs for t2i and edit", () => {
  for (const key of ["minimax-h3", "minimax-h3-image"]) {
    const t2i = buildRecipe(key, { prompt: "plush fox above summer meadow" });
    assertValidPromptGraph(t2i, key, {
      prompt: "plush fox above summer meadow",
    });

    const unet = findSingleNode(t2i, "UNETLoader");
    assert.equal(
      unet.inputs.unet_name,
      "minimax_h3_image_pruned_int8_convrot.safetensors",
    );
    const clip = findSingleNode(t2i, "CLIPLoader");
    assert.deepEqual(clip.inputs, {
      clip_name: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
      type: "minimax",
      device: "default",
    });
    const vae = findSingleNode(t2i, "VAELoader");
    assert.equal(vae.inputs.vae_name, "minimax_h3_image_vae_fp16.safetensors");

    const cond = findSingleNode(t2i, "MiniMaxH3ImageConditioning");
    assert.deepEqual(cond.inputs, {
      clip: [clip.id, 0],
      vae: [vae.id, 0],
      prompt: "plush fox above summer meadow",
      width: 2048,
      height: 2048,
    });

    const zero = findSingleNode(t2i, "ConditioningZeroOut");
    assert.deepEqual(zero.inputs, { conditioning: [cond.id, 0] });

    const sampler = findSingleNode(t2i, "KSampler");
    assert.deepEqual(sampler.inputs.model, [unet.id, 0]);
    assert.deepEqual(sampler.inputs.positive, [cond.id, 0]);
    assert.deepEqual(sampler.inputs.negative, [zero.id, 0]);
    assert.deepEqual(sampler.inputs.latent_image, [cond.id, 1]);
    assert.equal(sampler.inputs.steps, 6);
    assert.equal(sampler.inputs.cfg, 1);
    assert.equal(sampler.inputs.sampler_name, "euler");
    assert.equal(sampler.inputs.scheduler, "simple");
    assert.equal(sampler.inputs.denoise, 1);
  }

  const editSettings = {
    prompt:
      "Replace the taxi in <Picture 1> with a pastel pink ice-cream truck",
    image: "vintage_yellow_taxi.png",
    unet: "custom_h3.safetensors",
    clip: "custom_h3_vl.safetensors",
    vae: "custom_h3_vae.safetensors",
    seed: 42,
  };
  const edit = buildRecipe("minimax-h3-image", editSettings);
  assertValidPromptGraph(edit, "minimax-h3-image", editSettings);

  const load = findSingleNode(edit, "LoadImage");
  assert.equal(load.inputs.image, "vintage_yellow_taxi.png");
  const cond = findSingleNode(edit, "MiniMaxH3ImageConditioning");
  assert.deepEqual(cond.inputs["images.image_1"], [load.id, 0]);
  assert.equal(cond.inputs.width, 0);
  assert.equal(cond.inputs.height, 0);
  assert.equal(
    findSingleNode(edit, "UNETLoader").inputs.unet_name,
    "custom_h3.safetensors",
  );
  assert.equal(
    findSingleNode(edit, "CLIPLoader").inputs.clip_name,
    "custom_h3_vl.safetensors",
  );
  assert.equal(
    findSingleNode(edit, "VAELoader").inputs.vae_name,
    "custom_h3_vae.safetensors",
  );
});

test("MOSS-Image builds verified t2i and edit graphs with EmptyFlux2LatentImage and TextEncodeMOSSImageEdit", () => {
  for (const key of ["moss", "moss-image"]) {
    const t2i = buildRecipe(key, { prompt: "editorial studio photograph" });
    assertValidPromptGraph(t2i, key, { prompt: "editorial studio photograph" });

    const unet = findSingleNode(t2i, "UNETLoader");
    assert.equal(
      unet.inputs.unet_name,
      "moss_image_sft_int8_convrot.safetensors",
    );
    const clip = findSingleNode(t2i, "CLIPLoader");
    assert.deepEqual(clip.inputs, {
      clip_name: "qwen3.5_9b_w4a8_gptq.safetensors",
      type: "moss_image",
      device: "default",
    });
    const vae = findSingleNode(t2i, "VAELoader");
    assert.equal(vae.inputs.vae_name, "flux2-vae_small.safetensors");
    const latent = findSingleNode(t2i, "EmptyFlux2LatentImage");
    assert.deepEqual(latent.inputs, {
      width: 1024,
      height: 1024,
      batch_size: 1,
    });
    const sampler = findSingleNode(t2i, "KSampler");
    assert.deepEqual(sampler.inputs.model, [unet.id, 0]);
    assert.equal(sampler.inputs.steps, 25);
    assert.equal(sampler.inputs.cfg, 2.5);
    assert.equal(sampler.inputs.sampler_name, "er_sde");
    assert.equal(sampler.inputs.scheduler, "simple");
    assert.equal(sampler.inputs.denoise, 1);
  }

  const baseT2i = buildRecipe("moss-base", { prompt: "poster typography" });
  assertValidPromptGraph(baseT2i, "moss-base", { prompt: "poster typography" });
  assert.equal(
    findSingleNode(baseT2i, "UNETLoader").inputs.unet_name,
    "moss_image_base_int8_convrot.safetensors",
  );

  const editAutoSettings = {
    prompt: "Change only the pink floral blazer to a plain black wool coat.",
    negative: "nsfw, worst quality",
    image: "two_women.png",
  };
  const editAuto = buildRecipe("moss", editAutoSettings);
  assertValidPromptGraph(editAuto, "moss", editAutoSettings);

  const unet = findSingleNode(editAuto, "UNETLoader");
  const lora = findSingleNode(editAuto, "LoraLoaderModelOnly");
  assert.deepEqual(lora.inputs, {
    model: [unet.id, 0],
    lora_name: "moss_image_edit_lora_rank_64_bf16.safetensors",
    strength_model: 1,
  });
  const slg = findSingleNode(editAuto, "SkipLayerGuidanceDiTSimple");
  assert.deepEqual(slg.inputs, {
    model: [lora.id, 0],
    double_layers: "",
    single_layers: "22",
    start_percent: 0,
    end_percent: 1,
  });
  const load = findSingleNode(editAuto, "LoadImage");
  assert.equal(load.inputs.image, "two_women.png");
  const scale = findSingleNode(editAuto, "ImageScaleToTotalPixels");
  assert.deepEqual(scale.inputs, {
    image: [load.id, 0],
    upscale_method: "lanczos",
    megapixels: 1,
    resolution_steps: 16,
  });
  const getSize = findSingleNode(editAuto, "GetImageSize");
  assert.deepEqual(getSize.inputs, { image: [scale.id, 0] });
  const editLatent = findSingleNode(editAuto, "EmptyFlux2LatentImage");
  assert.deepEqual(editLatent.inputs, {
    width: [getSize.id, 0],
    height: [getSize.id, 1],
    batch_size: 1,
  });

  const encodes = findNodesByClass(editAuto, "TextEncodeMOSSImageEdit");
  assert.equal(encodes.length, 2);
  const clip = findSingleNode(editAuto, "CLIPLoader");
  const vae = findSingleNode(editAuto, "VAELoader");
  const sampler = findSingleNode(editAuto, "KSampler");
  assert.deepEqual(sampler.inputs.model, [slg.id, 0]);
  assert.equal(sampler.inputs.steps, 30);
  assert.equal(sampler.inputs.cfg, 4);
  assert.equal(sampler.inputs.sampler_name, "euler");
  assert.equal(sampler.inputs.scheduler, "normal");

  const posNode = editAuto[sampler.inputs.positive[0]];
  const negNode = editAuto[sampler.inputs.negative[0]];
  assert.equal(posNode.class_type, "TextEncodeMOSSImageEdit");
  assert.equal(negNode.class_type, "TextEncodeMOSSImageEdit");
  assert.equal(posNode.inputs.prompt, editAutoSettings.prompt);
  assert.equal(negNode.inputs.prompt, editAutoSettings.negative);
  assert.equal(posNode.inputs.edit_format, "Moss-Image-Edit");
  assert.equal(negNode.inputs.edit_format, "Moss-Image-Edit");
  assert.equal(posNode.inputs.image_strength, 1);
  assert.deepEqual(posNode.inputs["images.image_0"], [scale.id, 0]);
  assert.deepEqual(posNode.inputs.clip, [clip.id, 0]);
  assert.deepEqual(posNode.inputs.vae, [vae.id, 0]);

  const editExplicit = buildRecipe("moss-image", {
    prompt: "make jacket blue",
    image: "two_women.png",
    width: 1280,
    height: 768,
    lora: "custom_moss_edit_lora.safetensors",
  });
  assertValidPromptGraph(editExplicit, "moss-image", {
    prompt: "make jacket blue",
    image: "two_women.png",
    width: 1280,
    height: 768,
    lora: "custom_moss_edit_lora.safetensors",
  });
  assert.equal(findNodesByClass(editExplicit, "GetImageSize").length, 0);
  assert.deepEqual(
    findSingleNode(editExplicit, "EmptyFlux2LatentImage").inputs,
    {
      width: 1280,
      height: 768,
      batch_size: 1,
    },
  );
  assert.equal(
    findSingleNode(editExplicit, "LoraLoaderModelOnly").inputs.lora_name,
    "custom_moss_edit_lora.safetensors",
  );
});

test("explicit errors on unsupported features, masks, unknown families, and invalid settings", () => {
  // Unknown / invalid family
  assert.throws(() => buildRecipe(""), /family/i);
  assert.throws(() => buildRecipe("flux"), /family/i);
  assert.throws(() => buildRecipe(null), /family/i);
  assert.throws(() => getRequiredNodes("unknown"), /family/i);

  // Invalid settings container
  assert.throws(() => buildRecipe("sdxl", null), /settings/i);
  assert.throws(() => buildRecipe("sdxl", []), /settings/i);

  // Unsupported image editing / mask controls
  assert.throws(
    () => buildRecipe("anima-preview", { prompt: "x", image: "ref.png" }),
    /t2i|preview|edit|not supported/i,
  );
  assert.throws(
    () =>
      buildRecipe("anima-preview", {
        prompt: "x",
        image: "ref.png",
        mask: true,
      }),
    /preview|mask|not supported/i,
  );
  assert.throws(
    () => buildRecipe("anima", { prompt: "x", image: "ref.png" }),
    /mask|unmasked|edit|not supported/i,
  );
  assert.throws(
    () =>
      buildRecipe("anima-base-v1", {
        prompt: "x",
        image: "ref.png",
        mask: false,
      }),
    /mask|unmasked|edit|not supported/i,
  );
  assert.throws(
    () =>
      buildRecipe("minimax-h3", { prompt: "x", image: "ref.png", mask: true }),
    /mask/i,
  );
  assert.throws(
    () =>
      buildRecipe("minimax-h3-image", {
        prompt: "x",
        image: "ref.png",
        mask: "mask.png",
      }),
    /mask/i,
  );
  assert.throws(
    () => buildRecipe("moss", { prompt: "x", image: "ref.png", mask: true }),
    /mask/i,
  );
  assert.throws(
    () =>
      buildRecipe("moss-image", {
        prompt: "x",
        image: "ref.png",
        mask: "mask.png",
      }),
    /mask/i,
  );

  // Mask without image
  assert.throws(
    () => buildRecipe("sdxl", { prompt: "x", mask: true }),
    /image/i,
  );
  assert.throws(
    () => buildRecipe("anima", { prompt: "x", mask: true }),
    /image/i,
  );
  assert.throws(
    () => buildRecipe("minimax-h3", { prompt: "x", mask: true }),
    /mask/i,
  );
  assert.throws(
    () => buildRecipe("moss", { prompt: "x", mask: true }),
    /mask/i,
  );

  // Dimension step & bounds validation
  assert.throws(
    () => buildRecipe("sdxl", { width: 1004, height: 1024 }),
    /multiple of 8/i,
  );
  assert.throws(
    () => buildRecipe("anima", { width: 1024, height: 1004 }),
    /multiple of 8/i,
  );
  assert.throws(
    () => buildRecipe("moss", { width: 1000, height: 1024 }),
    /multiple of 16/i,
  );
  assert.throws(
    () => buildRecipe("minimax-h3", { width: 1000, height: 2048 }),
    /multiple of 32/i,
  );
  assert.throws(
    () => buildRecipe("minimax-h3", { width: 0, height: 2048 }),
    /width|positive|32/i,
  );
  assert.throws(
    () => buildRecipe("sdxl", { width: 16400, height: 1024 }),
    /width|16384/i,
  );

  // Conflicting or unsupported model loader overrides
  assert.throws(
    () => buildRecipe("sdxl", { unet: "foo.safetensors" }),
    /checkpoint|unet/i,
  );
  assert.throws(
    () => buildRecipe("sdxl", { clip: "foo.safetensors" }),
    /checkpoint|clip/i,
  );
  assert.throws(
    () => buildRecipe("minimax-h3", { checkpoint: "ckpt.safetensors" }),
    /checkpoint/i,
  );
  assert.throws(
    () => buildRecipe("moss", { checkpoint: "ckpt.safetensors" }),
    /checkpoint/i,
  );
  assert.throws(
    () =>
      buildRecipe("anima", {
        checkpoint: "a.safetensors",
        unet: "b.safetensors",
      }),
    /checkpoint|unet/i,
  );

  // Invalid numeric/string parameters
  assert.throws(() => buildRecipe("sdxl", { prompt: 42 }), /prompt/i);
  assert.throws(() => buildRecipe("sdxl", { negative: 42 }), /negative/i);
  assert.throws(() => buildRecipe("sdxl", { steps: 0 }), /steps/i);
  assert.throws(() => buildRecipe("sdxl", { steps: 2.5 }), /steps/i);
  assert.throws(() => buildRecipe("sdxl", { cfg: -1 }), /cfg/i);
  assert.throws(() => buildRecipe("sdxl", { denoise: 1.5 }), /denoise/i);
  assert.throws(() => buildRecipe("sdxl", { seed: -1 }), /seed/i);
  assert.throws(() => buildRecipe("sdxl", { seed: 1.25 }), /seed/i);
});
