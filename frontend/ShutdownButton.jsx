import React, { useState } from "react";
import { Power } from "lucide-react";
import { post } from "./api.mjs";

export default function ShutdownButton({ onStopped }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        title="Orimeを終了"
        aria-label="Orimeを終了"
        disabled={pending}
        onClick={async () => {
          if (
            !window.confirm(
              "Orimeを終了しますか？\nOrimeが起動したComfyUIと生成中の処理も停止します。\n未保存の変更は失われます。既存のComfyUIや他のPythonは停止しません。",
            )
          )
            return;
          setPending(true);
          setError("");
          try {
            await post("/canvas-api/shutdown", {});
            onStopped();
          } catch (e) {
            setError(e.message);
            setPending(false);
          }
        }}
      >
        <Power size={18} />
        {pending ? "終了中…" : "終了"}
      </button>
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button aria-label="終了エラーを閉じる" onClick={() => setError("")}>
            閉じる
          </button>
        </div>
      )}
    </>
  );
}
