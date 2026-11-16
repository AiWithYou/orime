import canny from "./templates/sdxl-canny.json" with { type: "json" };
const tools = {
  1: { class_type: "LoadImage", inputs: { image: "" } },
  2: {
    class_type: "ImageCrop",
    inputs: { image: ["1", 0], width: 512, height: 512, x: 0, y: 0 },
  },
  3: {
    class_type: "UpscaleModelLoader",
    inputs: { model_name: "RealESRGAN_x2plus.pth" },
  },
  4: {
    class_type: "ImageUpscaleWithModel",
    inputs: { upscale_model: ["3", 0], image: ["2", 0] },
  },
  5: {
    class_type: "SaveImage",
    inputs: { images: ["4", 0], filename_prefix: "orime_upscale" },
  },
};
export function templateWithImage(name, image) {
  if (!image || typeof image !== "string")
    throw Error("先にキャンバスへ画像を読み込んでください。");
  const template = { tools, canny }[name];
  if (!template) throw Error("テンプレートが見つかりません。");
  const prompt = structuredClone(template);
  for (const n of Object.values(prompt))
    if (n.class_type === "LoadImage") n.inputs.image = image;
  return prompt;
}
