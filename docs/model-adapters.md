# Model adapter contract

Adapters construct ComfyUI API prompt objects, not frontend workflow serialization. Input names and node classes must be based on current official source. Expose model-family-specific capabilities; never emulate unsupported mask/reference controls silently. Preserve explicit user filenames; detect missing nodes before queueing. Default model filenames are suggestions only.

Model weights are not bundled. Use the filenames reported by the connected ComfyUI instance; matching a filename does not establish model compatibility.

## Module API (`adapters/recipes.mjs`)

`adapters/recipes.mjs` is a dependency-free, browser-compatible ES module (no Node-only built-ins) exporting:

- **`buildRecipe(family, settings = {})`**: Builds and returns a ComfyUI API prompt graph (`{ [nodeId]: { class_type, inputs } }`). Throws an explicit `Error` for unknown families, invalid settings, conflicting loaders, or unsupported modes (such as image editing on a text-to-image-only variant or mask controls on models without mask wiring).
- **`recipeCapabilities`**: Frozen map keyed by every supported `family` / variant ID and alias, describing supported modes, negative prompt support, mask support, loader kind, defaults, and verified limitations.
- **`requiredNodes`**: Frozen map keyed by every supported `family` / variant ID and alias, listing every ComfyUI `class_type` that `buildRecipe` can emit for that family/variant so callers can check `/object_info` before queueing.
- **`getRequiredNodes(family, settings = {})`**: Convenience helper that returns the exact deduplicated array of ComfyUI `class_type` names emitted for a specific `buildRecipe(family, settings)` call (useful when a server supports a family's T2I graph but lacks nodes required only for editing/inpainting).

## Supported Families and Variants

| Family / Alias | Canonical Variant | Supported Modes | Default Loaders |
| --- | --- | --- | --- |
| `sdxl` | `sdxl` | `t2i`, `img2img`, `inpaint` | `CheckpointLoaderSimple` (+ optional `VAELoader`) |
| `anima`, `anima-base-v1`, `anima-base`, `anima-base-v1.0` | `anima-base-v1` | `t2i`, `inpaint` (LLLite mask patch) | `UNETLoader` + `CLIPLoader` (`type: "stable_diffusion"`) + `VAELoader` (or `CheckpointLoaderSimple` via `checkpoint`) |
| `anima-preview`, `anima-preview3` | `anima-preview` | `t2i` only | `UNETLoader` + `CLIPLoader` (`type: "stable_diffusion"`) + `VAELoader` (or `CheckpointLoaderSimple` via `checkpoint`) |
| `minimax-h3`, `minimax-h3-image` | `minimax-h3-image` | `t2i`, `edit` | `UNETLoader` + `CLIPLoader` (`type: "minimax"`) + `VAELoader` |
| `moss`, `moss-image` | `moss-image` | `t2i`, `edit` (with edit LoRA) | `UNETLoader` + `CLIPLoader` (`type: "moss_image"`) + `VAELoader` |
| `moss-base`, `moss-image-base` | `moss-image-base` | `t2i`, `edit` (with edit LoRA) | `UNETLoader` + `CLIPLoader` (`type: "moss_image"`) + `VAELoader` |

Family matching is case-insensitive and trims surrounding whitespace.

## `settings` Fields

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | Positive text prompt (default `""`). |
| `negative` | `string` | Negative text prompt (default `""`). Ignored by `minimax-h3-image` because its official graph uses `ConditioningZeroOut` instead of a negative encoder (`recipeCapabilities[family].supportsNegativePrompt === false`). |
| `width`, `height` | `number` | Target output pixel dimensions. Must respect each family's alignment step (`8` for SDXL/Anima, `16` for MOSS-Image, `32` for MiniMax-H3-Image). For `minimax-h3-image` edit mode, `0` or omitted lets `MiniMaxH3ImageConditioning` compute reference-scaled dimensions; for `moss-image` edit mode, omitting both uses `GetImageSize` from the 1 MP scaled input image. |
| `seed` | `number` | Non-negative integer noise seed (`default: 0`). |
| `steps` | `number` | Positive integer sampling step count (`1..10000`). |
| `cfg` | `number` | Classifier-Free Guidance scale (`0..100`). |
| `denoise` | `number` | Denoising strength in `[0, 1]`. |
| `sampler`, `sampler_name` | `string` | Optional ComfyUI `KSampler` sampler name override. |
| `scheduler` | `string` | Optional ComfyUI `KSampler` scheduler override. |
| `checkpoint` | `string` | Checkpoint filename for `CheckpointLoaderSimple` (`sdxl`, or single-file `anima` override). Rejected for `minimax-h3-image` and `moss-image`. |
| `unet` | `string` | Diffusion model filename for `UNETLoader` (`anima`, `minimax-h3-image`, `moss-image`). Rejected for `sdxl` and when combined with `checkpoint`. |
| `clip` | `string` | Text encoder filename for `CLIPLoader` (`anima`, `minimax-h3-image`, `moss-image`). Rejected for `sdxl` and when combined with `checkpoint`. |
| `vae` | `string` | VAE filename for `VAELoader`. Supported across all families (optional override on `sdxl`). |
| `lora` | `string` | Optional edit LoRA filename override for `moss-image` edit mode (`LoraLoaderModelOnly`). |
| `modelPatch` | `string` | Optional LLLite model patch filename override for `anima-base-v1` inpainting (`ModelPatchLoader`). |
| `image` | `string` | Input image filename (for `LoadImage`) to enter `img2img` / `edit` / `inpaint` mode. |
| `mask` | `boolean \| string` | Mask flag (`true` to use the input image's alpha channel via `LoadImage` output slot `1`, or a separate mask image filename string). Throws an `Error` if truthy without `image` or on any family/variant that does not wire mask inpainting (`anima-preview`, `minimax-h3-image`, `moss-image`). |

## Family Specifications and Defaults

### 1. SDXL (`sdxl`)
- **Suggested checkpoint**: `sd_xl_base_1.0.safetensors`
- **Defaults**: `1024x1024` (step `8`), `steps: 25`, `cfg: 7`, `sampler_name: "dpmpp_2m"`, `scheduler: "karras"`, `denoise: 1` (`t2i`) / `0.75` (`img2img`, `inpaint`)
- **T2I graph**: `CheckpointLoaderSimple` -> `CLIPTextEncode` (pos/neg) + `EmptyLatentImage` -> `KSampler` -> `VAEDecode` -> `SaveImage`
- **img2img (`image`, no `mask`)**: `LoadImage` -> `VAEEncode` -> `KSampler` -> `VAEDecode` -> `SaveImage`
- **inpaint (`image` + `mask`)**: `LoadImage` -> `VAEEncode` -> `SetLatentNoiseMask` -> `KSampler` -> `VAEDecode` -> `SaveImage` (mask from `LoadImage` slot `1`, or a second `LoadImage` if `mask` is a separate filename)

### 2. Anima (`anima`, `anima-base-v1`, `anima-preview`)
- **Suggested files**:
  - `unet`: `anima-base-v1.0.safetensors` (`anima` / `anima-base-v1`), `anima-preview3-base.safetensors` (`anima-preview`)
  - `clip`: `qwen_3_06b_base.safetensors` loaded via `CLIPLoader` with `type: "stable_diffusion"`
  - `vae`: `qwen_image_vae.safetensors`
  - `modelPatch` (inpaint only): `anima-lllite-inpainting-v2.safetensors`
- **Defaults**: `1024x1024` (step `8`), `steps: 30`, `cfg: 4`, `scheduler: "simple"`, `denoise: 1`; `sampler_name: "er_sde"` for T2I (`"euler"` for Base v1 LLLite inpainting)
- **Capabilities and limits**:
  - Official Anima templates use `CLIPLoader` with `type: "stable_diffusion"` (not `"cosmos"` or `"anima"`).
  - `anima-preview` is **T2I-only**; passing `image` or `mask` throws an explicit `Error`.
  - `anima` / `anima-base-v1` has no unmasked `img2img` or reference edit workflow; passing `image` without `mask` throws an explicit `Error`.
  - When both `image` and `mask` are provided on `anima-base-v1`, the adapter constructs the official Anima LLLite inpainting graph (`ModelPatchLoader` + `AnimaLLLiteApply` + `EmptyLatentImage`). Note that this requires an installed Anima LLLite inpainting model patch file.
  - Designed for anime/non-photorealistic generation; weak photorealism and typography.

### 3. MiniMax-H3-Image (`minimax-h3`, `minimax-h3-image`)
- **Suggested files**:
  - `unet`: `minimax_h3_image_pruned_int8_convrot.safetensors`
  - `clip`: `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` loaded via `CLIPLoader` with `type: "minimax"`
  - `vae`: `minimax_h3_image_vae_fp16.safetensors`
- **Defaults**: `2048x2048` for T2I (step `32`; `0` auto-sizes from `image_1` in edit mode), `steps: 6`, `cfg: 1`, `sampler_name: "euler"`, `scheduler: "simple"`, `denoise: 1`
- **Graph**:
  - `UNETLoader` + `CLIPLoader` + `VAELoader` -> `MiniMaxH3ImageConditioning` -> `ConditioningZeroOut` -> `KSampler` -> `VAEDecode` -> `SaveImage`
  - In edit mode (`image` provided), `LoadImage` connects to `MiniMaxH3ImageConditioning` input `images.image_1`. Prompts may reference the source picture as `<Picture 1>`.
- **Capabilities and limits**:
  - Does not work well at low resolutions (effective range is ~4 MP to ~20 MP; recommended sweet spot is ~16 MP such as `4096x4096`, with `2048x2048` as the reduced 4 MP default).
  - Dimensions must be multiples of `32`.
  - Official workflows do not use a negative text encoder (`ConditioningZeroOut` + `cfg: 1`).
  - `MiniMaxH3ImageConditioning` has no `mask` input; passing `mask` throws an explicit `Error`.

### 4. MOSS-Image (`moss`, `moss-image`, `moss-base`, `moss-image-base`)
- **Suggested files**:
  - `unet`: `moss_image_sft_int8_convrot.safetensors` (`moss` / `moss-image`), `moss_image_base_int8_convrot.safetensors` (`moss-base` / `moss-image-base`)
  - `clip`: `qwen3.5_9b_w4a8_gptq.safetensors` loaded via `CLIPLoader` with `type: "moss_image"`
  - `vae`: `flux2-vae_small.safetensors`
  - `lora` (edit mode only): `moss_image_edit_lora_rank_64_bf16.safetensors`
- **Defaults**:
  - T2I: `1024x1024` (step `16`), `steps: 25`, `cfg: 2.5`, `sampler_name: "er_sde"`, `scheduler: "simple"`, `denoise: 1`
  - Edit: `steps: 30`, `cfg: 4`, `sampler_name: "euler"`, `scheduler: "normal"`, `denoise: 1`
- **T2I graph**: `UNETLoader` + `CLIPLoader` + `VAELoader` -> `CLIPTextEncode` (pos/neg) + `EmptyFlux2LatentImage` -> `KSampler` -> `VAEDecode` -> `SaveImage`
- **Edit graph (`image` provided)**: `UNETLoader` -> `LoraLoaderModelOnly` -> `SkipLayerGuidanceDiTSimple` (`single_layers: "22"`), `LoadImage` -> `ImageScale` (explicit output dimensions, `lanczos`, no crop) or `ImageScaleToTotalPixels` (automatic dimensions: `1.0` MP, `resolution_steps: 16`) -> `TextEncodeMOSSImageEdit` (pos/neg with `edit_format: "Moss-Image-Edit"`, `images.image_0`, `image_strength: 1`) -> `EmptyFlux2LatentImage` (explicit dimensions or `GetImageSize` from scaled image) -> `KSampler` -> `VAEDecode` -> `SaveImage`
- **Capabilities and limits**:
  - Width and height must be positive multiples of `16` (recommended pixel budget ~1M-2M; extrapolation ~0.25M-4M).
  - Base/SFT checkpoints do not natively accept reference images on their own; image editing requires an edit LoRA (e.g. `moss_image_edit_lora_rank_64_bf16.safetensors`) and `TextEncodeMOSSImageEdit` (ComfyUI >= 0.43.0).
  - `TextEncodeMOSSImageEdit` has no `mask` input; passing `mask` throws an explicit `Error`.

## Error Behavior

`buildRecipe(family, settings)` throws descriptive `Error` instances instead of silently falling back when:
- `family` is missing or unknown.
- `settings` is defined and not a plain object (including `null` or arrays), or any provided field has an invalid type/range (`prompt`, `negative`, `width`, `height`, `seed`, `steps`, `cfg`, `denoise`, model filenames).
- `width` or `height` violates the family's step alignment (`8` for SDXL/Anima, `16` for MOSS-Image, `32` for MiniMax-H3-Image).
- `checkpoint` is passed to `minimax-h3-image` or `moss-image`, `unet`/`clip` is passed to `sdxl`, or `checkpoint` is combined with `unet`/`clip` on `anima`.
- `image` is passed to `anima-preview` (T2I-only) or passed to `anima-base-v1` without `mask`.
- `mask` is truthy without `image`, or passed to `anima-preview`, `minimax-h3-image`, or `moss-image`.

## Official Comfy-Org Source References

- ComfyUI core nodes and model definitions:
  - https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py
  - https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/supported_models.py
  - https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/anima.py
  - https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py
  - https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_moss_image.py
- Official ComfyUI workflow templates:
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_sdxl_simple.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_anima_preview.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_anima_base_v1.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_anima_lllite_image_inpainting.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_minimax_h3_image_t2i.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_minimax_h3_image_edit.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_t2i.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_base_t2i.json
  - https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_edit.json
