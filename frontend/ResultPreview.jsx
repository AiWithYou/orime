import React, { useEffect, useRef, useState } from "react";
import { imageURL } from "./api.mjs";

export default function ResultPreview({ image, onClose, onAdopt }) {
  const dialog = useRef();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="result-preview"
      aria-label="生成結果"
      onClose={onClose}
    >
      <div className="dialog-heading">
        <h2>生成結果</h2>
        <button autoFocus onClick={() => dialog.current.close()}>
          閉じる
        </button>
      </div>
      <img
        src={imageURL(image)}
        alt="生成結果"
        onError={() =>
          setError("画像を読み込めません。保存先を確認してください。")
        }
      />
      {error && <p role="alert">{error}</p>}
      <div className="preview-actions">
        <a href={imageURL(image)} download={image.filename}>
          画像を保存
        </a>
        <button
          className="primary"
          disabled={pending || !!error}
          onClick={async () => {
            setPending(true);
            try {
              await onAdopt(image);
              dialog.current?.close();
            } catch (e) {
              setError(e.message);
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "読み込み中…" : "編集に使う"}
        </button>
      </div>
    </dialog>
  );
}
