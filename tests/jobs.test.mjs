import test from "node:test";
import assert from "node:assert/strict";

test("failed jobs expose a bounded node-specific error", () => {
  const job = reconcileJob(
    { id: "bad" },
    {
      bad: {
        status: {
          status_str: "error",
          messages: [
            [
              "execution_error",
              {
                node_type: "ControlNet",
                exception_message: "Incompatible VAE " + "x".repeat(1000),
              },
            ],
          ],
        },
        outputs: {},
      },
    },
    {},
  );
  assert.match(job.error, /^ControlNet: Incompatible VAE/);
  assert.ok(job.error.length <= 600);
});
import { reconcileJob } from "../frontend/jobs.mjs";
import * as jobs from "../frontend/jobs.mjs";
import { cancelJob } from "../frontend/jobs.mjs";
import { mergeRecoveredJobs } from "../frontend/jobs.mjs";
test("delayed recovery preserves newly submitted jobs and known completion", () => {
  const current = [
    { id: "new", created: 2, status: "生成中" },
    { id: "old", created: 1, status: "完了", images: [{ filename: "a.png" }] },
  ];
  const merged = mergeRecoveredJobs(current, [
    { id: "old", created: 1, status: "未確認" },
  ]);
  assert.equal(merged[0].id, "new");
  assert.equal(merged[1].status, "完了");
  assert.equal(merged[1].images.length, 1);
  const lateReceipt = mergeRecoveredJobs(current, [
    { id: "old", status: "停止", cancelRequested: true },
  ]);
  assert.equal(lateReceipt.find((j) => j.id === "old").status, "完了");
});
test("PreviewImage results remain visible as temporary images", () => {
  const job = reconcileJob(
    { id: "a" },
    {
      a: {
        status: { completed: true },
        outputs: { 1: { images: [{ filename: "preview.png", type: "temp" }] } },
      },
    },
    {},
  );
  assert.equal(job.images[0].type, "temp");
});
test("cancellation uses the server atomic per-job endpoint", async () => {
  const sent = [];
  let queues = 0;
  const api = async (path) =>
    path === "/queue"
      ? ++queues === 1
        ? { queue_pending: [[1, "mine"]] }
        : {
            queue_running: [
              [1, "mine"],
              [2, "other"],
            ],
          }
      : {};
  await cancelJob(api, async (path, body) => sent.push([path, body]), "mine");
  assert.deepEqual(sent, [["/api/jobs/mine/cancel", {}]]);
});
test("history wins over queue and completed means actual completion", () => {
  const result = reconcileJob(
    { id: "a" },
    {
      a: {
        status: { completed: true, status_str: "success" },
        outputs: { 1: { images: [{ filename: "a.png", type: "output" }] } },
      },
    },
    { queue_running: [[1, "a"]] },
  );
  assert.equal(result.status, "完了");
  assert.equal(result.images.length, 1);
});
test("missing history is pending only while queue confirms it", () => {
  assert.equal(
    reconcileJob({ id: "a" }, {}, { queue_pending: [[1, "a"]] }).status,
    "待機中",
  );
  assert.equal(
    reconcileJob({ id: "a" }, {}, { queue_running: [[1, "a"]] }).status,
    "生成中",
  );
  assert.equal(reconcileJob({ id: "a" }, {}, {}).status, "未確認");
});
test("interrupted output is not a successful generation", () => {
  assert.equal(
    reconcileJob(
      { id: "a" },
      {
        a: {
          status: {
            completed: false,
            status_str: "error",
            messages: [["execution_interrupted", {}]],
          },
        },
      },
      {},
    ).status,
    "停止",
  );
});

test("a missing job is stopped only after acknowledged cancellation; history wins", async () => {
  const queue = { queue_running: [], queue_pending: [] };
  const api = async (path) => (path === "/queue" ? queue : {});
  const accepted = await cancelJob(
    api,
    async () => ({ cancelled: true }),
    "mine",
  );
  const refused = await cancelJob(
    api,
    async () => ({ cancelled: false }),
    "mine",
  );
  assert.equal(accepted.status, "停止");
  assert.equal(refused.status, "未確認");
  const done = await cancelJob(
    async (p) =>
      p === "/queue" ? queue : { mine: { status: { completed: true } } },
    async () => ({ cancelled: true }),
    "mine",
  );
  assert.equal(done.status, "完了");
  queue.queue_running.push([1, "mine"]);
  assert.equal(
    (await cancelJob(api, async () => ({ cancelled: true }), "mine")).status,
    "停止要求中",
  );
});

test("missing jobs stop frequent polling, while jobs in the queue remain active", () => {
  let job = { id: "gone", status: "未確認" };
  assert.equal(jobs.shouldPollJob(job), true);
  for (let i = 0; i < 10; i++)
    job = reconcileJob(job, {}, { queue_running: [], queue_pending: [] });
  assert.equal(jobs.shouldPollJob(job), false);
  job = reconcileJob(job, {}, { queue_running: [[0, "gone"]] });
  assert.equal(jobs.shouldPollJob(job), true);
});
