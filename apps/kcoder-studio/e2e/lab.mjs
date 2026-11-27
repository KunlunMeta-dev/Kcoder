import { access, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startGateway } from "./harness/gateway.mjs";
import { startLabControl, unavailableLabStatus, validLabRunManifest, waitForLabStop } from "./harness/lab-control.mjs";
import { startModelStreamController } from "./harness/model-stream/controller.mjs";
import { assertRendererBuildFresh } from "./harness/renderer-build.mjs";
import { materializeWorkspace } from "./harness/workspace-fixture.mjs";
import { requireExecutable, repoRoot, retainedArtifactRunRoot, runE2E, waitFor } from "./harness/run-context.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const studioRoot = dirname(dirname(scriptPath));
const defaultRendererRoot = resolve(studioRoot, "renderer/dist");
const defaultKcoderBin = resolve(repoRoot, "target/debug", process.platform === "win32" ? "kcoder.exe" : "kcoder");
const defaultTimeoutMs = 2 * 60 * 60 * 1000;
const defaultRequestWaitMs = 10 * 60 * 1000;
const maxRequestWaitMs = 60 * 60 * 1000;
const maxTimeoutMs = 24 * 60 * 60 * 1000;
const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export async function startStudioLab(context, options = {}) {
  const rendererRoot = resolve(options.rendererRoot || process.env.KCODER_E2E_RENDERER_ROOT || defaultRendererRoot);
  await assertRendererBuildFresh({ buildRoot: rendererRoot });
  const kcoderBin = resolve(options.kcoderBin || process.env.KCODER_E2E_KCODER_BIN || defaultKcoderBin);
  await requireExecutable(kcoderBin, "KCoder app-server binary");

  const templateId = options.templateId || "minimal";
  const { path: workspace, metadata: workspaceTemplate } = await materializeWorkspace(context, templateId, { instanceId: "lab-workspace" });
  const home = context.pathInState("home");
  const gatewayConfig = context.pathInState("gateway-config");
  const targetProfile = context.pathInState("target-profile");
  await Promise.all([home, gatewayConfig, targetProfile].map(path => mkdir(path, { recursive: true, mode: 0o700 })));

  const scenario = await readScenario(options.scenarioId || "text-completion");
  const controller = await startModelStreamController(context, {
    scenarioId: scenario.id,
    operationId: "interactive",
    scenario,
  });
  const providerId = "lab-minimax";
  const modelId = "MiniMax-M2.7";
  const hasReadToolScenario = scenario.requests.some(request => request.match?.lastMessageRole === "tool");
  const settingsFile = await context.writeStateJson("target-profile/settings.json", {
    active_provider: providerId,
    model: modelId,
    max_retries: 0,
    permission_mode: "ask",
    allowed_tools: hasReadToolScenario ? ["read", "read_file"] : [],
    tools: { profile: hasReadToolScenario ? "full" : "none", disabled: [] },
    providers: {
      [providerId]: {
        api_format: "openai_chat_completions",
        endpoint: controller.endpointUrl,
        default_model: modelId,
        authentication: { mode: "none" },
        context_window_tokens: 128000,
        max_output_tokens: 4096,
        output_headroom_tokens: 1024,
        max_retries: 0,
        no_proxy: true,
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "lab",
    label: "E2E Lab",
    runtime: "kcoder",
    transport: "local",
    command: kcoderBin,
    workspace,
    settingsFile,
  }]);
  const serversStore = context.pathInState("gateway-config/servers-store.json");
  const gateway = await startGateway(context, {
    label: "lab-gateway",
    host: "127.0.0.1",
    workspace,
    serversFile,
    serversStore,
    kcoderBin,
    startTimeoutMs: 120_000,
    env: {
      KCODER_CONFIG_DIR: gatewayConfig,
      KCODER_HOME: home,
      KCODER_STUDIO_WEB_ROOT: rendererRoot,
      KCODER_MAX_RETRIES: "0",
    },
  });
  await waitFor(async () => {
    const response = await fetch(gateway.baseUrl, { redirect: "manual" }).catch(() => null);
    if (response?.status !== 200) return false;
    const html = await response.text();
    return html.includes("KCoder Studio") || html.includes("<div id=\"root\"");
  }, options.startTimeoutMs || 30_000, "Studio Gateway Web UI", 100, context.abortSignal);

  const session = {
    schemaVersion: 1,
    ownerPid: process.pid,
    gatewayUrl: `${gateway.baseUrl}/`,
    gatewayPid: gateway.child.pid || null,
    gatewayPort: gateway.port,
    workspace,
    home,
    gatewayConfig,
    targetProfile,
    rendererRoot,
    kcoderBin,
    templateId: workspaceTemplate.id,
    templateVersion: workspaceTemplate.version,
    scenarioId: scenario.id,
    operationId: controller.operationId,
    modelRequestMarker: scenario.requests[0]?.match?.lastMessageIncludes || null,
    modelEndpoint: controller.endpointUrl,
    modelControlUrl: controller.controlUrl,
    modelControlToken: controller.controlToken,
    phase: "ready",
  };
  await context.writeStateJson("lab-session.json", session);
  return { session, gateway, controller };
}

export function parseLabArgs(argv) {
  const [command, ...rest] = argv;
  if (!["start", "status", "stop", "wait", "release", "disconnect"].includes(command)) {
    throw new Error("Usage: lab.mjs start [--template ID] [--scenario ID] [--timeout-ms MS] | status RUN_ID | stop RUN_ID | wait RUN_ID REQUEST_ID [TIMEOUT_MS] | release RUN_ID REQUEST_ID [COUNT|all] | disconnect RUN_ID REQUEST_ID");
  }
  if (command === "start") {
    const options = { timeoutMs: defaultTimeoutMs };
    for (let index = 0; index < rest.length; index += 1) {
      const name = rest[index];
      const value = rest[index + 1];
      if (name === "--template") options.templateId = value;
      else if (name === "--scenario") options.scenarioId = value;
      else if (name === "--timeout-ms") options.timeoutMs = Number(value);
      else throw new Error(`Unknown lab start option: ${name}`);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
      index += 1;
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > maxTimeoutMs) {
      throw new Error(`--timeout-ms must be between 1 and ${maxTimeoutMs}`);
    }
    return { command, options };
  }
  const [runId, requestId, frameCount] = rest;
  if (!runId || rest.length !== (command === "status" || command === "stop" ? 1 : command === "release" ? 3 : command === "wait" ? (rest.length === 3 ? 3 : 2) : 2)) {
    throw new Error(`Invalid arguments for lab ${command}`);
  }
  if (["wait", "release", "disconnect"].includes(command) && !requestIdPattern.test(requestId || "")) {
    throw new Error("request ID is invalid");
  }
  if (command === "wait") {
    const timeoutMs = rest.length === 3 ? Number(rest[2]) : defaultRequestWaitMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxRequestWaitMs) {
      throw new Error(`request wait timeout must be between 1 and ${maxRequestWaitMs}`);
    }
    return { command, runId, requestId, timeoutMs };
  }
  if (command === "release" && frameCount !== "all" && !/^[1-9]\d{0,2}$/.test(frameCount || "")) {
    throw new Error("release frame count must be a positive integer or 'all'");
  }
  if (command === "status" || command === "stop") return { command, runId };
  if (command === "disconnect") return { command, runId, requestId };
  return { command, runId, requestId, frames: frameCount === "all" ? "all" : Number(frameCount) };
}

