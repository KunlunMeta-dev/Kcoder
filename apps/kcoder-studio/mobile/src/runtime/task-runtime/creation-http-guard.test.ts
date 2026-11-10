import { afterEach, expect, it, vi } from "vitest";
const owned = vi.hoisted(() => ({ linkedRead: vi.fn() }));
vi.mock("@/storage/pending-thread-creation", async importOriginal => ({ ...await importOriginal<typeof import("@/storage/pending-thread-creation")>(), readWorkspaceTaskHandoff: owned.linkedRead }));
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { profile, server } from "./fixture.test-support";
import { canCoordinateDeviceAuthorization, canCoordinateLegacyCreation } from "@/storage/context-lock";
import { setLocale, t } from "@/i18n";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); taskRuntimeTestHelpers.resetConnector(); owned.linkedRead.mockReset(); });
it("does not turn an IDB-capable insecure context into an unfenced legacy thread/start path", async () => {
  vi.stubGlobal("document", {}); vi.stubGlobal("navigator", {}); vi.stubGlobal("indexedDB", { open() { throw new Error("not needed by early guard"); } }); setLocale("en");
  expect(canCoordinateDeviceAuthorization()).toBe(true); expect(canCoordinateLegacyCreation()).toBe(false);
  const connect = vi.fn(); taskRuntimeTestHelpers.setConnector(connect);
  await expect(TaskRuntime.create({ profile, server, cwd: "/owned-unlinked", prompt: "must not dispatch" })).rejects.toThrow(t("new.original_open_identity_unverified"));
  expect(connect).not.toHaveBeenCalled(); expect(owned.linkedRead).not.toHaveBeenCalled();
});
it("leaves linked V2 creation on its original source verification path without demanding Web Locks", async () => {
  vi.stubGlobal("document", {}); vi.stubGlobal("navigator", {}); vi.stubGlobal("indexedDB", { open() { throw new Error("not needed by receipt boundary fixture"); } });
  const connect = vi.fn().mockRejectedValue(new Error("owned V2 source verification boundary")); taskRuntimeTestHelpers.setConnector(connect);
  const handoff = { key: "owned-v2-key", clientRequestId: "owned-create", receiptId: "owned-receipt" };
  await expect(TaskRuntime.create({ profile, server, cwd: "/owned-linked", prompt: "must verify the original receipt", workspaceHandoff: handoff })).rejects.toThrow("owned V2 source verification boundary");
  expect(connect).toHaveBeenCalledOnce(); expect(owned.linkedRead).not.toHaveBeenCalled();
});
