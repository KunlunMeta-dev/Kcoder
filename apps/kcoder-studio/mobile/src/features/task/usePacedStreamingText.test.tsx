import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePacedStreamingText } from "./usePacedStreamingText";
import { safeDisplayEnd, TEXT_PACING } from "./streaming-text-pacing";

type Input = { text: string; live: boolean; owner: object; messageId: string; fragmentId: string };
let view: ReactTestRenderer;
const initial = (): Input => ({ text: "", live: true, owner: {}, messageId: "message", fragmentId: "text" });
function Probe(props: Input) { return <span>{usePacedStreamingText(props.text, props.live, props.owner, props.messageId, props.fragmentId)}</span>; }
async function mount(props: Input) { await act(async () => { view = create(<Probe {...props} />); }); }
async function update(props: Input) { await act(async () => { view.update(<Probe {...props} />); }); }
const visible = () => view.root.findByType("span").children.join("");
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows pre-existing history and small live updates immediately", async () => {
  const input = { ...initial(), text: "Historical text".repeat(100), live: false };
  await mount(input); expect(visible()).toBe(input.text);
  await update({ ...input, live: true, text: input.text + "小增量" });
  expect(visible()).toBe(input.text + "小增量"); expect(vi.getTimerCount()).toBe(0);
});

it("reveals a burst monotonically and catches up within the display deadline", async () => {
  const input = initial(); await mount(input);
  input.text = "中文突发内容。".repeat(200);
  await update(input); expect(visible()).toBe("");
  await advance(24); const first = visible();
  expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThan(input.text.length);
  await advance(24); expect(visible().startsWith(first)).toBe(true);
  await advance(TEXT_PACING.maxLagMs - 48); expect(visible()).toBe(input.text); expect(vi.getTimerCount()).toBe(0);
});

it("continuous new chunks cannot postpone the oldest unread text indefinitely", async () => {
  const input = initial(); await mount(input); input.text = "x".repeat(1000); await update(input);
  for (let index = 0; index < 32; index++) { await advance(5); input.text += "y".repeat(20); await update(input); }
  expect(visible()).toBe(input.text); expect(vi.getTimerCount()).toBe(0);
});

it("large backlog and long Markdown bypass animation", async () => {
  const input = initial(); await mount(input); input.text = "x".repeat(TEXT_PACING.maxBacklog); await update(input);
  expect(visible()).toBe(input.text); expect(vi.getTimerCount()).toBe(0);
  input.text = "y".repeat(TEXT_PACING.maxAnimatedLength); await update(input);
  input.text += "z".repeat(600); await update(input);
  expect(visible()).toBe(input.text); expect(vi.getTimerCount()).toBe(0);
});

it.each(["finished", "stopped", "disconnected", "background", "reduced motion"])("%s immediately shows all received text and cancels the timer", async () => {
  const input = initial(); await mount(input); input.text = "x".repeat(1500); await update(input); await advance(24);
  expect(visible()).not.toBe(input.text);
  await update({ ...input, live: false }); expect(visible()).toBe(input.text); expect(vi.getTimerCount()).toBe(0);
});

it("replacements and A -> B -> A owner changes never publish the previous owner's partial text", async () => {
  const a = initial(); await mount(a); a.text = "A".repeat(1500); await update(a); await advance(24);
  const b = { ...a, owner: {}, text: "B".repeat(900) }; await update(b);
  expect(visible()).toBe(b.text); await advance(200); expect(visible()).toBe(b.text);
  await update(a); expect(visible()).toBe(a.text);
  await update({ ...a, text: "Authoritative replacement" }); expect(visible()).toBe("Authoritative replacement");
});

it("starts a new live fragment without exposing the preceding fragment", async () => {
  const input = initial(); await mount(input); input.text = "Prior answer"; await update(input);
  input.fragmentId = "next"; input.text = "N".repeat(1000); await update(input);
  expect(visible()).toBe(""); await advance(24); expect(visible()).toMatch(/^N+$/);
  await act(async () => view.unmount()); expect(vi.getTimerCount()).toBe(0);
});

it.each(["😀", "👍🏽", "👨‍👩‍👧‍👦", "e\u0301", "🇨🇳"])("does not split the visible Unicode cluster %s", cluster => {
  const text = `A${cluster}Z`;
  for (let cut = 2; cut < 1 + cluster.length; cut++) expect(safeDisplayEnd(text, cut)).toBe(1 + cluster.length);
});
