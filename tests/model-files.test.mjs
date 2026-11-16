import test from "node:test";
import assert from "node:assert/strict";
import { suggestModelFiles } from "../frontend/model-files.mjs";
const inventory = (unets, clips, vaes) => ({
  UNETLoader: { input: { required: { unet_name: [unets] } } },
  CLIPLoader: { input: { required: { clip_name: [clips] } } },
  VAELoader: { input: { required: { vae_name: [vaes] } } },
});

test("standard Anima never suggests the 3.8B extension architecture", () => {
  const info = inventory(
    [
      "Anima-3.8B-v1.1-int8-convrot.safetensors",
      "Anima-3.8B-int8-convrot.safetensors",
    ],
    [],
    [],
  );
  assert.equal(suggestModelFiles("anima", info).unet, undefined);
  info.UNETLoader.input.required.unet_name[0].push(
    "anima-base-v1.0-int8convrot.safetensors",
  );
  assert.equal(
    suggestModelFiles("anima", info).unet,
    "anima-base-v1.0-int8convrot.safetensors",
  );
});
test("P-H3 suggestion requires a paired model and encoder", () => {
  let info = inventory(["p-h3-image_w4a8.safetensors"], [], []);
  assert.equal(suggestModelFiles("minimax-h3", info).unet, undefined);
  info = inventory(
    ["p-h3-image_w4a8.safetensors"],
    ["p-h3-image_text_encoder_w4a8.safetensors"],
    ["minimax_h3_image_vae_fp16.safetensors"],
  );
  assert.equal(
    suggestModelFiles("minimax-h3", info).clip,
    "p-h3-image_text_encoder_w4a8.safetensors",
  );
});
test("MOSS chooses native quantized filenames without confusing Forge exports", () => {
  const info = inventory(
    [
      "moss-image-sft-dit-int8-convrot.safetensors",
      "moss_image_sft_int8_convrot.safetensors",
    ],
    ["qwen3.5_9b_w4a8_gptq.safetensors"],
    ["flux2-vae_small.safetensors"],
  );
  assert.equal(
    suggestModelFiles("moss", info).unet,
    "moss_image_sft_int8_convrot.safetensors",
  );
});