async function main(argv) {
  const parsed = parseLabArgs(argv);
  if (parsed.command === "start") return start(parsed.options);
  if (parsed.command === "status") return showStatus(parsed.runId);
  if (parsed.command === "stop") return stop(parsed.runId);
  if (parsed.command === "wait") return waitForRequest(parsed.runId, parsed.requestId, parsed.timeoutMs);
  if (parsed.command === "release") return release(parsed.runId, parsed.requestId, parsed.frames);
  return disconnect(parsed.runId, parsed.requestId);
}

async function start(options) {
  await runE2E(import.meta.url, {
    testId: "interactive-studio-lab",
    tier: "manual-live",
    modelPolicy: "owned loopback scripted Chat Completions; no external model credentials or upstream requests",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 30_000,
  }, async (context, signal) => {
    const runId = basename(context.runRoot);
    console.log(`Lab run ${runId} is starting.`);
    const runtime = await startStudioLab(context, options);
    const control = await startLabControl(context, {
      getStatus: async () => ({
        runId,
        phase: runtime.gateway.child.exitCode === null && runtime.gateway.child.signalCode === null ? "ready" : "gateway-exited",
        gatewayUrl: runtime.session.gatewayUrl,
        gatewayPid: runtime.session.gatewayPid,
        workspace: runtime.session.workspace,
        home: runtime.session.home,
        configDirectory: runtime.session.gatewayConfig,
        targetProfile: runtime.session.targetProfile,
        templateId: runtime.session.templateId,
        scenarioId: runtime.session.scenarioId,
        modelRequestMarker: runtime.session.modelRequestMarker,
        modelStream: runtime.controller.snapshot(),
      }),
    });
    console.log(`Run ID: ${runId}`);
    console.log(`Open in a browser on this machine: ${runtime.session.gatewayUrl}`);
    console.log(`Workspace: ${runtime.session.workspace}`);
    console.log(`Owned Home: ${runtime.session.home}`);
    console.log(`Model request marker: ${runtime.session.modelRequestMarker}`);
    console.log(`Check status: node apps/kcoder-studio/e2e/lab.mjs status ${runId}`);
    console.log(`Wait for model request: node apps/kcoder-studio/e2e/lab.mjs wait ${runId} initial`);
    console.log(`Release request: node apps/kcoder-studio/e2e/lab.mjs release ${runId} initial all`);
    console.log(`Stop lab: node apps/kcoder-studio/e2e/lab.mjs stop ${runId}`);
    await waitForLabStop(control.stopRequested, { timeoutMs: options.timeoutMs, signal, ownerProcess: runtime.gateway.child });
    return { runId, stoppedBy: "control" };
  });
}

