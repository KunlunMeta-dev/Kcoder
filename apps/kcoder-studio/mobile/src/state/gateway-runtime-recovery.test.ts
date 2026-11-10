import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGatewayRuntimeRecovery, type GatewayRecoveryState } from "./gateway-runtime-recovery";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const state: GatewayRecoveryState = { failed: true, refreshing: false, blocked: false };
  const host = { foreground: true };
  const refresh = vi.fn(async () => {});
  const recovery = createGatewayRuntimeRecovery({ read: () => state, isForeground: () => host.foreground, refresh });
  return { state, host, refresh, recovery };
}

it("retries transient failures with bounded backoff and stops once reads recover", async () => {
  const { state, refresh, recovery } = fixture();
  recovery.changed();
  let calls = 0;
  for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1); expect(refresh).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1); expect(refresh).toHaveBeenCalledTimes(++calls);
  }
  state.failed = false; recovery.changed();
  await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledTimes(calls);
  recovery.dispose();
});

it("coalesces browser restore and online events into one immediate read", async () => {
  const { state, refresh, recovery } = fixture(); state.failed = false;
  recovery.wake(); recovery.wake(); recovery.changed();
  await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledOnce();
  recovery.dispose();
});

it("pauses while hidden or offline and immediately reconciles on return", async () => {
  const { host, refresh, recovery } = fixture(); recovery.changed();
  host.foreground = false; recovery.sleep();
  await vi.advanceTimersByTimeAsync(60_000); expect(refresh).not.toHaveBeenCalled();
  host.foreground = true; recovery.wake(); await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledOnce(); recovery.dispose();
});

it("does not overlap a pending read or refresh an owner awaiting authorization", async () => {
  const { state, refresh, recovery } = fixture();
  let complete!: () => void;
  refresh.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  recovery.wake(); await vi.advanceTimersByTimeAsync(0);
  recovery.wake(); recovery.changed(); await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce();
  state.blocked = true; recovery.changed(); complete(); await vi.advanceTimersByTimeAsync(60_000);
  recovery.wake(); await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledOnce();
  recovery.dispose();
});

it("joins ordinary refresh ownership and cancels retries on owner removal", async () => {
  const { state, refresh, recovery } = fixture(); state.refreshing = true;
  recovery.changed(); recovery.wake(); await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled(); state.refreshing = false; recovery.changed();
  recovery.dispose(); await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled();
});

it("ignores a late rejected read from a disposed owner", async () => {
  const { refresh, recovery } = fixture(); let reject!: (error: Error) => void;
  refresh.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  recovery.wake(); await vi.advanceTimersByTimeAsync(0); recovery.dispose();
  reject(new Error("old Gateway")); await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
