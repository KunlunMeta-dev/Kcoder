import { releaseEnvironmentNames } from "./release-plan.mjs";
import { realModelSuites } from "../suite-registry.mjs";
import { canonicalSuiteId, isIntegrationSuite } from "./suite-sources.mjs";
const registeredRealModelSuites = new Set(realModelSuites);
const isRealModelSuite = source => registeredRealModelSuites.has(source) || source.includes('/model/');
export function selectSuites(suites, args, env = process.env) {
  suites = [...new Set(suites.map(canonicalSuiteId))];
  const kindIndex = args.indexOf("--kind");
  if (kindIndex >= 0) {
    const kind = args[kindIndex + 1];
    if (!["integration", "e2e"].includes(kind)) throw new Error("--kind requires integration or e2e");
    suites = suites.filter(source => isIntegrationSuite(source) === (kind === "integration"));
  }
  const realModelConsent = args.includes("--real-model");
  if (args.includes("--model-independent") && realModelConsent) {
    throw new Error(
      "--model-independent and --real-model are mutually exclusive",
    );
  }
  if (realModelConsent && env.KCODER_E2E_REAL_MODEL !== "1") {
    throw new Error(
      "--real-model also requires KCODER_E2E_REAL_MODEL=1; both explicit consents are required",
    );
  }
  const index = args.indexOf("--suite");
  if (index < 0)
    return realModelConsent ? suites : modelIndependentSuites(suites);
  const name = canonicalSuiteId(args[index + 1]);
  const matches = suites.filter(
    (source) =>
      source === name ||
      source.includes(`/${name}/`) ||
      source.endsWith(`/${name}`) ||
      source.endsWith(`/${name}.e2e.mjs`) ||
      source.endsWith(`/${name}.integration.mjs`),
  );
  if (matches.length !== 1)
    throw new Error(
      `--suite must uniquely select one suite; got ${name || "<missing>"}`,
    );
  if (isRealModelSuite(matches[0]) && !realModelConsent) {
    throw new Error(
      `real-model suite ${name} requires the --real-model CLI consent flag`,
    );
  }
  return matches;
}

