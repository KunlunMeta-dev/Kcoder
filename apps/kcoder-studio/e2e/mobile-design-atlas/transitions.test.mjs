import assert from "node:assert/strict";
import { test } from "node:test";
import { currentCases } from "./current-catalog.mjs";
import { currentTransitions, resolvedTransition, validateTransitions } from "./current-transitions.mjs";
import { transitionHtml, transitionMarkdown } from "./transition-view.mjs";
import { aiBrief, indexPage, statePage } from "./pages.mjs";

test("every current specimen has valid entry and outgoing references, without inventing unsampled pages", () => {
  validateTransitions(currentCases);
  const broken = structuredClone(currentTransitions);
  broken["CHAT-01"].next[0].id = "NOT-CAPTURED";
  assert.throws(() => validateTransitions(currentCases, broken), /Invalid transition reference/);
  const missing = structuredClone(currentTransitions);
  delete missing["CHAT-01"];
  assert.throws(() => validateTransitions(currentCases, missing), /coverage/);
  for (const [id] of currentCases) {
    const value = resolvedTransition(id, currentCases);
    for (const node of [...value.from, ...value.next]) assert.ok(node.label);
  }
});

test("send receipts and subagent outcomes are conditional events, not a mandatory happy-path sequence", () => {
  assert.equal(currentTransitions["SEND-sending"].trigger.kind, "event");
  assert.deepEqual(currentTransitions["SEND-sending"].next.map(node => [node.kind, node.id]), [
    ["event", "SEND-accepted"], ["event", "SEND-unknown"], ["event", "SEND-failed"],
  ]);
  assert.match(currentTransitions["SEND-unknown"].note, /不能盲目重发/);
  assert.equal(currentTransitions["AGENT-01"].from[0].id, "MENU-02");
  assert.ok(currentTransitions["AGENT-09"].next.some(node => node.id === "AGENT-02" && node.kind === "event"));
  assert.ok(currentTransitions["FILTER-01"].from[0].unsampled);
});

test("offline HTML, live viewer and AI brief retain the same chain, safe text and real neighbor links", () => {
  const state = { id: "AGENT-09", title: '<img src=x onerror="alert(1)">', transition: resolvedTransition("AGENT-09", currentCases),
    version: "V3", captureDate: "2026-10-26", evidence: "synthetic", freshness: "本次组件采样", condition: "fixture", can: [], constraints: [], concepts: [], variants: [] };
  state.transition.trigger.steps.push("</script><script>alert(1)</script>");
  const html = transitionHtml(state);
  assert.ok(html.includes('data-state="AGENT-01"'));
  assert.ok(html.includes('aria-label="状态触发链"'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img"));
  const standalone = statePage(state, [], "");
  assert.ok(standalone.includes('href="./AGENT-01.html"'));
  assert.ok(!standalone.includes('data-state="AGENT-01"'));
  assert.ok(aiBrief(state, []).includes(transitionMarkdown(state)));
  const data = { states: [state], groups: [], imageCount: 0, createdAt: "today" };
  const index = indexPage(data, "", "");
  assert.ok(index.includes("window.renderAtlasTransition="));
  assert.ok(!index.includes("</script><script>alert(1)</script>"));
  // The browser uses the exact serialized function, without module dependencies.
  const browserRenderer = Function(`return (${transitionHtml.toString()})`)();
  assert.equal(browserRenderer(state), html);
});
