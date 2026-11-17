import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createLatestMcpProgress } from "./LatestMcpProgress.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("keeps one active delivery and only the latest pending value out of 1000 notifications", async () => {
  const release = deferred();
  const latest = deferred();
  const delivered: number[] = [];
  let active = 0;
  let peak = 0;
  const progress = createLatestMcpProgress(async (value) => {
    active++;
    peak = Math.max(peak, active);
    delivered.push(value.progress);
    if (value.progress === 1) await release.promise;
    if (value.progress === 1000) latest.resolve();
    active--;
  });
  for (let i = 1; i <= 1000; i++) progress.push({ progress: i });
  expect(delivered).toEqual([1]);
  release.resolve();
  await latest.promise;
  await progress.finish();
  expect(peak).toBe(1);
  expect(delivered).toEqual([1, 1000]);
});

it("drops pending progress at completion and waits for the active delivery", async () => {
  const release = deferred();
  const order: number[] = [];
  const progress = createLatestMcpProgress(async (value) => {
    await release.promise;
    order.push(value.progress);
  });
  for (let i = 1; i <= 1000; i++) progress.push({ progress: i });
  const finish = progress.finish().then(() => order.push(0));
  progress.push({ progress: 1001 });
  expect(order).toEqual([]);
  release.resolve();
  await finish;
  expect(order).toEqual([1, 0]);
  progress.push({ progress: 1002 });
  expect(order).toEqual([1, 0]);
});

it("stops after a failed delivery and surfaces the failure at completion", async () => {
  const failure = new Error("delivery failed");
  const send = vi.fn(async () => {
    throw failure;
  });
  const progress = createLatestMcpProgress(send);
  progress.push({ progress: 1 });
  progress.push({ progress: 2 });
  await expect(progress.finish()).rejects.toBe(failure);
  expect(send).toHaveBeenCalledOnce();
});
