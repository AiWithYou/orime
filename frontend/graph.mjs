export function patchGraph(graph, bindings, values) {
  const next = structuredClone(graph);
  for (const binding of bindings) {
    if (!(binding.key in values)) continue;
    const node = next.nodes.find(
      (n) => String(n.id) === String(binding.nodeId),
    );
    if (
      !node ||
      node.type !== binding.type ||
      !Array.isArray(node.widgets_values) ||
      binding.index >= node.widgets_values.length
    )
      throw Error(
        "連携するノードが変更されています。ノード画面で確認してください。",
      );
    node.widgets_values[binding.index] = values[binding.key];
  }
  return next;
}
export function discoverBindings(prompt) {
  const entries = Object.entries(prompt).filter(
    ([, n]) => n.class_type === "CLIPTextEncode",
  );
  return entries.length === 1
    ? [
        {
          key: "prompt",
          nodeId: entries[0][0],
          input: "text",
          type: "CLIPTextEncode",
        },
      ]
    : [];
}
export function validatePrompt(prompt, info) {
  for (const [id, node] of Object.entries(prompt)) {
    if (!info[node.class_type])
      throw Error(`必要なノードがありません: ${node.class_type}`);
    const inputs = {
      ...info[node.class_type].input?.required,
      ...info[node.class_type].input?.optional,
    };
    for (const [key, value] of Object.entries(node.inputs)) {
      if (inputs[key]?.[1]?.image_upload) continue;
      const choices = inputChoices(info, node.class_type, key);
      if (
        choices.length > 0 &&
        !Array.isArray(value) &&
        !choices.includes(value)
      )
        throw Error(
          `モデルまたは設定が見つかりません: ${key} = ${value} (ノード ${id})`,
        );
    }
  }
  return prompt;
}
export function maskAlpha(paintedAlpha) {
  return 255 - paintedAlpha;
}
export function inputChoices(info, type, input) {
  const spec =
    info[type]?.input?.required?.[input] ??
    info[type]?.input?.optional?.[input];
  return Array.isArray(spec?.[0])
    ? spec[0]
    : spec?.[0] === "COMBO" && Array.isArray(spec[1]?.options)
      ? spec[1].options
      : [];
}
export function recipeBindings(prompt) {
  const samplerEntry = Object.entries(prompt).find(
    ([, n]) => n.class_type === "KSampler",
  );
  const sampler = samplerEntry?.[1];
  const positive = String(sampler?.inputs.positive?.[0]);
  const negative = String(sampler?.inputs.negative?.[0]);
  const out = [];
  const keys = {
    width: "width",
    height: "height",
    seed: "seed",
    noise_seed: "seed",
    steps: "steps",
    cfg: "cfg",
    denoise: "denoise",
    ckpt_name: "checkpoint",
    unet_name: "unet",
    clip_name: "clip",
    vae_name: "vae",
    sampler_name: "sampler_name",
    scheduler: "scheduler",
  };
  for (const [id, n] of Object.entries(prompt))
    for (const [input, value] of Object.entries(n.inputs)) {
      let key = keys[input];
      if (input === "text" || input === "prompt")
        key =
          id === positive ? "prompt" : id === negative ? "negative" : undefined;
      if (key && !Array.isArray(value)) {
        const binding = { key, nodeId: id, type: n.class_type, input };
        if (["prompt", "negative"].includes(key))
          binding.role = {
            nodeId: samplerEntry[0],
            type: "KSampler",
            input: key === "prompt" ? "positive" : "negative",
            target: [id, 0],
          };
        out.push(binding);
      }
    }
  return out;
}
export function inspectBindings(prompt, bindings) {
  const values = {},
    blocked = {};
  for (const b of bindings) {
    if (b.role) {
      const owner = prompt[b.role.nodeId];
      if (
        owner?.class_type !== b.role.type ||
        JSON.stringify(owner.inputs[b.role.input]) !==
          JSON.stringify(b.role.target)
      ) {
        blocked[b.key] = "接続先が変わりました";
        continue;
      }
    }
    const n = prompt[b.nodeId];
    if (!n || n.class_type !== b.type || !(b.input in n.inputs)) {
      blocked[b.key] = "再指定が必要";
      continue;
    }
    const v = n.inputs[b.input];
    if (Array.isArray(v)) {
      blocked[b.key] = "ノードから制御中";
      continue;
    }
    values[b.key] = v;
  }
  return { values, blocked };
}