export function suiteEnvironmentNames(suiteId, env = process.env) {
  if (suiteId === '../integration/gateway/windows-subagent-stream-rate.integration.mjs')
    return [...suiteEnvironmentNames('../integration/gateway/windows-terminal-lifecycle.integration.mjs', env),
      'KCODER_E2E_SUBAGENT_STREAM_CHILDREN', 'KCODER_E2E_SUBAGENT_STREAM_LONG', 'KCODER_E2E_SUBAGENT_PROFILE_READS', 'KCODER_E2E_SUBAGENT_STREAM_SOURCES'];
  suiteId = canonicalSuiteId(suiteId);
  const names = [
    "KCODER_E2E_CHROMIUM_BIN",
    "KCODER_E2E_CHROMIUM_NO_SANDBOX",
    "KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX",
    "KCODER_E2E_KCODER_BIN",
    "KCODER_E2E_SUITE_TIMEOUT_MS",
    "KCODER_E2E_VARIANT_ID",
  ];
  if (['../integration/storage-account-paths.integration.mjs', '../integration/storage-session-paths.integration.mjs'].includes(suiteId))
    names.push('KCODER_E2E_ELECTRON_BIN', 'KCODER_E2E_ELECTRON_BIN_SHA256');
  if (['suites/browser/desktop-source-storage-read.e2e.mjs', 'suites/browser/desktop-source-storage-handoff.e2e.mjs'].includes(suiteId))
    names.push('KCODER_E2E_ELECTRON_BIN', 'KCODER_E2E_ELECTRON_BIN_SHA256', 'KCODER_E2E_KCODER_BIN_SHA256',
      'KCODER_E2E_STORAGE_COPY_OWNER_ROOT', 'KCODER_E2E_STORAGE_COPY_OWNER', 'KCODER_E2E_STORAGE_COPY_DATA',
      'KCODER_E2E_STORAGE_COPY_PROJECT', 'KCODER_E2E_STORAGE_COPY_CACHE', 'KCODER_E2E_ALLOW_CURRENT_USER_STORAGE_MIGRATION');
  if (suiteId === '../integration/storage-cross-filesystem.integration.mjs')
    names.push('KCODER_E2E_CONFIG_LIBTEST', 'KCODER_E2E_CONFIG_LIBTEST_SHA256', 'KCODER_E2E_STORAGE_CROSS_VOLUME');
  if (['../integration/storage-handoff-native-boundaries.integration.mjs',
    'suites/browser/desktop-storage-relocation.e2e.mjs'].includes(suiteId))
    names.push('KCODER_E2E_STORAGE_CROSS_VOLUME', 'KCODER_TARGET_DIR');
  if (suiteId === '../integration/gateway/browser-session-read-cost.integration.mjs') names.push('KCODER_E2E_KCODER_BIN_SHA256');
  if (suiteId === 'suites/browser/desktop-request-cost.e2e.mjs') names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_TARGET_DIR');
  if (suiteId === 'suites/browser/subagent-stream-rate.e2e.mjs') names.push(
    'KCODER_E2E_RENDERER_ROOT', 'KCODER_TARGET_DIR', 'KCODER_E2E_SUBAGENT_STREAM_PROFILE',
    'KCODER_E2E_CLI_SHA256', 'KCODER_E2E_CLI_SOURCE_REVISION');
  if (suiteId === '../integration/gateway/subagent-workspace.integration.mjs')
    names.push('KCODER_TARGET_DIR', 'KCODER_E2E_CLI_SHA256', 'KCODER_E2E_CLI_SOURCE_REVISION');
  if (['suites/browser/desktop-storage-legacy-startup.e2e.mjs',
    'suites/browser/desktop-storage-first-launch.e2e.mjs',
    'suites/browser/desktop-storage-relocation.e2e.mjs',
    '../integration/storage-handoff-native-boundaries.integration.mjs'].includes(suiteId))
    names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_STORAGE_ADDON_SHA256');
  if (suiteId === 'suites/browser/desktop-storage-relocation.e2e.mjs')
    names.push('KCODER_E2E_STORAGE_CLEANUP', 'KCODER_E2E_STORAGE_RENDERER_MODE', 'KCODER_E2E_RENDERER_ROOT');
  if (suiteId === 'suites/browser/desktop-storage-first-launch.e2e.mjs') names.push('KCODER_E2E_STORAGE_FIRST_CHOICE');
  if (suiteId === 'suites/browser/desktop-storage-upgrade.e2e.mjs') names.push(
    'KCODER_E2E_WINDOWS_OLD_INSTALLER', 'KCODER_E2E_WINDOWS_NEW_INSTALLER', 'KCODER_E2E_WINDOWS_SSH_TARGET',
    'KCODER_E2E_WINDOWS_NODE', 'KCODER_E2E_WINDOWS_UNINSTALL_PROBE_SUPERVISOR', 'KCODER_E2E_WINDOWS_EXPECTED_COMMIT',
    'KCODER_E2E_WINDOWS_EXPECTED_NATIVE_COMMIT',
    'KCODER_E2E_WINDOWS_EXPECTED_VERSION', 'KCODER_E2E_WINDOWS_EXPECTED_INSTALLER_SHA256', 'KCODER_E2E_WINDOWS_EXPECTED_HOST_SHA256',
    'KCODER_E2E_WINDOWS_EXPECTED_MANIFEST_SHA256', 'KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256',
  );
  if (suiteId === "suites/mobile/mobile-cached-session-preview.e2e.mjs") {
    names.push("KCODER_E2E_CACHE_FIXTURE_RUN_ROOT", "KCODER_CACHE_FIXTURE_ORIGIN", "KCODER_CACHE_FIXTURE_PREFIX");
  }
  if ([
    'suites/browser/task-pin-search-archive-restore.e2e.mjs',
    'suites/browser/attachment-compose-lifecycle.e2e.mjs',
    'suites/browser/desktop-tray-background-continue.e2e.mjs',
    'suites/browser/scheduled-timezone.e2e.mjs',
    'suites/browser/provider-error-classification.e2e.mjs',
    'suites/browser/thread-creation-recovery.e2e.mjs',
    '../integration/gateway/provider-routing-profile-priority.integration.mjs',
    'suites/browser/task-board-acceptance.e2e.mjs',
    'suites/browser/plugins-failed-draft-recovery.e2e.mjs',
    'suites/browser/scheduled-tasks.e2e.mjs',
    'suites/browser/workflow-canvas.e2e.mjs',
    'suites/browser/settings-task-return-navigation.e2e.mjs',
  ].includes(suiteId)) names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT');
  if (suiteId === '../integration/model/ollama-context-window.integration.mjs')
    names.push('KCODER_E2E_OLLAMA_BIN', 'KCODER_E2E_OLLAMA_MODEL_STORE',
      'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_OLLAMA_PROBE_MODE');
  if (suiteId === '../integration/gateway/provider-routing-profile-priority.integration.mjs')
    names.push('KCODER_E2E_PROVIDER_SETTINGS_UI', 'KCODER_E2E_PROVIDER_DOCTOR_CONSISTENCY');
  if (suiteId === 'suites/browser/desktop-tray-background-continue.e2e.mjs')
    names.push('KCODER_E2E_ELECTRON_BIN', 'KCODER_E2E_DESKTOP_TRAY_SNI_BIN',
      'KCODER_E2E_DESKTOP_TRAY_XEMBED_BIN', 'KCODER_E2E_DESKTOP_TRAY_XEMBED_LIBDIR',
      'KCODER_E2E_DESKTOP_TRAY_WM_BIN', 'KCODER_E2E_DESKTOP_TRAY_WM_LIBDIR',
      'KCODER_E2E_DESKTOP_TRAY_WMCTRL_BIN', 'KCODER_E2E_XDOTOOL_BIN');
  if (suiteId === 'suites/browser/kworker-conversation-lifecycle.e2e.mjs') {
    names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE', 'KCODER_E2E_HOME_COMPOSER_ONLY');
  }
  if (suiteId === '../integration/gateway/peer-model-tool-source-attempt.integration.mjs') {
    names.push('KCODER_E2E_KCODER_BIN_SHA256');
  }
  if (['../integration/gateway/peer-cold-workspace-wake.integration.mjs', '../integration/gateway/peer-background-reply.integration.mjs', '../integration/gateway/peer-background-conversation.integration.mjs'].includes(suiteId)) {
    names.push('KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_GATEWAY_ROOT');
  }
  if (suiteId === 'suites/browser/packaged-renderer-boot.e2e.mjs') names.push(
    'KCODER_E2E_PACKAGED_RESOURCES', 'KCODER_E2E_RENDERER_INDEX_SHA256',
    'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_CANDIDATE_RENDERER_ROOT',
  );
  if (suiteId === 'suites/browser/web-search-positive-native.e2e.mjs'
      || suiteId.startsWith('../integration/gateway/web-search-native-')
      || suiteId === '../integration/gateway/web-fetch-native-stream-cancel.integration.mjs') {
    names.push('KCODER_E2E_SEARCH_NATIVE_BIN', 'KCODER_E2E_SEARCH_NATIVE_SHA256',
      'KCODER_E2E_SEARCH_NATIVE_CHECKPOINT', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_RENDERER_SOURCE_ROOT', 'KCODER_E2E_OPENSSL_BIN');
  }
  if (suiteId === '../integration/gateway/physical-web-targets.integration.mjs') names.push('KCODER_E2E_WINDOWS_NATIVE_LIBTEST','KCODER_E2E_WEB_EXTERNAL_NETWORK','KCODER_E2E_PHYSICAL_WEB_EXECUTE','KCODER_E2E_PHYSICAL_WEB_TARGET','KCODER_E2E_WINDOWS_NODE','KCODER_E2E_WINDOWS_PROBE_PARENT','KCODER_E2E_PHYSICAL_WEB_ARCHIVE','KCODER_E2E_PHYSICAL_WEB_ARCHIVE_SHA256','KCODER_E2E_PHYSICAL_WEB_ARCHIVE_BYTES','KCODER_E2E_PHYSICAL_WEB_MEMBERS','KCODER_E2E_PHYSICAL_WEB_PRIVATE_URL_FILE','KCODER_E2E_PHYSICAL_WEB_LAUNCHER','KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256','KCODER_E2E_WINDOWS_EXPECTED_COMMIT','KCODER_E2E_PHYSICAL_WEB_GATEWAY_ROOT','KCODER_E2E_PHYSICAL_WEB_GATEWAY_SOURCE_COMMIT','KCODER_E2E_PHYSICAL_WEB_NATIVE_BUILD_RESULT','KCODER_E2E_PHYSICAL_WEB_CLIENT_BIN');
  if (suiteId === 'suites/browser/provider-settings-persistence.e2e.mjs') names.push('KCODER_E2E_PROVIDER_DISCOVERY_ONLY');
  if (suiteId === 'suites/browser/memory-native-management.e2e.mjs') names.push('KCODER_E2E_NATIVE_MEMORY_ONLY', 'KCODER_E2E_NATIVE_MEMORY_PUBLICATION_ONLY', 'KCODER_E2E_KNOWLEDGE_FIXTURE_BIN', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_BUDGET', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_GATEWAY_ROOT');
  if (suiteId === '../integration/gateway/native-code-service-lifetime.integration.mjs') names.push(
    'KCODER_E2E_REL_STORAGE_RECOVERY', 'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE',
  );
  if (suiteId === '../integration/gateway/application-controls-native.integration.mjs') names.push(
    'KCODER_E2E_APPLICATION_TASKS', 'KCODER_E2E_APPLICATION_OAUTH',
    'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE',
  );
  if (suiteId === '../integration/gateway/project-knowledge-publication.integration.mjs') names.push(
    'KCODER_E2E_STATE_NATIVE_BIN', 'KCODER_E2E_STATE_NATIVE_SHA256', 'KCODER_E2E_KCODER_BIN_SHA256',
    'KCODER_E2E_PACKAGED_DIR', 'KCODER_E2E_PACKAGED_MANIFEST_SHA256', 'KCODER_E2E_PACKAGED_HOST_SHA256',
    'KCODER_RELEASE_EXPECTED_COMMIT', 'KCODER_E2E_PROCESS_SUPERVISOR_BIN',
    'KCODER_E2E_GIT_SH_BIN', 'KCODER_E2E_GIT_SH_SHA256',
  );
  if ([
    '../integration/gateway/application-business-native.integration.mjs',
    '../integration/gateway/application-business-read-native.integration.mjs',
    '../integration/gateway/application-business-unknown-native.integration.mjs',
    '../integration/gateway/application-business-unknown-hard-drop-native.integration.mjs',
  ].includes(suiteId)) names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_GATEWAY_ROOT');
  if (suiteId === '../integration/gateway/application-business-read-native.integration.mjs') names.push('KCODER_E2E_APPLICATION_READ_SOURCE');
  if (suiteId === '../integration/gateway/plugin-version-retention.integration.mjs') names.push(
    'KCODER_E2E_NATIVE_PLUGIN_SOURCE_LEASE', 'KCODER_E2E_KCODER_SHA256', 'KCODER_E2E_GATEWAY_ROOT',
  );
  if (suiteId === "../integration/model/real-model-business-templates.integration.mjs") names.push("KCODER_E2E_KNOWLEDGE_FIXTURE_BIN", "KCODER_E2E_GATEWAY_ROOT", "KCODER_E2E_NATIVE_BUSINESS_CASES", "KCODER_E2E_NATIVE_BUSINESS_REQUEST_CAP");
  if (suiteId === "suites/browser/organization-oidc-login.e2e.mjs") names.push("KCODER_TEST_SYSTEM_USERS", "KCODER_E2E_OIDC_PYTHON", "KCODER_E2E_KCODER_BIN_SHA256", "KCODER_E2E_ORGANIZATION_RESOURCE_UI");
  if (suiteId === 'suites/browser/windows-migration-ui.e2e.mjs') names.push(
    'KCODER_E2E_WINDOWS_SSH_TARGET', 'KCODER_E2E_WINDOWS_STUDIO_DIRECTORY',
    'KCODER_E2E_WINDOWS_NODE', 'KCODER_E2E_WINDOWS_CLI', 'KCODER_E2E_WINDOWS_CLI_SHA256', 'KCODER_E2E_RENDERER_ROOT',
  );
  if (suiteId === 'suites/browser/automation-period-budget.e2e.mjs') names.push('KCODER_E2E_AUTOMATION_UNIFIED_CODE_ONLY', 'KCODER_E2E_KCODER_BIN_SHA256');
  if (suiteId === '../integration/gateway/windows-installer-lifecycle.integration.mjs') names.push('KCODER_E2E_WINDOWS_INTERACTIVE_SESSION','KCODER_E2E_WINDOWS_OS_PROFILE_QUALIFICATION','KCODER_E2E_WINDOWS_INSTALLER_DIRECTORY_TRUST','KCODER_E2E_WINDOWS_INSTALLER_OFFICE', 'KCODER_E2E_WINDOWS_INSTALLER_OFFICE_UPGRADE_ONLY','KCODER_E2E_WINDOWS_INSTALLER_OFFICE_FRESH','KCODER_E2E_WINDOWS_INSTALLER_STARTUP');
  if (suiteId === '../integration/gateway/windows-native-components.integration.mjs') names.push(
    'KCODER_E2E_WINDOWS_NATIVE_COMPONENTS', 'KCODER_E2E_WINDOWS_SSH_TARGET',
    'KCODER_E2E_WINDOWS_STUDIO_DIRECTORY', 'KCODER_E2E_WINDOWS_NODE',
    'KCODER_E2E_WINDOWS_NATIVE_CLI', 'KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR',
    'KCODER_E2E_WINDOWS_CHANNEL_SOURCE_ARCHIVE', 'KCODER_E2E_WINDOWS_NATIVE_STORE_READONLY_PROBE',
    'KCODER_E2E_WINDOWS_NATIVE_IMAGE_ONLY', 'KCODER_E2E_WINDOWS_NATIVE_COMPONENT_ADDON',
    'KCODER_E2E_WINDOWS_NATIVE_GATEWAY', 'KCODER_E2E_WINDOWS_GATEWAY_SOURCE_ARCHIVE',
  );
  if (suiteId === "../integration/gateway/linux-headless-credentials.integration.mjs") names.push(
    "KCODER_E2E_LINUX_HEADLESS_CREDENTIALS", "KCODER_E2E_LINUX_HEADLESS_NATIVE", "KCODER_E2E_LINUX_HEADLESS_NATIVE_SHA256",
  );

  if (suiteId === "../integration/gateway/migration-terminal-transfer.integration.mjs") names.push("KCODER_E2E_MIGRATION_TERMINAL_PRIVATE_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (["suites/browser/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY");
  if (["suites/browser/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_HISTORY_FAMILIES_ONLY");
  if (["suites/browser/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_UPLOADED_PLUGINS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (["suites/browser/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_PROJECT_MCP_ONLY");
  if (["suites/browser/migration.e2e.mjs", "../integration/gateway/migration-terminal-transfer.integration.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_PROJECTS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (suiteId === "../integration/gateway/migration-terminal-transfer.integration.mjs") names.push("KCODER_E2E_MIGRATION_PROJECTS_CASES");
  if (["suites/browser/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_AGENT_ADAPTATION_ONLY");
  if (["suites/browser/migration.e2e.mjs", "../integration/gateway/migration-terminal-transfer.integration.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_HISTORY_SOURCE_ONLY");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY");
  if (suiteId === "suites/browser/migration-private-credentials.e2e.mjs") names.push("KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_MIGRATION_FIXTURE_BINARY");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "suites/browser/migration-large-history.e2e.mjs") names.push(
    "KCODER_E2E_MIGRATION_LARGE_HISTORY", "KCODER_E2E_MIGRATION_PERF_CASE", "KCODER_E2E_MIGRATION_SMALL_ASSET_COUNT", "KCODER_E2E_KCODER_BIN_SHA256", "KCODER_E2E_RENDERER_ROOT",
    "KCODER_E2E_MIGRATION_RENDERER_BASELINE", "KCODER_E2E_MIGRATION_RENDERER_BASELINE_SHA256",
  );
  if (["suites/browser/electron-widget-controller.e2e.mjs", "suites/browser/electron-widget-isolation.e2e.mjs", "suites/browser/electron-widget-resources.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_ELECTRON_BIN", "KCODER_E2E_PROCESS_SUPERVISOR_BIN");
  if (suiteId === "suites/browser/provider-retry-feedback.e2e.mjs") {
    names.push(
      "KCODER_E2E_PROVIDER_RETRY_MAC_ELECTRON",
      "HOME",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
    );
  }
  if (suiteId === "../integration/gateway/windows-wine-resources.integration.mjs") names.push("KCODER_E2E_PACKAGED_DIR");
  if (suiteId === "../integration/gateway/plugin-target-ca.integration.mjs") names.push("KCODER_E2E_PLUGIN_CA_PROBE_BIN");
  if (suiteId === "../integration/gateway/windows-migration-security.integration.mjs") names.push(
    "KCODER_E2E_WINDOWS_MIGRATION_SECURITY", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT",
    "KCODER_E2E_WINDOWS_SECURITY_HELPER", "KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256", "KCODER_E2E_WINDOWS_SECURITY_BASELINE_SOURCE",
  );
  if (suiteId === "../integration/gateway/windows-keyring-logon.integration.mjs") names.push(
    "KCODER_E2E_WINDOWS_KEYRING_LOGON", "KCODER_E2E_WINDOWS_KEYRING_LOGON_MODE",
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT",
  );
  if (["../integration/gateway/windows-keyring-account.integration.mjs", "../integration/gateway/windows-keyring-core.integration.mjs", "../integration/gateway/windows-keyring-host.integration.mjs", "../integration/gateway/windows-private-keyring.integration.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_KEYRING_LOGON", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_FAULT",
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_SECURITY_HELPER", "KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256",
  );
  if (["../integration/gateway/windows-keyring-host.integration.mjs", "../integration/gateway/windows-private-keyring.integration.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_KEYRING_HOST_CLI", "KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256",
    "KCODER_E2E_WINDOWS_NODE", "KCODER_E2E_WINDOWS_KEYRING_HOST_NODE_SHA256",
  );
  if (["../integration/gateway/windows-historical-undo.integration.mjs", "../integration/gateway/windows-terminal-lifecycle.integration.mjs", "../integration/gateway/windows-local-attachment.integration.mjs", "../integration/gateway/windows-local-attachment-lock.integration.mjs", "../integration/gateway/windows-snapshot-paths.integration.mjs", "../integration/gateway/windows-profile-settings-lock.integration.mjs", "../integration/gateway/windows-plugin-migration.integration.mjs", "../integration/gateway/windows-source-transfer.integration.mjs", "../integration/gateway/windows-archive-retention.integration.mjs", "../integration/gateway/windows-peer-authorization.integration.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
  );
  if (suiteId === "../integration/gateway/windows-terminal-lifecycle.integration.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY", "KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK",
  );
  if (["../integration/gateway/windows-local-attachment.integration.mjs", "../integration/gateway/windows-local-attachment-lock.integration.mjs", "../integration/gateway/windows-snapshot-paths.integration.mjs", "../integration/gateway/windows-profile-settings-lock.integration.mjs", "../integration/gateway/windows-plugin-migration.integration.mjs", "../integration/gateway/windows-source-transfer.integration.mjs", "../integration/gateway/windows-archive-retention.integration.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
  );
  if (suiteId === "../integration/gateway/windows-real-source-import.integration.mjs") names.push("KCODER_E2E_WINDOWS_PERSONAL_MIGRATION_READ", "KCODER_E2E_WINDOWS_MIGRATION_SOURCE_ROOTS");
  if (suiteId === "../integration/gateway/windows-profile-settings-lock.integration.mjs") names.push("KCODER_E2E_WINDOWS_CONFIG_LOCK_SCOPE");
  if (suiteId === "../integration/gateway/windows-peer-authorization.integration.mjs") names.push("KCODER_E2E_WINDOWS_PEER_AUTH_CASE", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY");
  if (suiteId === "../integration/gateway/windows-plugin-migration.integration.mjs") names.push("KCODER_E2E_WINDOWS_PLUGIN_LEASE_SCOPE");
  if (suiteId === "../integration/gateway/windows-private-credentials.integration.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
    "KCODER_E2E_WINDOWS_PRIVATE_REVIEW_SHA256", "KCODER_E2E_WINDOWS_PRIVATE_NODE_SHA256",
  );
  if (suiteId === "../integration/gateway/windows-archive-retention.integration.mjs") names.push("KCODER_E2E_WINDOWS_RETENTION_SCOPE");
  if (suiteId === "../integration/gateway/windows-archive-retention.integration.mjs" && ['read-tools', 'read-engine'].includes(env.KCODER_E2E_WINDOWS_RETENTION_SCOPE)) names.push("KCODER_E2E_WINDOWS_READ_PATH_MODE");
  if (suiteId === "../integration/gateway/windows-cross-host-source.integration.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
    "KCODER_E2E_WINDOWS_CROSS_HOST_SOURCE", "KCODER_E2E_WINDOWS_CROSS_HOST_CHECKOUT", "KCODER_E2E_WINDOWS_LINUX_ADDRESS",
    "KCODER_E2E_WINDOWS_SSH_WRAPPER_BIN", "KCODER_E2E_WINDOWS_SSH_WRAPPER_SHA256", "KCODER_E2E_KCODER_BIN", "KCODER_E2E_KCODER_BIN_SHA256",
  );
  if (["../integration/gateway/windows-real-source-import.integration.mjs", "../integration/model/windows-migration-continuation.integration.mjs", "../integration/gateway/windows-migration.integration.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_NODE", "KCODER_E2E_WINDOWS_PROBE_PARENT",
    "KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE", "KCODER_E2E_WINDOWS_PAYLOAD_SHA256",
    "KCODER_E2E_WINDOWS_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT",
    "KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS", "KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS_SHA256",
    "KCODER_E2E_WINDOWS_CATALOG_LOCK_TEST_MODE",
  );
  if (['../integration/browser/web-startup-baseline-zero-business.integration.mjs', '../integration/browser/web-startup-current-zero-business.integration.mjs'].includes(suiteId))
    names.push('KCODER_E2E_STARTUP_BIN', 'KCODER_E2E_STARTUP_SHA256', 'KCODER_E2E_RENDERER_ROOT');
  if (suiteId === "suites/browser/packaged-desktop-smoke.e2e.mjs") names.push("KCODER_E2E_PACKAGED_DIR", "KCODER_E2E_PROCESS_SUPERVISOR_BIN", "KCODER_E2E_PACKAGED_WIDGET_LIFECYCLE", "KCODER_RELEASE_EXPECTED_COMMIT");
  if (suiteId === "suites/browser/macos-packaged-exit-diagnostic.e2e.mjs")
    names.push("KCODER_E2E_MAC_EXIT_DIAGNOSTIC", "KCODER_E2E_MAC_DMG", "KCODER_E2E_MAC_DMG_SHA256");
  if (suiteId.startsWith("suites/browser/electron-"))
    names.push("KCODER_E2E_ELECTRON_BIN", "KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "../integration/gateway/windows-wine-resources.integration.mjs")
    names.push("KCODER_E2E_PACKAGED_DIR");
  if (suiteId === "../integration/gateway/plugin-target-ca.integration.mjs")
    names.push("KCODER_E2E_PLUGIN_CA_PROBE_BIN");
  if (suiteId === "suites/browser/packaged-desktop-smoke.e2e.mjs")
    names.push("KCODER_E2E_PACKAGED_DIR", "KCODER_E2E_PROCESS_SUPERVISOR_BIN");
  if (suiteId === "suites/browser/right-workspace-multitool.e2e.mjs") {
    names.push("KCODER_E2E_MANAGED_CHROMIUM");
  }
  if (suiteId === "../integration/gateway/canva-oauth-discovery.integration.mjs") {
    names.push("KCODER_E2E_CANVA_LIVE");
  }
  if (suiteId === "suites/desktop/legacy-task-flow.e2e.mjs") {
    names.push(
      "CODEX_BIN",
      "CODEX_BINARY_PATH",
      "KCODER_STUDIO_E2E_EXECUTOR_BIN",
      "KCODER_STUDIO_E2E_APP_BIN",
      "KCODER_STUDIO_E2E_DESKTOP_SCENARIO_MODULE",
      "KCODER_STUDIO_E2E_DESKTOP_SCENARIO_ONLY",
      "KCODER_STUDIO_DESKTOP_E2E_REQUEST_INPUT_ONLY",
      "KCODER_STUDIO_E2E_CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB",
      "KCODER_STUDIO_E2E_MEMORY_MAX_PEAK_GROWTH_KIB",
      "KCODER_STUDIO_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB",
      "KCODER_STUDIO_E2E_MEMORY_MAX_SETTLED_DOM_NODES",
    );
  }
  if (isRealModelSuite(suiteId)) {
    names.push(
      "KCODER_E2E_REAL_MODEL",
      "KCODER_E2E_MODEL_PROFILE",
      "KCODER_E2E_MODEL_ENDPOINT",
      "KCODER_E2E_MODEL_NAME",
      "KCODER_E2E_MODEL_API_FORMAT",
      "KCODER_E2E_MODEL_CREDENTIAL_ENV",
      "KCODER_E2E_MODEL_CREDENTIAL_VALUE",
      "KCODER_E2E_ALLOW_INSECURE_REMOTE",
      "KCODER_E2E_MODEL_MAX_TOKENS",
      "KCODER_E2E_MODEL_TIMEOUT_SECS",
      "KCODER_E2E_REAL_MODEL_PREREQUISITE_ONLY",
      "KCODER_E2E_SOURCE_CONFIG_DIR",
      "KCODER_CONFIG_DIR",
    );
    const credentialName = env.KCODER_E2E_MODEL_CREDENTIAL_ENV;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialName || ""))
      names.push(credentialName);
  }
  if (suiteId === '../integration/model/real-model-kworker-office.integration.mjs') {
    names.push('KCODER_E2E_OFFICE_INPUT_USD_PER_MILLION',
      'KCODER_E2E_OFFICE_OUTPUT_USD_PER_MILLION', 'KCODER_E2E_OFFICE_MAX_USD');
  }
  return [...new Set([...names, ...releaseEnvironmentNames(suiteId)])];
}

function modelIndependentSuites(suites) {
  return suites.filter((source) => !isRealModelSuite(source));
}
