import { releaseEnvironmentNames } from "./release-plan.mjs";
export function selectSuites(suites, args, env = process.env) {
  const realModelConsent = args.includes("--real-model");
  if (args.includes("--model-independent") && realModelConsent) {
    throw new Error("--model-independent and --real-model are mutually exclusive");
  }
  if (realModelConsent && env.KCODER_E2E_REAL_MODEL !== "1") {
    throw new Error("--real-model also requires KCODER_E2E_REAL_MODEL=1; both explicit consents are required");
  }
  const index = args.indexOf("--suite");
  if (index < 0) return realModelConsent ? suites : modelIndependentSuites(suites);
  const name = args[index + 1];
  const matches = suites.filter(source => source === name || source.includes(`/${name}/`) || source.endsWith(`/${name}`) || source.endsWith(`/${name}.e2e.mjs`));
  if (matches.length !== 1) throw new Error(`--suite must uniquely select one suite; got ${name || "<missing>"}`);
  if (matches[0].includes("/model/") && !realModelConsent) {
    throw new Error(`real-model suite ${name} requires the --real-model CLI consent flag`);
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
  if (suiteId === "suites/gateway/plugin-target-ca.e2e.mjs") names.push("KCODER_E2E_PLUGIN_CA_PROBE_BIN");
  if (suiteId === "suites/browser/packaged-desktop-smoke.e2e.mjs") names.push("KCODER_E2E_PACKAGED_DIR", "KCODER_E2E_PROCESS_SUPERVISOR_BIN");
  if (suiteId === "suites/browser/right-workspace-multitool.e2e.mjs") {
    names.push("KCODER_E2E_MANAGED_CHROMIUM");
  }
  if (suiteId === "suites/gateway/canva-oauth-discovery.e2e.mjs") {
    names.push("KCODER_E2E_CANVA_LIVE");
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
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialName || "")) names.push(credentialName);
  }
  return [...new Set([...names, ...releaseEnvironmentNames(suiteId)])];
}

function modelIndependentSuites(suites) {
  return suites.filter(source => !source.includes("/model/"));
}
