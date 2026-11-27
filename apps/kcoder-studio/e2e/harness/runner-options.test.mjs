import assert from "node:assert/strict";
import test from "node:test";
import { selectSuites, suiteEnvironmentNames } from "./runner-options.mjs";

test("explicit variant labels pass through the normal runner environment", () => {
  for (const suite of ["suites/gateway/auth.e2e.mjs", "../integration/model/real-model-task.integration.mjs"]) {
    assert.ok(suiteEnvironmentNames(suite).includes("KCODER_E2E_VARIANT_ID"));
  }
});

test('desktop request-cost suite receives its Native resource root only', () => {
  const suite = 'suites/browser/desktop-request-cost.e2e.mjs';
  assert.ok(suiteEnvironmentNames(suite).includes('KCODER_TARGET_DIR'));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_TARGET_DIR'), false);
});

test('subagent stream-rate uses the exact candidate inputs without rebuilding shared products', async () => {
  const suite = 'suites/browser/subagent-stream-rate.e2e.mjs';
  for (const name of ['KCODER_E2E_RENDERER_ROOT', 'KCODER_TARGET_DIR', 'KCODER_E2E_SUBAGENT_STREAM_PROFILE',
    'KCODER_E2E_CLI_SHA256', 'KCODER_E2E_CLI_SOURCE_REVISION']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts([suite], {
    environment: { KCODER_E2E_KCODER_BIN: '/owned/native', KCODER_E2E_RENDERER_ROOT: '/owned/renderer' },
    run: async () => assert.fail('Pinned stream-rate acceptance must not rebuild another candidate'),
  });
});

test('background peer reply and conversation use the owned Gateway integration suites', async () => {
  const { registeredSuites, modelIndependentSuites } = await import('../suite-registry.mjs');
  for (const suffix of ['peer-background-reply', 'peer-background-conversation']) {
    const suite = `../integration/gateway/${suffix}.integration.mjs`;
    assert.deepEqual(selectSuites(registeredSuites, ['--suite', suffix]), [suite]);
    assert.ok(modelIndependentSuites.includes(suite));
    for (const name of ['KCODER_E2E_KCODER_BIN', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_GATEWAY_ROOT']) {
      assert.ok(suiteEnvironmentNames(suite).includes(name));
    }
  }
});

test('real-model peer reply requires explicit model consent', async () => {
  const suite = '../integration/model/real-model-peer-reply.integration.mjs';
  const { registeredSuites, realModelSuites, modelIndependentSuites } = await import('../suite-registry.mjs');
  assert.ok(realModelSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false);
  assert.throws(() => selectSuites(registeredSuites, ['--suite', 'real-model-peer-reply'], {}), /--real-model/);
  assert.throws(() => selectSuites(registeredSuites, ['--real-model', '--suite', 'real-model-peer-reply'], {}), /KCODER_E2E_REAL_MODEL/);
  assert.deepEqual(selectSuites(registeredSuites, ['--real-model', '--suite', 'real-model-peer-reply'],
    { KCODER_E2E_REAL_MODEL: '1' }), [suite]);
  for (const name of ['KCODER_E2E_REAL_MODEL', 'KCODER_E2E_MODEL_PROFILE', 'KCODER_CONFIG_DIR', 'KCODER_E2E_KCODER_BIN'])
    assert.ok(suiteEnvironmentNames(suite).includes(name));
});

test('Windows peer authorization runs only an explicit native artifact and bypasses unrelated builds', async () => {
  const suite = '../integration/gateway/windows-peer-authorization.integration.mjs';
  const { registeredSuites, manualLiveSuites, modelIndependentSuites, smokeSuites } = await import('../suite-registry.mjs');
  assert.deepEqual(selectSuites(registeredSuites, ['--suite', 'windows-peer-authorization']), [suite]);
  assert.ok(manualLiveSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false);
  assert.equal(smokeSuites.includes(suite), false);
  for (const name of ['KCODER_E2E_WINDOWS_PEER_AUTH_CASE', 'KCODER_E2E_WINDOWS_NATIVE_TEST_BIN',
    'KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256', 'KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256',
    'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT', 'KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('Exact Windows libtest must not rebuild unrelated products') });
});

test('packaged renderer boot uses only pinned artifact inputs and bypasses unrelated preparation', async () => {
  const suite = 'suites/browser/packaged-renderer-boot.e2e.mjs';
  const { registeredSuites, manualLiveSuites, modelIndependentSuites, smokeSuites } = await import('../suite-registry.mjs');
  assert.deepEqual(selectSuites(registeredSuites, ['--suite', 'packaged-renderer-boot']), [suite]);
  assert.ok(manualLiveSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false); assert.equal(smokeSuites.includes(suite), false);
  for (const name of ['KCODER_E2E_PACKAGED_RESOURCES', 'KCODER_E2E_RENDERER_INDEX_SHA256',
    'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_CANDIDATE_RENDERER_ROOT']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts([suite], { run: async () => assert.fail('Frozen artifact boot must not run Cargo, TSC, Vite or export') });
});

test('owned native search suites forward only their explicit frozen fixture identity', () => {
  for (const suite of ['suites/browser/web-search-positive-native.e2e.mjs',
    '../integration/gateway/web-search-native-faults.integration.mjs', '../integration/gateway/web-search-native-policy-revoke.integration.mjs']) {
    const names = suiteEnvironmentNames(suite);
    for (const name of ['KCODER_E2E_SEARCH_NATIVE_BIN','KCODER_E2E_SEARCH_NATIVE_SHA256','KCODER_E2E_SEARCH_NATIVE_CHECKPOINT'])
      assert.ok(names.includes(name));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_SEARCH_NATIVE_BIN'),false);
});

test('KWorker conversation lifecycle receives its pinned CLI, renderer and owned scratch base only', () => {
  const suite = 'suites/browser/kworker-conversation-lifecycle.e2e.mjs';
  for (const name of ['KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE', 'KCODER_E2E_HOME_COMPOSER_ONLY']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/browser/task-parent-interactions-native.e2e.mjs').includes(name), false);
  }
});
import { manualLiveSuites, modelIndependentSuites } from "../suite-registry.mjs";

test('independent channels use ordinary tasks and retired Native SDK suites stay unregistered', () => {
  assert.ok(modelIndependentSuites.includes('../integration/gateway/independent-channel-task.integration.mjs'));
  for (const retired of ['native-channel-task-protocol', 'native-channel-ui-peer-protocol', 'native-channel-windows-scope',
    'native-channel-directory', 'native-channel-gateway-owner', 'native-channel-weixin-context-recovery']) {
    const suite = `suites/gateway/${retired}.e2e.mjs`;
    assert.equal(modelIndependentSuites.includes(suite), false);
    assert.equal(manualLiveSuites.includes(suite), false);
  }
  assert.equal(modelIndependentSuites.includes('suites/browser/feishu-bound-task-live-process.e2e.mjs'), false);
  for (const name of ['KCODER_E2E_CHANNEL_TASK_TEST_BIN', 'KCODER_E2E_NATIVE_CHANNEL_PROTOCOL_CASE'])
    assert.equal(suiteEnvironmentNames('../integration/gateway/independent-channel-task.integration.mjs').includes(name), false);
});

test('pinned startup comparisons require explicit selection and preserve their input identity', () => {
  const suites = [
    '../integration/browser/web-startup-baseline-zero-business.integration.mjs',
    '../integration/browser/web-startup-current-zero-business.integration.mjs',
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

test('reviewed Agent adaptation stays in registered Web migration suites with pinned Native sources', () => {
  const flag = 'KCODER_E2E_MIGRATION_AGENT_ADAPTATION_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs']) {
    const names = suiteEnvironmentNames(suite);
    assert.ok(names.includes(flag));
    assert.ok(names.includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('terminal private acceptance remains in the registered terminal suite with pinned Native identity', () => {
  const flag = 'KCODER_E2E_MIGRATION_TERMINAL_PRIVATE_ONLY';
  const names = suiteEnvironmentNames('../integration/gateway/migration-terminal-transfer.integration.mjs');
  assert.ok(names.includes(flag)); assert.ok(names.includes('KCODER_E2E_KCODER_BIN_SHA256'));
  for (const suite of ['suites/browser/migration.e2e.mjs', 'suites/gateway/auth.e2e.mjs'])
    assert.equal(suiteEnvironmentNames(suite).includes(flag), false);
});

test('project MCP acceptance stays scoped to the registered desktop migration client', () => {
  const flag = 'KCODER_E2E_MIGRATION_PROJECT_MCP_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs']) assert.ok(suiteEnvironmentNames(suite).includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('scoped-instruction acceptance stays in registered migration clients and terminal and pins Native identity', () => {
  const flag = 'KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs', '../integration/gateway/migration-terminal-transfer.integration.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes(flag));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('family-index acceptance is scoped to the desktop migration suite only', () => {
  const flag = 'KCODER_E2E_MIGRATION_HISTORY_FAMILIES_ONLY';
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

const suites = [
  "suites/gateway/auth.e2e.mjs",
  "suites/browser/ssh.e2e.mjs",
  "../integration/model/real-model-task.integration.mjs",
  "suites/model/real-model-image-attachment.e2e.mjs",
];

test('uploaded-plugin acceptance uses only desktop Web migration and pins Native', () => {
  const flag = 'KCODER_E2E_MIGRATION_UPLOADED_PLUGINS_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes(flag));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.ok(!suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MIGRATION_MOBILE_ARCHIVE'));
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_RENDERER_ROOT'));
});

test("the explicit history-source boundary reaches only the registered browser migration suite", () => {
  const flag = "KCODER_E2E_MIGRATION_HISTORY_SOURCE_ONLY";
  assert.ok(suiteEnvironmentNames("suites/browser/migration.e2e.mjs").includes(flag));
  assert.equal(suiteEnvironmentNames("suites/browser/ssh.e2e.mjs").includes(flag), false);
});

test('the private-credential boundary is confined to the desktop migration suite', () => {
  const flag = 'KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY';
  assert.ok(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
  assert.equal(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MOBILE_SOURCE_ROOT'), false);
});

test("Windows archive retention forwards its explicit frozen native scope only to that suite", () => {
  const suite = "../integration/gateway/windows-archive-retention.integration.mjs";
  const names = suiteEnvironmentNames(suite);
  for (const key of ["KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_RETENTION_SCOPE"]) assert.ok(names.includes(key));
  assert.equal(suiteEnvironmentNames("../integration/gateway/windows-plugin-migration.integration.mjs").includes("KCODER_E2E_WINDOWS_RETENTION_SCOPE"), false);
  assert.equal(names.includes("KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK"), false);
});

test('Windows read path modes are forwarded only for the two explicit registered read subscopes', () => {
  const suite = '../integration/gateway/windows-archive-retention.integration.mjs', flag = 'KCODER_E2E_WINDOWS_READ_PATH_MODE';
  for (const scope of ['read-tools', 'read-engine']) assert.ok(suiteEnvironmentNames(suite, { KCODER_E2E_WINDOWS_RETENTION_SCOPE: scope }).includes(flag));
  for (const scope of [undefined, 'config', 'private-credentials', 'uploaded-product']) assert.equal(suiteEnvironmentNames(suite, { KCODER_E2E_WINDOWS_RETENTION_SCOPE: scope }).includes(flag), false);
  assert.equal(suiteEnvironmentNames('../integration/gateway/windows-cross-host-source.integration.mjs', { KCODER_E2E_WINDOWS_RETENTION_SCOPE: 'read-tools' }).includes(flag), false);
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
      "../integration/gateway/canva-oauth-discovery.integration.mjs",
    ).includes(flag),
  );
  assert.equal(
    suiteEnvironmentNames("../integration/gateway/mcp-oauth.integration.mjs").includes(flag),
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
    "../integration/model/real-model-task.integration.mjs",
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
      "../integration/gateway/windows-wine-resources.integration.mjs",
    ).includes("KCODER_E2E_PACKAGED_DIR"),
  );
  assert.equal(
    suiteEnvironmentNames(
      "../integration/gateway/runtime-target-local.integration.mjs",
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
    suiteEnvironmentNames("suites/gateway/session-disconnect.e2e.mjs").includes(
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

test('resource budget acceptance option is confined to the desktop migration suite', () => {
  const key = 'KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY';
  for (const suite of ['suites/browser/migration.e2e.mjs']) assert.ok(suiteEnvironmentNames(suite).includes(key));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(key), false);
});

test('the registered Studio private credential UI accepts only its explicit renderer input', () => {
  const env = { KCODER_E2E_RENDERER_ROOT: '/owned/renderer' };
  assert.ok(suiteEnvironmentNames('suites/browser/migration-private-credentials.e2e.mjs', env).includes('KCODER_E2E_RENDERER_ROOT'));
  assert.equal(suiteEnvironmentNames('../integration/gateway/migration-private-credentials.integration.mjs', env).includes('KCODER_E2E_RENDERER_ROOT'), false);
});


test('project inventory acceptance is scoped to the registered Web and terminal clients with a pinned Native', () => {
  for (const suite of ['suites/browser/migration.e2e.mjs','../integration/gateway/migration-terminal-transfer.integration.mjs']) {
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_MIGRATION_PROJECTS_ONLY'));
    assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  }
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_MIGRATION_PROJECTS_ONLY'),false);
  assert.ok(suiteEnvironmentNames('../integration/gateway/migration-terminal-transfer.integration.mjs').includes('KCODER_E2E_MIGRATION_PROJECTS_CASES'));
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


test('actual model-tool source-attempt acceptance receives its explicit Native image pin', () => {
  assert.ok(suiteEnvironmentNames('../integration/gateway/peer-model-tool-source-attempt.integration.mjs').includes('KCODER_E2E_KCODER_BIN_SHA256'));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_KCODER_BIN_SHA256'), false);
});

test('Ollama acceptance receives its pinned client and explicit probe mode without exposing them to ordinary suites', () => {
  const names = suiteEnvironmentNames('../integration/model/ollama-context-window.integration.mjs');
  for (const name of ['KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_OLLAMA_PROBE_MODE']) {
    assert.ok(names.includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
});

test('provider doctor consistency is scoped to the registered provider routing acceptance', () => {
  const flag = 'KCODER_E2E_PROVIDER_DOCTOR_CONSISTENCY';
  assert.ok(suiteEnvironmentNames('../integration/gateway/provider-routing-profile-priority.integration.mjs').includes(flag));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(flag), false);
});

test('Mac exit diagnostic keeps its opt-in and artifact pin scoped to that registered suite', () => {
  for (const key of ['KCODER_E2E_MAC_EXIT_DIAGNOSTIC', 'KCODER_E2E_MAC_DMG', 'KCODER_E2E_MAC_DMG_SHA256']) {
    assert.ok(suiteEnvironmentNames('suites/browser/macos-packaged-exit-diagnostic.e2e.mjs').includes(key));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(key), false);
    assert.equal(suiteEnvironmentNames('suites/browser/packaged-desktop-smoke.e2e.mjs').includes(key), false);
  }
});
