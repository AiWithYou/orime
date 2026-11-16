export function augmentRecipe(original, options = {}, family) {
  const graph = structuredClone(original);
  let next =
    Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
  const add = (class_type, inputs) => {
    const id = String(next++);
    graph[id] = { class_type, inputs };
    return id;
  };
  const loras = (options.loras || []).filter(
    (l) => l.enabled !== false && l.name,
  );
  if (loras.length) {
    const model = Object.entries(graph).find(([, n]) =>
      ["CheckpointLoaderSimple", "UNETLoader"].includes(n.class_type),
    );
    if (!model)
      throw Error("LoRAの挿入点がありません。ノード画面で追加してください。");
    let modelRef = [model[0], 0],
      clipRef = family === "sdxl" ? [model[0], 1] : null;
    const ids = new Set(Object.keys(graph));
    for (const lora of loras) {
      if (!Number.isFinite(lora.strength) || Math.abs(lora.strength) > 10)
        throw Error("LoRA強度が不正です");
      const id = add(clipRef ? "LoraLoader" : "LoraLoaderModelOnly", {
        model: modelRef,
        ...(clipRef ? { clip: clipRef, strength_clip: lora.strength } : {}),
        lora_name: lora.name,
        strength_model: lora.strength,
      });
      modelRef = [id, 0];
      if (clipRef) clipRef = [id, 1];
    }
    for (const id of ids) {
      if (id === model[0]) continue;
      for (const [key, v] of Object.entries(graph[id].inputs)) {
        if (Array.isArray(v) && v[0] === model[0]) {
          if (v[1] === 0) graph[id].inputs[key] = modelRef;
          else if (v[1] === 1 && clipRef) graph[id].inputs[key] = clipRef;
        }
      }
    }
  }
  const scale = Number(options.scale || 1);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4)
    throw Error("拡大倍率は1〜4です");
  if (scale > 1 || options.upscaler) {
    for (const node of Object.values(graph).filter(
      (n) => n.class_type === "SaveImage",
    )) {
      let images = node.inputs.images;
      if (options.upscaler) {
        const loader = add("UpscaleModelLoader", {
          model_name: options.upscaler,
        });
        images = [
          add("ImageUpscaleWithModel", {
            upscale_model: [loader, 0],
            image: images,
          }),
          0,
        ];
      }
      if (scale > 1)
        images = [
          add("ImageScaleBy", {
            image: images,
            upscale_method: "lanczos",
            scale_by: scale,
          }),
          0,
        ];
      node.inputs.images = images;
    }
  }
  return graph;
}
export function compositeMasked(original, { image, mask, width, height }) {
  if (
    !image ||
    !mask ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw Error("合成する画像・マスク・寸法が必要です");
  const graph = structuredClone(original);
  let next =
    Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
  const add = (class_type, inputs) => {
    const id = String(next++);
    graph[id] = { class_type, inputs };
    return id;
  };
  const loader = (name) =>
    Object.entries(graph).find(
      ([, n]) => n.class_type === "LoadImage" && n.inputs.image === name,
    )?.[0] || add("LoadImage", { image: name });
  const imageId = loader(image),
    maskId = loader(mask);
  for (const n of Object.values(graph).filter(
    (n) => n.class_type === "SaveImage",
  )) {
    const scale = add("ImageScale", {
      image: n.inputs.images,
      upscale_method: "lanczos",
      width,
      height,
      crop: "disabled",
    });
    const composite = add("ImageCompositeMasked", {
      destination: [imageId, 0],
      source: [scale, 0],
      mask: [maskId, 1],
      x: 0,
      y: 0,
      resize_source: false,
    });
    n.inputs.images = [composite, 0];
  }
  return graph;
}
