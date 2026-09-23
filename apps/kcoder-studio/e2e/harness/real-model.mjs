import { execFile } from "node:child_process";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { repoRoot, requireExecutable } from "./run-context.mjs";

const execFileAsync = promisify(execFile);
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_API_FORMATS = new Set([
  "anthropic_messages",
  "openai_chat_completions",
  "openai_responses",
]);
const BUILTIN_CREDENTIAL_ENV = new Map([
  ["anthropic", ["ANTHROPIC_API_KEY"]],
  ["openai", ["OPENAI_API_KEY"]],
  ["kunlunmeta", ["KUNLUNMETA_BASE_API_KEY"]],
]);

/** Keep mutable runtime state isolated without reading or copying approved credentials. */
export async function prepareIsolatedRealModelConfig(context, model, options = {}) {
  const summaryMaxTokens = options.summaryMaxTokens;
  if (summaryMaxTokens !== undefined &&
      (!Number.isInteger(summaryMaxTokens) || summaryMaxTokens < 1 || summaryMaxTokens > 8192)) {
    throw new Error("UNMET_PREREQUISITE: invalid real-model summary token budget");
  }
  const env = options.env || process.env;
  const availableEnv = model.credentialEnv.filter((name) => env[name]?.trim());
  for (const name of availableEnv) context.registerSecret(env[name]);
  const source = resolve(model.configDir, "credentials.json");
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("UNMET_PREREQUISITE: cannot inspect approved credential store");
    }
  }
  if (sourceStat && !sourceStat.isFile()) {
    throw new Error("UNMET_PREREQUISITE: approved credential store must be a regular file, not a symlink or directory");
  }
  if (!sourceStat && availableEnv.length === 0) {
    throw new Error("UNMET_PREREQUISITE: no available approved credential store or declared credential environment variable");
  }

  // RunContext owns this directory and removes the link itself, never its target.
  const configDir = context.pathInState("real-model-config");
  await mkdir(configDir, { mode: 0o700 });
  if (sourceStat) {
    try {
      await symlink(source, resolve(configDir, "credentials.json"), "file");
    } catch {
      throw new Error("UNMET_PREREQUISITE: cannot symlink approved credential store; credential copying is forbidden");
    }
  }
  const settingsFile = await context.writeStateJson(
    "real-model-config/settings_real_model.jsonc",
    {
      active_provider: model.provider,
      providers: { [model.provider]: model.providerConfig },
      tools: { disabled: ["*"] },
      ...(summaryMaxTokens === undefined ? {} : {
        // Explicitly keep compaction on the selected runtime, not another configured provider.
        summary_provider: null, summary_profile: null, summary_model: null,
        summary_max_tokens: summaryMaxTokens,
      }),
    },
    0o400,
  );
  return { configDir, settingsFile };
}

/**
 * Validate live-model test prerequisites through the application's Rust configuration loader.
 *
 * `config get providers` returns only public provider configuration, while
 * `auth status` reports credential availability only. This code never reads or
 * parses settings.json or credentials.json directly, thereby preserving layered
 * merging, old-format migration, overlays, and environment-credential rules.
 */
