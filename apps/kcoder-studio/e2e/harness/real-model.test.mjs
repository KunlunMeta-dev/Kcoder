import assert from "node:assert/strict";
import test from "node:test";
import { access, lstat, readFile, readlink, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import * as realModel from "./real-model.mjs";
import { RunContext } from "./run-context.mjs";
import { credentialEnvNames, realModelPreflight } from "./real-model.mjs";

const providerConfig = {
  api_format: "openai_chat_completions",
  endpoint: "https://example.invalid/v1",
  default_model: "test-model",
  context_window_tokens: 32_768,
  output_headroom_tokens: 4_096,
  max_output_tokens: 2_048,
};

test("真实模型隔离配置仅保存选中公开 profile，凭据链接清理不改变原文件", async () => {
  const approved = await RunContext.create(import.meta.url, { testId: "approved-fake-credentials" });
  const context = await RunContext.create(import.meta.url, { testId: "isolated-model-config" });
  try {
    const source = await approved.writeStateJson("credentials.json", { target: "FAKE_CREDENTIAL_FOR_ISOLATION_TEST" });
    const before = await lstat(source);
    const sourceBytes = await readFile(source);
    await approved.writeStateJson("settings.json", { providers: { other: providerConfig } });
    assert.equal(typeof realModel.prepareIsolatedRealModelConfig, "function");
    const isolated = await realModel.prepareIsolatedRealModelConfig(context, {
      provider: "target", providerConfig, configDir: approved.stateDir, credentialEnv: [],
    }, { env: {} });
    assert.equal(isolated.configDir, context.pathInState("real-model-config"));
    const link = resolve(isolated.configDir, "credentials.json");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), source);
    assert.deepEqual(JSON.parse(await readFile(isolated.settingsFile, "utf8")), {
      active_provider: "target", providers: { target: providerConfig },
      tools: { disabled: ["*"] },
    });
    assert.equal((await lstat(isolated.settingsFile)).mode & 0o222, 0);
    await context.finish("passed", { ok: true });
    await assert.rejects(access(context.stateDir), { code: "ENOENT" });
    assert.deepEqual(await readFile(source), sourceBytes);
    assert.equal((await lstat(source)).mode, before.mode);
  } finally {
    await context.finish("passed", { ok: true });
    await approved.finish("passed", { ok: true });
  }
});

test("真实模型隔离配置允许已声明的环境凭据且不生成凭据文件", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "isolated-model-env" });
  try {
    const isolated = await realModel.prepareIsolatedRealModelConfig(context, {
      provider: "target", providerConfig, configDir: context.pathInState("absent-approved-store"),
      credentialEnv: ["CUSTOM_API_KEY"],
    }, { env: { CUSTOM_API_KEY: "FAKE_ENV_CREDENTIAL" } });
    await assert.rejects(access(resolve(isolated.configDir, "credentials.json")), { code: "ENOENT" });
    assert.equal(context.redactValue("FAKE_ENV_CREDENTIAL"), "[REDACTED]");
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("压缩测试预算有界且摘要沿用同一真实模型", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "isolated-summary-budget" });
  let outcome = "failed";
  try {
    const model = { provider: "target", providerConfig, configDir: context.pathInState("absent-approved-store"), credentialEnv: ["CUSTOM_API_KEY"] };
    for (const summaryMaxTokens of [0, -1, 8193, "4096", Infinity]) {
      await assert.rejects(realModel.prepareIsolatedRealModelConfig(context, model, { summaryMaxTokens }), /summary token budget/);
    }
    const isolated = await realModel.prepareIsolatedRealModelConfig(context, model, { env: { CUSTOM_API_KEY: "FAKE_ENV_CREDENTIAL" }, summaryMaxTokens: 4096 });
    const config = JSON.parse(await readFile(isolated.settingsFile, "utf8"));
    assert.equal(config.summary_max_tokens, 4096);
    for (const field of ["summary_provider", "summary_profile", "summary_model"]) assert.equal(config[field], null);
    assert.deepEqual(Object.keys(config.providers), ["target"]);
    assert.equal((await lstat(isolated.settingsFile)).mode & 0o222, 0);
    outcome = "passed";
  } finally { await context.finish(outcome, { ok: outcome === "passed" }); }
});