async function showStatus(runId) {
  const state = await loadLabState(runId);
  if (state.manifest.status !== "running") {
    console.log(JSON.stringify({ runId, phase: state.manifest.status, endedAt: state.manifest.endedAt }, null, 2));
    return;
  }
  if (!state.control || !state.session) {
    console.log(JSON.stringify(unavailableLabStatus({ runId, runRoot: state.runRoot, manifest: state.manifest, session: state.session }), null, 2));
    return;
  }
  try {
    const status = await requestJson(`${state.controlUrl}/status`, state.control.token, "GET");
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    if (!isRefusedConnection(error)) throw error;
    console.log(JSON.stringify(unavailableLabStatus({ runId, runRoot: state.runRoot, manifest: state.manifest, session: state.session }), null, 2));
  }
}

async function stop(runId) {
  const state = await loadLabState(runId);
  if (state.manifest.status !== "running") {
    console.log(`Lab ${runId} is already ${state.manifest.status}.`);
    return;
  }
  if (!state.control || !state.session) {
    console.log(JSON.stringify(unavailableLabStatus({ runId, runRoot: state.runRoot, manifest: state.manifest, session: state.session }), null, 2));
    throw new Error("Lab owner state is incomplete. Recorded resources were retained because process ownership could not be reattached safely.");
  }
  try {
    await requestJson(`${state.controlUrl}/stop`, state.control.token, "POST");
    console.log(`Stop requested for lab ${runId}.`);
  } catch (error) {
    if (!isRefusedConnection(error)) throw error;
    console.log(JSON.stringify(unavailableLabStatus({
      runId,
      runRoot: state.runRoot,
      manifest: state.manifest,
      session: state.session,
    }), null, 2));
    throw new Error("Lab owner is unavailable. Recorded resources were retained because process ownership could not be reattached safely.");
  }
}

async function release(runId, requestId, frames) {
  const state = await loadLabState(runId);
  if (state.manifest.status !== "running" || !state.session) throw new Error(`Lab ${runId} has no active model controller`);
  const controller = state.session;
  const result = await requestJson(`${controller.modelControlUrl}/requests/${encodeURIComponent(requestId)}/release`, controller.modelControlToken, "POST", { frames });
  console.log(JSON.stringify(result, null, 2));
}

