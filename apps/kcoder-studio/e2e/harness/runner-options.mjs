import { releaseEnvironmentNames } from "./release-plan.mjs";
const pinnedMobileCacheSuites = new Set([
  "suites/mobile/mobile-session-cache-event-continuity.e2e.mjs",
  "suites/mobile/mobile-session-cache-multirealm.e2e.mjs",
  "suites/mobile/mobile-session-cache-unknown-offline-v1.e2e.mjs",
  "suites/mobile/mobile-session-cache-workspace-absence.e2e.mjs",
  "suites/mobile/mobile-session-cache-permission-revocation.e2e.mjs",
]);
export function selectSuites(suites, args, env = process.env) {
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
  const name = args[index + 1];
  const matches = suites.filter(
    (source) =>
      source === name ||
      source.includes(`/${name}/`) ||
      source.endsWith(`/${name}`) ||
      source.endsWith(`/${name}.e2e.mjs`),
  );
  if (matches.length !== 1)
    throw new Error(
      `--suite must uniquely select one suite; got ${name || "<missing>"}`,
    );
  if (matches[0].includes("/model/") && !realModelConsent) {
    throw new Error(
      `real-model suite ${name} requires the --real-model CLI consent flag`,
    );
  }
  return matches;
}

export function suiteEnvironmentNames(suiteId, env = process.env) {
  const names = [
    "KCODER_E2E_CHROMIUM_BIN",
    "KCODER_E2E_CHROMIUM_NO_SANDBOX",
    "KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX",
    "KCODER_E2E_KCODER_BIN",
    "KCODER_E2E_SUITE_TIMEOUT_MS",
  ];
  if (suiteId === 'suites/browser/web-search-positive-native.e2e.mjs'
      || suiteId.startsWith('suites/gateway/web-search-native-')
      || suiteId === 'suites/gateway/web-fetch-native-stream-cancel.e2e.mjs'
      || suiteId === 'suites/mobile/mobile-web-search-native.e2e.mjs') {
    names.push('KCODER_E2E_SEARCH_NATIVE_BIN', 'KCODER_E2E_SEARCH_NATIVE_SHA256',
      'KCODER_E2E_SEARCH_NATIVE_CHECKPOINT', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_RENDERER_SOURCE_ROOT', 'KCODER_E2E_OPENSSL_BIN');
  }
  if (suiteId === 'suites/gateway/physical-web-targets.e2e.mjs') names.push('KCODER_E2E_WINDOWS_NATIVE_LIBTEST','KCODER_E2E_WEB_EXTERNAL_NETWORK','KCODER_E2E_PHYSICAL_WEB_EXECUTE','KCODER_E2E_PHYSICAL_WEB_TARGET','KCODER_E2E_WINDOWS_NODE','KCODER_E2E_WINDOWS_PROBE_PARENT','KCODER_E2E_PHYSICAL_WEB_ARCHIVE','KCODER_E2E_PHYSICAL_WEB_ARCHIVE_SHA256','KCODER_E2E_PHYSICAL_WEB_ARCHIVE_BYTES','KCODER_E2E_PHYSICAL_WEB_MEMBERS','KCODER_E2E_PHYSICAL_WEB_PRIVATE_URL_FILE','KCODER_E2E_PHYSICAL_WEB_LAUNCHER','KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256','KCODER_E2E_WINDOWS_EXPECTED_COMMIT','KCODER_E2E_PHYSICAL_WEB_GATEWAY_ROOT','KCODER_E2E_PHYSICAL_WEB_GATEWAY_SOURCE_COMMIT','KCODER_E2E_PHYSICAL_WEB_NATIVE_BUILD_RESULT','KCODER_E2E_PHYSICAL_WEB_CLIENT_BIN');
  if (suiteId === 'suites/browser/provider-settings-persistence.e2e.mjs') names.push('KCODER_E2E_PROVIDER_DISCOVERY_ONLY');
  if (suiteId === 'suites/browser/memory-native-management.e2e.mjs') names.push('KCODER_E2E_NATIVE_MEMORY_ONLY', 'KCODER_E2E_NATIVE_MEMORY_PUBLICATION_ONLY', 'KCODER_E2E_KNOWLEDGE_FIXTURE_BIN', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_BUDGET', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_GATEWAY_ROOT');
  if (suiteId === 'suites/office/office-request-only-native.e2e.mjs') names.push(
    'KCODER_TEST_SYSTEM_USERS', 'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_OFFICE_FILE_PROOF',
  );
  if (suiteId === 'suites/gateway/native-code-service-lifetime.e2e.mjs') names.push(
    'KCODER_E2E_REL_STORAGE_RECOVERY', 'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE',
  );
  if (suiteId === 'suites/gateway/application-controls-native.e2e.mjs') names.push(
    'KCODER_E2E_APPLICATION_TASKS', 'KCODER_E2E_APPLICATION_OAUTH',
    'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT', 'KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE',
  );
  if (suiteId === 'suites/gateway/project-knowledge-publication.e2e.mjs') names.push(
    'KCODER_E2E_STATE_NATIVE_BIN', 'KCODER_E2E_STATE_NATIVE_SHA256', 'KCODER_E2E_KCODER_BIN_SHA256',
    'KCODER_E2E_PACKAGED_DIR', 'KCODER_E2E_PACKAGED_MANIFEST_SHA256', 'KCODER_E2E_PACKAGED_HOST_SHA256',
    'KCODER_RELEASE_EXPECTED_COMMIT', 'KCODER_E2E_PROCESS_SUPERVISOR_BIN',
    'KCODER_E2E_GIT_SH_BIN', 'KCODER_E2E_GIT_SH_SHA256',
  );
  if ([
    'suites/gateway/application-business-native.e2e.mjs',
    'suites/gateway/application-business-read-native.e2e.mjs',
    'suites/gateway/application-business-unknown-native.e2e.mjs',
    'suites/gateway/application-business-unknown-hard-drop-native.e2e.mjs',
  ].includes(suiteId)) names.push('KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_GATEWAY_ROOT');
  if (suiteId === 'suites/gateway/application-business-read-native.e2e.mjs') names.push('KCODER_E2E_APPLICATION_READ_SOURCE');
  if (suiteId === 'suites/gateway/plugin-version-retention.e2e.mjs') names.push(
    'KCODER_E2E_NATIVE_PLUGIN_SOURCE_LEASE', 'KCODER_E2E_KCODER_SHA256', 'KCODER_E2E_GATEWAY_ROOT',
  );
  if (suiteId === "suites/model/real-model-business-templates.e2e.mjs") names.push("KCODER_E2E_KNOWLEDGE_FIXTURE_BIN", "KCODER_E2E_GATEWAY_ROOT", "KCODER_E2E_NATIVE_BUSINESS_CASES", "KCODER_E2E_NATIVE_BUSINESS_REQUEST_CAP");
  if (suiteId === "suites/browser/organization-oidc-login.e2e.mjs") names.push("KCODER_TEST_SYSTEM_USERS", "KCODER_E2E_OIDC_PYTHON", "KCODER_E2E_KCODER_BIN_SHA256", "KCODER_E2E_ORGANIZATION_RESOURCE_UI");
  if (suiteId === 'suites/browser/windows-migration-ui.e2e.mjs') names.push(
    'KCODER_E2E_WINDOWS_SSH_TARGET', 'KCODER_E2E_WINDOWS_STUDIO_DIRECTORY',
    'KCODER_E2E_WINDOWS_NODE', 'KCODER_E2E_WINDOWS_CLI', 'KCODER_E2E_WINDOWS_CLI_SHA256', 'KCODER_E2E_RENDERER_ROOT',
  );
  if (suiteId === 'suites/browser/automation-period-budget.e2e.mjs') names.push('KCODER_E2E_AUTOMATION_UNIFIED_CODE_ONLY', 'KCODER_E2E_KCODER_BIN_SHA256');
  if (suiteId === 'suites/gateway/windows-installer-lifecycle.e2e.mjs') names.push('KCODER_E2E_WINDOWS_INSTALLER_DIRECTORY_TRUST','KCODER_E2E_WINDOWS_INSTALLER_OFFICE', 'KCODER_E2E_WINDOWS_INSTALLER_OFFICE_UPGRADE_ONLY','KCODER_E2E_WINDOWS_INSTALLER_OFFICE_FRESH','KCODER_E2E_WINDOWS_INSTALLER_STARTUP');
  if (suiteId === 'suites/gateway/windows-native-components.e2e.mjs') names.push(
    'KCODER_E2E_WINDOWS_NATIVE_COMPONENTS', 'KCODER_E2E_WINDOWS_SSH_TARGET',
    'KCODER_E2E_WINDOWS_STUDIO_DIRECTORY', 'KCODER_E2E_WINDOWS_NODE',
    'KCODER_E2E_WINDOWS_NATIVE_CLI', 'KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR',
    'KCODER_E2E_WINDOWS_CHANNEL_SOURCE_ARCHIVE', 'KCODER_E2E_WINDOWS_NATIVE_STORE_READONLY_PROBE',
    'KCODER_E2E_WINDOWS_NATIVE_IMAGE_ONLY', 'KCODER_E2E_WINDOWS_NATIVE_COMPONENT_ADDON',
    'KCODER_E2E_WINDOWS_NATIVE_GATEWAY', 'KCODER_E2E_WINDOWS_GATEWAY_SOURCE_ARCHIVE',
  );
  if (suiteId === "suites/gateway/linux-headless-credentials.e2e.mjs") names.push(
    "KCODER_E2E_LINUX_HEADLESS_CREDENTIALS", "KCODER_E2E_LINUX_HEADLESS_NATIVE", "KCODER_E2E_LINUX_HEADLESS_NATIVE_SHA256",
  );

  if (suiteId === "suites/gateway/migration-terminal-transfer.e2e.mjs") names.push("KCODER_E2E_MIGRATION_TERMINAL_PRIVATE_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_HISTORY_FAMILIES_ONLY");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_UPLOADED_PLUGINS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_PROJECT_MCP_ONLY");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs", "suites/gateway/migration-terminal-transfer.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_PROJECTS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (suiteId === "suites/gateway/migration-terminal-transfer.e2e.mjs") names.push("KCODER_E2E_MIGRATION_PROJECTS_CASES");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_AGENT_ADAPTATION_ONLY");
  if (["suites/browser/migration.e2e.mjs", "suites/mobile/migration.e2e.mjs", "suites/gateway/migration-terminal-transfer.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY", "KCODER_E2E_KCODER_BIN_SHA256");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_HISTORY_SOURCE_ONLY");
  if (suiteId === "suites/mobile/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_SOURCE_DIRECTORY_ONLY");
  if (suiteId === "suites/mobile/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY");
  if (suiteId === 'suites/mobile/migration.e2e.mjs') names.push('KCODER_E2E_MOBILE_SOURCE_ROOT');
  if (suiteId === 'suites/mobile/migration.e2e.mjs') names.push('KCODER_E2E_MIGRATION_MOBILE_ARCHIVE', 'KCODER_E2E_MIGRATION_MOBILE_ARCHIVE_SHA256');
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY");
  if (suiteId === "suites/browser/migration-private-credentials.e2e.mjs") names.push("KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_MIGRATION_FIXTURE_BINARY");
  if (suiteId === "suites/browser/migration.e2e.mjs") names.push("KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "suites/browser/migration-large-history.e2e.mjs") names.push(
    "KCODER_E2E_MIGRATION_LARGE_HISTORY", "KCODER_E2E_MIGRATION_PERF_CASE", "KCODER_E2E_MIGRATION_SMALL_ASSET_COUNT", "KCODER_E2E_KCODER_BIN_SHA256", "KCODER_E2E_RENDERER_ROOT",
    "KCODER_E2E_MIGRATION_RENDERER_BASELINE", "KCODER_E2E_MIGRATION_RENDERER_BASELINE_SHA256",
  );
  if (["suites/browser/electron-widget-controller.e2e.mjs", "suites/browser/electron-widget-isolation.e2e.mjs", "suites/browser/electron-widget-resources.e2e.mjs"].includes(suiteId)) names.push("KCODER_E2E_ELECTRON_BIN", "KCODER_E2E_PROCESS_SUPERVISOR_BIN");
  if (suiteId === "suites/mobile/mobile-qa-repeated-text-attachment-recovery.e2e.mjs") {
    names.push(
      "KCODER_E2E_REPEATED_TEXT_MOBILE_MANIFEST",
      "KCODER_E2E_REPEATED_TEXT_SOURCE_TREE_SHA256",
      "KCODER_E2E_REPEATED_TEXT_MANIFEST_SHA256",
      "KCODER_E2E_REPEATED_TEXT_BUNDLE_SHA256",
    );
  }
  if (suiteId === "suites/mobile/mobile-real-engine-auth-renewal.e2e.mjs") {
    names.push("KCODER_E2E_EXPECTED_KCODER_SHA256");
  }
  if (pinnedMobileCacheSuites.has(suiteId) || suiteId === "suites/mobile/mobile-profile-workbench-http.e2e.mjs") {
    names.push(
      "KCODER_E2E_KCODER_BIN_SHA256",
      "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE",
      "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256",
      "KCODER_E2E_MOBILE_SOURCE_ROOT",
      "KCODER_E2E_MOBILE_SOURCE_MANIFEST",
      "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256",
    );
  }
  if (suiteId === "suites/browser/provider-retry-feedback.e2e.mjs") {
    names.push(
      "KCODER_E2E_PROVIDER_RETRY_MAC_ELECTRON",
      "HOME",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
    );
  }
  if (suiteId === "suites/gateway/windows-wine-resources.e2e.mjs") names.push("KCODER_E2E_PACKAGED_DIR");
  if (suiteId === "suites/gateway/plugin-target-ca.e2e.mjs") names.push("KCODER_E2E_PLUGIN_CA_PROBE_BIN");
  if (suiteId === "suites/gateway/windows-migration-security.e2e.mjs") names.push(
    "KCODER_E2E_WINDOWS_MIGRATION_SECURITY", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT",
    "KCODER_E2E_WINDOWS_SECURITY_HELPER", "KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256", "KCODER_E2E_WINDOWS_SECURITY_BASELINE_SOURCE",
  );
  if (suiteId === "suites/gateway/windows-keyring-logon.e2e.mjs") names.push(
    "KCODER_E2E_WINDOWS_KEYRING_LOGON", "KCODER_E2E_WINDOWS_KEYRING_LOGON_MODE",
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT",
  );
  if (["suites/gateway/windows-keyring-account.e2e.mjs", "suites/gateway/windows-keyring-core.e2e.mjs", "suites/gateway/windows-keyring-host.e2e.mjs", "suites/gateway/windows-private-keyring.e2e.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_KEYRING_LOGON", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256", "KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_FAULT",
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_SECURITY_HELPER", "KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256",
  );
  if (["suites/gateway/windows-keyring-host.e2e.mjs", "suites/gateway/windows-private-keyring.e2e.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_KEYRING_HOST_CLI", "KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256",
    "KCODER_E2E_WINDOWS_NODE", "KCODER_E2E_WINDOWS_KEYRING_HOST_NODE_SHA256",
  );
  if (["suites/gateway/windows-historical-undo.e2e.mjs", "suites/gateway/windows-terminal-lifecycle.e2e.mjs", "suites/gateway/windows-local-attachment.e2e.mjs", "suites/gateway/windows-local-attachment-lock.e2e.mjs", "suites/gateway/windows-snapshot-paths.e2e.mjs", "suites/gateway/windows-profile-settings-lock.e2e.mjs", "suites/gateway/windows-plugin-migration.e2e.mjs", "suites/gateway/windows-source-transfer.e2e.mjs", "suites/gateway/windows-archive-retention.e2e.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
  );
  if (suiteId === "suites/gateway/windows-terminal-lifecycle.e2e.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY", "KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK",
  );
  if (["suites/gateway/windows-local-attachment.e2e.mjs", "suites/gateway/windows-local-attachment-lock.e2e.mjs", "suites/gateway/windows-snapshot-paths.e2e.mjs", "suites/gateway/windows-profile-settings-lock.e2e.mjs", "suites/gateway/windows-plugin-migration.e2e.mjs", "suites/gateway/windows-source-transfer.e2e.mjs", "suites/gateway/windows-archive-retention.e2e.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
  );
  if (suiteId === "suites/gateway/windows-real-source-import.e2e.mjs") names.push("KCODER_E2E_WINDOWS_PERSONAL_MIGRATION_READ", "KCODER_E2E_WINDOWS_MIGRATION_SOURCE_ROOTS");
  if (suiteId === "suites/gateway/windows-profile-settings-lock.e2e.mjs") names.push("KCODER_E2E_WINDOWS_CONFIG_LOCK_SCOPE");
  if (suiteId === "suites/gateway/windows-plugin-migration.e2e.mjs") names.push("KCODER_E2E_WINDOWS_PLUGIN_LEASE_SCOPE");
  if (suiteId === "suites/gateway/windows-private-credentials.e2e.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
    "KCODER_E2E_WINDOWS_PRIVATE_REVIEW_SHA256", "KCODER_E2E_WINDOWS_PRIVATE_NODE_SHA256",
  );
  if (suiteId === "suites/gateway/windows-archive-retention.e2e.mjs") names.push("KCODER_E2E_WINDOWS_RETENTION_SCOPE");
  if (suiteId === "suites/gateway/windows-archive-retention.e2e.mjs" && ['read-tools', 'read-engine'].includes(env.KCODER_E2E_WINDOWS_RETENTION_SCOPE)) names.push("KCODER_E2E_WINDOWS_READ_PATH_MODE");
  if (suiteId === "suites/gateway/windows-cross-host-source.e2e.mjs") names.push(
    "KCODER_E2E_WINDOWS_NATIVE_LIBTEST", "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_PROBE_PARENT", "KCODER_E2E_WINDOWS_NODE",
    "KCODER_E2E_WINDOWS_NATIVE_TEST_BIN", "KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256", "KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN", "KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256",
    "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY",
    "KCODER_E2E_WINDOWS_CROSS_HOST_SOURCE", "KCODER_E2E_WINDOWS_CROSS_HOST_CHECKOUT", "KCODER_E2E_WINDOWS_LINUX_ADDRESS",
    "KCODER_E2E_WINDOWS_SSH_WRAPPER_BIN", "KCODER_E2E_WINDOWS_SSH_WRAPPER_SHA256", "KCODER_E2E_KCODER_BIN", "KCODER_E2E_KCODER_BIN_SHA256",
  );
  if (["suites/gateway/windows-real-source-import.e2e.mjs", "suites/model/windows-migration-continuation.e2e.mjs", "suites/gateway/windows-migration.e2e.mjs"].includes(suiteId)) names.push(
    "KCODER_E2E_WINDOWS_SSH_TARGET", "KCODER_E2E_WINDOWS_NODE", "KCODER_E2E_WINDOWS_PROBE_PARENT",
    "KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE", "KCODER_E2E_WINDOWS_PAYLOAD_SHA256",
    "KCODER_E2E_WINDOWS_EXPECTED_COMMIT", "KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256", "KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT",
    "KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS", "KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS_SHA256",
    "KCODER_E2E_WINDOWS_CATALOG_LOCK_TEST_MODE",
  );
  if (['suites/browser/web-startup-baseline-zero-business.e2e.mjs', 'suites/browser/web-startup-current-zero-business.e2e.mjs'].includes(suiteId))
    names.push('KCODER_E2E_STARTUP_BIN', 'KCODER_E2E_STARTUP_SHA256', 'KCODER_E2E_RENDERER_ROOT');
  if (suiteId === "suites/browser/packaged-desktop-smoke.e2e.mjs") names.push("KCODER_E2E_PACKAGED_DIR", "KCODER_E2E_PROCESS_SUPERVISOR_BIN", "KCODER_E2E_PACKAGED_WIDGET_LIFECYCLE", "KCODER_RELEASE_EXPECTED_COMMIT");
  if (suiteId.startsWith("suites/browser/electron-"))
    names.push("KCODER_E2E_ELECTRON_BIN", "KCODER_E2E_RENDERER_ROOT");
  if (suiteId === "suites/gateway/windows-wine-resources.e2e.mjs")
    names.push("KCODER_E2E_PACKAGED_DIR");
  if (suiteId === "suites/gateway/plugin-target-ca.e2e.mjs")
    names.push("KCODER_E2E_PLUGIN_CA_PROBE_BIN");
  if (suiteId === "suites/browser/packaged-desktop-smoke.e2e.mjs")
    names.push("KCODER_E2E_PACKAGED_DIR", "KCODER_E2E_PROCESS_SUPERVISOR_BIN");
  if (suiteId === "suites/browser/right-workspace-multitool.e2e.mjs") {
    names.push("KCODER_E2E_MANAGED_CHROMIUM");
  }
  if (suiteId === "suites/gateway/canva-oauth-discovery.e2e.mjs") {
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
  if (suiteId.includes("/model/")) {
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
      "KCODER_CONFIG_DIR",
    );
    const credentialName = env.KCODER_E2E_MODEL_CREDENTIAL_ENV;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialName || ""))
      names.push(credentialName);
  }
  return [...new Set([...names, ...releaseEnvironmentNames(suiteId)])];
}

function modelIndependentSuites(suites) {
  return suites.filter((source) => !source.includes("/model/"));
}