test("真实模型隔离配置拒绝缺失凭据以及目录或符号链接凭据源", async () => {
  for (const kind of ["missing", "directory", "symlink"]) {
    const context = await RunContext.create(import.meta.url, { testId: `isolated-model-reject-${kind}` });
    try {
      const approvedDir = context.pathInState("approved");
      const original = await context.writeStateJson("approved/original.json", { target: "FAKE_SECRET" });
      if (kind === "directory") await context.writeStateJson("approved/credentials.json/child.json", {});
      if (kind === "symlink") await symlink(original, resolve(approvedDir, "credentials.json"), "file");
      await assert.rejects(realModel.prepareIsolatedRealModelConfig(context, {
        provider: "target", providerConfig, configDir: approvedDir, credentialEnv: ["CUSTOM_API_KEY"],
      }, { env: { UNRELATED_API_KEY: "FAKE_UNRELATED_SECRET" } }),
      kind === "missing" ? /no available approved credential/ : /regular file/);
    } finally {
      await context.finish("passed", { ok: true });
    }
  }
});

test("真实模型预检通过 CLI 读取合并后的 Provider，并且不直接解析配置文件", async () => {
  const calls = [];
  const result = await realModelPreflight("custom.profile", {
    env: {
      KCODER_E2E_REAL_MODEL: "1",
      KCODER_E2E_KCODER_BIN: process.execPath,
      KCODER_CONFIG_DIR: "/approved/config",
    },
    execute: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("providers")) {
        return { stdout: JSON.stringify({ "custom.profile": providerConfig }), stderr: "" };
      }
      return {
        stdout: "kcoder auth\n==============\ncredential store: /approved/config/credentials.json\ncustom.profile: configured\n",
        stderr: "",
      };
    },
  });

  assert.equal(result.provider, "custom.profile");
  assert.equal(result.model, "test-model");
  assert.deepEqual(result.providerConfig, providerConfig);
  assert.equal(result.configDir, "/approved/config");
  assert.deepEqual(calls[0].args.slice(-3), ["config", "get", "providers"]);
  assert.deepEqual(calls[1].args.slice(-2), ["auth", "status"]);
});

test("真实模型预检只接受目标 Provider 的 configured 状态", async () => {
  await assert.rejects(
    realModelPreflight("target", {
      env: {
        KCODER_E2E_REAL_MODEL: "1",
        KCODER_E2E_KCODER_BIN: process.execPath,
      },
      execute: async (_command, args) => args.includes("providers")
        ? { stdout: JSON.stringify({ target: providerConfig }), stderr: "" }
        : { stdout: "other: configured\ntarget: not configured\n", stderr: "" },
    }),
    /profile target has no configured credential/,
  );
});

test("真实模型预检不会把 CLI 的 stderr 或凭据内容带入错误", async () => {
  const secret = "super-secret-api-key";
  const failure = Object.assign(new Error(`command failed: ${secret}`), {
    stderr: `provider rejected ${secret}`,
    stdout: secret,
    code: 2,
  });
  await assert.rejects(
    realModelPreflight("target", {
      env: {
        KCODER_E2E_REAL_MODEL: "1",
        KCODER_E2E_KCODER_BIN: process.execPath,
      },
      execute: async () => { throw failure; },
    }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /configuration loader failed/);
      return true;
    },
  );
});

test("真实模型预检拒绝非法 Provider ID，且未授权时不调用 CLI", async () => {
  let called = false;
  await assert.rejects(
    realModelPreflight("bad\nprovider", {
      env: { KCODER_E2E_REAL_MODEL: "1", KCODER_E2E_KCODER_BIN: process.execPath },
      execute: async () => { called = true; },
    }),
    /invalid real-model provider ID/,
  );
  await assert.rejects(
    realModelPreflight("target", {
      env: { KCODER_E2E_KCODER_BIN: process.execPath },
      execute: async () => { called = true; },
    }),
    /set KCODER_E2E_REAL_MODEL=1/,
  );
  assert.equal(called, false);
});

test("真实模型只选择目标 Provider 声明或内置的凭据环境变量", () => {
  assert.deepEqual(
    credentialEnvNames("custom", { ...providerConfig, credential_env: ["CUSTOM_API_KEY", "bad-name"] }),
    ["CUSTOM_API_KEY"],
  );
  assert.deepEqual(credentialEnvNames("kunlunmeta", providerConfig), ["KUNLUNMETA_BASE_API_KEY"]);
  assert.deepEqual(credentialEnvNames("unmapped", providerConfig), []);
});

