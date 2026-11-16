import { app } from "/scripts/app.js";

// This extension is injected by the Rust proxy; the ComfyUI install is unmodified.
app.registerExtension({
  name: "Orime.CanvasBridge",
  async setup() {
    if (window.parent === window) return;
    const reply = (id, result, error) =>
      parent.postMessage(
        { source: "aikimi-bridge", id, result, error },
        location.origin,
      );
    let sequence = Promise.resolve();
    window.addEventListener("message", (event) => {
      if (
        event.origin !== location.origin ||
        event.source !== parent ||
        event.data?.source !== "orime"
      )
        return;
      const { id, action, payload } = event.data;
      sequence = sequence.then(async () => {
        try {
          if (action === "ping") return reply(id, { ready: true });
          if (action === "load-api") {
            if (
              Object.values(payload.prompt).some(
                (n) => n.class_type === "LoadImage",
              )
            )
              await app.reloadNodeDefs?.();
            if (typeof app.loadApiJson !== "function")
              throw Error("このComfyUIのAPI読込機能は未対応です");
            await app.loadApiJson(payload.prompt, "Orime.json");
          } else if (action === "load-workflow") {
            await app.loadGraphData(payload.workflow);
          } else if (action === "patch") {
            if (
              !payload.graphId ||
              app.graph.extra?.aikimiGraphId !== payload.graphId
            )
              throw Error(
                "別のワークフローに切り替わっています。キャンバスへ戻って入力を再指定してください。",
              );
            if (
              payload.bindings.some(
                (b) => b.type === "LoadImage" && b.key in payload.values,
              )
            )
              await app.reloadNodeDefs?.();
            const operations = [];
            for (const b of payload.bindings) {
              if (!(b.key in payload.values)) continue;
              const n = app.graph.getNodeById(b.nodeId);
              const w = n?.widgets?.find((w) => w.name === b.input);
              const input = n?.inputs?.find((i) => i.name === b.input);
              if (!n || n.type !== b.type || !w || input?.link != null)
                throw Error(
                  `ノード ${b.nodeId} の連携が変わりました。ノード画面で編集してください`,
                );
              operations.push({ n, w, value: payload.values[b.key] });
            }
            for (const { n, w, value } of operations) {
              w.value = value;
              w.callback?.(value, app.canvas, n);
            }
            app.graph.setDirtyCanvas(true, true);
          } else if (action !== "snapshot")
            throw Error("Unknown bridge operation");
          app.graph.extra ??= {};
          app.graph.extra.aikimiGraphId ??= crypto.randomUUID();
          const { workflow, output } = await app.graphToPrompt();
          const controls = [];
          for (const n of app.graph._nodes || []) {
            for (const w of n.widgets || []) {
              if (
                !["string", "number", "boolean"].includes(typeof w.value) ||
                ["button", "image"].includes(w.type)
              )
                continue;
              const input = n.inputs?.find((i) => i.name === w.name);
              controls.push({
                key: `${n.id}.${w.name}`,
                nodeId: n.id,
                type: n.type,
                input: w.name,
                label: `${n.title || n.type} · ${w.name}`,
                value: w.value,
                linked: input?.link != null,
                choices: Array.isArray(w.options?.values)
                  ? w.options.values
                  : null,
                min: w.options?.min,
                max: w.options?.max,
              });
            }
          }
          reply(id, {
            workflow,
            prompt: output,
            controls,
            graphId: app.graph.extra.aikimiGraphId,
          });
        } catch (error) {
          reply(id, null, String(error?.message || error));
        }
      });
    });
    reply("ready", { ready: true });
  },
});
