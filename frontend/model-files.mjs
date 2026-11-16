import { inputChoices } from "./graph.mjs";
export function suggestModelFiles(family, info) {
  const picks = {};
  const choose = (key, type, input, names) => {
    const found = names.find((n) =>
      inputChoices(info, type, input).includes(n),
    );
    if (found) picks[key] = found;
  };
  const split = (unet, clip, vae) => {
    choose("unet", "UNETLoader", "unet_name", unet);
    choose("clip", "CLIPLoader", "clip_name", clip);
    choose("vae", "VAELoader", "vae_name", vae);
  };
  if (family === "sdxl")
    choose("checkpoint", "CheckpointLoaderSimple", "ckpt_name", [
      "sd_xl_base_1.0.safetensors",
    ]);
  if (family === "anima" || family === "anima-preview") {
    split(
      family === "anima"
        ? [
            "anima-base-v1.0-int8convrot.safetensors",
            "anima-base-v1.0-int8rowwise.safetensors",
            "anima-base-v1.0.safetensors",
          ]
        : ["Anima-2.9B-preview-v1.safetensors", "anima-preview.safetensors"],
      ["qwen_3_06b_base.safetensors"],
      ["qwen_image_vae.safetensors"],
    );
    if (family === "anima")
      choose("modelPatch", "ModelPatchLoader", "name", [
        "anima-lllite-inpainting-v2.safetensors",
      ]);
  }
  if (family === "moss") {
    split(
      ["moss_image_sft_int8_convrot.safetensors"],
      ["qwen3.5_9b_w4a8_gptq.safetensors"],
      ["flux2-vae_small.safetensors"],
    );
    choose("lora", "LoraLoaderModelOnly", "lora_name", [
      "moss_image_edit_lora_rank_64_bf16.safetensors",
    ]);
  }
  if (family === "minimax-h3") {
    const paired =
      inputChoices(info, "UNETLoader", "unet_name").includes(
        "p-h3-image_w4a8.safetensors",
      ) &&
      inputChoices(info, "CLIPLoader", "clip_name").includes(
        "p-h3-image_text_encoder_w4a8.safetensors",
      );
    split(
      paired
        ? ["p-h3-image_w4a8.safetensors"]
        : ["minimax_h3_image_pruned_int8_convrot.safetensors"],
      paired
        ? ["p-h3-image_text_encoder_w4a8.safetensors"]
        : [
            "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
            "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
          ],
      [
        "minimax_h3_image_vae_fp16.safetensors",
        "p-h3-image_vae_int8_convrot.safetensors",
      ],
    );
  }
  return picks;
}