test("真实模型预检拒绝无效或与保护环境错配的 Provider 目标", async () => {
  const executeFor = config => async (_command, args) => args.includes("providers")
    ? { stdout: JSON.stringify({ target: config }), stderr: "" }
    : { stdout: "target: configured\n", stderr: "" };
  const baseEnv = {
    KCODER_E2E_REAL_MODEL: "1",
    KCODER_E2E_KCODER_BIN: process.execPath,
  };

  await assert.rejects(
    realModelPreflight("target", {
      env: baseEnv,
      execute: executeFor({ ...providerConfig, endpoint: "file:///tmp/provider" }),
    }),
    /invalid endpoint/,
  );
  await assert.rejects(
    realModelPreflight("target", {
      env: baseEnv,
      execute: executeFor({ ...providerConfig, api_format: "unknown_wire_format" }),
    }),
    /unsupported api_format/,
  );
  await assert.rejects(
    realModelPreflight("target", {
      env: { ...baseEnv, KCODER_E2E_MODEL_NAME: "different-model" },
      execute: executeFor(providerConfig),
    }),
    /model does not match/,
  );
  await assert.rejects(
    realModelPreflight("target", {
      env: { ...baseEnv, KCODER_E2E_MODEL_PROFILE: "other" },
      execute: executeFor(providerConfig),
    }),
    /profile does not match/,
  );
});

test("真实模型仅允许 HTTPS 或明确的 loopback HTTP endpoint", async () => {
  const executeFor = config => async (_command, args) => args.includes("providers")
    ? { stdout: JSON.stringify({ kunlunmeta: config }), stderr: "" }
    : { stdout: "kunlunmeta: configured\n", stderr: "" };
  const env = {
    KCODER_E2E_REAL_MODEL: "1",
    KCODER_E2E_KCODER_BIN: process.execPath,
  };
  await assert.rejects(
    realModelPreflight("kunlunmeta", {
      env,
      execute: executeFor({ ...providerConfig, endpoint: "http://models.example.invalid/v1" }),
    }),
    /insecure remote endpoint/,
  );
  const remoteResult = await realModelPreflight("kunlunmeta", {
    env: { ...env, KCODER_E2E_ALLOW_INSECURE_REMOTE: "1", KCODER_E2E_MODEL_ENDPOINT: "http://models.example.invalid/v1" },
    execute: executeFor({ ...providerConfig, endpoint: "http://models.example.invalid/v1" }),
  });
  assert.equal(remoteResult.providerConfig.endpoint, "http://models.example.invalid/v1");
  for (const endpoint of ["http://127.0.0.1:8000/v1", "http://localhost:8000/v1", "http://[::1]:8000/v1"]) {
    const result = await realModelPreflight("kunlunmeta", {
      env: { ...env, KCODER_E2E_MODEL_ENDPOINT: endpoint },
      execute: executeFor({ ...providerConfig, endpoint }),
    });
    assert.equal(result.providerConfig.endpoint, endpoint);
  }
});

test("真实模型预检按 Provider 声明接受 CUSTOM_API_KEY selector", async () => {
  const customConfig = { ...providerConfig, credential_env: ["CUSTOM_API_KEY"] };
  const result = await realModelPreflight("custom", {
    env: {
      KCODER_E2E_REAL_MODEL: "1",
      KCODER_E2E_KCODER_BIN: process.execPath,
      KCODER_E2E_MODEL_CREDENTIAL_ENV: "CUSTOM_API_KEY",
      CUSTOM_API_KEY: "custom-secret-value",
    },
    execute: async (_command, args) => args.includes("providers")
      ? { stdout: JSON.stringify({ custom: customConfig }), stderr: "" }
      : { stdout: "custom: configured\n", stderr: "" },
  });
  assert.deepEqual(result.credentialEnv, ["CUSTOM_API_KEY"]);
});

test('JSON credential status validates the requested profile in the isolated workspace', async () => {
  const calls = [];
  const result = await realModelPreflight('custom.profile', {
    cwd: '/isolated/workspace',
    env: { KCODER_E2E_REAL_MODEL: '1', KCODER_E2E_KCODER_BIN: process.execPath, KCODER_CONFIG_DIR: '/approved/config' },
    execute: async (_command, args) => {
      calls.push(args);
      return { stdout: args.includes('providers')
        ? JSON.stringify({ 'custom.profile': providerConfig })
        : JSON.stringify({ providers: [{ id: 'custom.profile', configured: true, source: 'file (plaintext)' }] }), stderr: '' };
    },
  });
  assert.equal(result.profile, 'custom.profile');
  assert.equal(calls[0][1], '/isolated/workspace');
  assert.ok(calls[1].includes('--json'));
});
