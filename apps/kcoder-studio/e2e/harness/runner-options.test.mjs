import assert from "node:assert/strict";
import test from "node:test";
import { selectSuites, suiteEnvironmentNames } from "./runner-options.mjs";

const suites = [
  "suites/gateway/auth.e2e.mjs",
  "suites/browser/ssh.e2e.mjs",
  "suites/model/real-model-task.e2e.mjs",
  "suites/model/real-model-image-attachment.e2e.mjs",
];

test("bare runner stays model-independent even when the environment remains authorized", () => {
  assert.deepEqual(
    selectSuites(suites, [], { KCODER_E2E_REAL_MODEL: "1" }),
    suites.slice(0, 2),
  );
});

test("managed browser staging is an explicit option only for the workspace browser suite", () => {
  const flag = "KCODER_E2E_MANAGED_CHROMIUM";
  assert.ok(
    suiteEnvironmentNames(
      "suites/browser/right-workspace-multitool.e2e.mjs",
    ).includes(flag),
  );
  assert.equal(
    suiteEnvironmentNames("suites/browser/ssh-browser.e2e.mjs").includes(flag),
    false,
  );
});

test("Canva live registration consent is forwarded only to its explicit suite", () => {
  const flag = "KCODER_E2E_CANVA_LIVE";
  assert.ok(
    suiteEnvironmentNames(
      "suites/gateway/canva-oauth-discovery.e2e.mjs",
    ).includes(flag),
  );
  assert.equal(
    suiteEnvironmentNames("suites/gateway/mcp-oauth.e2e.mjs").includes(flag),
    false,
  );
});

test("Provider retry Mac Electron opt-in is forwarded only to its browser suite", () => {
  const flag = "KCODER_E2E_PROVIDER_RETRY_MAC_ELECTRON";
  const suite = "suites/browser/provider-retry-feedback.e2e.mjs";
  const forwarded = suiteEnvironmentNames(suite);
  assert.ok(forwarded.includes(flag));
  for (const name of ["HOME", "SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
    assert.ok(forwarded.includes(name), `${name} is required for the explicit Mac SSH target`);
    assert.equal(
      suiteEnvironmentNames("suites/browser/ssh-browser.e2e.mjs").includes(name),
      false,
      `${name} must not be forwarded to unrelated suites`,
    );
  }
  assert.equal(suiteEnvironmentNames("suites/browser/ssh-browser.e2e.mjs").includes(flag), false);
});

test("repeated-text recovery receives only its pinned Mobile export inputs", () => {
  const suite = "suites/mobile/mobile-qa-repeated-text-attachment-recovery.e2e.mjs";
  const pins = [
    "KCODER_E2E_REPEATED_TEXT_MOBILE_MANIFEST",
    "KCODER_E2E_REPEATED_TEXT_SOURCE_TREE_SHA256",
    "KCODER_E2E_REPEATED_TEXT_MANIFEST_SHA256",
    "KCODER_E2E_REPEATED_TEXT_BUNDLE_SHA256",
  ];
  const names = suiteEnvironmentNames(suite);
  for (const pin of pins) assert.ok(names.includes(pin), `${pin} must reach its suite`);
  assert.ok(
    pins.every((pin) => !suiteEnvironmentNames("suites/mobile/mobile-qa-empty-thread-lifecycle.e2e.mjs").includes(pin)),
    "frozen export pins must not be forwarded to unrelated mobile suites",
  );
});

test("real-model execution requires CLI and environment consent together", () => {
  assert.throws(
    () => selectSuites(suites, ["--real-model"], {}),
    /also requires KCODER_E2E_REAL_MODEL=1/,
  );
  assert.throws(
    () =>
      selectSuites(suites, ["--suite", "real-model-task"], {
        KCODER_E2E_REAL_MODEL: "1",
      }),
    /requires the --real-model CLI consent flag/,
  );
  assert.deepEqual(
    selectSuites(suites, ["--real-model"], { KCODER_E2E_REAL_MODEL: "1" }),
    suites,
  );
});

test("conflicting suite policies fail before any child starts", () => {
  assert.throws(
    () =>
      selectSuites(suites, ["--model-independent", "--real-model"], {
        KCODER_E2E_REAL_MODEL: "1",
      }),
    /mutually exclusive/,
  );
});

test("real-model suite ID receives only its explicit provider environment", () => {
  const realNames = suiteEnvironmentNames(
    "suites/model/real-model-task.e2e.mjs",
    {
      KCODER_E2E_MODEL_CREDENTIAL_ENV: "CUSTOM_API_KEY",
    },
  );
  assert.ok(realNames.includes("KCODER_E2E_REAL_MODEL"));
  assert.ok(realNames.includes("KCODER_E2E_MODEL_ENDPOINT"));
  assert.ok(realNames.includes("KCODER_E2E_ALLOW_INSECURE_REMOTE"));
  assert.ok(realNames.includes("CUSTOM_API_KEY"));
  assert.equal(realNames.includes("UNRELATED_API_KEY"), false);
  assert.equal(
    suiteEnvironmentNames("suites/browser/ssh.e2e.mjs", {
      KCODER_E2E_MODEL_CREDENTIAL_ENV: "CUSTOM_API_KEY",
    }).includes("CUSTOM_API_KEY"),
    false,
  );
});

test("Wine packaged smoke only receives its explicit package path", () => {
  assert.ok(
    suiteEnvironmentNames(
      "suites/gateway/windows-wine-resources.e2e.mjs",
    ).includes("KCODER_E2E_PACKAGED_DIR"),
  );
  assert.equal(
    suiteEnvironmentNames(
      "suites/gateway/runtime-target-local.e2e.mjs",
    ).includes("KCODER_E2E_PACKAGED_DIR"),
    false,
  );
});
test("owned native suites receive explicit binary and current renderer paths", () => {
  const names = suiteEnvironmentNames(
    "suites/browser/tauri-file-navigation.e2e.mjs",
  );
  assert.ok(names.includes("KCODER_E2E_TAURI_BIN"));
  assert.ok(names.includes("KCODER_E2E_RENDERER_ROOT"));
  assert.equal(
    suiteEnvironmentNames("suites/mobile/mobile-send-receipt.e2e.mjs").includes(
      "KCODER_E2E_TAURI_BIN",
    ),
    false,
  );
});
