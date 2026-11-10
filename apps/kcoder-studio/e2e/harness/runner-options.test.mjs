import assert from "node:assert/strict";
import test from "node:test";
import { selectSuites, suiteEnvironmentNames } from "./runner-options.mjs";

test('owned native search suites forward only their explicit frozen fixture identity', () => {
  for (const suite of ['suites/browser/web-search-positive-native.e2e.mjs',
    'suites/gateway/web-search-native-faults.e2e.mjs', 'suites/gateway/web-search-native-policy-revoke.e2e.mjs']) {
    const names = suiteEnvironmentNames(suite);
    for (const name of ['KCODER_E2E_SEARCH_NATIVE_BIN','KCODER_E2E_SEARCH_NATIVE_SHA256','KCODER_E2E_SEARCH_NATIVE_CHECKPOINT'])
      assert.ok(names.includes(name));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_SEARCH_NATIVE_BIN'),false);
});
import { manualLiveSuites, modelIndependentSuites } from "../suite-registry.mjs";

test('independent channels use ordinary tasks and retired Native SDK suites stay unregistered', () => {
  assert.ok(modelIndependentSuites.includes('suites/gateway/independent-channel-task.e2e.mjs'));
  for (const retired of ['native-channel-task-protocol', 'native-channel-ui-peer-protocol', 'native-channel-windows-scope',
    'native-channel-directory', 'native-channel-gateway-owner', 'native-channel-weixin-context-recovery']) {
    const suite = `suites/gateway/${retired}.e2e.mjs`;
    assert.equal(modelIndependentSuites.includes(suite), false);
    assert.equal(manualLiveSuites.includes(suite), false);
  }
  assert.equal(modelIndependentSuites.includes('suites/browser/feishu-bound-task-live-process.e2e.mjs'), false);
  for (const name of ['KCODER_E2E_CHANNEL_TASK_TEST_BIN', 'KCODER_E2E_NATIVE_CHANNEL_PROTOCOL_CASE'])
    assert.equal(suiteEnvironmentNames('suites/gateway/independent-channel-task.e2e.mjs').includes(name), false);
});

test('pinned startup comparisons require explicit selection and preserve their input identity', () => {
  const suites = [
    'suites/browser/web-startup-baseline-zero-business.e2e.mjs',
    'suites/browser/web-startup-current-zero-business.e2e.mjs',
  ];
  for (const suite of suites) {
    assert.ok(manualLiveSuites.includes(suite));
    assert.equal(modelIndependentSuites.includes(suite), false);
    const names = suiteEnvironmentNames(suite);
    for (const name of ['KCODER_E2E_STARTUP_BIN', 'KCODER_E2E_STARTUP_SHA256', 'KCODER_E2E_RENDERER_ROOT'])
      assert.ok(names.includes(name));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_STARTUP_BIN'), false);
});

test('draft model discovery stays in the existing provider settings suite', () => {
  const flag = 'KCODER_E2E_PROVIDER_DISCOVERY_ONLY';
  assert.ok(suiteEnvironmentNames('suites/browser/provider-settings-persistence.e2e.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('reviewed Agent adaptation stays in registered Web migration suites with pinned Native and Mobile sources', () => {
  const flag = 'KCODER_E2E_MIGRATION_AGENT_ADAPTATION_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs', 'suites/mobile/migration.e2e.mjs']) {
    const names = suiteEnvironmentNames(suite);
    assert.ok(names.includes(flag));
    assert.ok(names.includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.ok(suiteEnvironmentNames('suites/mobile/migration.e2e.mjs').includes('KCODER_E2E_MOBILE_SOURCE_ROOT'));
});

test('terminal private acceptance remains in the registered terminal suite with pinned Native identity', () => {
  const flag = 'KCODER_E2E_MIGRATION_TERMINAL_PRIVATE_ONLY';
  const names = suiteEnvironmentNames('suites/gateway/migration-terminal-transfer.e2e.mjs');
  assert.ok(names.includes(flag)); assert.ok(names.includes('KCODER_E2E_KCODER_BIN_SHA256'));
  for (const suite of ['suites/browser/migration.e2e.mjs', 'suites/mobile/migration.e2e.mjs', 'suites/gateway/auth.e2e.mjs'])
    assert.equal(suiteEnvironmentNames(suite).includes(flag), false);
});

test('project MCP acceptance stays scoped to the registered two Web migration clients', () => {
  const flag = 'KCODER_E2E_MIGRATION_PROJECT_MCP_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs', 'suites/mobile/migration.e2e.mjs']) assert.ok(suiteEnvironmentNames(suite).includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('scoped-instruction acceptance stays in registered migration clients and terminal and pins Native identity', () => {
  const flag = 'KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY';
  for (const suite of ['suites/mobile/migration.e2e.mjs', 'suites/browser/migration.e2e.mjs', 'suites/gateway/migration-terminal-transfer.e2e.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes(flag));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('family-index acceptance is scoped to the two existing migration suites only', () => {
  const flag = 'KCODER_E2E_MIGRATION_HISTORY_FAMILIES_ONLY';
  assert.ok(suiteEnvironmentNames('suites/mobile/migration.e2e.mjs').includes(flag));
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

const suites = [
  "suites/gateway/auth.e2e.mjs",
  "suites/browser/ssh.e2e.mjs",
  "suites/model/real-model-task.e2e.mjs",
  "suites/model/real-model-image-attachment.e2e.mjs",
];

test('uploaded-plugin acceptance uses only the registered two Web migration suites and pins Native', () => {
  const flag = 'KCODER_E2E_MIGRATION_UPLOADED_PLUGINS_ONLY';
  for (const suite of ['suites/mobile/migration.e2e.mjs', 'suites/browser/migration.e2e.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes(flag));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.ok(suiteEnvironmentNames('suites/mobile/migration.e2e.mjs').includes('KCODER_E2E_MIGRATION_MOBILE_ARCHIVE'));
  assert.ok(!suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MIGRATION_MOBILE_ARCHIVE'));
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_RENDERER_ROOT'));
});

test("the explicit history-source boundary reaches only the registered browser migration suite", () => {
  const flag = "KCODER_E2E_MIGRATION_HISTORY_SOURCE_ONLY";
  assert.ok(suiteEnvironmentNames("suites/browser/migration.e2e.mjs").includes(flag));
  assert.equal(suiteEnvironmentNames("suites/mobile/migration.e2e.mjs").includes(flag), false);
  assert.equal(suiteEnvironmentNames("suites/browser/ssh.e2e.mjs").includes(flag), false);
});

test("the Mobile directory-consumer boundary does not affect unrelated registered suites", () => {
  const flag = "KCODER_E2E_MIGRATION_SOURCE_DIRECTORY_ONLY";
  assert.ok(suiteEnvironmentNames("suites/mobile/migration.e2e.mjs").includes(flag));
  assert.equal(suiteEnvironmentNames("suites/browser/migration.e2e.mjs").includes(flag), false);
  assert.equal(suiteEnvironmentNames("suites/browser/ssh.e2e.mjs").includes(flag), false);
});

test('the private-credential boundary is confined to the two registered migration Web suites', () => {
  const flag = 'KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY';
  assert.ok(suiteEnvironmentNames('suites/mobile/migration.e2e.mjs').includes(flag));
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.ok(suiteEnvironmentNames('suites/mobile/migration.e2e.mjs').includes('KCODER_E2E_MOBILE_SOURCE_ROOT'));
  assert.equal(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MOBILE_SOURCE_ROOT'), false);
});

test("Windows archive retention forwards its explicit frozen native scope only to that suite", () => {
  const suite = "suites/gateway/windows-archive-retention.e2e.mjs";
  const names = suiteEnvironmentNames(suite);
  for (const key of ["KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_RETENTION_SCOPE"]) assert.ok(names.includes(key));
  assert.equal(suiteEnvironmentNames("suites/gateway/windows-plugin-migration.e2e.mjs").includes("KCODER_E2E_WINDOWS_RETENTION_SCOPE"), false);
  assert.equal(names.includes("KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK"), false);
});

test('Windows read path modes are forwarded only for the two explicit registered read subscopes', () => {
  const suite = 'suites/gateway/windows-archive-retention.e2e.mjs', flag = 'KCODER_E2E_WINDOWS_READ_PATH_MODE';
  for (const scope of ['read-tools', 'read-engine']) assert.ok(suiteEnvironmentNames(suite, { KCODER_E2E_WINDOWS_RETENTION_SCOPE: scope }).includes(flag));
  for (const scope of [undefined, 'config', 'private-credentials', 'uploaded-product']) assert.equal(suiteEnvironmentNames(suite, { KCODER_E2E_WINDOWS_RETENTION_SCOPE: scope }).includes(flag), false);
  assert.equal(suiteEnvironmentNames('suites/gateway/windows-cross-host-source.e2e.mjs', { KCODER_E2E_WINDOWS_RETENTION_SCOPE: 'read-tools' }).includes(flag), false);
});

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

test("caller-pinned Mobile cache gates receive only their required archive and Rust pins", () => {
  const suites = [
    "suites/mobile/mobile-session-cache-event-continuity.e2e.mjs",
    "suites/mobile/mobile-session-cache-multirealm.e2e.mjs",
    "suites/mobile/mobile-session-cache-unknown-offline-v1.e2e.mjs",
    "suites/mobile/mobile-session-cache-workspace-absence.e2e.mjs",
    "suites/mobile/mobile-session-cache-permission-revocation.e2e.mjs",
  ];
  const pins = [
    "KCODER_E2E_KCODER_BIN_SHA256",
    "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE",
    "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256",
    "KCODER_E2E_MOBILE_SOURCE_ROOT",
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST",
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256",
  ];
  for (const suite of suites) {
    const names = suiteEnvironmentNames(suite);
    for (const pin of pins) assert.ok(names.includes(pin), `${pin} must reach ${suite}`);
  }
  const unrelated = "suites/mobile/mobile-session-cache-recovery.e2e.mjs";
  assert.ok(pins.every(pin => !suiteEnvironmentNames(unrelated).includes(pin)),
    "the new gate's archive and source pins must not be forwarded to other Mobile suites");
  const permissionSuite = "suites/mobile/mobile-session-cache-permission-revocation.e2e.mjs";
  const permissionNames = suiteEnvironmentNames(permissionSuite);
  assert.ok(permissionNames.includes("KCODER_E2E_KCODER_BIN"),
    "the permission gate needs the caller-selected Rust executable path");
  assert.equal(permissionNames.includes("KCODER_E2E_REAL_MODEL"), false,
    "the permission gate must not receive real-model consent by default");
  assert.equal(permissionNames.includes("KCODER_E2E_MODEL_CREDENTIAL_VALUE"), false,
    "the permission gate must not receive model credentials");
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
    "suites/browser/electron-file-navigation.e2e.mjs",
  );
  assert.ok(names.includes("KCODER_E2E_ELECTRON_BIN"));
  assert.ok(names.includes("KCODER_E2E_RENDERER_ROOT"));
  assert.equal(
    suiteEnvironmentNames("suites/mobile/mobile-send-receipt.e2e.mjs").includes(
      "KCODER_E2E_ELECTRON_BIN",
    ),
    false,
  );
});

test("widget native suites receive only their explicitly owned Electron and supervisor binaries", () => {
  const names = ["KCODER_E2E_ELECTRON_BIN", "KCODER_E2E_PROCESS_SUPERVISOR_BIN"];
  for (const suite of ["electron-widget-isolation", "electron-widget-resources", "electron-widget-controller"]) {
    for (const name of names) assert.ok(suiteEnvironmentNames(`suites/browser/${suite}.e2e.mjs`).includes(name));
  }
  for (const name of names) assert.equal(suiteEnvironmentNames("suites/gateway/auth.e2e.mjs").includes(name), false);
});

test('resource budget acceptance option is confined to the two registered migration Web suites', () => {
  const key = 'KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs', 'suites/mobile/migration.e2e.mjs']) assert.ok(suiteEnvironmentNames(suite).includes(key));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(key), false);
});

test("ordinary HTTP profile verification accepts only its explicit frozen Mobile inputs", () => {
  const suite = "suites/mobile/mobile-profile-workbench-http.e2e.mjs";
  for (const name of ["KCODER_E2E_MOBILE_SOURCE_ROOT", "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE", "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256"]) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames("suites/mobile/mobile-profile-account-http.e2e.mjs").includes(name), false);
  }
});

test('the registered Studio private credential UI accepts only its explicit renderer input', () => {
  const env = { KCODER_E2E_RENDERER_ROOT: '/owned/renderer' };
  assert.ok(suiteEnvironmentNames('suites/browser/migration-private-credentials.e2e.mjs', env).includes('KCODER_E2E_RENDERER_ROOT'));
  assert.equal(suiteEnvironmentNames('suites/gateway/migration-private-credentials.e2e.mjs', env).includes('KCODER_E2E_RENDERER_ROOT'), false);
});


test('project inventory acceptance is scoped to the registered Web and terminal clients with a pinned Native', () => {
  for (const suite of ['suites/browser/migration.e2e.mjs','suites/mobile/migration.e2e.mjs','suites/gateway/migration-terminal-transfer.e2e.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_MIGRATION_PROJECTS_ONLY'));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_MIGRATION_PROJECTS_ONLY'),false);
  assert.ok(suiteEnvironmentNames('suites/gateway/migration-terminal-transfer.e2e.mjs').includes('KCODER_E2E_MIGRATION_PROJECTS_CASES'));
  assert.equal(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MIGRATION_PROJECTS_CASES'),false);
});


test('unified scheduled Code actual remains scoped to the existing registered automation suite', () => {
  const flag = 'KCODER_E2E_AUTOMATION_UNIFIED_CODE_ONLY';
  const names = suiteEnvironmentNames('suites/browser/automation-period-budget.e2e.mjs');
  assert.ok(names.includes(flag));
  assert.ok(names.includes('KCODER_E2E_KCODER_BIN_SHA256'));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.equal(suiteEnvironmentNames('suites/browser/automation-native-human-wait.e2e.mjs').includes(flag), false);
});


test('ordinary Office request acceptance scopes its UID gate, native pin, renderer and optional file proof', () => {
  const suite = 'suites/office/office-request-only-native.e2e.mjs';
  for (const name of ['KCODER_TEST_SYSTEM_USERS', 'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_OFFICE_FILE_PROOF']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
});
