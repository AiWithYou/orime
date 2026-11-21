function executionError(status) {
  const failure = status?.messages?.find(
    ([type]) => type === "execution_error",
  )?.[1];
  return failure
    ? `${failure.node_type || "生成"}: ${failure.exception_message || "処理に失敗しました"}`.slice(
        0,
        600,
      )
    : "";
}
export function reconcileJob(job, history, queue) {
  job = { ...job, receiptChecked: true };
  const h = history[job.id];
  if (h) {
    const interrupted = h.status?.messages?.some(
      ([type]) => type === "execution_interrupted",
    );
    const status = interrupted
      ? "停止"
      : h.status?.status_str === "error"
        ? "失敗"
        : h.status?.completed
          ? "完了"
          : "生成中";
    const images = Object.values(h.outputs || {})
      .flatMap((o) => o.images || [])
      .filter((i) => ["output", "temp"].includes(i.type));
    return {
      ...job,
      status,
      images,
      error: executionError(h.status),
      missingChecks: 0,
    };
  }
  const contains = (items) => items?.some((item) => item[1] === job.id);
  const running = contains(queue.queue_running);
  const waiting = contains(queue.queue_pending);
  if (running || waiting)
    return {
      ...job,
      status: job.cancelRequested
        ? "停止要求中"
        : running
          ? "生成中"
          : "待機中",
      missingChecks: 0,
    };
  const queueKnown =
    Array.isArray(queue.queue_running) && Array.isArray(queue.queue_pending);
  if (job.cancelRequested)
    return {
      ...job,
      status: queueKnown ? "停止" : "停止要求中",
      missingChecks: 0,
    };
  return {
    ...job,
    status: "未確認",
    missingChecks: (job.missingChecks || 0) + 1,
  };
}
export const pendingJob = (job) =>
  ["生成中", "待機中", "停止要求中", "未確認"].includes(job.status);
export const shouldPollJob = (job) =>
  (job.cancelRequested && job.status === "停止" && !job.receiptChecked) ||
  (pendingJob(job) &&
    (job.status !== "未確認" || (job.missingChecks || 0) < 3));
export function mergeRecoveredJobs(current, recovered) {
  const byId = new Map(current.map((j) => [j.id, j]));
  for (const record of recovered) {
    const r = {
      ...record,
      error: record.error || executionError(record.execution_status),
    };
    const existing = byId.get(r.id);
    const keepLive =
      existing &&
      (["完了", "失敗"].includes(existing.status) ||
        (existing.status === "停止" && pendingJob(r)) ||
        (r.status === "未確認" && existing.status !== "未確認"));
    byId.set(r.id, keepLive ? { ...r, ...existing } : { ...existing, ...r });
  }
  return [...byId.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
}
export async function cancelJob(api, post, id) {
  const reply = await post(
    "/api/jobs/" + encodeURIComponent(id) + "/cancel",
    {},
  );
  const job = { id, cancelRequested: reply?.cancelled === true };
  try {
    const [history, queue] = await Promise.all([
      api("/history/" + encodeURIComponent(id)),
      api("/queue"),
    ]);
    return reconcileJob(job, history, queue);
  } catch (error) {
    if (!job.cancelRequested) throw error;
    return { ...job, status: "停止要求中" };
  }
}
