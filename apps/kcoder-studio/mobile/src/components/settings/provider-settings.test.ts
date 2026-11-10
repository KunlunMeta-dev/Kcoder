import { describe, expect, test } from "vitest";
import {
  makeProviderUpsertParams,
  providerProbeErrorCategory,
  providerSaveOutcomeUnknown,
  positiveInteger,
  safeProviderEndpointLabel,
  providerTemplateDraft,
  type ProviderSettingsDraft,
  type ProviderTemplate,
} from "./provider-settings";
import { settingsModelsEn } from "@/i18n/locales/settings-models.en";
import { settingsModelsZhCN } from "@/i18n/locales/settings-models.zh-CN";

const template: ProviderTemplate = {
  id: "fixture-provider",
  displayName: "Fixture provider",
  apiFormat: "openai_chat_completions",
  endpoint: "http://127.0.0.1:8000/v1",
  documentationUrl: "http://127.0.0.1:8000/docs",
};

function draft(patch: Partial<ProviderSettingsDraft> = {}): ProviderSettingsDraft {
  return {
    ...providerTemplateDraft(template),
    model: "fixture-model",
    contextWindowTokens: "32000",
    maxOutputTokens: "4096",
    ...patch,
  };
}

describe("provider settings wire values", () => {
  test("templates leave model limits blank until the user supplies documented values", () => {
    const value = providerTemplateDraft(template);
    expect(value.model).toBe("");
    expect(value.contextWindowTokens).toBe("");
    expect(value.maxOutputTokens).toBe("");
    expect(value.makeDefault).toBe(false);
  });

  test("accepts only positive safe integer model limits", () => {
    expect(positiveInteger("32000")).toBe(32_000);
    expect(positiveInteger("")).toBeNull();
    expect(positiveInteger("0")).toBeNull();
    expect(positiveInteger("1.5")).toBeNull();
    expect(positiveInteger("999999999999999999999")).toBeNull();
  });

  test("omits an empty API key so an edit keeps its saved credential", () => {
    const params = makeProviderUpsertParams(draft(), 32_000, 4_096, {
      expectedRevision: "fixture-revision",
      independentProbe: true,
      supportsAuthenticationPolicy: false,
      supportsModelCapabilities: false,
      supportsMultipleModels: false,
    });
    expect(params).not.toHaveProperty("apiKey");
    expect(params).toMatchObject({
      id: "fixture-provider",
      model: "fixture-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
      expectedRevision: "fixture-revision",
      validateConnection: false,
    });
  });

  test("sends only a newly entered key and never substitutes a configured-key placeholder", () => {
    const params = makeProviderUpsertParams(draft({ apiKey: "new-fixture-key" }), 32_000, 4_096, {
      independentProbe: false,
      supportsAuthenticationPolicy: true,
      supportsModelCapabilities: false,
      supportsMultipleModels: false,
    });
    expect(params.apiKey).toBe("new-fixture-key");
    expect(JSON.stringify(params)).not.toContain("••••");
  });

  test("distinguishes unknown mutation delivery from a request that was not sent", () => {
    expect(providerSaveOutcomeUnknown(Object.assign(new Error("transport closed"), { delivery: "unknown" }))).toBe(true);
    expect(providerSaveOutcomeUnknown(Object.assign(new Error("target changed"), { delivery: "not-sent" }))).toBe(false);
    expect(providerProbeErrorCategory(new Error("[provider_probe_authentication] fixture-secret"))).toBe("authentication");
  });

  test("redacts URL credentials, query strings, and fragments from provider rows", () => {
    const value = safeProviderEndpointLabel("https://user:secret@example.invalid/v1?token=fixture-secret#key");
    expect(value).not.toContain("secret");
    expect(value).not.toContain("fixture-secret");
    expect(value).toContain("redacted");
  });
});

test("model service locale resources expose the same flat keys and explain required limits", () => {
  expect(Object.keys(settingsModelsEn).sort()).toEqual(Object.keys(settingsModelsZhCN).sort());
  expect(settingsModelsEn["settings_models.capabilities_optional"]).toBe("Optional model capabilities");
  expect(settingsModelsZhCN["settings_models.capabilities_optional"]).toBe("可选模型能力");
  expect(settingsModelsEn["settings_models.limits_help"]).toContain("documented");
  expect(settingsModelsZhCN["settings_models.limits_required"]).toContain("文档");
});
