import { beforeEach, expect, it } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { loadPendingThreadCreation, savePendingThreadCreation, clearPendingThreadCreation, pendingThreadCreationKey, linkedCreationIntent, originalCreationInput, type PendingThreadCreation } from "./pending-thread-creation";
beforeEach(() => installBrowserProfileFixture([profile]));
const key = () => pendingThreadCreationKey(profile, server, "/workspace");
function journal(): PendingThreadCreation {
  const input = { cwd: "/workspace", prompt: "original", permissionMode: "ask" as const, localAttachmentIds: ["a".repeat(32)], attachmentDraftId: "draft-original" };
  return { clientRequestId: "create-original", intent: linkedCreationIntent(input), dispatched: true, threadId: "thread-original", input };
}
it("keeps legacy unknown first turns readable without fabricating a missing payload", async () => {
  const old = { clientRequestId: "legacy-create", intent: JSON.stringify(["/workspace", "old prompt", null, null, null, null, null]), dispatched: true, threadId: "old-thread", turnDispatched: true };
  await AsyncStorage.setItem(key(), JSON.stringify(old));
  const result = await loadPendingThreadCreation(key()); expect(result).toEqual(old);
  expect(originalCreationInput(result!)).toMatchObject({ cwd: "/workspace", prompt: "old prompt" }); expect(result!.initialTurnParams).toBeUndefined();
});
it("keeps the unselected creation tuple byte-for-byte compatible and omits the expert field", async () => {
  const input = { cwd: "/workspace", prompt: "original" };
  const legacyIntent = JSON.stringify(["/workspace", "original", null, null, null, null, null]);
  expect(linkedCreationIntent(input)).toBe(legacyIntent);
  const record = { clientRequestId: "legacy-intent", intent: legacyIntent, dispatched: false, input } satisfies PendingThreadCreation;
  await savePendingThreadCreation(key(), profile.id, record);
  expect(await loadPendingThreadCreation(key())).toEqual(record);
  expect(JSON.parse((await AsyncStorage.getItem(key()))!).input).not.toHaveProperty("agentDefinition");
});
it("retains the selected generated definition reference through durable input recovery", async () => {
  const record = journal();
  const agentDefinition = { id: "expert-review", version: "v3", definitionSha256: "a".repeat(64) };
  record.input!.agentDefinition = agentDefinition;
  record.intent = linkedCreationIntent(record.input!);
  await savePendingThreadCreation(key(), profile.id, record);
  const recovered = await loadPendingThreadCreation(key());
  expect(recovered?.input?.agentDefinition).toEqual(agentDefinition);
  expect(originalCreationInput(recovered!)).toEqual(record.input);
});
it.each([
  { id: "x".repeat(257), version: "v1", definitionSha256: "a".repeat(64) },
  { id: "valid", version: "v\u0085bad", definitionSha256: "a".repeat(64) },
  { id: "valid", version: "v1", definitionSha256: "A".repeat(64) },
])("rejects an AgentDefinitionRef outside Native validity rules", async agentDefinition => {
  const input = { cwd: "/workspace", prompt: "original", agentDefinition };
  expect(() => linkedCreationIntent(input)).toThrow();
  const record: PendingThreadCreation = {
    clientRequestId: "invalid-expert",
    intent: JSON.stringify(["/workspace", "original", null, null, null, null, null, { agentDefinition }]),
    dispatched: false,
    input,
  };
  await AsyncStorage.setItem(key(), JSON.stringify(record));
  await expect(loadPendingThreadCreation(key())).rejects.toThrow();
});
it.each(["prompt", "permissionMode", "attachmentDraftId", "cwd"])("rejects corrupt persisted %s without replacing the original journal", async field => {
  const original = journal(); const corrupted = structuredClone(original); (corrupted.input as any)[field] = field === "permissionMode" ? "yolo" : "another-owner";
  await AsyncStorage.setItem(key(), JSON.stringify(corrupted));
  await expect(loadPendingThreadCreation(key())).rejects.toThrow();
  expect(await AsyncStorage.getItem(key())).toBe(JSON.stringify(corrupted));
});
it("requires exact initial thread/message/text/permission and freezes the prepared payload", async () => {
  const record = journal(); record.input!.localAttachmentIds = undefined; record.input!.attachmentDraftId = undefined; record.intent = linkedCreationIntent(record.input!);
  record.initialTurnParams = { threadId: record.threadId, clientMessageId: `${record.clientRequestId}-initial-turn`, input: [{ type: "text", text: "original" }], permissionMode: "ask" }; record.turnDispatched = true;
  await savePendingThreadCreation(key(), profile.id, record);
  expect(await loadPendingThreadCreation(key())).toEqual(record);
  await expect(savePendingThreadCreation(key(), profile.id, { ...record, initialTurnParams: { ...record.initialTurnParams, permissionMode: "yolo" } })).rejects.toThrow();
  const corrupt = structuredClone(record); corrupt.initialTurnParams!.clientMessageId = "new-message";
  await AsyncStorage.setItem(key(), JSON.stringify(corrupt)); await expect(loadPendingThreadCreation(key())).rejects.toThrow();
});
it("rejects legacy params that lost their selected attachment descriptors", async () => {
  const record = journal(); record.input!.attachmentTransport = "legacy"; record.intent = linkedCreationIntent(record.input!);
  record.initialTurnParams = { threadId: record.threadId, clientMessageId: `${record.clientRequestId}-initial-turn`, input: [{ type: "text", text: record.input!.prompt }], permissionMode: "ask" };
  await AsyncStorage.setItem(key(), JSON.stringify(record)); await expect(loadPendingThreadCreation(key())).rejects.toThrow();
});
it("preserves a newer journal when an old creation finishes cleanup late", async () => {
  const newer = { ...journal(), clientRequestId: "create-newer" };
  await savePendingThreadCreation(key(), profile.id, newer);
  await clearPendingThreadCreation(key(), "create-original");
  expect(await loadPendingThreadCreation(key())).toEqual(newer);
  await clearPendingThreadCreation(key(), "create-newer");
  expect(await loadPendingThreadCreation(key())).toBeNull();
});
