import assert from "node:assert/strict";
import test from "node:test";
import {
  armTrustedTranscriptWheelObservation,
  armTrustedTranscriptWheelObservationWithViewport,
  readTrustedTranscriptWheelObservation,
  readTrustedTranscriptWheelTargetAtPoint,
  readTranscriptViewport,
} from "./mobile-session-cache-transcript-scroll-host.mjs";
import { buildColdProcessAnchorPrompt } from "./mobile-session-cache-user-anchor.mjs";


class FakeHTMLElement {
  constructor({ id = "", testId = null, tagName = "DIV", scrollHeight = 0, clientHeight = 0, scrollTop = 0, overflowY = "visible", rect = {} } = {}) {
    this.id = id;
    this.testId = testId;
    this.tagName = tagName;
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.scrollTop = scrollTop;
    this.overflowY = overflowY;
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...rect };
    this.children = [];
    this.parentElement = null;
    this.listeners = [];
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(target) {
    for (let current = target; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (selector === '[id^="message-"]' && current.id.startsWith("message-")) return current;
    }
    return null;
  }

  querySelectorAll(selector) {
    const testIdBySelector = new Map([
      ['[data-testid="message-user"], [data-testid="message-assistant"]', new Set(["message-user", "message-assistant"])],
      ['[data-testid="message-user"]', new Set(["message-user"])],
      ['[data-testid="message-assistant"]', new Set(["message-assistant"])],
    ]);
    const acceptedTestIds = testIdBySelector.get(selector);
    if (!acceptedTestIds) return [];
    return descendants(this).filter(element => acceptedTestIds.has(element.testId));
  }

  getBoundingClientRect() { return this.rect; }
  getAttribute(name) { return name === "data-testid" ? this.testId : null; }
  hasAttribute(name) { return name === "data-testid" && this.testId !== null; }
  addEventListener(type, callback, options) { this.listeners.push({ type, callback, options }); }
  removeEventListener(type, callback) {
    this.listeners = this.listeners.filter(listener => listener.type !== type || listener.callback !== callback);
  }
}

class FakeTextNode {
  constructor(nodeValue, parentElement) {
    this.nodeValue = nodeValue;
    this.parentElement = parentElement;
  }
}

function descendants(root) {
  return root.children.flatMap(child => child instanceof FakeHTMLElement
    ? [child, ...descendants(child)]
    : []);
}

