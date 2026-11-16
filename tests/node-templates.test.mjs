import test from "node:test";
import assert from "node:assert/strict";
import { templateWithImage } from "../frontend/node-templates.mjs";
test("node templates require an image and return independent linked graphs", () => {
  assert.throws(() => templateWithImage("tools", ""));
  assert.throws(() => templateWithImage("unknown", "source.png"));
  const first = templateWithImage("tools", "upload.png");
  first["1"].inputs.image = "changed.png";
  for (const name of ["tools", "canny"]) {
    const g = templateWithImage(name, "upload.png");
    assert.ok(
      Object.values(g).some(
        (n) => n.class_type === "LoadImage" && n.inputs.image === "upload.png",
      ),
    );
    assert.ok(Object.values(g).some((n) => n.class_type === "SaveImage"));
    for (const n of Object.values(g))
      for (const v of Object.values(n.inputs))
        if (Array.isArray(v)) assert.ok(g[v[0]], `Missing link ${v[0]}`);
  }
});
