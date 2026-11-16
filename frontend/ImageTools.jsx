import React, { useState } from "react";
import { imageTools, toolFields } from "./custom-tools.mjs";

export default function ImageTools({
  info,
  source,
  hasMask,
  onClose,
  onOpen,
  onRefresh,
}) {
  const [selected, setSelected] = useState("canny"),
    [values, setValues] = useState({}),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const tool = imageTools.find((t) => t.id === selected);
  let fields = [],
    schemaError = "";
  try {
    fields = toolFields(selected, info);
  } catch (e) {
    schemaError = e.message;
  }
  async function open() {
    setPending(true);
    setError("");
    try {
      await onOpen(selected, values);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="画像ツール"
        className="dialog image-tools-dialog"
      >
        <div className="dialog-heading">
          <h2>画像ツール</h2>
          <button
            disabled={pending}
            onClick={onClose}
            aria-label="画像ツールを閉じる"
          >
            閉じる
          </button>
        </div>
        <label className="field-row">
          処理
          <select
            disabled={pending}
            aria-label="画像処理"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setValues({});
              setError("");
            }}
          >
            {imageTools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {info[t.type] ? "" : " · 未導入"}
              </option>
            ))}
          </select>
        </label>
        <div className="tool-origin">
          <a href={tool.url} target="_blank" rel="noreferrer">
            {tool.pack} ↗
          </a>
          <button
            disabled={pending}
            onClick={async () => {
              try {
                await onRefresh();
                setError("");
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            接続を更新
          </button>
        </div>
        {schemaError ? (
          <p role="status">
            {schemaError}。配布元の手順で導入し、ComfyUIを再起動してください。
          </p>
        ) : (
          <div className="tool-fields">
            {fields.map((f) => (
              <label className="field-row" key={f.key}>
                {f.label}
                {f.choices ? (
                  <select
                    disabled={pending}
                    aria-label={f.label}
                    value={values[f.key] ?? f.value}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                  >
                    {f.choices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : f.type === "BOOLEAN" ? (
                  <input
                    disabled={pending}
                    aria-label={f.label}
                    type="checkbox"
                    checked={values[f.key] ?? f.value}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.checked }))
                    }
                  />
                ) : (
                  <input
                    disabled={pending}
                    aria-label={f.label}
                    type={f.type === "STRING" ? "text" : "number"}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={values[f.key] ?? f.value}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [f.key]:
                          f.type === "STRING"
                            ? e.target.value
                            : Number(e.target.value),
                      }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
        )}
        {tool.download && (
          <p className="binding-note">
            初回の実行時に追加モデルをダウンロードする場合があります。
          </p>
        )}
        {!source && <p>先にキャンバスへ画像を読み込んでください。</p>}
        {tool.mask && !hasMask && <p>先にブラシで範囲を塗ってください。</p>}
        {error && <p role="alert">{error}</p>}
        <p className="binding-note">
          元の作業を下書きに保存し、処理用の設定をキャンバスに開きます。
        </p>
        <button
          className="primary"
          disabled={
            pending || !source || !!schemaError || (tool.mask && !hasMask)
          }
          onClick={open}
        >
          {pending ? "準備中…" : "キャンバスで開く"}
        </button>
      </section>
    </div>
  );
}