function fixture({ echoedPrompt = false, unwrappedUser = false, duplicateUser = false, userText = null } = {}) {
  const promptMarker = "SESSION_CACHE_PROMPT_COLD_V3";
  const userMessageText = userText ?? promptMarker;
  const list = new FakeHTMLElement({
    id: "message-list-root",
    testId: "message-list",
    scrollHeight: 6_200,
    clientHeight: 820,
    scrollTop: 116,
    overflowY: "auto",
    rect: { top: 90, bottom: 910, left: 30, right: 900, width: 870, height: 820 },
  });
  const toolRow = list.append(new FakeHTMLElement({
    id: "message-tool",
    rect: { top: 250, bottom: 520, left: 50, right: 850, width: 800, height: 270 },
  }));
  const toolBubble = new FakeHTMLElement({ testId: "message-assistant" });
  toolBubble.append(new FakeTextNode("tool output", null));
  toolRow.append(toolBubble);
  const boundedOutput = toolRow.append(new FakeHTMLElement({
    testId: "bounded-output",
    scrollHeight: 12_000,
    clientHeight: 240,
    overflowY: "auto",
  }));
  const tailRow = list.append(new FakeHTMLElement({
    id: "message-tail",
    rect: { top: 130, bottom: 190, left: 50, right: 850, width: 800, height: 60 },
  }));
  const tailBubble = tailRow.append(new FakeHTMLElement({ testId: "message-assistant" }));
  tailBubble.append(new FakeTextNode("visible tui-lab-final-sentinel tail", tailBubble));
  if (echoedPrompt) tailBubble.append(new FakeTextNode(`I received your message: ${promptMarker}`, tailBubble));
  const userRow = unwrappedUser ? list : list.append(new FakeHTMLElement({
    id: "message-user-row",
    rect: { top: 210, bottom: 258, left: 50, right: 850, width: 800, height: 48 },
  }));
  const userBubble = userRow.append(new FakeHTMLElement({ testId: "message-user" }));
  userBubble.append(new FakeTextNode(userMessageText, userBubble));
  let duplicateUserRow = null;
  if (duplicateUser) {
    duplicateUserRow = list.append(new FakeHTMLElement({
      id: "message-user-duplicate",
      rect: { top: 300, bottom: 348, left: 50, right: 850, width: 800, height: 48 },
    }));
    duplicateUserRow.append(new FakeHTMLElement({ testId: "message-user" }))
      .append(new FakeTextNode(promptMarker, null));
  }

  const rows = new Map([
    [list.id, list], [toolRow.id, toolRow], [tailRow.id, tailRow], ["message-user-row", userRow],
    ...(duplicateUserRow ? [["message-user-duplicate", duplicateUserRow]] : []),
  ]);
  const ranges = [];
  const documentListeners = [];
  const document = {
    querySelector: selector => selector === '[data-testid="message-list"]' ? list : null,
    querySelectorAll: () => [],
    getElementById: id => rows.get(id) ?? null,
    elementFromPoint: () => userBubble,
    addEventListener(type, callback, options) { documentListeners.push({ type, callback, options }); },
    removeEventListener(type, callback) {
      for (let index = documentListeners.length - 1; index >= 0; index--) {
        if (documentListeners[index].type === type && documentListeners[index].callback === callback) {
          documentListeners.splice(index, 1);
        }
      }
    },
    async dispatchTrustedWheel(deltaY) {
      const event = {
        isTrusted: true,
        cancelable: true,
        defaultPrevented: false,
        target: userBubble,
        deltaY,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const listener of list.listeners.filter(row => row.type === "wheel" && row.options?.capture)) {
        listener.callback(event);
      }
      // Model a microtask checkpoint after capture but before the host bubble listener.
      await Promise.resolve();
      list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, list.scrollTop - deltaY));
      event.preventDefault();
      for (const listener of documentListeners.filter(row => row.type === "scroll" && row.options === true)) {
        listener.callback({ target: list });
      }
      return event.defaultPrevented;
    },
    createTreeWalker(root) {
      const texts = [];
      const visit = element => {
        for (const child of element.children) {
          if (child instanceof FakeTextNode) texts.push(child);
          else visit(child);
        }
      };
      visit(root);
      let index = 0;
      return { nextNode: () => texts[index++] ?? null };
    },
    createRange() {
      const range = {
        startContainer: null,
        startOffset: null,
        endContainer: null,
        endOffset: null,
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        getBoundingClientRect: () => ({ top: 145, bottom: 164, left: 210, right: 440, width: 230, height: 19 }),
        getClientRects: () => [{}],
      };
      ranges.push(range);
      return range;
    },
  };
  const window = { innerWidth: 1280, innerHeight: 960 };
  const page = {
    evaluate: async (callback, argument) => withBrowserGlobals({
      document,
      window,
      HTMLElement: FakeHTMLElement,
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: element => ({
        overflowY: element.overflowY,
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
      requestAnimationFrame: callback => {
        queueMicrotask(() => callback(1));
        return 1;
      },
    }, () => callback(argument)),
  };
  return { page, list, boundedOutput, window, ranges, userMessageText, userBubble };
}

async function withBrowserGlobals(replacements, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.hasOwn(globalThis, name) ? globalThis[name] : undefined);
    globalThis[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test("atomic wheel arm returns current viewport after a prepared offset changes from 30 to 0", async () => {
  const input = fixture();
  const options = { markerText: "SESSION_CACHE_PROMPT_COLD_V3", rowDomId: "message-user-row", rowTestId: "message-user" };
  input.list.scrollTop = 30;
  const prepared = await readTranscriptViewport(input.page, options);
  input.list.scrollTop = 0;
  const evaluate = input.page.evaluate;
  let evaluations = 0;
  input.page.evaluate = (...args) => { evaluations += 1; return evaluate(...args); };

  const armed = await armTrustedTranscriptWheelObservationWithViewport(input.page, options);

  assert.equal(evaluations, 1, "arming and viewport capture must share one page evaluation");
  assert.equal(prepared.host.scrollTop, 30, "preparation evidence must remain unchanged");
  assert.equal(armed.rowDomId, prepared.rowDomId);
  assert.equal(armed.rowMatchCount, 1);
  assert.equal(armed.markerTextMatchCount, 1);
  assert.equal(armed.host.scrollTop, 0);
  assert.deepEqual(armed.wheelStart, { scrollTop: 0, scrollHeight: 6_200, clientHeight: 820 });
  assert.equal(armed.host.scrollHeight, armed.wheelStart.scrollHeight);
  assert.equal(armed.host.clientHeight, armed.wheelStart.clientHeight);
  assert.deepEqual(await armTrustedTranscriptWheelObservation(input.page, options), armed.wheelStart,
    "the legacy arm API must preserve its original wheelStart-only shape");
  assert.equal(evaluations, 2, "legacy arming must also require exactly one page evaluation");
  assert.equal(input.list.listeners.filter(listener => listener.type === "wheel").length, 1);
});

test("uses the real message-list ancestor for a row and tail marker, not the larger nested output scroll range", async () => {
  const input = fixture();
  assert.ok(input.boundedOutput.scrollHeight - input.boundedOutput.clientHeight >
    input.list.scrollHeight - input.list.clientHeight);

  const toolGeometry = await readTranscriptViewport(input.page, { rowDomId: "message-tool", rowTestId: "message-assistant" });
  const tailGeometry = await readTranscriptViewport(input.page, { markerText: "tui-lab-final-sentinel", rowTestId: "message-assistant" });

  assert.equal(toolGeometry.host.testId, "message-list");
  assert.equal(tailGeometry.host.testId, "message-list");
  assert.equal(toolGeometry.host.scrollTop, 116);
  assert.equal(toolGeometry.rowDomId, "message-tool");
  assert.equal(tailGeometry.rowDomId, "message-tail");
  assert.equal(tailGeometry.markerIntersectsList, true);
  assert.equal(tailGeometry.markerIntersectsWindow, true);

  const wheelStart = await armTrustedTranscriptWheelObservation(input.page, {
    rowDomId: "message-tool", rowTestId: "message-assistant",
  });
  assert.deepEqual(wheelStart, { scrollTop: 116, scrollHeight: 6_200, clientHeight: 820 });
  assert.equal(input.list.listeners.length, 1);
  assert.equal(input.list.listeners[0].type, "wheel");
  assert.equal(input.list.listeners[0].options.capture, true);
});

test("scopes a repeated prompt marker to the unique user row and its exact DOM identity", async () => {
  const input = fixture({ echoedPrompt: true });
  const promptMarker = "SESSION_CACHE_PROMPT_COLD_V3";

  const globalGeometry = await readTranscriptViewport(input.page, { markerText: promptMarker });
  assert.equal(globalGeometry.rowMatchCount, 2, "the fixture intentionally echoes the prompt in the assistant row");
  assert.equal(globalGeometry.markerTextMatchCount, 2);

  const userGeometry = await readTranscriptViewport(input.page, {
    markerText: promptMarker,
    rowTestId: "message-user",
  });
  assert.equal(userGeometry.rowMatchCount, 1);
  assert.equal(userGeometry.markerTextMatchCount, 1);
  assert.equal(userGeometry.rowDomId, "message-user-row");

  const rowAndRoleGeometry = await readTranscriptViewport(input.page, {
    markerText: promptMarker,
    rowDomId: "message-user-row",
    rowTestId: "message-user",
  });
  assert.equal(rowAndRoleGeometry.rowMatchCount, 1);
  assert.equal(rowAndRoleGeometry.markerTextMatchCount, 1);
  assert.equal(rowAndRoleGeometry.rowDomId, userGeometry.rowDomId);
  const wheelStart = await armTrustedTranscriptWheelObservation(input.page, {
    markerText: promptMarker,
    rowDomId: userGeometry.rowDomId,
    rowTestId: "message-user",
  });
  assert.deepEqual(wheelStart, { scrollTop: 116, scrollHeight: 6_200, clientHeight: 820 });

  const wrongRole = await readTranscriptViewport(input.page, {
    markerText: promptMarker,
    rowDomId: "message-user-row",
    rowTestId: "message-assistant",
  });
  assert.equal(wrongRole.rowMatchCount, 0, "a scoped row must contain exactly one requested role bubble");
  assert.equal(wrongRole.markerTextMatchCount, 0);
});

test("measures the exact trusted-wheel hit path and observes dispatch/default-scroll evidence", async () => {
  const input = fixture();
  const wheelStart = await armTrustedTranscriptWheelObservation(input.page, {
    markerText: "SESSION_CACHE_PROMPT_COLD_V3",
    rowDomId: "message-user-row",
    rowTestId: "message-user",
  });
  const target = await readTrustedTranscriptWheelTargetAtPoint(input.page, { x: 240, y: 220 });
  assert.equal(target.targetInsideList, true);
  assert.equal(target.targetIsHost, false);
  assert.equal(target.pathReachesHost, true);
  assert.deepEqual(target.targetPath.map(entry => [entry.tagName, entry.testId, entry.isHost, entry.rnwScrollable]), [
    ["DIV", "message-user", false, false],
    ["DIV", null, false, false],
    ["DIV", "message-list", true, true],
  ]);
  assert.equal(JSON.stringify(target).includes("SESSION_CACHE_PROMPT"), false,
    "wheel hit evidence must not record user text or a message DOM id");
  assert.equal(wheelStart.scrollTop, 116);

  await input.page.evaluate(async () => {
    await document.dispatchTrustedWheel(16);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const audit = await readTrustedTranscriptWheelObservation(input.page);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].isTrusted, true);
  assert.equal(audit.events[0].defaultPreventedAtCapture, false);
  assert.equal(audit.events[0].defaultPreventedAfterDispatch, true);
  assert.equal(audit.events[0].hostScrollTopAtCapture, 116);
  assert.equal(audit.events[0].hostScrollTopAfterDispatch, 100);
  assert.equal(audit.events[0].hostScrollTopAfterFrame, 100);
  assert.deepEqual(audit.scrollSamples.map(sample => sample.hostScrollTop), [100, 100]);
});

test("measures the exact prompt marker Range inside one ordinary user Text node", async () => {
  const promptMarker = "SESSION_CACHE_PROMPT_COLD_V3";
  const promptText = buildColdProcessAnchorPrompt(promptMarker);
  const input = fixture({ userText: promptText });
  const geometry = await readTranscriptViewport(input.page, {
    markerText: promptMarker,
    rowTestId: "message-user",
  });

  assert.equal(input.userMessageText, promptText);
  assert.equal(geometry.rowMatchCount, 1);
  assert.equal(geometry.markerTextMatchCount, 1);
  assert.equal(geometry.markerVisible, true);
  assert.equal(geometry.markerIntersectsWindow, true);
  assert.equal(geometry.markerIntersectsList, true);
  assert.equal(input.ranges.length, 1);
  assert.equal(input.ranges[0].startContainer.nodeValue, promptText);
  assert.equal(input.ranges[0].startOffset, promptText.indexOf(promptMarker));
  assert.equal(input.ranges[0].endContainer, input.ranges[0].startContainer);
  assert.equal(input.ranges[0].endOffset, promptText.indexOf(promptMarker) + promptMarker.length);
});

test("keeps duplicate matches within one role ambiguous", async () => {
  const input = fixture({ duplicateUser: true });
  const geometry = await readTranscriptViewport(input.page, {
    markerText: "SESSION_CACHE_PROMPT_COLD_V3",
    rowTestId: "message-user",
  });

  assert.equal(geometry.rowMatchCount, 2);
  assert.equal(geometry.markerTextMatchCount, 2);
});

test("never mistakes a message-prefixed list container for a message row", async () => {
  const input = fixture({ unwrappedUser: true });
  const geometry = await readTranscriptViewport(input.page, {
    markerText: "SESSION_CACHE_PROMPT_COLD_V3",
    rowTestId: "message-user",
  });

  assert.equal(geometry.rowMatchCount, 1);
  assert.equal(geometry.rowDomId, null, "without an actual message row ID, the enclosing message-list ID is not returned");
  const container = await readTranscriptViewport(input.page, {
    rowDomId: "message-list-root",
    rowTestId: "message-user",
  });
  assert.equal(container.rowMatchCount, 0, "the list cannot satisfy an exact message row lookup");
});

test("rejects unsupported row role scopes before evaluating page DOM", async () => {
  let evaluated = false;
  const page = { evaluate: async () => { evaluated = true; } };
  await assert.rejects(readTranscriptViewport(page, { markerText: "prompt", rowTestId: "message-list" }),
    /row scope must be message-user or message-assistant/);
  assert.equal(evaluated, false);
});
