export async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok)
    throw Error(typeof data === "string" ? data : JSON.stringify(data));
  return data;
}
export const post = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export function download(name, data, type = "application/json") {
  const url = URL.createObjectURL(
    data instanceof Blob
      ? data
      : new Blob(
          [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
          { type },
        ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const imageURL = (image) =>
  "/view?" +
  new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
export async function upload(blob, name) {
  const form = new FormData();
  form.append("image", blob, name);
  form.append("overwrite", "false");
  const result = await api("/upload/image", { method: "POST", body: form });
  return (result.subfolder ? result.subfolder + "/" : "") + result.name;
}
export function createBridge(frame, onReady) {
  const pending = new Map();
  const listener = (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.current?.contentWindow ||
      event.data?.source !== "aikimi-bridge"
    )
      return;
    const { id, result, error } = event.data;
    if (id === "ready") {
      onReady();
      return;
    }
    const call = pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(id);
    error ? call.reject(Error(error)) : call.resolve(result);
  };
  window.addEventListener("message", listener);
  return {
    call(action, payload = {}) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            Error(
              "ノード画面との接続を確認してください。ComfyUIの読み込みが完了していません。",
            ),
          );
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        frame.current?.contentWindow?.postMessage(
          { source: "orime", id, action, payload },
          location.origin,
        );
      });
    },
    dispose() {
      window.removeEventListener("message", listener);
      for (const c of pending.values()) {
        clearTimeout(c.timer);
        c.reject(Error("接続を閉じました"));
      }
    },
  };
}
