// Actual hook/timer in a controlled hook host; mounted React and Native remain separate gates.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
const host = vi.hoisted(() => ({ revision: 0, ticks: 0, effect: undefined as undefined | (() => void | (() => void)) }));
vi.mock("react", () => ({
  useState: () => [host.revision, (update: (value: number) => number) => { host.revision = update(host.revision); host.ticks++; }],
  useEffect: (effect: () => void | (() => void)) => { host.effect = effect; },
}));
import { useCacheProfileReadable } from "./useCacheProfileReadable";
const profile: GatewayProfile = { id: "p", baseUrl: "https://gateway.example", label: "P", accessToken: "synthetic", rpcToken: "synthetic", expiresAt: 1100 };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); host.revision = host.ticks = 0; host.effect = undefined; });
afterEach(() => vi.useRealTimers());
it("nonrenewable expiry schedules its own hide update without another input render", async () => {
  expect(useCacheProfileReadable(profile, false)).toBe(true);
  const cleanup = host.effect!();
  await vi.advanceTimersByTimeAsync(100);
  expect(host.ticks).toBe(1);
  expect(useCacheProfileReadable(profile, false)).toBe(false);
  if (cleanup) cleanup();
});
it("token/expiry rotation reschedules the deadline while a renewable offline profile stays readable", async () => {
  useCacheProfileReadable(profile, false); const cleanup = host.effect!();
  if (cleanup) cleanup();
  const rotated = { ...profile, accessToken: "rotated", expiresAt: 1300 };
  expect(useCacheProfileReadable(rotated, false)).toBe(true); const nextCleanup = host.effect!();
  await vi.advanceTimersByTimeAsync(100); expect(host.ticks).toBe(0);
  await vi.advanceTimersByTimeAsync(200); expect(host.ticks).toBe(1);
  if (nextCleanup) nextCleanup();
  expect(useCacheProfileReadable({ ...profile, authMode: "device", refreshToken: "refresh", refreshExpiresAt: 1600 }, false)).toBe(true);
  const finalCleanup = host.effect!();
  await vi.advanceTimersByTimeAsync(300);
  expect(host.ticks).toBe(2);
  expect(useCacheProfileReadable({ ...profile, authMode: "device", refreshToken: "refresh", refreshExpiresAt: 1600 }, false)).toBe(false);
  if (finalCleanup) finalCleanup();
});


it("refresh deadline rotation postpones the last-credential expiry without changing identity", async () => {
  const original = { ...profile, authMode: "device" as const, refreshToken: "refresh", expiresAt: 1050, refreshExpiresAt: 1100 };
  expect(useCacheProfileReadable(original, false)).toBe(true); const cleanup = host.effect!();
  if (cleanup) cleanup();
  const rotated = { ...original, refreshToken: "rotated", refreshExpiresAt: 1200 };
  expect(useCacheProfileReadable(rotated, false)).toBe(true); const nextCleanup = host.effect!();
  await vi.advanceTimersByTimeAsync(100); expect(host.ticks).toBe(0);
  await vi.advanceTimersByTimeAsync(100); expect(host.ticks).toBe(1);
  expect(useCacheProfileReadable(rotated, false)).toBe(false);
  if (nextCleanup) nextCleanup();
});
