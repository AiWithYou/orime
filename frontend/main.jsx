import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Save,
  Settings,
  Sparkles,
  Dices,
  X,
  Download,
  Upload,
  Square,
  RotateCcw,
  Check,
  SlidersHorizontal,
} from "lucide-react";
import Canvas from "./Canvas.jsx";
import { api, post, download, imageURL, upload, createBridge } from "./api.mjs";
import {
  validatePrompt,
  inspectBindings,
  recipeBindings,
  inputChoices,
} from "./graph.mjs";
import { augmentRecipe, compositeMasked } from "./recipe-options.mjs";
import {
  reconcileJob,
  pendingJob,
  shouldPollJob,
  cancelJob,
  mergeRecoveredJobs,
} from "./jobs.mjs";
import {
  canvasInputs,
  editableImageBindings,
  recipeImageBindings,
} from "./canvas-inputs.mjs";
import { suggestModelFiles } from "./model-files.mjs";
import { imageEditSettings, shortcutAction } from "./editor-controls.mjs";
import { templateWithImage } from "./node-templates.mjs";
import {
  buildImageTool,
  imageTools,
  controlGroups,
  matchingControls,
  labels,
} from "./custom-tools.mjs";
import ImageTools from "./ImageTools.jsx";
import ResultPreview from "./ResultPreview.jsx";
import ShutdownButton from "./ShutdownButton.jsx";
import "./style.css";

