export function canvasInputs(prompt, bindings) {
  const result = {};
  for (const b of bindings) {
    if (!["image", "mask"].includes(b.key)) continue;
    const node = prompt[b.nodeId];
    if (
      node?.class_type === "LoadImage" &&
      node.class_type === b.type &&
      typeof node.inputs?.[b.input] === "string"
    )
      result[b.key] = node.inputs[b.input];
  }
  return result;
}
export function editableImageBindings(snapshot, bindings) {
  return bindings.filter((b) => {
    const node = snapshot.prompt[b.nodeId];
    const value = node?.inputs?.[b.input];
    return (
      node?.class_type === b.type &&
      (typeof value === "string" || typeof value === "number") &&
      !snapshot.controls?.some(
        (c) =>
          String(c.nodeId) === String(b.nodeId) &&
          c.input === b.input &&
          c.linked,
      )
    );
  });
}
export function recipeImageBindings(prompt, image, mask) {
  const bindings = Object.entries(prompt)
    .filter(([, n]) => n.class_type === "LoadImage")
    .map(([id, n]) => ({
      key:
        n.inputs.image === image
          ? "image"
          : n.inputs.image === mask
            ? "mask"
            : "",
      nodeId: id,
      type: n.class_type,
      input: "image",
    }))
    .filter((b) => b.key);
  const scales = new Set(
    Object.values(prompt)
      .filter((n) => n.class_type === "ImageCompositeMasked")
      .map((n) => String(n.inputs.source?.[0])),
  );
  for (const id of scales)
    if (prompt[id]?.class_type === "ImageScale")
      for (const [key, input] of [
        ["imageWidth", "width"],
        ["imageHeight", "height"],
      ])
        bindings.push({ key, nodeId: id, type: "ImageScale", input });
  return bindings;
}
