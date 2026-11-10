import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTargetPluginList,
  readTargetSkillList,
  setTargetPluginEnabled,
  setTargetSkillEnabled,
  type TargetSettingsRequest,
} from "@/storage/target-extensions";

const request = vi.fn();
const send: TargetSettingsRequest = (method, params) => request(method, params);

describe("target extension protocol helpers", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads the target plugin inventory and real diagnostics", async () => {
    request.mockResolvedValueOnce({
      plugins: [{ id: "fixture.ext", name: "Fixture", enabled: true }],
      diagnostics: [{ code: "manifest_warning", message: "Fixture-only warning" }],
    });
    await expect(readTargetPluginList(send)).resolves.toEqual({
      plugins: [{ id: "fixture.ext", name: "Fixture", enabled: true }],
      diagnostics: [{ code: "manifest_warning", message: "Fixture-only warning" }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("plugin/list", { all: true });
  });

  it("requests disabled skills through the advertised activation API", async () => {
    request.mockResolvedValueOnce({
      items: [{ name: "fixture-skill", description: "Fixture", enabled: false, userInvocable: true }],
      appliesToNewConversations: true,
    });
    await expect(readTargetSkillList(send)).resolves.toEqual({
      items: [{ name: "fixture-skill", description: "Fixture", enabled: false, userInvocable: true }],
      appliesToNewConversations: true,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("skills/list", { includeDisabled: true });
  });

  it("does not turn malformed list responses into empty inventories", async () => {
    request.mockResolvedValueOnce({ diagnostics: [] });
    await expect(readTargetPluginList(send)).rejects.toThrow(/invalid plugin list/);
    request.mockResolvedValueOnce({ items: [] });
    await expect(readTargetSkillList(send)).rejects.toThrow(/invalid skill list/);
  });

  it("only toggles an already-listed plugin and validates its target receipt", async () => {
    request.mockResolvedValueOnce({
      plugin: { id: "fixture.ext", name: "Fixture", enabled: false },
      changed: true,
    });
    await expect(setTargetPluginEnabled(send, "fixture.ext", false)).resolves.toMatchObject({
      id: "fixture.ext",
      enabled: false,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("plugin/disable", { pluginId: "fixture.ext" });
    await expect(setTargetPluginEnabled(send, " ", true)).rejects.toThrow(/plugin ID/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requires a matching skill activation receipt", async () => {
    request.mockResolvedValueOnce({
      name: "fixture-skill",
      enabled: false,
      appliesToNewConversations: true,
    });
    await expect(setTargetSkillEnabled(send, "fixture-skill", false)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledExactlyOnceWith("skills/setEnabled", {
      name: "fixture-skill",
      enabled: false,
    });
    request.mockResolvedValueOnce({ name: "other-skill", enabled: false, appliesToNewConversations: true });
    await expect(setTargetSkillEnabled(send, "fixture-skill", false)).rejects.toThrow(/invalid skill activation receipt/);
  });
});
