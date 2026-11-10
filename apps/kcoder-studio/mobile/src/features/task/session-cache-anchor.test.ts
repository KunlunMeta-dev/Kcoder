import { expect, it } from "vitest";
import { confirmedSessionAnchor, displayedSessionAnchor } from "./session-cache-anchor";

const raw = { id: "raw", role: "assistant", turnId: "turn", attemptId: "attempt" };
const live = { ...raw, id: "live" };
const marker = { messageId: "live", offset: 31, followsLatest: false };
it("maps a unique explicit source both ways and preserves only row-top offset", () => {
  const canonical = confirmedSessionAnchor(marker, [live], [raw], [raw]);
  expect(canonical).toEqual({ ...marker, messageId: "raw" });
  expect(displayedSessionAnchor(canonical!, [live], [raw], [raw])).toEqual(marker);
  expect(confirmedSessionAnchor({ ...marker, messageId: "raw" }, [raw], [raw], [raw])).toEqual(canonical);
});
it.each(["role", "turnId", "attemptId"] as const)("rejects exact-ID %s conflicts", key => {
  const conflicting = { ...raw, [key]: "other" };
  expect(confirmedSessionAnchor({ ...marker, messageId: "raw" }, [conflicting], [raw], [raw])).toBeUndefined();
  expect(displayedSessionAnchor({ ...marker, messageId: "raw" }, [conflicting], [raw], [raw])).toBeUndefined();
});
it("rejects duplicate IDs, multiple raw sources and multiple coalesced display rows", () => {
  expect(confirmedSessionAnchor(marker, [live, live], [raw], [raw])).toBeUndefined();
  expect(confirmedSessionAnchor(marker, [live], [raw, raw], [raw])).toBeUndefined();
  expect(confirmedSessionAnchor(marker, [live], [raw], [raw, raw])).toBeUndefined();
  expect(confirmedSessionAnchor(marker, [live], [raw, { ...raw, id: "raw2" }], [raw])).toBeUndefined();
  expect(displayedSessionAnchor({ ...marker, messageId: "raw" }, [live, { ...live, id: "live2" }], [raw], [raw])).toBeUndefined();
});
it("requires explicit nonempty turn and attempt, never synthetic ID or body inference", () => {
  for (const incomplete of [{ ...raw, attemptId: undefined }, { ...raw, turnId: "" }, { ...raw, attemptId: " " }])
    expect(confirmedSessionAnchor(marker, [live], [incomplete], [incomplete])).toBeUndefined();
});
it("requires canonical presence in the current page and retained projection", () => {
  expect(confirmedSessionAnchor(marker, [live], [raw], [])).toBeUndefined();
  expect(displayedSessionAnchor({ ...marker, messageId: "raw" }, [live], [{ ...raw, id: "replacement" }], [raw])).toBeUndefined();
  expect(displayedSessionAnchor({ ...marker, messageId: "raw" }, [live], [raw], [])).toBeUndefined();
});
it("accepts only an explicit runtime string clientMessageId for a unique user source", () => {
  const user = { id: "user-raw", role: "user", clientMessageId: "client-message" };
  const shown = { ...user, id: "local-display" };
  expect(confirmedSessionAnchor({ ...marker, messageId: shown.id }, [shown], [user], [user])?.messageId).toBe(user.id);
  for (const value of [undefined, 7, {}, "", " "])
    expect(confirmedSessionAnchor({ ...marker, messageId: shown.id }, [{ ...shown, clientMessageId: value }], [user], [user])).toBeUndefined();
});