async function waitForRequest(runId, requestId, timeoutMs) {
  const state = await loadLabState(runId);
  if (state.manifest.status !== "running" || !state.session) throw new Error(`Lab ${runId} has no active model controller`);
  const url = `${state.session.modelControlUrl}/requests/${encodeURIComponent(requestId)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const request = await requestJson(url, state.session.modelControlToken, "GET");
    if (request.status !== "waiting") {
      console.log(JSON.stringify(request, null, 2));
      return request;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for model request ${requestId} after ${timeoutMs}ms`);
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(250, deadline - Date.now())));
  }
}

async function disconnect(runId, requestId) {
  const state = await loadLabState(runId);
  if (state.manifest.status !== "running" || !state.session) throw new Error(`Lab ${runId} has no active model controller`);
  const result = await requestJson(`${state.session.modelControlUrl}/requests/${encodeURIComponent(requestId)}/disconnect`, state.session.modelControlToken, "POST", {});
  console.log(JSON.stringify(result, null, 2));
}

async function loadLabState(runId) {
  const runRoot = retainedArtifactRunRoot(scriptPath, runId);
  const manifest = JSON.parse(await readFile(resolve(runRoot, "manifest.json"), "utf8"));
  if (!validLabRunManifest(manifest, runId, { activeOnly: false })) throw new Error(`Run ${runId} is not a KCoder E2E lab`);
  if (manifest.status !== "running") return { manifest, runRoot };
  const stateRoot = resolve(runRoot, "state");
  const [control, session] = await Promise.all([
    readStateJson(resolve(stateRoot, "lab-control.json"), { missing: true }),
    readStateJson(resolve(stateRoot, "lab-session.json"), { missing: true }),
  ]);
  if (!control || !session) return { manifest, runRoot, control: null, session: session || null };
  const controlPort = manifest.ports.find(port => port.label === "lab-control")?.port;
  if (control.schemaVersion !== 1 || control.host !== "127.0.0.1" || control.port !== controlPort || !control.token) {
    throw new Error(`Lab ${runId} control endpoint does not match its recorded owned port`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(session.scenarioId || "") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(session.operationId || "") ||
      typeof session.modelControlToken !== "string" || session.modelControlToken.length < 32) {
    throw new Error(`Lab ${runId} model controller identity is invalid`);
  }
  const modelControl = new URL(session.modelControlUrl);
  const expectedModelPath = `/__control/${encodeURIComponent(session.scenarioId)}/${encodeURIComponent(session.operationId)}`;
  if (modelControl.protocol !== "http:" || modelControl.hostname !== "127.0.0.1" || modelControl.pathname !== expectedModelPath) {
    throw new Error(`Lab ${runId} model controller must use its recorded loopback control route`);
  }
  const modelPort = modelControl.port;
  if (!manifest.ports.some(port => port.port === Number(modelPort) && port.label.startsWith("model stream "))) {
    throw new Error(`Lab ${runId} model controller does not match a recorded owned port`);
  }
  return { manifest, runRoot, control, session, controlUrl: `http://${control.host}:${control.port}/__kcoder_e2e_lab` };
}

async function readStateJson(path, { missing = false } = {}) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw new Error(`Unable to read active lab state (${error.code || "invalid_json"})`);
  }
}

async function requestJson(url, token, method, body) {
  const address = new URL(url);
  if (address.protocol !== "http:" || address.hostname !== "127.0.0.1") throw new Error("Lab controls must use loopback HTTP");
  const response = await fetch(address, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Lab control request failed with HTTP ${response.status}: ${value.error || "unknown error"}`);
  return value;
}

function isRefusedConnection(error) {
  return error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
}

async function readScenario(scenarioId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scenarioId)) throw new Error("Scenario ID is invalid");
  const path = resolve(studioRoot, "e2e/fixtures/model-stream/chat-completions/minimax", scenarioId, "scenario.json");
  await access(path);
  const scenario = JSON.parse(await readFile(path, "utf8"));
  if (scenario.id !== scenarioId) throw new Error(`Scenario identity does not match ${scenarioId}`);
  return scenario;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