const families = [
  ["sdxl", "SDXL"],
  ["anima", "Anima Base v1"],
  ["anima-preview", "Anima Preview"],
  ["minimax-h3", "MiniMax H3 / P-H3"],
  ["moss", "MOSS Image"],
];
const initial = {
  prompt: "",
  negative: "",
  width: 1024,
  height: 1024,
  steps: 24,
  cfg: 7,
  seed: 42,
  checkpoint: "",
  unet: "",
  clip: "",
  vae: "",
  denoise: 0.7,
};
function Field({
  name,
  label,
  value,
  onChange,
  className = "field-row",
  ...props
}) {
  return (
    <label className={className}>
      {label}
      <input
        name={name}
        aria-label={label}
        value={value}
        onChange={(e) =>
          onChange(
            e.target.type === "number"
              ? Number(e.target.value)
              : e.target.value,
          )
        }
        {...props}
      />
    </label>
  );
}
function App({ onShutdown } = {}) {
  const [preview, setPreview] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [controlSearch, setControlSearch] = useState("");
  const [maskSource, setMaskSource] = useState(null);
  const [sourceSize, setSourceSize] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [family, setFamily] = useState("sdxl"),
    [settings, setSettings] = useState(initial),
    [mode, setMode] = useState("canvas"),
    [connected, setConnected] = useState(false),
    [ready, setReady] = useState(false),
    [info, setInfo] = useState({}),
    [message, setMessage] = useState("ComfyUIを確認中…"),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState(false),
    [source, setSource] = useState(null),
    [tool, setTool] = useState("brush"),
    [brush, setBrush] = useState(36),
    [jobs, setJobs] = useState([]),
    [busy, setBusy] = useState(false),
    [activeJob, setActiveJob] = useState(null),
    [custom, setCustom] = useState(false),
    [compare, setCompare] = useState(false);
  const iframe = useRef(),
    bridge = useRef(),
    canvas = useRef(),
    workflow = useRef(null),
    bindings = useRef([]),
    dirty = useRef(true),
    file = useRef(),
    changed = useRef(new Set()),
    imageBindings = useRef([]);
  const [blocked, setBlocked] = useState({}),
    [caps, setCaps] = useState(null),
    [extras, setExtras] = useState({ loras: [], scale: 1, upscaler: "" });
  const [controls, setControls] = useState([]),
    [pins, setPins] = useState([]),
    [drafts, setDrafts] = useState([]);
  const update = (key, value) => {
    changed.current.add(key);
    setSettings((s) => ({ ...s, [key]: value }));
  };
  useEffect(() => {
    if (workflow.current) return;
    const picks = suggestModelFiles(family, info);
    if (!Object.keys(picks).length) return;
    setSettings((s) =>
      s.checkpoint || s.unet || s.clip || s.vae ? s : { ...s, ...picks },
    );
  }, [info, family]);
  const fail = (e) => {
    setError(e.message || String(e));
    setBusy(false);
  };
  useEffect(() => {
    bridge.current = createBridge(iframe, () => setReady(true));
    return () => bridge.current.dispose();
  }, []);
  useEffect(() => {
    const url = "/canvas-api/recipes.mjs";
    import(/* @vite-ignore */ url)
      .then((m) => setCaps(m.recipeCapabilities[family]))
      .catch(() => {});
  }, [family]);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const state = await api("/canvas-api/status");
        if (cancelled) return;
        setConnected(state.connected);
        setMessage(state.connected ? "ComfyUI 接続済み" : "ComfyUI 未接続");
        if (state.connected) {
          const i = await api("/object_info");
          if (!cancelled) setInfo(i);
        }
      } catch (e) {
        if (!cancelled) setMessage("ComfyUI 未接続");
      }
    }
    check();
    const timer = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    async function recover() {
      try {
        const records = await api("/canvas-api/jobs");
        if (disposed) return;
        setJobs((current) => mergeRecoveredJobs(current, records));
      } catch {}
    }
    recover();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (connected)
      setJobs((current) =>
        current.map((job) =>
          job.missingChecks || (job.cancelRequested && job.receiptChecked)
            ? { ...job, missingChecks: 0, receiptChecked: false }
            : job,
        ),
      );
  }, [connected]);
  useEffect(() => {
    if (dialog)
      api("/canvas-api/drafts")
        .then(setDrafts)
        .catch(() => {});
  }, [dialog]);
  useEffect(() => {
    if (!connected) return;
    const pending = jobs.filter(shouldPollJob);
    if (!pending.length) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const queue = await api("/queue");
        const updates = await Promise.all(
          pending.map(async (job) =>
            reconcileJob(job, await api("/history/" + job.id), queue),
          ),
        );
        if (stopped) return;
        setJobs((current) =>
          current.map((j) =>
            pending.includes(j) ? updates.find((u) => u.id === j.id) || j : j,
          ),
        );
        const active = updates.find((j) => j.id === activeJob);
        if (active && (!pendingJob(active) || !shouldPollJob(active))) {
          setActiveJob(null);
          setBusy(false);
          setMessage(
            active.status === "完了"
              ? "生成が完了しました"
              : active.status === "未確認"
                ? "生成状態を確認できません。ノード画面の履歴を確認してください。"
                : `生成: ${active.status}`,
          );
        }
      } catch {
        if (!stopped) setMessage("接続を再確認しています…");
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connected, activeJob, jobs]);
  async function cancel(id) {
    try {
      const result = await cancelJob(api, post, id);
      setJobs((current) =>
        current.map((j) =>
          j.id === id && pendingJob(j) ? { ...j, ...result } : j,
        ),
      );
      if (activeJob === id && !pendingJob(result)) {
        setActiveJob(null);
        setBusy(false);
      }
      setMessage(
        result.cancelRequested
          ? "停止を要求しました"
          : `生成の状態: ${result.status}`,
      );
    } catch (e) {
      fail(e);
    }
  }
  function clearBindings() {
    bindings.current = [];
    imageBindings.current = [];
    changed.current.clear();
    setBlocked({});
    setControls([]);
    setPins([]);
  }
  async function loadForeign(data) {
    await archive();
    clearBindings();
    newSource(null);
    workflow.current = await bridge.current.call(
      data.nodes ? "load-workflow" : "load-api",
      data.nodes ? { workflow: data } : { prompt: data },
    );
    dirty.current = false;
    setCustom(true);
    setControls(workflow.current.controls || []);
  }
  async function openNodeTemplate(name) {
    try {
      if (!source) throw Error("先にキャンバスへ画像を読み込んでください。");
      const image = await upload(
        await canvas.current.imageBlob(false),
        "tools-" + crypto.randomUUID() + ".png",
      );
      const prompt = templateWithImage(name, image);
      validatePrompt(prompt, info);
      await loadForeign(prompt);
      setDialog(false);
      setMode("nodes");
    } catch (e) {
      fail(e);
    }
  }
  async function openImageTool(name, values) {
    if (!ready || !source)
      throw Error("ComfyUIの接続と入力画像を確認してください");
    const tool = imageTools.find((t) => t.id === name);
    const fresh = await api("/object_info");
    setInfo(fresh);
    const image = await upload(
      await canvas.current.imageBlob(false),
      "tool-" + crypto.randomUUID() + ".png",
    );
    const mask =
      tool.mask && canvas.current.hasMask()
        ? await upload(
            await canvas.current.imageBlob(true),
            "mask-" + crypto.randomUUID() + ".png",
          )
        : undefined;
    const prompt = buildImageTool(name, fresh, image, values, mask);
    validatePrompt(prompt, fresh);
    const original = source;
    await loadForeign(prompt);
    // Keep the source preview bound to this exact tool graph, never guessed nodes.
    imageBindings.current = recipeImageBindings(prompt, image, mask);
    setSource(original);
    setMaskSource(mask ? imageURL({ filename: mask, type: "input" }) : null);
    setPins(
      (workflow.current.controls || [])
        .filter((c) => String(c.nodeId) === "2")
        .map((c) => c.key),
    );
    setToolsOpen(false);
    setMode("canvas");
    setMessage(tool.label + "の設定を開きました。「生成する」で実行できます");
  }
  async function archive() {
    let snap = null;
    let sameGraph = true;
    if (workflow.current) {
      snap = await bridge.current.call("snapshot");
      if (workflow.current?.graphId !== snap.graphId) {
        sameGraph = false;
        clearBindings();
        newSource(null);
        setCustom(true);
      }
      if (!custom && changed.current.size) {
        const checked = inspectBindings(snap.prompt, bindings.current);
        const values = Object.fromEntries(
          [...changed.current]
            .filter((k) => !checked.blocked[k])
            .map((k) => [k, settings[k]]),
        );
        snap = await bridge.current.call("patch", {
          bindings: bindings.current,
          values,
          graphId: workflow.current?.graphId,
        });
        changed.current.clear();
      }
      workflow.current = snap;
    }
    let canvasImage = null,
      canvasMask = null;
    if (source && sameGraph) {
      canvasImage = await upload(
        await canvas.current.imageBlob(false),
        "draft-" + crypto.randomUUID() + ".png",
      );
      if (canvas.current.hasMask())
        canvasMask = await upload(
          await canvas.current.imageBlob(true),
          "draft-mask-" + crypto.randomUUID() + ".png",
        );
    }
    const editable = snap
      ? editableImageBindings(snap, imageBindings.current)
      : [];
    const canWriteMask = editable.some((b) => b.key === "mask");
    const needsCanvasCompile =
      !!canvasImage &&
      (!editable.some((b) => b.key === "image") ||
        (!!canvasMask && !canWriteMask));
    if (snap && canvasImage && !needsCanvasCompile) {
      const values = {
        image: canvasImage,
        imageWidth: canvas.current.size[0],
        imageHeight: canvas.current.size[1],
      };
      if (canWriteMask)
        values.mask =
          canvasMask ||
          (await upload(
            await canvas.current.imageBlob(true, true),
            "draft-mask-" + crypto.randomUUID() + ".png",
          ));
      snap = await bridge.current.call("patch", {
        graphId: snap.graphId,
        bindings: editable,
        values,
      });
      workflow.current = snap;
    }
    return await post("/canvas-api/drafts", {
      aikimiDraft: true,
      workflow: snap?.workflow,
      family,
      settings,
      pins,
      bindings: bindings.current,
      imageBindings: imageBindings.current,
      builtWithMask: imageBindings.current.some((b) => b.key === "mask"),
      extras,
      custom: custom || (!!snap && !bindings.current.length),
      needsCanvasCompile,
      canvasImage,
      canvasMask,
    });
  }
  async function restoreDraft(d) {
    await archive();
    clearBindings();
    workflow.current = d.workflow?.nodes
      ? await bridge.current.call("load-workflow", { workflow: d.workflow })
      : null;
    bindings.current = d.bindings || [];
    imageBindings.current = d.imageBindings || [];
    const inputs = canvasInputs(
      workflow.current?.prompt || {},
      imageBindings.current,
    );
    const sourceFile = "canvasImage" in d ? d.canvasImage : inputs.image;
    const maskFile = "canvasMask" in d ? d.canvasMask : inputs.mask;
    setSource(
      sourceFile ? imageURL({ filename: sourceFile, type: "input" }) : null,
    );
    setMaskSource(
      maskFile ? imageURL({ filename: maskFile, type: "input" }) : null,
    );
    setSettings(d.settings || initial);
    setFamily(d.family || "sdxl");
    setPins(d.pins || []);
    setExtras(d.extras || { loras: [], scale: 1, upscaler: "" });
    setControls(workflow.current?.controls || []);
    setCustom(!!workflow.current && (d.custom ?? !bindings.current.length));
    dirty.current = !workflow.current;
    if (workflow.current && d.needsCanvasCompile)
      setMessage(
        "画像・マスクを復元しました。現在のノード構成を保護するため、「新規レシピ」から編集用レシピを作成してください。",
      );
    setBlocked(
      workflow.current
        ? inspectBindings(workflow.current.prompt, bindings.current).blocked
        : {},
    );
    setDialog(false);
    setMode("canvas");
  }
  async function newRecipe() {
    try {
      await archive();
      dirty.current = true;
      workflow.current = null;
      clearBindings();
      setCustom(false);
    } catch (e) {
      fail(e);
    }
  }
  async function selectFamily(value) {
    try {
      await archive();
      setFamily(value);
      dirty.current = true;
      setCustom(false);
      clearBindings();
      workflow.current = null;
      const url = "/canvas-api/recipes.mjs";
      const m = await import(/* @vite-ignore */ url);
      const c = m.recipeCapabilities[value];
      setCaps(c);
      setSettings((s) => {
        const next = {
          ...initial,
          prompt: s.prompt,
          negative: c.supportsNegativePrompt ? s.negative : "",
          ...c.defaults,
          checkpoint: "",
          unet: "",
          clip: "",
          vae: "",
          denoise: 0.7,
          ...suggestModelFiles(value, info),
        };
        return source ? imageEditSettings(next, c.defaults) : next;
      });
      setExtras({ loras: [], scale: 1, upscaler: "" });
    } catch (e) {
      fail(e);
    }
  }
  async function sync(uploadImages = true) {
    if (!ready)
      throw Error(
        "ComfyUIのノード画面を読み込み中です。しばらくお待ちください。",
      );
    if (source && !dirty.current && uploadImages) {
      const current = await bridge.current.call("snapshot");
      if (current.graphId !== workflow.current?.graphId)
        throw Error(
          "別のワークフローに切り替わりました。ノード画面から戻ってください。",
        );
      const editable = editableImageBindings(current, imageBindings.current);
      const canWriteMask = editable.some((b) => b.key === "mask");
      if (!editable.some((b) => b.key === "image"))
        throw Error(
          "このグラフの画像入力は未指定です。画像を使う新しいレシピを作成するか、ノード画面で指定してください。",
        );
      if (canvas.current.hasMask() && !canWriteMask)
        throw Error(
          "このレシピにはマスク処理がありません。「新規レシピ」で現在のグラフを保存すると、マスクを組み込めます。",
        );
      const image = await upload(
        await canvas.current.imageBlob(false),
        "canvas-" + crypto.randomUUID() + ".png",
      );
      const values = {
        image,
        imageWidth: canvas.current.size[0],
        imageHeight: canvas.current.size[1],
      };
      if (canWriteMask)
        values.mask = await upload(
          await canvas.current.imageBlob(true, !canvas.current.hasMask()),
          "mask-" + crypto.randomUUID() + ".png",
        );
      await bridge.current.call("patch", {
        graphId: workflow.current?.graphId,
        bindings: editable,
        values,
      });
    }
    if (dirty.current) {
      const s = {
        ...settings,
        denoise: source && family === "sdxl" ? settings.denoise : 1,
      };
      let maskFile;
      if (source) {
        s.image = await upload(
          await canvas.current.imageBlob(false),
          "canvas-" + crypto.randomUUID() + ".png",
        );
        if (canvas.current.hasMask()) {
          maskFile = await upload(
            await canvas.current.imageBlob(true),
            "mask-" + crypto.randomUUID() + ".png",
          );
          s.mask = caps?.supportsMask ? maskFile : false;
        }
      }
      const recipeURL = "/canvas-api/recipes.mjs";
      const { buildRecipe } = await import(/* @vite-ignore */ recipeURL);
      const basePrompt = buildRecipe(family, s);
      let prompt = augmentRecipe(basePrompt, extras, family);
      if (maskFile)
        prompt = compositeMasked(prompt, {
          image: s.image,
          mask: maskFile,
          width: canvas.current.size[0],
          height: canvas.current.size[1],
        });
      validatePrompt(prompt, info);
      imageBindings.current = recipeImageBindings(prompt, s.image, maskFile);
      bindings.current = recipeBindings(basePrompt);
      workflow.current = await bridge.current.call("load-api", { prompt });
      dirty.current = false;
    } else if (!custom) {
      const values = Object.fromEntries(
        [...changed.current]
          .filter((k) => !blocked[k])
          .map((k) => [k, settings[k]]),
      );
      workflow.current = await bridge.current.call("patch", {
        graphId: workflow.current?.graphId,
        bindings: bindings.current,
        values,
      });
    } else workflow.current = await bridge.current.call("snapshot");
    changed.current.clear();
    return workflow.current;
  }
  async function switchMode(next) {
    if (next === mode) return;
    setError("");
    try {
      if (next === "nodes") {
        const hasDraft =
          source ||
          settings.prompt ||
          settings.negative ||
          settings.checkpoint ||
          settings.unet ||
          settings.clip ||
          settings.vae ||
          changed.current.size;
        if (workflow.current || hasDraft) await sync();
        setMode("nodes");
      } else {
        if (!ready) {
          setMode("canvas");
          return;
        }
        const snap = await bridge.current.call("snapshot");
        const oldInputs = canvasInputs(
          workflow.current?.prompt || {},
          imageBindings.current,
        );
        const newInputs = canvasInputs(snap.prompt, imageBindings.current);
        if (
          workflow.current?.graphId === snap.graphId &&
          JSON.stringify(oldInputs) !== JSON.stringify(newInputs)
        ) {
          setSource(
            newInputs.image
              ? imageURL({ filename: newInputs.image, type: "input" })
              : null,
          );
          setMaskSource(
            newInputs.mask
              ? imageURL({ filename: newInputs.mask, type: "input" })
              : null,
          );
        }
        if (workflow.current?.graphId !== snap.graphId) {
          clearBindings();
          newSource(null);
        }
        workflow.current = snap;
        setControls(workflow.current.controls || []);
        const checked = inspectBindings(
          workflow.current.prompt,
          bindings.current,
        );
        setSettings((s) => ({ ...s, ...checked.values }));
        setBlocked(checked.blocked);
        setCustom(!bindings.current.length);
        dirty.current = false;
        changed.current.clear();
        setMode("canvas");
      }
    } catch (e) {
      fail(e);
    }
  }
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const snap = await sync();
      validatePrompt(snap.prompt, info);
      const id = crypto.randomUUID();
      const result = await post("/prompt", {
        prompt: snap.prompt,
        client_id: id,
        extra_data: {
          extra_pnginfo: { workflow: snap.workflow },
          aikimi: {
            family: custom ? "カスタム" : family,
            prompt: custom ? "" : settings.prompt,
          },
        },
      });
      if (!result.prompt_id) throw Error(JSON.stringify(result));
      setJobs((j) => [
        {
          id: result.prompt_id,
          status: "生成中",
          family: custom ? "カスタム" : family,
          prompt: custom ? "" : settings.prompt,
          workflow: snap.workflow,
          api: snap.prompt,
          images: [],
          created: Date.now(),
        },
        ...j,
      ]);
      setActiveJob(result.prompt_id);
      setMessage("生成中…");
    } catch (e) {
      fail(e);
    }
  }
  async function save() {
    try {
      const d = await archive();
      let out = d;
      if (d.workflow && !d.needsCanvasCompile) {
        out = structuredClone(d.workflow);
        out.extra ??= {};
        const { workflow: _, id, created, ...metadata } = d;
        out.extra.aikimi = metadata;
      }
      download(out.nodes ? "orime-workflow.json" : "orime-draft.json", out);
      setMessage("編集内容を保存しました");
    } catch (e) {
      fail(e);
    }
  }
  async function importWorkflow(f) {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.nodes && data.extra?.aikimi)
        await restoreDraft({ ...data.extra.aikimi, workflow: data });
      else if (data.aikimiDraft) await restoreDraft(data);
      else await loadForeign(data);
      setDialog(false);
    } catch (e) {
      fail(e);
    }
  }
  async function editControl(c, value) {
    try {
      const snap = await bridge.current.call("patch", {
        graphId: workflow.current?.graphId,
        bindings: [c],
        values: { [c.key]: value },
      });
      const keys = bindings.current
        .filter(
          (b) =>
            String(b.nodeId) === String(c.nodeId) &&
            b.type === c.type &&
            b.input === c.input,
        )
        .map((b) => b.key);
      for (const key of keys) changed.current.delete(key);
      if (keys.length)
        setSettings((current) => ({
          ...current,
          ...Object.fromEntries(keys.map((key) => [key, value])),
        }));
      workflow.current = snap;
      setControls(snap.controls || []);
    } catch (e) {
      fail(e);
    }
  }
  function newSource(value) {
    setMaskSource(null);
    setSourceSize(null);
    setSource(value);
    if (!workflow.current) {
      if (value && !source)
        setSettings((s) => imageEditSettings(s, caps?.defaults));
      dirty.current = true;
      setCustom(false);
    }
  }
  async function adopt(image) {
    const response = await fetch(imageURL(image));
    if (!response.ok)
      throw Error("画像を読み込めません。保存先を確認してください。");
    const blob = await response.blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error("画像を読み込めませんでした"));
      reader.readAsDataURL(blob);
    });
    newSource(data);
    setCompare(false);
    setShowHistory(false);
  }
  const modelOptions = (type, input) => inputChoices(info, type, input);
  const selections = [
    ["checkpoint", "チェックポイント", "CheckpointLoaderSimple", "ckpt_name"],
    ["unet", "生成モデル", "UNETLoader", "unet_name"],
    ["clip", "テキストエンコーダー", "CLIPLoader", "clip_name"],
    ["vae", "VAE", "VAELoader", "vae_name"],
    ["modelPatch", "Anima マスク編集用パッチ", "ModelPatchLoader", "name"],
    ["lora", "MOSS 画像編集用LoRA", "LoraLoaderModelOnly", "lora_name"],
  ];
  useEffect(() => {
    const handler = (event) => {
      if (mode !== "canvas" || dialog || toolsOpen || preview) return;
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "generate" && connected && ready && !busy) generate();
      if (action === "save" && ready && !busy) save();
      if (action === "brush" || action === "erase") setTool(action);
      if (action === "undo") canvas.current?.undo();
      if (action === "fit") canvas.current?.fit();
      if (action === "smaller") setBrush((v) => Math.max(4, v - 4));
      if (action === "larger") setBrush((v) => Math.min(180, v + 4));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  return (
    <main>
      <header>
        <h1 title="Orime — ComfyUI Canvas">
          Orime <small className="brand-description">ComfyUI Canvas</small>
        </h1>
        <div className="mode-switch">
          <button
            className={mode === "canvas" ? "active" : ""}
            onClick={() => switchMode("canvas")}
          >
            キャンバス
          </button>
          <button
            className={mode === "nodes" ? "active" : ""}
            onClick={() => switchMode("nodes")}
          >
            ノード
          </button>
        </div>
        <div className="header-actions">
          <button
            aria-label="画像ツール"
            title="画像ツール"
            disabled={!connected || !ready || busy || mode !== "canvas"}
            onClick={() => setToolsOpen(true)}
          >
            <SlidersHorizontal size={18} />
            画像ツール
          </button>
          <button onClick={save}>
            <Save size={18} />
            保存
          </button>
          <button onClick={() => setDialog(true)}>
            <Settings size={18} />
            設定
          </button>
          <ShutdownButton onStopped={onShutdown} />
        </div>
      </header>
      <div className={"workspace " + (mode === "nodes" ? "node-mode" : "")}>
        <aside className="inspector">
          <div className="inspector-fields">
            {!custom && (
              <>
                <label className="field-row family-row">
                  モデル
                  <select
                    value={family}
                    onChange={(e) => selectFamily(e.target.value)}
                  >
                    {families.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="model-summary"
                  onClick={() => setDialog(true)}
                  title={
                    settings.checkpoint ||
                    settings.unet ||
                    "モデルファイルを選択"
                  }
                >
                  <span>
                    {settings.checkpoint ||
                      settings.unet ||
                      "モデルファイルを選択"}
                  </span>
                  <Settings size={14} />
                </button>
              </>
            )}
            {workflow.current && (
              <div className="custom-note">
                {custom ? "カスタムグラフ" : "ノード連携中"}
                <button
                  title="現在のグラフを保存して新しいレシピへ"
                  onClick={newRecipe}
                >
                  新規レシピ
                </button>
              </div>
            )}
            <fieldset disabled={custom} hidden={custom}>
              <label className="prompt-field">
                プロンプト
                <textarea
                  disabled={!!blocked.prompt}
                  value={settings.prompt}
                  placeholder="生成したい画像の内容を入力…"
                  onChange={(e) => update("prompt", e.target.value)}
                />
              </label>
              {caps?.supportsNegativePrompt !== false && (
                <details>
                  <summary>ネガティブプロンプト</summary>
                  <textarea
                    disabled={!!blocked.negative}
                    aria-label="ネガティブプロンプト"
                    value={settings.negative}
                    onChange={(e) => update("negative", e.target.value)}
                  />
                </details>
              )}
              <label className="field-row">
                画像サイズ
                <div className="two-inputs">
                  <input
                    aria-label="幅"
                    disabled={
                      !!blocked.width || (!!source && family === "sdxl")
                    }
                    type="number"
                    min="64"
                    max="8192"
                    step="64"
                    value={
                      source && family === "sdxl" && sourceSize
                        ? sourceSize[0]
                        : settings.width
                    }
                    onChange={(e) => update("width", +e.target.value)}
                  />
                  <span>×</span>
                  <input
                    aria-label="高さ"
                    disabled={
                      !!blocked.height || (!!source && family === "sdxl")
                    }
                    type="number"
                    min="64"
                    max="8192"
                    step="64"
                    value={
                      source && family === "sdxl" && sourceSize
                        ? sourceSize[1]
                        : settings.height
                    }
                    onChange={(e) => update("height", +e.target.value)}
                  />
                </div>
              </label>
              <div className="parameter-pair">
                <Field
                  disabled={!!blocked.steps || custom}
                  label="ステップ数"
                  type="number"
                  min="1"
                  max="150"
                  value={settings.steps}
                  onChange={(v) => update("steps", v)}
                />
                <Field
                  label="CFG"
                  type="number"
                  min="0"
                  max="30"
                  step=".1"
                  disabled={!!blocked.cfg || custom}
                  value={settings.cfg}
                  onChange={(v) => update("cfg", v)}
                />
              </div>
              <label className="field-row">
                シード値
                <div className="seed">
                  <input
                    aria-label="シード値"
                    disabled={!!blocked.seed}
                    type="number"
                    min="0"
                    value={settings.seed}
                    onChange={(e) => update("seed", +e.target.value)}
                  />
                  <button
                    disabled={!!blocked.seed}
                    title="シードをランダムにする"
                    onClick={() =>
                      update("seed", Math.floor(Math.random() * 2 ** 32))
                    }
                  >
                    <Dices size={19} />
                  </button>
                </div>
              </label>
              {source && family === "sdxl" && (
                <Field
                  disabled={!!blocked.denoise || custom}
                  label="変更の強さ"
                  type="number"
                  min="0"
                  max="1"
                  step=".05"
                  value={settings.denoise}
                  onChange={(v) => update("denoise", v)}
                />
              )}
              <details className="sampling-options">
                <summary>
                  サンプリング{" "}
                  <small>
                    {settings.sampler_name || caps?.defaults?.sampler_name}
                  </small>
                </summary>
                {[
                  ["sampler_name", "サンプラー"],
                  ["scheduler", "スケジュール"],
                ].map(([key, label]) => (
                  <label className="field-row" key={key}>
                    {label}
                    <select
                      disabled={!!blocked[key]}
                      value={settings[key] || caps?.defaults?.[key] || ""}
                      onChange={(e) => update(key, e.target.value)}
                    >
                      {modelOptions("KSampler", key).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </details>
              <button
                className="extras-summary"
                onClick={() => setDialog(true)}
              >
                LoRA・拡大{" "}
                <small>
                  {extras.loras.filter((l) => l.name).length}件 · {extras.scale}
                  ×{extras.upscaler ? " + 超解像" : ""}
                </small>
              </button>
            </fieldset>
            {source && !custom && caps?.supportsMask === false && (
              <p className="binding-note">
                塗った範囲は生成後に合成します。範囲外は元画像を保持します。
              </p>
            )}
            {Object.keys(blocked).length > 0 && (
              <p className="binding-note">
                {Object.entries(blocked)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" / ")}
              </p>
            )}
            {controls.length > 0 && (
              <section className="pinned-controls">
                {controls
                  .filter((c) => pins.includes(c.key))
                  .map((c) => (
                    <label className="field-row" key={c.key} title={c.label}>
                      <span className="control-label">
                        {labels[c.input] || c.label}
                      </span>
                      {c.linked ? (
                        <small>ノードから制御中</small>
                      ) : c.choices ? (
                        <select
                          value={c.value}
                          onChange={(e) => editControl(c, e.target.value)}
                        >
                          {c.choices.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : typeof c.value === "boolean" ? (
                        <input
                          type="checkbox"
                          checked={c.value}
                          onChange={(e) => editControl(c, e.target.checked)}
                        />
                      ) : typeof c.value === "number" ? (
                        <input
                          type="number"
                          value={c.value}
                          min={c.min}
                          max={c.max}
                          step="any"
                          onChange={(e) => editControl(c, +e.target.value)}
                        />
                      ) : (
                        <textarea
                          value={c.value}
                          onChange={(e) => editControl(c, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                <details>
                  <summary>ノード入力を簡易画面に追加</summary>
                  <div className="control-groups">
                    {controlGroups(controls).map((g) => (
                      <button
                        key={g.id}
                        onClick={() =>
                          setPins((p) => [...new Set([...p, ...g.keys])])
                        }
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                  <input
                    aria-label="ノード入力を検索"
                    placeholder="ノード名・設定名で検索"
                    value={controlSearch}
                    onChange={(e) => setControlSearch(e.target.value)}
                  />
                  {matchingControls(controls, controlSearch).map((c) => (
                    <label className="pin-choice" key={c.key}>
                      <input
                        type="checkbox"
                        checked={pins.includes(c.key)}
                        onChange={(e) =>
                          setPins((p) =>
                            e.target.checked
                              ? [...p, c.key]
                              : p.filter((k) => k !== c.key),
                          )
                        }
                      />
                      {c.label}
                    </label>
                  ))}
                </details>
              </section>
            )}
          </div>
          <div className="inspector-actions">
            {" "}
            <button
              className="primary generate"
              title="生成する (Ctrl+Enter)"
              disabled={!connected || busy || !ready}
              onClick={generate}
            >
              <Sparkles size={21} />
              {busy ? "生成中…" : "生成する"}
            </button>
            {activeJob && (
              <button onClick={() => cancel(activeJob)}>
                <Square size={15} />
                停止
              </button>
            )}
          </div>
        </aside>
        <Canvas
          ref={canvas}
          source={source}
          maskSource={maskSource}
          onDimensions={setSourceSize}
          onSource={newSource}
          onRemove={async () => {
            try {
              await archive();
              workflow.current = null;
              clearBindings();
              dirty.current = true;
              setCustom(false);
              newSource(null);
            } catch (e) {
              fail(e);
            }
          }}
          onError={fail}
          tool={tool}
          setTool={setTool}
          brush={brush}
          setBrush={setBrush}
          compare={compare}
          setCompare={setCompare}
        />
        <aside className={"history " + (showHistory ? "mobile-open" : "")}>
          <h2>
            履歴
            <button
              className="mobile-only"
              onClick={() => setShowHistory(false)}
              title="履歴を閉じる"
            >
              <X size={16} />
            </button>
          </h2>
          {jobs.map((job) => (
            <article key={job.id}>
              <span>
                {job.family} · {job.status}
              </span>
              {["生成中", "待機中"].includes(job.status) && (
                <button onClick={() => cancel(job.id)}>
                  <Square size={13} />
                  停止
                </button>
              )}
              {(job.images || []).map((image, i) => (
                <div key={i}>
                  <button
                    className="thumb"
                    title="生成結果を拡大"
                    onClick={() => setPreview(image)}
                  >
                    <img src={imageURL(image)} alt={job.prompt || "生成結果"} />
                  </button>
                  <div className="result-actions">
                    <button
                      title="編集に使う"
                      onClick={() => adopt(image).catch(fail)}
                    >
                      <Check size={15} />
                    </button>
                    <a
                      title="画像を保存"
                      href={imageURL(image)}
                      download={image.filename}
                    >
                      <Download size={15} />
                    </a>
                  </div>
                </div>
              ))}
              <p>{job.prompt}</p>
              {job.error && (
                <details className="job-error">
                  <summary>失敗の詳細</summary>
                  <span>{job.error}</span>
                </details>
              )}
              <button
                title="このワークフローを開く"
                onClick={async () => {
                  try {
                    await loadForeign(
                      job.workflow?.nodes ? job.workflow : job.api,
                    );
                    setMode("nodes");
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                <RotateCcw size={14} />
                再編集
              </button>
            </article>
          ))}
        </aside>
        {connected && (
          <iframe
            ref={iframe}
            className={"node-frame " + (mode === "nodes" ? "visible" : "")}
            src="/nodes"
            title="ComfyUI ノードエディター"
            inert={mode !== "nodes"}
            tabIndex={mode === "nodes" ? 0 : -1}
          />
        )}
      </div>
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button title="閉じる" onClick={() => setError("")}>
            <X size={18} />
          </button>
        </div>
      )}
      <footer>
        <span className={"status-dot " + (connected ? "online" : "")} />
        {message}
        <button
          className="mobile-only history-toggle"
          onClick={() => setShowHistory((v) => !v)}
        >
          履歴
        </button>
        <span className="footer-right">
          {ready ? "ノード連携準備完了" : ""}
        </span>
      </footer>
      {preview && (
        <ResultPreview
          image={preview}
          onClose={() => setPreview(null)}
          onAdopt={adopt}
        />
      )}
      {dialog && (
        <div className="dialog-backdrop">
          <section className="dialog" role="dialog" aria-label="設定">
            <div className="dialog-heading">
              <h2>設定</h2>
              <button title="閉じる" onClick={() => setDialog(false)}>
                <X />
              </button>
            </div>
            <fieldset disabled={!!workflow.current && !dirty.current}>
              {selections
                .filter(([key]) =>
                  key === "modelPatch"
                    ? family === "anima"
                    : key === "lora"
                      ? family === "moss"
                      : family === "sdxl"
                        ? key === "checkpoint"
                        : key !== "checkpoint",
                )
                .map(([key, label, type, input]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={settings[key] || ""}
                      onChange={(e) => {
                        update(key, e.target.value);
                        dirty.current = true;
                      }}
                    >
                      <option value="">ファイルを選択</option>
                      {modelOptions(type, input).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
            </fieldset>
            <details>
              <summary>追加LoRA・拡大</summary>
              <p>
                新しいレシピに適用します。編集済みのグラフではノード入力から調整してください。
              </p>
              <fieldset disabled={!!workflow.current && !dirty.current}>
                {extras.loras.map((l, i) => (
                  <div className="lora-row" key={i}>
                    <select
                      aria-label={`LoRA ${i + 1}`}
                      value={l.name}
                      onChange={(e) => {
                        setExtras((x) => ({
                          ...x,
                          loras: x.loras.map((v, j) =>
                            i === j ? { ...v, name: e.target.value } : v,
                          ),
                        }));
                        dirty.current = true;
                      }}
                    >
                      <option value="">LoRAを選択</option>
                      {modelOptions("LoraLoader", "lora_name").map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <input
                      aria-label={`LoRA ${i + 1} 強度`}
                      type="number"
                      step=".1"
                      min="-10"
                      max="10"
                      value={l.strength}
                      onChange={(e) => {
                        setExtras((x) => ({
                          ...x,
                          loras: x.loras.map((v, j) =>
                            i === j ? { ...v, strength: +e.target.value } : v,
                          ),
                        }));
                        dirty.current = true;
                      }}
                    />
                    <button
                      title="LoRAを外す"
                      onClick={() => {
                        setExtras((x) => ({
                          ...x,
                          loras: x.loras.filter((_, j) => j !== i),
                        }));
                        dirty.current = true;
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    setExtras((x) => ({
                      ...x,
                      loras: [...x.loras, { name: "", strength: 1 }],
                    }))
                  }
                >
                  LoRAを追加
                </button>
                <Field
                  label={
                    extras.upscaler ? "超解像後の追加倍率" : "出力の拡大倍率"
                  }
                  type="number"
                  min="1"
                  max="4"
                  step=".5"
                  value={extras.scale}
                  onChange={(v) => {
                    setExtras((x) => ({ ...x, scale: v }));
                    dirty.current = true;
                  }}
                />
                <label>
                  超解像モデル
                  <select
                    value={extras.upscaler}
                    onChange={(e) => {
                      setExtras((x) => ({ ...x, upscaler: e.target.value }));
                      dirty.current = true;
                    }}
                  >
                    <option value="">使用しない</option>
                    {modelOptions("UpscaleModelLoader", "model_name").map(
                      (v) => (
                        <option key={v}>{v}</option>
                      ),
                    )}
                  </select>
                </label>
              </fieldset>
            </details>
            <details>
              <summary>画像ツールのテンプレート</summary>
              <p>
                現在の画像から作成し、ノード画面で調整できます。元の作業は下書きに保存します。
              </p>
              <div className="dialog-actions">
                <button
                  disabled={!source}
                  onClick={() => openNodeTemplate("tools")}
                >
                  切り抜き・2倍超解像
                </button>
                <button
                  disabled={!source}
                  onClick={() => openNodeTemplate("canny")}
                >
                  SDXL・輪郭指定
                </button>
              </div>
              {!source && <p>先にキャンバスへ画像を読み込んでください。</p>}
            </details>
            {drafts.length > 0 && (
              <details>
                <summary>保存した下書き</summary>
                {drafts.map((d) => (
                  <button
                    className="draft-row"
                    key={d.id}
                    onClick={() => restoreDraft(d).catch(fail)}
                  >
                    {new Date(d.created).toLocaleString()} · {d.family}
                  </button>
                ))}
              </details>
            )}
            <div className="dialog-actions">
              <button onClick={() => file.current.click()}>
                <Upload size={16} />
                ワークフローを開く
              </button>
              <button onClick={save}>
                <Download size={16} />
                書き出す
              </button>
            </div>
            <input
              ref={file}
              hidden
              type="file"
              accept=".json"
              onChange={(e) => importWorkflow(e.target.files[0])}
            />
            <p>
              ComfyUI: {connected ? "接続済み" : "未接続"}。接続先は起動時の
              COMFY_URL で指定できます。
            </p>
            <button className="primary" onClick={() => setDialog(false)}>
              完了
            </button>
          </section>
        </div>
      )}
      {toolsOpen && (
        <ImageTools
          info={info}
          source={source}
          hasMask={!!canvas.current?.hasMask()}
          onClose={() => setToolsOpen(false)}
          onOpen={openImageTool}
          onRefresh={async () => setInfo(await api("/object_info"))}
        />
      )}
    </main>
  );
}
function Root() {
  const [stopped, setStopped] = useState(false);
  return stopped ? (
    <main className="shutdown-screen">
      <h1>Orime</h1>
      <p>終了を受け付けました。このタブを閉じてください。</p>
      <p>再起動は start-orime.bat から行えます。</p>
    </main>
  ) : (
    <App onShutdown={() => setStopped(true)} />
  );
}
createRoot(document.getElementById("root")).render(<Root />);