export async function realModelPreflight(profile = "kunlunmeta", options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || repoRoot;
  const execute = options.execute || execFileAsync;
  if (env.KCODER_E2E_REAL_MODEL !== "1") {
    throw new Error(
      "UNMET_PREREQUISITE: set KCODER_E2E_REAL_MODEL=1 to authorize a real provider request; no mock fallback is permitted",
    );
  }
  if (typeof profile !== "string" || !SAFE_PROVIDER_ID.test(profile)) {
    throw new Error("UNMET_PREREQUISITE: invalid real-model provider ID");
  }

  const kcoderBin = await requireExecutable(
    env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
    "KCoder app-server",
  );
  const configDir = resolve(
    env.KCODER_CONFIG_DIR || resolve(env.HOME || "", ".config/kcoder"),
  );
  const commandOptions = {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  };
  const providersOutput = await executeSafely(
    execute,
    kcoderBin,
    ["--cwd", cwd, "config", "get", "providers"],
    commandOptions,
    "configuration loader",
  );
  const providers = parseProviderMap(providersOutput.stdout);
  const providerConfig = providers[profile];
  if (!isProviderConfig(providerConfig)) {
    throw new Error(
      `UNMET_PREREQUISITE: provider profile ${profile} is not declared in the effective merged settings`,
    );
  }
  validateProviderTarget(profile, providerConfig, env);

  const authOutput = await executeSafely(
    execute,
    kcoderBin,
    ["--cwd", cwd, "--json", "auth", "status"],
    commandOptions,
    "credential status check",
  );
  const credentialStatus = parseCredentialStatus(authOutput.stdout);
  if (credentialStatus.get(profile) !== true) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has no configured credential`,
    );
  }
  const credentialEnv = credentialEnvNames(profile, providerConfig);
  const selectedCredential = env.KCODER_E2E_MODEL_CREDENTIAL_ENV;
  if (
    selectedCredential !== undefined &&
    !credentialEnv.includes(selectedCredential)
  ) {
    throw new Error(
      "UNMET_PREREQUISITE: protected credential selector does not match the effective Provider configuration",
    );
  }

  return {
    kcoderBin,
    profile,
    provider: profile,
    model: providerConfig.default_model,
    providerConfig,
    credentialEnv,
    configDir,
  };
}

export function credentialEnvNames(profile, providerConfig) {
  const declared = Array.isArray(providerConfig?.credential_env)
    ? providerConfig.credential_env
    : [];
  const names =
    declared.length > 0
      ? declared
      : BUILTIN_CREDENTIAL_ENV.get(String(profile).toLowerCase()) || [];
  return [
    ...new Set(
      names.filter(
        (name) => typeof name === "string" && SAFE_ENV_NAME.test(name),
      ),
    ),
  ];
}

async function executeSafely(execute, command, args, options, label) {
  try {
    return await execute(command, args, options);
  } catch (error) {
    const exitCode = Number.isInteger(error?.code)
      ? ` (exit ${error.code})`
      : "";
    // Do not propagate child stdout, stderr, or messages because they may contain provider-returned secrets.
    throw new Error(`UNMET_PREREQUISITE: KCoder ${label} failed${exitCode}`);
  }
}

function parseProviderMap(stdout) {
  try {
    const value = JSON.parse(String(stdout));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value;
  } catch {
    throw new Error(
      "UNMET_PREREQUISITE: KCoder configuration loader returned invalid Provider metadata",
    );
  }
}

function parseCredentialStatus(stdout) {
  const statuses = new Map();
  try {
    const value = JSON.parse(String(stdout));
    if (Array.isArray(value.providers)) {
      for (const row of value.providers) if (SAFE_PROVIDER_ID.test(row.id || '') && typeof row.configured === 'boolean') statuses.set(row.id, row.configured);
      return statuses;
    }
  } catch { /* Older CLI versions return human-readable status. */ }
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(
      /^([A-Za-z0-9._-]+): (configured|not configured|file \(plaintext\)|environment)$/,
    );
    if (match) statuses.set(match[1], match[2] !== "not configured");
  }
  return statuses;
}

function isProviderConfig(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.default_model === "string" &&
    value.default_model.trim().length > 0
  );
}

function validateProviderTarget(profile, providerConfig, env) {
  const endpoint = providerConfig.endpoint;
  const apiFormat = providerConfig.api_format;
  const model = providerConfig.default_model;
  if (
    typeof endpoint !== "string" ||
    endpoint.trim() !== endpoint ||
    /[\r\n\0]/.test(endpoint)
  ) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an invalid endpoint`,
    );
  }
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an invalid endpoint`,
    );
  }
  if (
    !new Set(["http:", "https:"]).has(parsedEndpoint.protocol) ||
    parsedEndpoint.username ||
    parsedEndpoint.password
  ) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an invalid endpoint`,
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const allowInsecureRemote = env.KCODER_E2E_ALLOW_INSECURE_REMOTE === "1";
  if (
    parsedEndpoint.protocol === "http:" &&
    !loopbackHosts.has(parsedEndpoint.hostname.toLowerCase()) &&
    !allowInsecureRemote
  ) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an insecure remote endpoint`,
    );
  }
  if (!SUPPORTED_API_FORMATS.has(apiFormat)) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an unsupported api_format`,
    );
  }
  if (model.trim() !== model || model.length > 512 || /[\r\n\0]/.test(model)) {
    throw new Error(
      `UNMET_PREREQUISITE: real-model profile ${profile} has an invalid default model`,
    );
  }
  const expected = [
    ["KCODER_E2E_MODEL_PROFILE", profile, "profile"],
    ["KCODER_E2E_MODEL_ENDPOINT", endpoint, "endpoint"],
    ["KCODER_E2E_MODEL_NAME", model, "model"],
    ["KCODER_E2E_MODEL_API_FORMAT", apiFormat, "api_format"],
  ];
  for (const [name, actual, label] of expected) {
    if (env[name] !== undefined && env[name] !== actual) {
      throw new Error(
        `UNMET_PREREQUISITE: protected real-model ${label} does not match the effective Provider configuration`,
      );
    }
  }
}
