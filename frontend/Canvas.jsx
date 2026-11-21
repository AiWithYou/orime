import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";
import {
  Download,
  Plus,
  Minus,
  ImagePlus,
  Undo2,
  Trash2,
  Eraser,
  Scan,
  Maximize,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import { maskAlpha } from "./graph.mjs";
import { clampZoom } from "./editor-controls.mjs";

export default forwardRef(function Canvas(
  {
    source,
    maskSource,
    onDimensions,
    onSource,
    onRemove,
    onError,
    tool,
    setTool,
    brush,
    setBrush,
    compare,
    setCompare,
  },
  ref,
) {
  const base = useRef(),
    mask = useRef(),
    box = useRef(),
    file = useRef(),
    undo = useRef([]),
    drawing = useRef(false),
    last = useRef(),
    loaded = useRef(false),
    dragDepth = useRef(0);
  const [size, setSize] = useState([1024, 1024]),
    [zoom, setZoom] = useState(1),
    [fit, setFit] = useState(0.5),
    [painted, setPainted] = useState(false),
    [dragging, setDragging] = useState(false),
    [cursor, setCursor] = useState(null);
  useEffect(() => {
    loaded.current = false;
    if (!source) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      if (image.width * image.height > 21_000_000) {
        onSource(null);
        onError(Error("編集画像は21MP以下にしてください。"));
        return;
      }
      setSize([image.width, image.height]);
      onDimensions([image.width, image.height]);
      for (const c of [base.current, mask.current]) {
        c.width = image.width;
        c.height = image.height;
      }
      base.current.getContext("2d").drawImage(image, 0, 0);
      undo.current = [];
      setPainted(false);
      setZoom(1);
      if (maskSource) {
        const saved = new Image();
        saved.onload = () => {
          if (!active) return;
          const context = mask.current.getContext("2d");
          context.drawImage(saved, 0, 0, image.width, image.height);
          const pixels = context.getImageData(0, 0, image.width, image.height);
          let any = false;
          for (let i = 0; i < pixels.data.length; i += 4) {
            const alpha = 255 - pixels.data[i + 3];
            pixels.data[i] = 168;
            pixels.data[i + 1] = 230;
            pixels.data[i + 2] = 207;
            pixels.data[i + 3] = alpha;
            if (alpha) any = true;
          }
          context.putImageData(pixels, 0, 0);
          setPainted(any);
          loaded.current = true;
        };
        saved.onerror = () => {
          if (active)
            onError(
              Error(
                "保存したマスク画像が見つかりません。ComfyUIの入力フォルダーを確認してください。",
              ),
            );
        };
        saved.src = maskSource;
      } else loaded.current = true;
    };
    image.onerror = () => {
      if (active) {
        onSource(null);
        onError(
          Error(
            "画像を読み込めませんでした。PNG・JPEGなどの画像を選んでください。",
          ),
        );
      }
    };
    image.src = source;
    return () => {
      active = false;
    };
  }, [source, maskSource]);
  useEffect(() => {
    const observer = new ResizeObserver(([e]) =>
      setFit(
        Math.max(
          0.05,
          Math.min(
            (e.contentRect.width - 32) / size[0],
            (e.contentRect.height - 64) / size[1],
            1,
          ),
        ),
      ),
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [size]);
  async function load(f) {
    if (!f?.type.startsWith("image/")) return;
    if (f.size > 64 * 1024 * 1024)
      return onError(Error("画像は64MB以下にしてください"));
    const reader = new FileReader();
    reader.onload = () => onSource(reader.result);
    reader.readAsDataURL(f);
  }
  function point(e) {
    const r = mask.current.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * size[0]) / r.width,
      ((e.clientY - r.top) * size[1]) / r.height,
    ];
  }
  function stroke(e) {
    if (!drawing.current) return;
    const p = point(e),
      c = mask.current.getContext("2d");
    c.globalCompositeOperation =
      tool === "erase" ? "destination-out" : "source-over";
    c.strokeStyle = "#a8e6cf";
    c.lineWidth = brush;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(...last.current);
    c.lineTo(...p);
    c.stroke();
    last.current = p;
    if (tool === "brush") setPainted(true);
  }
  function start(e) {
    if (!source || !["brush", "erase"].includes(tool)) return;
    setCompare(false);
    mask.current.setPointerCapture(e.pointerId);
    undo.current.push(
      mask.current.getContext("2d").getImageData(0, 0, ...size),
    );
    const limit = Math.max(
      1,
      Math.min(12, Math.floor((64 * 1024 * 1024) / (size[0] * size[1] * 4))),
    );
    while (undo.current.length > limit) undo.current.shift();
    drawing.current = true;
    last.current = point(e);
    const c = mask.current.getContext("2d");
    c.globalCompositeOperation =
      tool === "erase" ? "destination-out" : "source-over";
    c.fillStyle = "#a8e6cf";
    c.beginPath();
    c.arc(...last.current, brush / 2, 0, Math.PI * 2);
    c.fill();
    if (tool === "brush") setPainted(true);
  }
  function undoMask() {
    const previous = undo.current.pop();
    if (previous) mask.current.getContext("2d").putImageData(previous, 0, 0);
    refreshPainted();
  }
  function finishStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "erase") refreshPainted();
  }
  function refreshPainted() {
    setPainted(
      mask.current
        .getContext("2d")
        .getImageData(0, 0, ...size)
        .data.some((v, i) => i % 4 === 3 && v),
    );
  }
  function clearMaskWithUndo() {
    if (!source || !painted) return;
    undo.current.push(
      mask.current.getContext("2d").getImageData(0, 0, ...size),
    );
    mask.current.getContext("2d").clearRect(0, 0, ...size);
    setPainted(false);
  }
  function updateCursor(e) {
    if (!mask.current) return;
    const r = mask.current.getBoundingClientRect();
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
  }
  useImperativeHandle(ref, () => ({
    undo: undoMask,
    fit: () => setZoom(1),
    hasMask: () => painted,
    async imageBlob(withMask = false, fullMask = false) {
      if (!source) return null;
      if (!loaded.current)
        throw Error(
          "編集画像を読み込み中です。読み込み完了後に操作してください。",
        );
      const out = document.createElement("canvas");
      out.width = size[0];
      out.height = size[1];
      const ctx = out.getContext("2d");
      ctx.drawImage(base.current, 0, 0);
      if (withMask) {
        const pixels = ctx.getImageData(0, 0, ...size),
          m = mask.current.getContext("2d").getImageData(0, 0, ...size);
        for (let i = 3; i < pixels.data.length; i += 4)
          pixels.data[i] = fullMask ? 0 : maskAlpha(m.data[i]);
        ctx.putImageData(pixels, 0, 0);
      }
      return new Promise((resolve) => out.toBlob(resolve, "image/png"));
    },
    clearMask() {
      mask.current.getContext("2d").clearRect(0, 0, ...size);
      setPainted(false);
    },
    size,
  }));
  return (
    <>
      <nav className="tools" aria-label="画像ツール">
        <button title="画像を読み込む" onClick={() => file.current.click()}>
          <ImagePlus />
          <span>
            画像を
            <br />
            読み込む
          </span>
        </button>
        {source && (
          <button title="画像を外して新しいレシピへ" onClick={onRemove}>
            <X size={18} />
            <span>画像を外す</span>
          </button>
        )}
        <hr />
        <button
          className={tool === "brush" ? "selected" : ""}
          title="選択ブラシ (B)"
          aria-label="選択ブラシ"
          aria-pressed={tool === "brush"}
          onClick={() => setTool("brush")}
        >
          <Scan />
          <span>
            選択
            <br />
            ブラシ
          </span>
        </button>
        <button
          className={tool === "erase" ? "selected" : ""}
          title="消去 (E)"
          aria-label="消去"
          aria-pressed={tool === "erase"}
          onClick={() => setTool("erase")}
        >
          <Eraser />
          <span>消去</span>
        </button>
        <button
          title="マスクを隠す"
          aria-label="マスクを隠す"
          aria-pressed={compare}
          className={compare ? "selected" : ""}
          disabled={!source}
          onClick={() => setCompare((value) => !value)}
        >
          {compare ? <EyeOff /> : <Eye />}
          <span>マスク表示</span>
        </button>
        <hr />
        <button
          title="マスクを元に戻す (Ctrl+Z)"
          aria-label="マスクを元に戻す"
          onClick={undoMask}
        >
          <Undo2 />
          <span>元に戻す</span>
        </button>
        <button
          title="マスクを全消去"
          aria-label="マスクを全消去"
          disabled={!source || !painted}
          onClick={clearMaskWithUndo}
        >
          <Trash2 />
          <span>全消去</span>
        </button>
      </nav>
      <section
        className={"canvas-space" + (dragging ? " dragging" : "")}
        ref={box}
        onWheel={(e) => {
          if (!source || !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          setZoom((z) => clampZoom(z + (e.deltaY < 0 ? 0.15 : -0.15)));
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          load(e.dataTransfer.files[0]);
        }}
      >
        {dragging && (
          <div className="drop-overlay" aria-hidden="true">
            <span>画像をドロップして読み込む</span>
          </div>
        )}
        <input
          type="file"
          accept="image/*"
          hidden
          ref={file}
          onChange={(e) => {
            load(e.target.files[0]);
            e.target.value = "";
          }}
        />
        {!source && (
          <button className="dropzone" onClick={() => file.current.click()}>
            <Download size={48} />
            <strong>画像をドロップ</strong>
            <span>またはプロンプトから描きはじめる</span>
          </button>
        )}
        <div
          className="image-stage"
          style={{
            display: source ? "block" : "none",
            width: size[0] * fit * zoom,
            height: size[1] * fit * zoom,
          }}
        >
          <canvas ref={base} />
          <canvas
            className="mask"
            style={{ opacity: compare ? 0 : 0.55 }}
            ref={mask}
            onPointerDown={(e) => {
              updateCursor(e);
              start(e);
            }}
            onPointerMove={(e) => {
              updateCursor(e);
              stroke(e);
            }}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            onPointerLeave={() => setCursor(null)}
          />
          {cursor && source && ["brush", "erase"].includes(tool) && (
            <div
              className={"brush-cursor " + tool}
              aria-hidden="true"
              style={{
                left: cursor.x,
                top: cursor.y,
                width: Math.max(4, brush * fit * zoom),
                height: Math.max(4, brush * fit * zoom),
              }}
            />
          )}
        </div>
        <div className="zoom">
          {source && (
            <span className="resolution-pill" title="画像解像度">
              {size[0]}×{size[1]}
            </span>
          )}
          {source && (
            <div className="brush-controls">
              <span>ブラシ</span>
              <input
                aria-label="ブラシの太さ"
                type="range"
                min="4"
                max="180"
                value={brush}
                onChange={(e) => setBrush(+e.target.value)}
              />
              <input
                aria-label="ブラシの太さを数値で指定"
                type="number"
                min="4"
                max="180"
                value={brush}
                onChange={(e) =>
                  setBrush(Math.max(4, Math.min(180, +e.target.value)))
                }
              />
            </div>
          )}

          <button
            title="縮小"
            onClick={() => setZoom((z) => clampZoom(z - 0.25))}
          >
            <Minus size={16} />
          </button>
          <span>{Math.round(fit * zoom * 100)}%</span>
          <button
            title="拡大"
            onClick={() => setZoom((z) => clampZoom(z + 0.25))}
          >
            <Plus size={16} />
          </button>
          <i />
          <button onClick={() => setZoom(1)}>
            <Maximize size={14} />
            フィット
          </button>
        </div>
      </section>
    </>
  );
});
