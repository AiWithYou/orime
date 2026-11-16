/**
 * Pure ComfyUI API prompt recipe builders for Orime.
 * Dependency-free, browser-compatible ES module derived from official ComfyUI nodes and templates.
 */

const MAX_RESOLUTION = 16384;
const MAX_STEPS = 10000;
const MAX_CFG = 100;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim() === '' ? undefined : value;
}

function readPromptString(value, fieldName) {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function readInteger(value, fieldName, { min, max, defaultValue }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readNumber(value, fieldName, { min, max, defaultValue }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function readDimension(value, fieldName, step, { allowZero = false, defaultValue }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer multiple of ${step}`);
  }
  if (value === 0) {
    if (allowZero) return 0;
    throw new Error(`${fieldName} must be a positive multiple of ${step}`);
  }
  if (value < 0) {
    throw new Error(`${fieldName} must be a positive multiple of ${step}`);
  }
  if (value > MAX_RESOLUTION) {
    throw new Error(`${fieldName} must be <= ${MAX_RESOLUTION}`);
  }
  if (value % step !== 0) {
    throw new Error(`${fieldName} must be a multiple of ${step}`);
  }
  return value;
}

function readMaskSetting(value) {
  if (value === undefined || value === false || value === null || value === '') {
    return { active: false, file: undefined };
  }
  if (value === true) {
    return { active: true, file: undefined };
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return { active: true, file: value };
  }
  throw new Error('mask must be a boolean or a non-empty filename string');
}

function createGraph() {
  let nextId = 1;
  const prompt = {};
  return {
    prompt,
    add(classType, inputs) {
      const id = String(nextId++);
      prompt[id] = { class_type: classType, inputs };
      return id;
    },
  };
}

function addTextEncodePair(graph, classType, clipRef, positiveText, negativeText, extraInputs = {}) {
  const posId = graph.add(classType, { clip: clipRef, text: positiveText, ...extraInputs });
  const negId = graph.add(classType, { clip: clipRef, text: negativeText, ...extraInputs });
  return [posId, negId];
}

function addSampleDecodeSave(graph, {
  modelRef,
  positiveRef,
  negativeRef,
  latentRef,
  vaeRef,
  samplerParams,
  filenamePrefix,
}) {
  const samplerId = graph.add('KSampler', {
    model: modelRef,
    seed: samplerParams.seed,
    steps: samplerParams.steps,
    cfg: samplerParams.cfg,
    sampler_name: samplerParams.sampler_name,
    scheduler: samplerParams.scheduler,
    positive: positiveRef,
    negative: negativeRef,
    latent_image: latentRef,
    denoise: samplerParams.denoise,
  });
  const decodeId = graph.add('VAEDecode', {
    samples: [samplerId, 0],
    vae: vaeRef,
  });
  graph.add('SaveImage', {
    images: [decodeId, 0],
    filename_prefix: filenamePrefix,
  });
}

function resolveSamplerParams(settings, defaults, overrides = {}) {
  const customSampler =
    readOptionalString(settings.sampler_name, 'sampler_name') ??
    readOptionalString(settings.sampler, 'sampler');
  const customScheduler = readOptionalString(settings.scheduler, 'scheduler');

  return {
    seed: readInteger(settings.seed, 'seed', { min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 }),
    steps: readInteger(settings.steps, 'steps', {
      min: 1,
      max: MAX_STEPS,
      defaultValue: overrides.steps ?? defaults.steps,
    }),
    cfg: readNumber(settings.cfg, 'cfg', {
      min: 0,
      max: MAX_CFG,
      defaultValue: overrides.cfg ?? defaults.cfg,
    }),
    sampler_name: customSampler ?? overrides.sampler_name ?? defaults.sampler_name,
    scheduler: customScheduler ?? overrides.scheduler ?? defaults.scheduler,
    denoise: readNumber(settings.denoise, 'denoise', {
      min: 0,
      max: 1,
      defaultValue: overrides.denoise ?? defaults.denoise,
    }),
  };
}

function addSplitLoaders(graph, { unetName, clipName, clipType, vaeName }) {
  const unetId = graph.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' });
  const clipId = graph.add('CLIPLoader', { clip_name: clipName, type: clipType, device: 'default' });
  const vaeId = graph.add('VAELoader', { vae_name: vaeName });
  return { modelRef: [unetId, 0], clipRef: [clipId, 0], vaeRef: [vaeId, 0] };
}

function addImageAndOptionalMask(graph, image, mask) {
  const imageLoadId = graph.add('LoadImage', { image });
  const imageRef = [imageLoadId, 0];
  let maskRef = [imageLoadId, 1];
  if (mask.file !== undefined) {
    const maskLoadId = graph.add('LoadImage', { image: mask.file });
    maskRef = [maskLoadId, 1];
  }
  return { imageRef, maskRef };
}

function buildSdxlPrompt(spec, parsed) {
  const { checkpoint, unet, clip, vae, image, mask, promptText, negativeText, raw } = parsed;
  if (unet !== undefined || clip !== undefined) {
    throw new Error('sdxl uses checkpoint (+ optional vae); unet and clip overrides are not supported');
  }

  const graph = createGraph();
  const ckptId = graph.add('CheckpointLoaderSimple', {
    ckpt_name: checkpoint ?? spec.capabilities.defaults.checkpoint,
  });
  const vaeRef = vae !== undefined ? [graph.add('VAELoader', { vae_name: vae }), 0] : [ckptId, 2];

  const [posId, negId] = addTextEncodePair(graph, 'CLIPTextEncode', [ckptId, 1], promptText, negativeText);

  let latentRef;
  if (image !== undefined) {
    const { imageRef, maskRef } = addImageAndOptionalMask(graph, image, mask);
    const encodeId = graph.add('VAEEncode', { pixels: imageRef, vae: vaeRef });
    if (mask.active) {
      const setMaskId = graph.add('SetLatentNoiseMask', { samples: [encodeId, 0], mask: maskRef });
      latentRef = [setMaskId, 0];
    } else {
      latentRef = [encodeId, 0];
    }
  } else {
    const width = readDimension(raw.width, 'width', 8, { defaultValue: 1024 });
    const height = readDimension(raw.height, 'height', 8, { defaultValue: 1024 });
    latentRef = [graph.add('EmptyLatentImage', { width, height, batch_size: 1 }), 0];
  }

  addSampleDecodeSave(graph, {
    modelRef: [ckptId, 0],
    positiveRef: [posId, 0],
    negativeRef: [negId, 0],
    latentRef,
    vaeRef,
    samplerParams: resolveSamplerParams(raw, spec.capabilities.defaults, {
      denoise: image !== undefined ? 0.75 : 1,
    }),
    filenamePrefix: 'orime_sdxl',
  });
  return graph.prompt;
}

function buildAnimaPrompt(spec, parsed) {
  const { checkpoint, unet, clip, vae, modelPatch, image, mask, promptText, negativeText, raw } = parsed;
  const isPreview = spec.capabilities.canonical === 'anima-preview';

  if (checkpoint !== undefined && (unet !== undefined || clip !== undefined)) {
    throw new Error('anima cannot combine checkpoint with unet or clip');
  }
  if (!isPreview && image !== undefined && !mask.active) {
    throw new Error('anima-base-v1 requires mask inpainting when image is provided; unmasked img2img/edit is not supported');
  }

  const width = readDimension(raw.width, 'width', 8, { defaultValue: 1024 });
  const height = readDimension(raw.height, 'height', 8, { defaultValue: 1024 });
  const defaults = spec.capabilities.defaults;

  const graph = createGraph();
  let modelRef;
  let clipRef;
  let vaeRef;

  if (checkpoint !== undefined) {
    const ckptId = graph.add('CheckpointLoaderSimple', { ckpt_name: checkpoint });
    modelRef = [ckptId, 0];
    clipRef = [ckptId, 1];
    vaeRef = vae !== undefined ? [graph.add('VAELoader', { vae_name: vae }), 0] : [ckptId, 2];
  } else {
    ({ modelRef, clipRef, vaeRef } = addSplitLoaders(graph, {
      unetName: unet ?? defaults.unet,
      clipName: clip ?? defaults.clip,
      clipType: 'stable_diffusion',
      vaeName: vae ?? defaults.vae,
    }));
  }

  const isInpaint = !isPreview && image !== undefined && mask.active;
  if (isInpaint) {
    const patchId = graph.add('ModelPatchLoader', {
      name: modelPatch ?? defaults.modelPatch,
    });
    const { imageRef, maskRef } = addImageAndOptionalMask(graph, image, mask);
    const applyId = graph.add('AnimaLLLiteApply', {
      model: modelRef,
      model_patch: [patchId, 0],
      image: imageRef,
      mask: maskRef,
      strength: 1,
      start_percent: 0,
      end_percent: 1,
    });
    modelRef = [applyId, 0];
  }

  const [posId, negId] = addTextEncodePair(graph, 'CLIPTextEncode', clipRef, promptText, negativeText);
  const latentId = graph.add('EmptyLatentImage', { width, height, batch_size: 1 });

  addSampleDecodeSave(graph, {
    modelRef,
    positiveRef: [posId, 0],
    negativeRef: [negId, 0],
    latentRef: [latentId, 0],
    vaeRef,
    samplerParams: resolveSamplerParams(raw, defaults, {
      sampler_name: isInpaint ? 'euler' : defaults.sampler_name,
    }),
    filenamePrefix: isPreview ? 'orime_anima_preview' : 'orime_anima',
  });
  return graph.prompt;
}

function buildMiniMaxH3Prompt(spec, parsed) {
  const { checkpoint, unet, clip, vae, image, promptText, raw } = parsed;
  if (checkpoint !== undefined) {
    throw new Error('minimax-h3-image requires unet, clip, and vae loaders; checkpoint is not supported');
  }

  const isEdit = image !== undefined;
  const width = readDimension(raw.width, 'width', 32, {
    allowZero: isEdit,
    defaultValue: isEdit ? 0 : 2048,
  });
  const height = readDimension(raw.height, 'height', 32, {
    allowZero: isEdit,
    defaultValue: isEdit ? 0 : 2048,
  });
  const defaults = spec.capabilities.defaults;

  const graph = createGraph();
  const { modelRef, clipRef, vaeRef } = addSplitLoaders(graph, {
    unetName: unet ?? defaults.unet,
    clipName: clip ?? defaults.clip,
    clipType: 'minimax',
    vaeName: vae ?? defaults.vae,
  });

  const condInputs = {
    clip: clipRef,
    vae: vaeRef,
    prompt: promptText,
    width,
    height,
  };
  if (isEdit) {
    const loadId = graph.add('LoadImage', { image });
    condInputs['images.image_1'] = [loadId, 0];
  }

  const condId = graph.add('MiniMaxH3ImageConditioning', condInputs);
  const zeroId = graph.add('ConditioningZeroOut', { conditioning: [condId, 0] });

  addSampleDecodeSave(graph, {
    modelRef,
    positiveRef: [condId, 0],
    negativeRef: [zeroId, 0],
    latentRef: [condId, 1],
    vaeRef,
    samplerParams: resolveSamplerParams(raw, defaults),
    filenamePrefix: 'orime_minimax_h3',
  });
  return graph.prompt;
}

function buildMossPrompt(spec, parsed) {
  const { checkpoint, unet, clip, vae, lora, image, promptText, negativeText, raw } = parsed;
  if (checkpoint !== undefined) {
    throw new Error(`${spec.capabilities.canonical} requires unet, clip, and vae loaders; checkpoint is not supported`);
  }

  const isEdit = image !== undefined;
  const hasExplicitDims = raw.width !== undefined || raw.height !== undefined;
  const defaults = spec.capabilities.defaults;

  let width;
  let height;
  if (!isEdit || hasExplicitDims) {
    width = readDimension(raw.width, 'width', 16, { defaultValue: 1024 });
    height = readDimension(raw.height, 'height', 16, { defaultValue: 1024 });
  }

  const graph = createGraph();
  const { modelRef, clipRef, vaeRef } = addSplitLoaders(graph, {
    unetName: unet ?? defaults.unet,
    clipName: clip ?? defaults.clip,
    clipType: 'moss_image',
    vaeName: vae ?? defaults.vae,
  });

  let effectiveModelRef = modelRef;
  let posId;
  let negId;
  let latentWidth = width;
  let latentHeight = height;

  if (isEdit) {
    const loraId = graph.add('LoraLoaderModelOnly', {
      model: modelRef,
      lora_name: lora ?? defaults.lora,
      strength_model: 1,
    });
    const slgId = graph.add('SkipLayerGuidanceDiTSimple', {
      model: [loraId, 0],
      double_layers: '',
      single_layers: '22',
      start_percent: 0,
      end_percent: 1,
    });
    effectiveModelRef = [slgId, 0];

    const loadId = graph.add('LoadImage', { image });
    const scaleId = graph.add(hasExplicitDims ? 'ImageScale' : 'ImageScaleToTotalPixels', {
      image: [loadId, 0],
      upscale_method: 'lanczos',
      ...(hasExplicitDims ? { width, height, crop: 'disabled' } : { megapixels: 1, resolution_steps: 16 }),
    });

    const editEncodeInputs = {
      clip: clipRef,
      vae: vaeRef,
      edit_format: 'Moss-Image-Edit',
      image_strength: 1,
      'images.image_0': [scaleId, 0],
    };
    posId = graph.add('TextEncodeMOSSImageEdit', { prompt: promptText, ...editEncodeInputs });
    negId = graph.add('TextEncodeMOSSImageEdit', { prompt: negativeText, ...editEncodeInputs });

    if (!hasExplicitDims) {
      const sizeId = graph.add('GetImageSize', { image: [scaleId, 0] });
      latentWidth = [sizeId, 0];
      latentHeight = [sizeId, 1];
    }
  } else {
    [posId, negId] = addTextEncodePair(graph, 'CLIPTextEncode', clipRef, promptText, negativeText);
  }

  const latentId = graph.add('EmptyFlux2LatentImage', {
    width: latentWidth,
    height: latentHeight,
    batch_size: 1,
  });

  addSampleDecodeSave(graph, {
    modelRef: effectiveModelRef,
    positiveRef: [posId, 0],
    negativeRef: [negId, 0],
    latentRef: [latentId, 0],
    vaeRef,
    samplerParams: resolveSamplerParams(
      raw,
      defaults,
      isEdit ? { steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } : {},
    ),
    filenamePrefix: spec.capabilities.canonical === 'moss-image-base' ? 'orime_moss_base' : 'orime_moss',
  });
  return graph.prompt;
}

const SDXL_SPEC = {
  capabilities: {
    canonical: 'sdxl',
    modes: { t2i: true, img2img: true, edit: false, inpaint: true },
    supportsNegativePrompt: true,
    supportsImageInput: true,
    supportsMask: true,
    loaderKind: 'checkpoint',
    defaults: {
      checkpoint: 'sd_xl_base_1.0.safetensors',
      width: 1024,
      height: 1024,
      step: 8,
      steps: 25,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      img2imgDenoise: 0.75,
    },
    limitations: [
      'Dimensions must be positive multiples of 8 (max 16384).',
      'Uses CheckpointLoaderSimple (+ optional VAELoader); unet and clip overrides are not supported.',
    ],
  },
  requiredNodes: [
    'CheckpointLoaderSimple',
    'VAELoader',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'LoadImage',
    'VAEEncode',
    'SetLatentNoiseMask',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  build: buildSdxlPrompt,
};

const ANIMA_BASE_SPEC = {
  capabilities: {
    canonical: 'anima-base-v1',
    modes: { t2i: true, img2img: false, edit: false, inpaint: true },
    supportsNegativePrompt: true,
    supportsImageInput: true,
    supportsMask: true,
    loaderKind: 'split-or-checkpoint',
    defaults: {
      unet: 'anima-base-v1.0.safetensors',
      clip: 'qwen_3_06b_base.safetensors',
      clipType: 'stable_diffusion',
      vae: 'qwen_image_vae.safetensors',
      modelPatch: 'anima-lllite-inpainting-v2.safetensors',
      width: 1024,
      height: 1024,
      step: 8,
      steps: 30,
      cfg: 4,
      sampler_name: 'er_sde',
      inpaintSamplerName: 'euler',
      scheduler: 'simple',
      denoise: 1,
    },
    limitations: [
      'Official CLIPLoader type is "stable_diffusion".',
      'Unmasked img2img/reference editing is not supported; inpainting requires image + mask + LLLite patch.',
      'Designed for anime/non-photorealistic generation; weak photorealism and typography.',
    ],
  },
  requiredNodes: [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'CheckpointLoaderSimple',
    'ModelPatchLoader',
    'AnimaLLLiteApply',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'LoadImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  build: buildAnimaPrompt,
};

const ANIMA_PREVIEW_SPEC = {
  capabilities: {
    canonical: 'anima-preview',
    modes: { t2i: true, img2img: false, edit: false, inpaint: false },
    supportsNegativePrompt: true,
    supportsImageInput: false,
    supportsMask: false,
    loaderKind: 'split-or-checkpoint',
    defaults: {
      unet: 'anima-preview3-base.safetensors',
      clip: 'qwen_3_06b_base.safetensors',
      clipType: 'stable_diffusion',
      vae: 'qwen_image_vae.safetensors',
      width: 1024,
      height: 1024,
      step: 8,
      steps: 30,
      cfg: 4,
      sampler_name: 'er_sde',
      scheduler: 'simple',
      denoise: 1,
    },
    limitations: [
      'Text-to-image only; image and mask inputs are not supported.',
      'Official CLIPLoader type is "stable_diffusion".',
    ],
  },
  requiredNodes: [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  build: buildAnimaPrompt,
};

const MINIMAX_H3_SPEC = {
  capabilities: {
    canonical: 'minimax-h3-image',
    modes: { t2i: true, img2img: false, edit: true, inpaint: false },
    supportsNegativePrompt: false,
    supportsImageInput: true,
    supportsMask: false,
    loaderKind: 'split',
    defaults: {
      unet: 'minimax_h3_image_pruned_int8_convrot.safetensors',
      clip: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
      clipType: 'minimax',
      vae: 'minimax_h3_image_vae_fp16.safetensors',
      width: 2048,
      height: 2048,
      step: 32,
      steps: 6,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    },
    limitations: [
      'Dimensions must be multiples of 32 (4 MP to ~20 MP recommended; 2048x2048 default T2I, 0 auto-sizes in edit).',
      'Uses ConditioningZeroOut instead of a negative prompt encoder.',
      'Mask inpainting is not supported by MiniMaxH3ImageConditioning.',
    ],
  },
  requiredNodes: [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'LoadImage',
    'MiniMaxH3ImageConditioning',
    'ConditioningZeroOut',
    'KSampler',
    'VAEDecode',
    'SaveImage',
  ],
  build: buildMiniMaxH3Prompt,
};

const MOSS_SHARED_LIMITATIONS = [
  'Width and height must be positive multiples of 16.',
  'Image editing requires an edit LoRA (e.g. moss_image_edit_lora_rank_64_bf16.safetensors) and TextEncodeMOSSImageEdit.',
  'Mask inpainting is not supported by TextEncodeMOSSImageEdit.',
];

const MOSS_SHARED_NODES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'CLIPTextEncode',
  'EmptyFlux2LatentImage',
  'LoraLoaderModelOnly',
  'SkipLayerGuidanceDiTSimple',
  'LoadImage',
  'ImageScaleToTotalPixels',
  'ImageScale',
  'GetImageSize',
  'TextEncodeMOSSImageEdit',
  'KSampler',
  'VAEDecode',
  'SaveImage',
];

function createMossSpec(canonical, unet) {
  return {
    capabilities: {
      canonical,
      modes: { t2i: true, img2img: false, edit: true, inpaint: false },
      supportsNegativePrompt: true,
      supportsImageInput: true,
      supportsMask: false,
      loaderKind: 'split',
      defaults: {
        unet,
        clip: 'qwen3.5_9b_w4a8_gptq.safetensors',
        clipType: 'moss_image',
        vae: 'flux2-vae_small.safetensors',
        lora: 'moss_image_edit_lora_rank_64_bf16.safetensors',
        width: 1024,
        height: 1024,
        step: 16,
        steps: 25,
        cfg: 2.5,
        sampler_name: 'er_sde',
        scheduler: 'simple',
        editSteps: 30,
        editCfg: 4,
        editSamplerName: 'euler',
        editScheduler: 'normal',
        denoise: 1,
      },
      limitations: MOSS_SHARED_LIMITATIONS,
    },
    requiredNodes: MOSS_SHARED_NODES,
    build: buildMossPrompt,
  };
}

const MOSS_SFT_SPEC = createMossSpec('moss-image', 'moss_image_sft_int8_convrot.safetensors');
const MOSS_BASE_SPEC = createMossSpec('moss-image-base', 'moss_image_base_int8_convrot.safetensors');

const FAMILY_SPECS = {
  sdxl: SDXL_SPEC,
  anima: ANIMA_BASE_SPEC,
  'anima-base-v1': ANIMA_BASE_SPEC,
  'anima-base': ANIMA_BASE_SPEC,
  'anima-base-v1.0': ANIMA_BASE_SPEC,
  'anima-preview': ANIMA_PREVIEW_SPEC,
  'anima-preview3': ANIMA_PREVIEW_SPEC,
  'minimax-h3': MINIMAX_H3_SPEC,
  'minimax-h3-image': MINIMAX_H3_SPEC,
  moss: MOSS_SFT_SPEC,
  'moss-image': MOSS_SFT_SPEC,
  'moss-base': MOSS_BASE_SPEC,
  'moss-image-base': MOSS_BASE_SPEC,
};

function resolveSpec(family) {
  if (typeof family !== 'string' || family.trim() === '') {
    throw new Error('Unknown or missing model family');
  }
  const normalized = family.trim().toLowerCase();
  const spec = FAMILY_SPECS[normalized];
  if (!spec) {
    throw new Error(`Unsupported model family: "${family}"`);
  }
  return spec;
}

function parseSettings(spec, settings) {
  if (settings !== undefined && !isPlainObject(settings)) {
    throw new Error('settings must be a plain object');
  }
  const raw = settings ?? {};

  const promptText = readPromptString(raw.prompt, 'prompt');
  const negativeText = readPromptString(raw.negative, 'negative');
  const checkpoint = readOptionalString(raw.checkpoint, 'checkpoint');
  const unet = readOptionalString(raw.unet, 'unet');
  const clip = readOptionalString(raw.clip, 'clip');
  const vae = readOptionalString(raw.vae, 'vae');
  const lora = readOptionalString(raw.lora, 'lora');
  const modelPatch = readOptionalString(raw.modelPatch, 'modelPatch');
  const image = readOptionalString(raw.image, 'image');
  const mask = readMaskSetting(raw.mask);

  const caps = spec.capabilities;
  if (!caps.supportsImageInput && image !== undefined) {
    throw new Error(`Image input/editing is not supported for ${caps.canonical} (t2i only)`);
  }
  if (!caps.supportsMask && mask.active) {
    throw new Error(`Mask inpainting is not supported for ${caps.canonical}`);
  }
  if (mask.active && image === undefined) {
    throw new Error(`Mask inpainting requires an input image for ${caps.canonical}`);
  }

  return {
    raw,
    promptText,
    negativeText,
    checkpoint,
    unet,
    clip,
    vae,
    lora,
    modelPatch,
    image,
    mask,
  };
}

export const recipeCapabilities = deepFreeze(
  Object.fromEntries(
    Object.entries(FAMILY_SPECS).map(([key, spec]) => [key, spec.capabilities]),
  ),
);

export const requiredNodes = deepFreeze(
  Object.fromEntries(
    Object.entries(FAMILY_SPECS).map(([key, spec]) => [key, spec.requiredNodes]),
  ),
);

/**
 * Builds a ComfyUI API prompt graph for the given model family and settings.
 * @param {string} family
 * @param {Record<string, unknown>} [settings]
 * @returns {Record<string, { class_type: string, inputs: Record<string, unknown> }>}
 */
export function buildRecipe(family, settings = {}) {
  const spec = resolveSpec(family);
  const parsed = parseSettings(spec, settings);
  return spec.build(spec, parsed);
}

/**
 * Returns the deduplicated list of ComfyUI class_type names required for a specific buildRecipe call.
 * @param {string} family
 * @param {Record<string, unknown>} [settings]
 * @returns {string[]}
 */
export function getRequiredNodes(family, settings = {}) {
  const prompt = buildRecipe(family, settings);
  return [...new Set(Object.values(prompt).map((node) => node.class_type))];
}
