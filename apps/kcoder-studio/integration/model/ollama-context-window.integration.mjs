import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwnedOllamaOpenAiProxy } from "../../e2e/harness/ollama-openai-proxy.mjs";
import { parseOllamaServerLogEvidence } from "../../e2e/harness/ollama-server-log-evidence.mjs";
import { realModelPreflight } from "../../e2e/harness/real-model.mjs";
import { repoRoot, requireExecutable, runIntegration } from "../../e2e/harness/run-context.mjs";

const MODEL = "qwen3.5:2b";
const MAX_COPY_BYTES = 4n * 1024n * 1024n * 1024n;
const TMPFS_MAGIC = 0x01021994n;
const RUN_BUDGET_MS = 600_000;
const MODEL_RUNS = [1100, 1500];
const OUTPUT_TOKEN_LIMIT = 8;
const CLEANUP_RESERVE_MS = 30_000;
const KCODER_TURN_LIMIT_MS = 240_000;
const KCODER_EXIT_GRACE_MS = 90_000;

await runIntegration(import.meta.url, {
  testId: "ollama-context-window-internal-truncation",
  tier: "credentialed-integration",
  modelPolicy: "real-model-required",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 20_000,
}, async context => {
  const runStartedAt = new Date().toISOString();
  const runStartedMono = process.hrtime.bigint();
  const deadline = Date.now() + RUN_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const elapsedMs = () => Number(process.hrtime.bigint() - runStartedMono) / 1e6;
  const probeMode = process.env.KCODER_E2E_OLLAMA_PROBE_MODE || "kcoder";
  assert.ok(["kcoder", "native"].includes(probeMode), "invalid Ollama probe mode");
  const stamp = origin => ({
    utc: new Date().toISOString(),
    elapsedFromRunMs: elapsedMs(),
    elapsedFromOriginMs: origin === undefined
      ? null
      : Number(process.hrtime.bigint() - origin) / 1e6,
    monotonicNs: process.hrtime.bigint().toString(),
  });
  const summary = {
    runStartedAt,
    budgetMs: RUN_BUDGET_MS,
    model: MODEL,
    probeMode,
    status: "incomplete",
    consent: { realModelEnv: process.env.KCODER_E2E_REAL_MODEL === "1" },
    requests: [],
    testCheckoutCommit: context.gitCommit,
    boundary: probeMode === "kcoder"
      ? "Fixed KCoder CLI through the real OpenAI-compatible Provider to an owned Ollama server; not an installed-package acceptance test."
      : "Direct Ollama native /api/chat only; this is not a KCoder-to-Provider call.",
  };
  let serverStarted = false;
  let serverStopped = false;
  let proxyStopped = false;
  let proxy = null;
  let kcoderStopped = false;
  let serverLogCopied = false;
  let serverLogPath = null;
  let scratch = null;

  const persistSummary = async () => {
    await context.writeArtifactJson("probe-summary.json", summary);
  };
  const copyServerLog = async () => {
    if (!serverLogPath || serverLogCopied) return;
    try {
      const raw = await readFile(serverLogPath);
      const target = context.pathInArtifacts("ollama-server.raw.log");
      const file = await open(target, "wx", 0o600);
      try {
        await file.writeFile(raw);
        await file.sync();
      } finally {
        await file.close();
      }
      summary.serverLog = {
        artifact: "ollama-server.raw.log",
        bytes: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
      serverLogCopied = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const stopServer = async () => {
    if (!serverStarted || serverStopped) return;
    await context.stopOwned("ollama-server");
    serverStopped = true;
  };
  const stopKcoder = async () => {
    const processRecord = context.processes.get("kcoder-ctx002");
    if (!processRecord || processRecord.stopped || kcoderStopped) return;
    await context.stopOwned("kcoder-ctx002");
    kcoderStopped = true;
  };
  const stopProxy = async () => {
    if (!proxy || proxyStopped) return;
    await proxy.close();
    proxyStopped = true;
  };

  try {
    assert.equal(process.platform, "linux", "this isolated Snap Ollama fixture is Linux-only");
    assert.equal(
      process.env.KCODER_E2E_REAL_MODEL,
      "1",
      "UNMET_PREREQUISITE: real-model consent is required; no mock path exists",
    );
    assert.ok(remainingMs() > 60_000, "600-second run budget was exhausted before preflight");

    const ollamaBinRequested = resolve(
      process.env.KCODER_E2E_OLLAMA_BIN || "/snap/ollama/current/bin/ollama",
    );
    const sourceStore = resolve(
      process.env.KCODER_E2E_OLLAMA_MODEL_STORE || "/var/snap/ollama/common/models",
    );
    assert.ok(isAbsolute(ollamaBinRequested) && isAbsolute(sourceStore));
    const ollamaBin = await realpath(ollamaBinRequested);
    await requireExecutable(ollamaBin, "Ollama runtime");
    assert.equal(await realpath(sourceStore), sourceStore, "shared model-cache root must not be a path alias");
    await requireReadOnly(sourceStore, "shared model-cache root");
    const binarySha256 = await sha256File(ollamaBin, { signal: context.abortSignal });
    const snapMetadataPath = join(resolve(dirname(ollamaBin), ".."), "meta/snap.yaml");
    let runtimeVersion = null;
    try {
      const snapMetadata = await readFile(snapMetadataPath, "utf8");
      runtimeVersion = snapMetadata.match(/^version:\s*(\S+)/m)?.[1] || null;
    } catch {
      // A custom explicitly pinned binary may not be installed as a Snap.
    }
    summary.runtime = {
      requestedPath: ollamaBinRequested,
      resolvedPath: ollamaBin,
      sha256: binarySha256,
      version: runtimeVersion,
    };

    const manifestPath = join(
      sourceStore,
      "manifests/registry.ollama.ai/library/qwen3.5/2b",
    );
    const manifestStat = await requireRegularFile(manifestPath, "qwen3.5:2b manifest");
    await requireReadOnly(manifestPath, "qwen3.5:2b manifest");
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.schemaVersion, 2, "expected an Ollama v2 model manifest");
    assert.ok(manifest.config && Array.isArray(manifest.layers));
    const descriptors = [manifest.config, ...manifest.layers];
    const uniqueDescriptors = new Map();
    for (const descriptor of descriptors) {
      assert.match(descriptor.digest || "", /^sha256:[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0);
      const previous = uniqueDescriptors.get(descriptor.digest);
      assert.ok(!previous || previous.size === descriptor.size, "duplicate model digests must agree on size");
      uniqueDescriptors.set(descriptor.digest, descriptor);
    }
    assert.equal(uniqueDescriptors.size, 4, "this qwen3.5:2b fixture should reference four unique blobs");

    const blobInputs = [];
    let copyBytes = BigInt(manifestStat.size);
    for (const descriptor of uniqueDescriptors.values()) {
      const digestHex = descriptor.digest.slice("sha256:".length);
      const sourcePath = join(sourceStore, "blobs", "sha256-" + digestHex);
      const sourceStat = await requireRegularFile(sourcePath, "model blob " + digestHex);
      await requireReadOnly(sourcePath, "model blob " + digestHex);
      assert.equal(
        sourceStat.size,
        BigInt(descriptor.size),
        "manifest and shared blob size must match before copying",
      );
      copyBytes += sourceStat.size;
      blobInputs.push({
        digest: descriptor.digest,
        sourcePath,
        bytes: sourceStat.size,
        sourceUid: sourceStat.uid.toString(),
        sourceMode: (Number(sourceStat.mode) & 0o777).toString(8).padStart(4, "0"),
      });
    }
    assert.ok(copyBytes <= MAX_COPY_BYTES, "model copy exceeds the 4 GiB task cap");
    assertRunActive(context.abortSignal);
    assert.ok(remainingMs() > 60_000, "600-second run budget was exhausted during read-only preflight");

    const memoryAvailable = await readMemAvailable();
    const reserve = 256n * 1024n * 1024n;
    scratch = await context.createOwnedScratchDirectory("ollama-context-window", {
      baseDirectory: "/dev/shm",
      requiredBytes: copyBytes,
      reserveBytes: reserve,
      requiredMemoryBytes: copyBytes + reserve,
      availableMemoryBytes: memoryAvailable,
      expectedFilesystemType: TMPFS_MAGIC,
    });
    const modelRoot = context.pathInScratch(scratch, "models");
    const blobRoot = join(modelRoot, "blobs");
    const modelManifestPath = join(
      modelRoot,
      "manifests/registry.ollama.ai/library/qwen3.5/2b",
    );
    await mkdir(blobRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(modelManifestPath), { recursive: true, mode: 0o700 });
    const manifestFile = await open(modelManifestPath, "wx", 0o444);
    try {
      await manifestFile.writeFile(manifestBytes);
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }

    const copiedBlobs = [];
    for (const blob of blobInputs) {
      assertRunActive(context.abortSignal);
      assert.ok(remainingMs() > CLEANUP_RESERVE_MS, "copy exceeded the bounded run budget");
      const targetPath = join(blobRoot, "sha256-" + blob.digest.slice("sha256:".length));
      await pipeline(
        createReadStream(blob.sourcePath),
        createWriteStream(targetPath, { flags: "wx", mode: 0o600 }),
        { signal: context.abortSignal },
      );
      assertRunActive(context.abortSignal);
      await chmod(targetPath, 0o444);
      const targetStat = await requireRegularFile(targetPath, "owned model blob");
      assert.equal(targetStat.size, blob.bytes);
      const copiedDigest = "sha256:" + await sha256File(targetPath, { signal: context.abortSignal });
      assert.equal(copiedDigest, blob.digest, "copied model blob must match its content-addressed name");
      copiedBlobs.push({
        digest: blob.digest,
        bytes: targetStat.size.toString(),
        sha256VerifiedOnce: true,
        sourceUid: blob.sourceUid,
        sourceMode: blob.sourceMode,
      });
    }

    const modelCopy = {
      model: MODEL,
      sourceStore,
      sourceReadOnly: true,
      sourceManifestBytes: manifestStat.size.toString(),
      sourceManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      uniqueBlobCount: copiedBlobs.length,
      copiedBytes: copyBytes.toString(),
      capBytes: MAX_COPY_BYTES.toString(),
      scratch: {
        path: scratch.path,
        filesystemType: scratch.filesystemType,
        mode: scratch.mode,
        memoryAvailableBytesAtAllocation: memoryAvailable.toString(),
      },
      blobs: copiedBlobs,
      noDownload: true,
    };
    await context.writeArtifactJson("model-copy.json", modelCopy);
    summary.modelCopy = {
      uniqueBlobCount: copiedBlobs.length,
      copiedBytes: copyBytes.toString(),
      capBytes: MAX_COPY_BYTES.toString(),
      filesystemType: scratch.filesystemType,
      allBlobDigestsVerifiedOnce: true,
    };

    const port = await allocateLoopbackPort();
    assert.notEqual(port, 11_434, "owned Ollama must not use the shared listener");
    context.registerPort("ollama-private-loopback", port);
    const baseUrl = "http://127.0.0.1:" + port;
    const profile = "ollama_ctx002_local";
    let profileEndpoint = baseUrl + "/v1";
    if (probeMode === "kcoder") {
      const fixedBinaryPath = process.env.KCODER_E2E_KCODER_BIN;
      const suppliedBinaryHash = process.env.KCODER_E2E_KCODER_BIN_SHA256;
      assert.ok(fixedBinaryPath, "UNMET_PREREQUISITE: fixed KCoder CLI path is required");
      assert.match(suppliedBinaryHash || "", /^[0-9a-f]{64}$/,
        "UNMET_PREREQUISITE: a pinned KCoder CLI SHA256 is required");
      const resolvedBinary = await realpath(resolve(fixedBinaryPath));
      const binaryStat = await requireRegularFile(resolvedBinary, "fixed KCoder CLI");
      assert.equal(binaryStat.nlink, 1n, "fixed KCoder CLI must be an independent copy");
      await access(resolvedBinary, fsConstants.X_OK);
      const binaryHashStarted = process.hrtime.bigint();
      const actualBinaryHash = await sha256File(resolvedBinary, { signal: context.abortSignal });
      assert.equal(actualBinaryHash, suppliedBinaryHash, "selected KCoder CLI bytes do not match the supplied SHA256");
      summary.kcoder = {
        binaryPath: resolvedBinary,
        binarySha256: actualBinaryHash,
        binarySizeBytes: binaryStat.size.toString(),
        binaryLinkCount: binaryStat.nlink.toString(),
        binaryHashDurationMs: Number(process.hrtime.bigint() - binaryHashStarted) / 1e6,
        sourceBoundary: "fixed KCoder CLI path and SHA supplied for this run; not rebuilt from this checkout",
      };
      proxy = await startOwnedOllamaOpenAiProxy(context, {
        upstreamBaseUrl: baseUrl,
        stamp: () => stamp(),
        startSentinel: "BEGIN_CTX002_",
        endSentinel: "END_CTX002_",
      });
      profileEndpoint = proxy.baseUrl + "/v1";
      summary.proxy = {
        loopback: proxy.baseUrl,
        upstreamLoopback: baseUrl,
        acceptedPath: "/v1/chat/completions",
        maxForwardedGenerations: 1,
        rawRequestBodyRetained: false,
      };
    }
    const configDir = context.pathInState("ollama-preflight-config");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, ".env"), "# owned no-auth Ollama profile\n", {
      flag: "wx",
    });
    await context.writeStateJson(
      "ollama-preflight-config/settings.json",
      {
        active_provider: profile,
        providers: {
          [profile]: {
            api_format: "openai_chat_completions",
            endpoint: profileEndpoint,
            default_model: MODEL,
            authentication: { mode: "none" },
            context_window_tokens: 32_768,
            output_headroom_tokens: 4_096,
            max_output_tokens: OUTPUT_TOKEN_LIMIT,
            max_retries: 0,
            discover_models: false,
            no_proxy: true,
          },
        },
        tools: { disabled: ["*"] },
        memory: { observer_mode: "disabled", structured_enabled: false, legacy_prompt_enabled: false },
        session_memory: { enabled: false },
        summary_provider: null,
        summary_profile: null,
        summary_model: null,
      },
      0o400,
    );
    const preflightEnv = context.isolatedEnvironment({
      KCODER_CONFIG_DIR: configDir,
      KCODER_E2E_KCODER_BIN: process.env.KCODER_E2E_KCODER_BIN,
      KCODER_E2E_REAL_MODEL: "1",
      KCODER_E2E_MODEL_PROFILE: profile,
      KCODER_E2E_MODEL_ENDPOINT: profileEndpoint,
      KCODER_E2E_MODEL_NAME: MODEL,
      KCODER_E2E_MODEL_API_FORMAT: "openai_chat_completions",
    });
    delete preflightEnv.XDG_RUNTIME_DIR;
    delete preflightEnv.DBUS_SESSION_BUS_ADDRESS;
    const model = await realModelPreflight(profile, {
      env: preflightEnv,
      cwd: repoRoot,
    });
    if (probeMode === "kcoder") {
      assert.equal(await realpath(model.kcoderBin), summary.kcoder.binaryPath,
        "preflight and the real generation must use the same hashed KCoder CLI");
    }
    summary.preflight = {
      consent: "KCODER_E2E_REAL_MODEL=1",
      profile: model.profile,
      provider: model.provider,
      model: model.model,
      apiFormat: model.providerConfig.api_format,
      authenticationMode: model.providerConfig.authentication?.mode || "api_key",
      endpointOrigin: new URL(model.providerConfig.endpoint).origin,
      referenceClientHardInputLimit: 28_672,
      noExternalInput: true,
      configDirOwnedByRun: true,
    };
    summary.preflight.settingsFile = "state/ollama-preflight-config/settings.json";

    const home = context.pathInState("ollama-home");
    const temp = context.pathInState("ollama-tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temp, { recursive: true, mode: 0o700 });
    const snapRoot = resolve(dirname(ollamaBin), "..");
    const serverEnv = context.isolatedEnvironment({
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      LD_LIBRARY_PATH: join(snapRoot, "lib/ollama") + ":/var/lib/snapd/lib/gl",
      OLLAMA_HOST: "127.0.0.1:" + port,
      OLLAMA_MODELS: modelRoot,
      OLLAMA_NO_CLOUD: "1",
      OLLAMA_NOPRUNE: "1",
    });
    delete serverEnv.XDG_RUNTIME_DIR;
    delete serverEnv.DBUS_SESSION_BUS_ADDRESS;

    serverLogPath = join(context.logsDir, "ollama-server.log");
    context.spawnOwned("ollama-server", ollamaBin, ["serve"], {
      cwd: scratch.path,
      env: serverEnv,
    });
    serverStarted = true;
    const readyStarted = process.hrtime.bigint();
    const startupBudgetMs = Math.min(240_000, remainingMs() - CLEANUP_RESERVE_MS);
    assert.ok(startupBudgetMs > 0, "no time remains for bounded Ollama startup");
    const tags = await waitForModelTags(baseUrl, MODEL, startupBudgetMs, context.abortSignal);
    summary.server = {
      binary: ollamaBin,
      modelStore: modelRoot,
      loopback: baseUrl,
      model: MODEL,
      cloudDisabled: true,
      sharedListenerTouched: false,
      startupMs: Number(process.hrtime.bigint() - readyStarted) / 1e6,
      tagsModelCount: tags.models.length,
      tagsBytes: tags.responseBytes,
      contextEnvironmentOverridePresent: false,
    };

    const show = await fetchJson(baseUrl + "/api/show", {
      method: "POST",
      body: { model: MODEL },
      timeoutMs: Math.min(10_000, remainingMs() - CLEANUP_RESERVE_MS),
      abortSignal: context.abortSignal,
    });
    assert.equal(show.status, 200, "owned Ollama /api/show must succeed before generation");
    const thinkingValues = show.body?.thinking?.values;
    const thinkFalseSupported = Array.isArray(thinkingValues) && thinkingValues.includes(false);
    summary.modelMetadata = {
      endpoint: "/api/show",
      httpStatus: show.status,
      thinkingValues: Array.isArray(thinkingValues) ? thinkingValues : null,
      thinkDefault: show.body?.thinking?.default ?? null,
      thinkFalseSupported,
      trainingContextLength: findContextLength(show.body?.model_info),
    };
    const beforePs = await fetchJson(baseUrl + "/api/ps", {
      timeoutMs: Math.min(5_000, remainingMs() - CLEANUP_RESERVE_MS),
      abortSignal: context.abortSignal,
    });
    summary.apiPsBefore = summarizeApiPs(beforePs);

    if (probeMode === "kcoder") {
      const workspace = context.pathInState("kcoder-workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      summary.requests.push(await runKcoderProviderRequest({
        context,
        model,
        profile,
        workspace,
        configDir,
        proxy,
        abortSignal: context.abortSignal,
        runStartedMono,
        elapsedMs,
        remainingMs,
      }));
      await stopKcoder();
    } else {
      for (const repeatCount of MODEL_RUNS) {
        if (summary.requests.some(request => request.requestSent && request.serverPromptBeforeTruncation > 4_096)) {
          break;
        }
        if (remainingMs() <= CLEANUP_RESERVE_MS + 30_000) {
          summary.unrunRepeatCounts = MODEL_RUNS.slice(summary.requests.length);
          break;
        }
        const request = buildChatRequest(repeatCount, randomBytes(6).toString("hex"), thinkFalseSupported);
        assert.ok(request.promptEstimateBytesDiv4 > 4_096,
          "synthetic prompt estimate should exceed 4096 bytes/4 before the real tokenizer check");
        assert.ok(request.promptEstimateBytesDiv4 < 28_672,
          "synthetic prompt estimate should remain below the isolated profile's 28672 hard input limit");
        const requestRecord = await streamChatRequest({
          context,
          baseUrl,
          request,
          repeatCount,
          thinkFalseSupported,
          runStartedMono,
          elapsedMs,
          remainingMs,
          requestIndex: summary.requests.length + 1,
          abortSignal: context.abortSignal,
        });
        summary.requests.push(requestRecord);
        assertRunActive(context.abortSignal);
        await delay(250, undefined, { signal: context.abortSignal });
        const serverEvidence = await readServerEvidence(serverLogPath);
        requestRecord.serverPromptEvidence = serverEvidence;
        const lastTruncation = serverEvidence.truncations.at(-1) || null;
        requestRecord.serverPromptBeforeTruncation = lastTruncation?.prompt
          ?? requestRecord.promptEvalCount;
        requestRecord.serverPromptTruncation = lastTruncation;
        if (requestRecord.serverPromptBeforeTruncation > 4_096) break;
        if (!requestRecord.complete
            || requestRecord.serverPromptBeforeTruncation === null
            || repeatCount !== MODEL_RUNS[0]
            || remainingMs() <= CLEANUP_RESERVE_MS + 120_000) {
          break;
        }
      }
    }

    await stopKcoder();
    await stopProxy();
    const psAfter = await fetchJson(baseUrl + "/api/ps", {
      timeoutMs: Math.min(5_000, Math.max(1_000, remainingMs() - CLEANUP_RESERVE_MS)),
      abortSignal: context.abortSignal,
    }).catch(error => ({ status: null, error: safeErrorCode(error), body: null }));
    summary.apiPsAfter = summarizeApiPs(psAfter);
    const finalServerEvidence = await readServerEvidence(serverLogPath);
    summary.serverPromptEvidence = finalServerEvidence;
    if (probeMode === "kcoder") {
      const requestRecord = summary.requests[0];
      const truncations = finalServerEvidence.truncations;
      const relatedTruncation = truncations.at(-1) || null;
      if (requestRecord) {
        requestRecord.serverPromptBeforeTruncation = relatedTruncation?.prompt ?? null;
        requestRecord.serverPromptTruncation = relatedTruncation;
        requestRecord.serverPromptEvidence = finalServerEvidence;
      }
    }
    await stopServer();
    await copyServerLog();
    summary.processes = summarizeOwnedProcesses(context);
    captureProviderRequests(summary, proxy);
    assembleProbeAssessment(summary);

    assert.ok(summary.requests.length >= 1, "at least one bounded generation request must be attempted");
    assert.ok(summary.assessment.actualPromptOver4096, "the Ollama tokenizer must observe a prompt above 4096 tokens");
    assert.ok(summary.assessment.serverPromptTruncationObserved,
      "the owned Ollama server must expose before/after truncation in its log");
    assert.ok(summary.requests.some(request => request.complete),
      "one bounded Ollama generation must complete to retain caller-visible response evidence");
    if (probeMode === "kcoder") {
      const providerRequests = summary.providerRequestEvidence;
      const forwarded = providerRequests.filter(request => !request.requestRejected && request.upstreamRequestStartedAt);
      const rejected = providerRequests.filter(request => request.requestRejected);
      assert.equal(forwarded.length, 1, "KCoder mode forwards one actual model generation");
      assert.ok(rejected.every(request => request.rejectionReason === "generation_cap"
        && request.upstreamRequestStartedAt === undefined),
      "any later empty-response continuation must remain blocked before Ollama");
      const providerRequest = forwarded[0];
      assert.equal(providerRequest.requestParameters?.model, MODEL);
      assert.equal(providerRequest.requestParameters?.stream, true);
      assert.equal(providerRequest.requestParameters?.maxOutput, OUTPUT_TOKEN_LIMIT);
      assert.equal(providerRequest.requestParameters?.outputLimitsValid, true);
      assert.equal(providerRequest.requestParameters?.choiceCountValid, true);
      assert.equal(providerRequest.requestParameters?.thinkFieldSent, false);
      const userMessages = providerRequest.requestParameters?.userMessages || [];
      const lastUserMessage = userMessages.at(-1);
      assert.equal(lastUserMessage?.startSentinelPresent, true,
        "the last user message sent through KCoder must contain the starting sentinel");
      assert.equal(lastUserMessage?.endSentinelPresent, true,
        "the last user message sent through KCoder must contain the ending sentinel");
      assert.equal(providerRequest.responseStatus, 200);
      assert.ok(providerRequest.terminalSseDoneAt, "Ollama OpenAI-compatible stream must send [DONE]");
      if (providerRequest.usageCompletionCount !== null) {
        assert.ok(providerRequest.usageCompletionCount <= OUTPUT_TOKEN_LIMIT,
          "Ollama OpenAI-compatible usage must remain within the eight-token response cap");
      }
      assert.ok(summary.assessment.kcoderTurnCompleted,
        "the real KCoder headless task must end with a successful terminal result");
    }
    summary.status = "passed";
    return summary;
  } catch (error) {
    summary.status = "failed-or-incomplete";
    summary.error = safeErrorCode(error);
    throw error;
  } finally {
    await stopKcoder().catch(() => undefined);
    await stopProxy().catch(() => undefined);
    if (serverStarted && !serverStopped) {
      await stopServer().catch(() => undefined);
    }
    await copyServerLog().catch(() => undefined);
    captureProviderRequests(summary, proxy);
    summary.processes = summarizeOwnedProcesses(context);
    if (serverLogPath) {
      summary.serverPromptEvidence = await readServerEvidence(serverLogPath).catch(() => summary.serverPromptEvidence);
    }
    if (summary.requests[0] && summary.serverPromptEvidence) {
      const truncation = summary.serverPromptEvidence.truncations.at(-1) || null;
      summary.requests[0].serverPromptBeforeTruncation = truncation?.prompt ?? summary.requests[0].serverPromptBeforeTruncation;
      summary.requests[0].serverPromptTruncation = truncation;
      summary.requests[0].serverPromptEvidence = summary.serverPromptEvidence;
    }
    assembleProbeAssessment(summary);
    if (!context.abortSignal?.aborted) await persistSummary();
  }
});

async function runKcoderProviderRequest({
  context,
  model,
  profile,
  workspace,
  configDir,
  proxy,
  abortSignal,
  runStartedMono,
  elapsedMs,
  remainingMs,
}) {
  assertRunActive(abortSignal);
  const repeatCount = 1_100;
  const request = buildSyntheticPrompt(repeatCount, randomBytes(6).toString("hex"));
  assert.ok(request.promptEstimateBytesDiv4 > 4_096,
    "synthetic prompt estimate should exceed 4096 bytes/4 before the real tokenizer check");
  assert.ok(request.promptEstimateBytesDiv4 < 28_672,
    "synthetic prompt estimate should remain below the isolated profile's 28672 hard input limit");

  const requestMono = process.hrtime.bigint();
  const record = {
    requestIndex: 1,
    requestSent: false,
    complete: false,
    timedOut: false,
    requestParameters: {
      endpoint: "/v1/chat/completions",
      protocol: "openai_chat_completions",
      model: MODEL,
      stream: true,
      outputTokenLimit: OUTPUT_TOKEN_LIMIT,
      retryLimit: 0,
      cliTurnLimitMs: KCODER_TURN_LIMIT_MS,
      repeatCount,
      promptUtf8Bytes: request.promptUtf8Bytes,
      promptEstimateBytesDiv4: request.promptEstimateBytesDiv4,
      promptSha256: request.promptSha256,
      referenceClientHardInputLimit: request.referenceClientHardInputLimit,
      startSentinelOffset: request.startOffset,
      endSentinelOffset: request.endOffset,
      providerRequestBodyRetained: false,
    },
    startedAt: stampFor(requestMono, runStartedMono, elapsedMs),
    cliEvents: {
      firstJsonEventAt: null,
      firstThinkingAt: null,
      firstAssistantContentAt: null,
      assistantThinkingBytes: 0,
      assistantContentBytes: 0,
      assistantMessageDoneAt: null,
      terminalResultAt: null,
      terminalResult: null,
      eventTypeCounts: {},
      malformedJsonLineCount: 0,
      stdoutBytes: 0,
    },
    process: {
      label: "kcoder-ctx002",
      pid: null,
      pgid: null,
      spawnError: null,
      exitCode: null,
      signal: null,
      exitAt: null,
      naturalExitWithinGrace: null,
      stoppedByHarnessAfterBoundedWait: false,
    },
  };

  const home = context.pathInState("kcoder-home");
  const temporary = context.pathInState("kcoder-tmp");
  const xdgConfig = context.pathInState("kcoder-xdg-config");
  await Promise.all([home, temporary, xdgConfig].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const cliEnv = context.isolatedEnvironment({
    HOME: home,
    USERPROFILE: home,
    KCODER_HOME: home,
    KCODER_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: xdgConfig,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });
  delete cliEnv.XDG_RUNTIME_DIR;
  delete cliEnv.DBUS_SESSION_BUS_ADDRESS;
  const args = [
    "--cwd", workspace,
    "--provider", profile,
    "--model", MODEL,
    "--max-tokens", String(OUTPUT_TOKEN_LIMIT),
    "--max-retries", "0",
    "--max-duration-secs", String(KCODER_TURN_LIMIT_MS / 1_000),
    "--tool-profile", "none",
    "--permission-mode", "ask",
    "--training-mode",
    "--json",
    request.content,
  ];
  let child;
  try {
    child = context.spawnOwned("kcoder-ctx002", model.kcoderBin, args, {
      cwd: workspace,
      env: cliEnv,
    });
  } catch (error) {
    record.process.spawnError = safeErrorCode(error);
    record.finishedAt = stampFor(requestMono, runStartedMono, elapsedMs);
    return record;
  }
  record.process.pid = child.pid ?? null;
  const processRecord = context.processes.get(record.process.label);
  record.process.pgid = processRecord?.pgid ?? null;
  record.cliStartedAt = stampFor(requestMono, runStartedMono, elapsedMs);

  const stdoutDecoder = new TextDecoder();
  let pending = "";
  const parseLine = line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      record.cliEvents.malformedJsonLineCount += 1;
      return;
    }
    if (!event || typeof event.type !== "string") return;
    const now = stampFor(requestMono, runStartedMono, elapsedMs);
    const type = event.type;
    record.cliEvents.eventTypeCounts[type] = (record.cliEvents.eventTypeCounts[type] || 0) + 1;
    if (record.cliEvents.firstJsonEventAt === null) record.cliEvents.firstJsonEventAt = now;
    if (type === "assistant_thinking_delta" && typeof event.text === "string" && event.text.length > 0) {
      if (record.cliEvents.firstThinkingAt === null) record.cliEvents.firstThinkingAt = now;
      record.cliEvents.assistantThinkingBytes += Buffer.byteLength(event.text, "utf8");
    }
    if (type === "assistant_text_delta" && typeof event.text === "string" && event.text.length > 0) {
      if (record.cliEvents.firstAssistantContentAt === null) record.cliEvents.firstAssistantContentAt = now;
      record.cliEvents.assistantContentBytes += Buffer.byteLength(event.text, "utf8");
    }
    if (type === "assistant_message_done" && record.cliEvents.assistantMessageDoneAt === null) {
      record.cliEvents.assistantMessageDoneAt = now;
    }
    if (type === "result") {
      record.cliEvents.terminalResultAt = now;
      record.cliEvents.terminalResult = {
        subtype: typeof event.subtype === "string" ? event.subtype : null,
        runStatus: typeof event.run_status === "string" ? event.run_status : null,
        taskStatus: typeof event.task_status === "string" ? event.task_status : null,
        terminationReason: typeof event.termination_reason === "string" ? event.termination_reason : null,
        timedOut: event.timed_out === true,
        providerRetryCount: Number.isSafeInteger(event.provider_retry_count) ? event.provider_retry_count : null,
        errorPresent: typeof event.error === "string" && event.error.length > 0,
      };
    }
  };
  child.stdout.on("data", chunk => {
    record.cliEvents.stdoutBytes += chunk.length;
    pending += stdoutDecoder.decode(chunk, { stream: true });
    if (pending.length > 1024 * 1024) {
      record.cliEvents.malformedJsonLineCount += 1;
      pending = pending.slice(-1024 * 1024);
    }
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      parseLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  child.once("exit", (code, signal) => {
    record.process.exitCode = code;
    record.process.signal = signal;
    record.process.exitAt = stampFor(requestMono, runStartedMono, elapsedMs);
  });
  child.once("error", error => {
    record.process.spawnError = safeErrorCode(error);
  });

  const turnWaitMs = Math.max(0, Math.min(
    KCODER_TURN_LIMIT_MS,
    remainingMs() - KCODER_EXIT_GRACE_MS - CLEANUP_RESERVE_MS,
  ));
  record.requestParameters.availableTurnWaitMs = turnWaitMs;
  const turnDeadline = Date.now() + turnWaitMs;
  while (record.cliEvents.assistantMessageDoneAt === null
      && record.cliEvents.terminalResultAt === null
      && child.exitCode === null
      && child.signalCode === null
      && record.process.spawnError === null
      && !abortSignal?.aborted
      && Date.now() < turnDeadline) {
    await delay(50, undefined, { signal: abortSignal });
  }
  assertRunActive(abortSignal);
  if (record.cliEvents.assistantMessageDoneAt === null && child.exitCode === null
      && record.process.spawnError === null) {
    record.timedOut = true;
    record.process.stoppedByHarnessAfterBoundedWait = true;
  } else if (record.cliEvents.assistantMessageDoneAt !== null && child.exitCode === null) {
    const exitGraceMs = Math.max(0, Math.min(KCODER_EXIT_GRACE_MS, remainingMs() - CLEANUP_RESERVE_MS));
    const exitDeadline = Date.now() + exitGraceMs;
    while (record.cliEvents.terminalResultAt === null && child.exitCode === null
        && child.signalCode === null && !abortSignal?.aborted && Date.now() < exitDeadline) {
      await delay(50, undefined, { signal: abortSignal });
    }
    if (record.cliEvents.terminalResultAt !== null && child.exitCode === null) {
      const naturalExitDeadline = Math.min(exitDeadline, Date.now() + 5_000);
      while (child.exitCode === null && child.signalCode === null && !abortSignal?.aborted
          && Date.now() < naturalExitDeadline) {
        await delay(50, undefined, { signal: abortSignal });
      }
    }
    record.process.naturalExitWithinGrace = child.exitCode !== null;
    record.process.stoppedByHarnessAfterBoundedWait = child.exitCode === null;
  }
  if (record.process.stoppedByHarnessAfterBoundedWait) {
    await context.stopOwned(record.process.label).catch(error => {
      record.process.cleanupError = safeErrorCode(error);
    });
  }
  if (proxy.requests[0] && !proxy.requests[0].responseEndedAt) {
    const streamDeadline = Date.now() + Math.max(0, Math.min(10_000, remainingMs() - CLEANUP_RESERVE_MS));
    while (!proxy.requests[0].responseEndedAt
        && !proxy.requests[0].clientDisconnectedAt
        && !abortSignal?.aborted
        && Date.now() < streamDeadline) {
      await delay(25, undefined, { signal: abortSignal });
    }
  }
  await delay(25, undefined, { signal: abortSignal });
  assertRunActive(abortSignal);
  pending += stdoutDecoder.decode();
  if (pending.trim()) parseLine(pending);
  if (child.exitCode !== null && record.process.exitCode === null) {
    record.process.exitCode = child.exitCode;
  }
  if (child.signalCode !== null && child.signalCode !== undefined) record.process.signal = child.signalCode;

  const providerRequest = proxy.requests[0] || null;
  record.requestSent = Boolean(providerRequest && providerRequest.upstreamRequestStartedAt);
  record.providerRequestReceivedAt = providerRequest?.providerRequestReceivedAt ?? null;
  record.providerResponseHeadersAt = providerRequest?.responseHeadersAt ?? null;
  record.providerFirstSseFrameAt = providerRequest?.firstSseFrameAt ?? null;
  record.providerFirstSseReasoningAt = providerRequest?.firstSseReasoningAt ?? null;
  record.providerFirstSseContentAt = providerRequest?.firstSseContentAt ?? null;
  record.providerTerminalSseDoneAt = providerRequest?.terminalSseDoneAt ?? null;
  record.providerResponseEndedAt = providerRequest?.responseEndedAt ?? null;
  record.complete = Boolean(record.providerTerminalSseDoneAt && record.providerResponseEndedAt);
  record.finishedAt = stampFor(requestMono, runStartedMono, elapsedMs);
  record.responseComplete = record.complete;
  record.reasoningObserved = record.cliEvents.assistantThinkingBytes > 0;
  record.visibleAssistantContentObserved = record.cliEvents.assistantContentBytes > 0;
  record.contentObservationBoundary = "reasoning bytes and assistant_text_delta bytes are recorded separately; neither is retained verbatim";
  return record;
}

async function requireRegularFile(path, label) {
  const stat = await lstat(path, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), label + " must be a regular non-symlink file");
  return stat;
}

async function requireReadOnly(path, label) {
  try {
    await access(path, fsConstants.W_OK);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return;
    throw error;
  }
  throw new Error("UNMET_PREREQUISITE: " + label + " is writable by the test process");
}

async function readMemAvailable() {
  const contents = await readFile("/proc/meminfo", "utf8");
  const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  assert.ok(match, "Linux MemAvailable must be available for RAM-copy preflight");
  return BigInt(match[1]) * 1024n;
}

async function sha256File(path, { signal } = {}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, signal ? { signal } : undefined)) hash.update(chunk);
  return hash.digest("hex");
}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function waitForModelTags(baseUrl, model, timeoutMs, abortSignal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    assertRunActive(abortSignal);
    try {
      const response = await fetchJson(baseUrl + "/api/tags", {
        timeoutMs: Math.min(2_000, Math.max(1_000, deadline - Date.now())),
        abortSignal,
      });
      if (response.status === 200) {
        const models = Array.isArray(response.body?.models) ? response.body.models : [];
        if (models.some(entry => entry.name === model || entry.model === model)) {
          return { models, responseBytes: response.bytes };
        }
        lastError = new Error("expected model is absent from the private Ollama tags");
      } else {
        lastError = new Error("private Ollama /api/tags returned HTTP " + response.status);
      }
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason || error;
      lastError = error;
    }
    await delay(Math.min(1_000, Math.max(0, deadline - Date.now())), undefined, { signal: abortSignal });
  }
  throw new Error(
    "UNMET_PREREQUISITE: private Ollama startup/model listing exceeded its bounded startup window"
      + (lastError ? " (" + safeErrorCode(lastError) + ")" : ""),
  );
}

async function fetchJson(url, { method = "GET", body, timeoutMs, abortSignal }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "request needs remaining wall-clock budget");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("bounded request timeout")), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let parsed = null;
    try {
      parsed = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
    } catch {
      throw new Error("private Ollama returned a non-JSON metadata response");
    }
    return { status: response.status, contentType: response.headers.get("content-type"), bytes: bytes.length, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function buildSyntheticPrompt(repeatCount, nonce) {
  const start = "BEGIN_CTX002_" + nonce.toUpperCase();
  const end = "END_CTX002_" + nonce.toUpperCase();
  const filler = "alpha beta gamma delta ".repeat(repeatCount);
  const content = [
    "Read both exact sentinels below. Reply with exactly BOTH if both are present, otherwise reply MISSING. Do not use tools.",
    start,
    filler,
    end,
  ].join("\n");
  return {
    content,
    startSentinel: start,
    endSentinel: end,
    repeatCount,
    promptUtf8Bytes: Buffer.byteLength(content, "utf8"),
    promptEstimateBytesDiv4: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
    referenceClientHardInputLimit: 28_672,
    startOffset: Buffer.byteLength(content.slice(0, content.indexOf(start)), "utf8"),
    endOffset: Buffer.byteLength(content.slice(0, content.indexOf(end)), "utf8"),
    promptSha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function buildChatRequest(repeatCount, nonce, thinkFalseSupported) {
  const prompt = buildSyntheticPrompt(repeatCount, nonce);
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt.content }],
    stream: true,
    keep_alive: "10m",
    options: { num_predict: OUTPUT_TOKEN_LIMIT },
  };
  if (thinkFalseSupported) body.think = false;
  return {
    body,
    ...prompt,
  };
}

async function streamChatRequest({
  context,
  baseUrl,
  request,
  repeatCount,
  thinkFalseSupported,
  runStartedMono,
  elapsedMs,
  remainingMs,
  requestIndex,
  abortSignal,
}) {
  assertRunActive(abortSignal);
  const requestMono = process.hrtime.bigint();
  const requestPath = context.pathInArtifacts("generation-" + requestIndex + "-request.json");
  const responsePath = context.pathInArtifacts("generation-" + requestIndex + "-response.jsonl");
  const requestFile = await open(requestPath, "wx", 0o600);
  try {
    await requestFile.writeFile(JSON.stringify(request.body, null, 2) + "\n");
    await requestFile.sync();
  } finally {
    await requestFile.close();
  }
  const responseFile = await open(responsePath, "wx", 0o600);
  const record = {
    requestIndex,
    requestSent: false,
    requestParameters: {
      endpoint: "/api/chat",
      model: MODEL,
      stream: true,
      wireFormat: "newline-delimited JSON (JSONL), not SSE",
      think: thinkFalseSupported ? false : "omitted; /api/show did not advertise false",
      options: { num_predict: OUTPUT_TOKEN_LIMIT },
      numCtxSent: false,
      contextLengthSent: false,
      contextWindowFieldSent: false,
      repeatCount,
      promptUtf8Bytes: request.promptUtf8Bytes,
      promptEstimateBytesDiv4: request.promptEstimateBytesDiv4,
      promptSha256: request.promptSha256,
      startSentinelOffset: request.startOffset,
      endSentinelOffset: request.endOffset,
    },
    startedAt: stampFor(requestMono, runStartedMono, elapsedMs),
    headersReceivedAt: null,
    responseHttpStatus: null,
    responseContentType: null,
    responseBytes: 0,
    frameCount: 0,
    firstBodyByteAt: null,
    firstFrameAt: null,
    firstThinkingAt: null,
    firstContentAt: null,
    terminalDoneAt: null,
    finishedAt: null,
    complete: false,
    timedOut: false,
    promptEvalCount: null,
    evalCount: null,
    doneReason: null,
    startSentinelReturned: null,
    endSentinelReturned: null,
    responseTextBytes: 0,
  };
  const budgetForRequest = Math.max(1_000, remainingMs() - CLEANUP_RESERVE_MS);
  const controller = new AbortController();
  const abortRequest = () => controller.abort(abortSignal?.reason || new Error("RunContext abort"));
  abortSignal?.addEventListener("abort", abortRequest, { once: true });
  if (abortSignal?.aborted) abortRequest();
  const timer = setTimeout(() => controller.abort(new Error("600-second run budget reserved for cleanup")), budgetForRequest);
  const decoder = new TextDecoder();
  let pending = "";
  let combinedText = "";
  let responseTextBytes = 0;
  const parseFrame = line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    assert.ok(trimmed.length <= 1024 * 1024, "Ollama JSONL frame exceeded the bounded parser limit");
    const frame = JSON.parse(trimmed);
    record.frameCount += 1;
    if (record.firstFrameAt === null) record.firstFrameAt = stampFor(requestMono, runStartedMono, elapsedMs);
    const thinking = frame.message?.thinking;
    const content = frame.message?.content;
    if (typeof thinking === "string" && thinking.length > 0) {
      if (record.firstThinkingAt === null) record.firstThinkingAt = stampFor(requestMono, runStartedMono, elapsedMs);
      combinedText += thinking;
      responseTextBytes += Buffer.byteLength(thinking, "utf8");
    }
    if (typeof content === "string" && content.length > 0) {
      if (record.firstContentAt === null) record.firstContentAt = stampFor(requestMono, runStartedMono, elapsedMs);
      combinedText += content;
      responseTextBytes += Buffer.byteLength(content, "utf8");
    }
    if (Number.isSafeInteger(frame.prompt_eval_count)) record.promptEvalCount = frame.prompt_eval_count;
    if (Number.isSafeInteger(frame.eval_count)) record.evalCount = frame.eval_count;
    if (typeof frame.done_reason === "string") record.doneReason = frame.done_reason;
    if (frame.done === true && record.terminalDoneAt === null) {
      record.terminalDoneAt = stampFor(requestMono, runStartedMono, elapsedMs);
    }
  };

  try {
    record.requestSent = true;
    const response = await fetch(baseUrl + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    record.headersReceivedAt = stampFor(requestMono, runStartedMono, elapsedMs);
    record.responseHttpStatus = response.status;
    record.responseContentType = response.headers.get("content-type");
    if (!response.body) throw new Error("private Ollama streaming response has no body");
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      record.responseBytes += bytes.length;
      if (record.firstBodyByteAt === null && bytes.length > 0) {
        record.firstBodyByteAt = stampFor(requestMono, runStartedMono, elapsedMs);
      }
      await responseFile.writeFile(bytes);
      pending += decoder.decode(bytes, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        parseFrame(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      assert.ok(pending.length <= 1024 * 1024, "partial Ollama JSONL frame exceeded the bounded parser limit");
    }
    pending += decoder.decode();
    if (pending.trim()) parseFrame(pending);
    record.complete = record.terminalDoneAt !== null;
    record.startSentinelReturned = combinedText.includes(request.startSentinel);
    record.endSentinelReturned = combinedText.includes(request.endSentinel);
    record.responseTextBytes = responseTextBytes;
    record.finishedAt = stampFor(requestMono, runStartedMono, elapsedMs);
    if (record.responseHttpStatus !== 200) {
      throw new Error("private Ollama /api/chat returned HTTP " + record.responseHttpStatus);
    }
    if (!record.complete) throw new Error("Ollama stream ended without a terminal done frame");
    if (record.evalCount !== null) {
      assert.ok(record.evalCount <= OUTPUT_TOKEN_LIMIT, "Ollama generated more than the 8-token output cap");
    }
  } catch (error) {
    record.timedOut = controller.signal.aborted;
    record.error = safeErrorCode(error);
    record.finishedAt = stampFor(requestMono, runStartedMono, elapsedMs);
    record.startSentinelReturned = combinedText.includes(request.startSentinel);
    record.endSentinelReturned = combinedText.includes(request.endSentinel);
    record.responseTextBytes = responseTextBytes;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abortRequest);
    await responseFile.sync().catch(() => undefined);
    await responseFile.close().catch(() => undefined);
  }
  record.responseArtifacts = {
    request: "generation-" + requestIndex + "-request.json",
    stream: "generation-" + requestIndex + "-response.jsonl",
  };
  return record;
}

function stampFor(origin, runOrigin, elapsedFromRun) {
  const now = process.hrtime.bigint();
  return {
    utc: new Date().toISOString(),
    elapsedFromRequestMs: Number(now - origin) / 1e6,
    elapsedFromRunMs: elapsedFromRun(),
    monotonicNs: now.toString(),
    runOriginNs: runOrigin.toString(),
  };
}

async function readServerEvidence(serverLogPath) {
  let text = "";
  try {
    text = await readFile(serverLogPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return parseOllamaServerLogEvidence(text);
}

function summarizeApiPs(response) {
  if (response.status !== 200 || !response.body) {
    return { httpStatus: response.status ?? null, error: response.error ?? null, runningModelCount: null };
  }
  const models = Array.isArray(response.body.models) ? response.body.models : [];
  return {
    httpStatus: response.status,
    responseBytes: response.bytes,
    runningModelCount: models.length,
    models: models.map(model => ({
      name: model.name || model.model || null,
      contextLength: Number.isSafeInteger(model.context_length) ? model.context_length : null,
      sizeBytes: Number.isSafeInteger(model.size) ? model.size : null,
      sizeVramBytes: Number.isSafeInteger(model.size_vram) ? model.size_vram : null,
    })),
    contextLengths: models.map(model => model.context_length).filter(Number.isSafeInteger),
  };
}

function findContextLength(modelInfo) {
  if (!modelInfo || typeof modelInfo !== "object") return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/context_length$/i.test(key) && Number.isSafeInteger(value)) return value;
  }
  return null;
}

function safeErrorCode(error) {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
    ? error.name
    : "Error";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : null;
  return code ? name + ":" + code : name;
}

function assertRunActive(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("RunContext is aborting");
  error.code = "ABORT_ERR";
  throw error;
}

function captureProviderRequests(summary, proxy) {
  const records = proxy?.requests || [];
  summary.providerRequestEvidence = records.map(record => ({
    method: record.method,
    path: record.path,
    providerRequestReceivedAt: record.providerRequestReceivedAt ?? null,
    requestBodyCompleteAt: record.requestBodyCompleteAt ?? null,
    requestBodyBytes: record.requestBodyBytes ?? null,
    requestBodySha256: record.requestBodySha256 ?? null,
    requestParameters: record.requestParameters ?? null,
    admissionArtifactRecorded: record.admissionArtifactRecorded === true,
    admissionArtifact: record.admissionArtifact ?? null,
    admissionRecordedAt: record.admissionRecordedAt ?? null,
    upstreamRequestStartedAt: record.upstreamRequestStartedAt ?? null,
    responseStatus: record.responseStatus ?? null,
    responseHeadersAt: record.responseHeadersAt ?? null,
    responseFirstByteAt: record.responseFirstByteAt ?? null,
    firstSseFrameAt: record.firstSseFrameAt ?? null,
    firstSseReasoningAt: record.firstSseReasoningAt ?? null,
    firstSseContentAt: record.firstSseContentAt ?? null,
    terminalSseDoneAt: record.terminalSseDoneAt ?? null,
    responseEndedAt: record.responseEndedAt ?? null,
    sseFrameCount: record.sseFrameCount ?? 0,
    reasoningBytes: record.reasoningBytes ?? 0,
    contentBytes: record.contentBytes ?? 0,
    finishReason: record.finishReason ?? null,
    usagePromptCount: record.usagePromptCount ?? null,
    usageCompletionCount: record.usageCompletionCount ?? null,
    requestRejected: record.requestRejected === true,
    rejectionReason: record.rejectionReason ?? null,
    clientDisconnectedAt: record.clientDisconnectedAt ?? null,
    upstreamRequestError: record.upstreamRequestError ?? null,
    upstreamResponseError: record.upstreamResponseError ?? null,
  }));
  const forwarded = summary.providerRequestEvidence.filter(request => request.upstreamRequestStartedAt !== null);
  const rejected = summary.providerRequestEvidence.filter(request => request.requestRejected);
  summary.providerRequestCounts = {
    received: summary.providerRequestEvidence.length,
    forwardedToOllama: forwarded.length,
    rejectedBeforeOllama: rejected.length,
    rejectedReasons: rejected.reduce((counts, request) => {
      const reason = request.rejectionReason || "unspecified";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {}),
    rawRequestBodyRetained: false,
    rawHeadersRetained: false,
  };
}

function summarizeOwnedProcesses(context) {
  return [...context.processes.values()].map(record => ({
    label: record.label,
    pid: record.pid ?? null,
    pgid: record.pgid ?? null,
    command: record.command ?? null,
    stopped: record.stopped === true,
    exitCode: record.child?.exitCode ?? null,
    signal: record.child?.signalCode ?? null,
    spawnError: record.spawnError ? safeErrorCode(record.spawnError) : null,
    ioErrorCount: record.ioErrors?.length ?? 0,
  }));
}

function assembleProbeAssessment(summary) {
  const request = summary.requests[0] || null;
  const serverEvidence = summary.serverPromptEvidence || { truncations: [], runnerContexts: [] };
  const serverTruncation = request?.serverPromptTruncation
    ?? serverEvidence.truncations?.at(-1)
    ?? null;
  const serverPromptTokens = serverTruncation?.prompt
    ?? request?.serverPromptBeforeTruncation
    ?? request?.promptEvalCount
    ?? null;
  const serverTruncationObserved = Boolean(serverTruncation
    && Number.isSafeInteger(serverTruncation.prompt)
    && Number.isSafeInteger(serverTruncation.limit)
    && Number.isSafeInteger(serverTruncation.newCount)
    && serverTruncation.prompt > serverTruncation.limit
    && serverTruncation.newCount <= serverTruncation.limit);
  const forwarded = (summary.providerRequestEvidence || [])
    .filter(providerRequest => providerRequest.upstreamRequestStartedAt !== null);
  const providerRequest = forwarded[0] || null;
  const serverContextLength = summary.apiPsBefore?.contextLengths?.[0]
    ?? serverEvidence.runnerContexts?.at(-1)
    ?? null;
  const terminalResult = request?.cliEvents?.terminalResult;
  const process = request?.process;
  const successfulCliTerminal = Boolean(summary.probeMode === "kcoder"
    && process?.exitCode === 0
    && terminalResult?.subtype === "success"
    && terminalResult?.runStatus === "completed"
    && terminalResult?.taskStatus === "completed"
    && terminalResult?.terminationReason === "completed");
  const terminalGenerationFrameReceived = (providerRequest?.terminalSseDoneAt
    ?? request?.providerTerminalSseDoneAt
    ?? request?.terminalDoneAt) != null;
  const generationStreamCompleted = Boolean(terminalGenerationFrameReceived
    && (providerRequest?.responseEndedAt ?? request?.providerResponseEndedAt) != null);
  const kcoderProviderGenerationComplete = Boolean(summary.probeMode === "kcoder"
    && forwarded.length === 1
    && generationStreamCompleted);
  const providerPathServerTruncationObserved = Boolean(summary.probeMode === "kcoder"
    && forwarded.length === 1
    && serverTruncationObserved);

  summary.assessment = {
    actualPromptOver4096: Number.isSafeInteger(serverPromptTokens) && serverPromptTokens > 4_096,
    serverPromptTokensBeforeTruncation: serverPromptTokens,
    serverPromptTruncationObserved: serverTruncationObserved,
    serverPromptTruncation,
    serverContextLength,
    serverTruncationEvidenceBoundary: summary.probeMode === "kcoder"
      ? "owned KCoder Provider request reached the owned Ollama server; prompt token count and truncation come from Ollama server logs"
      : "direct Ollama native /api/chat request; no KCoder Provider call",
    kcoderProviderPathServerTruncationObserved: providerPathServerTruncationObserved,
    kcoderProviderGenerationComplete,
    forwardedProviderGenerationCount: forwarded.length,
    rejectedProviderRequestCount: summary.providerRequestCounts?.rejectedBeforeOllama ?? 0,
    terminalGenerationFrameReceived,
    generationStreamCompleted,
    assistantReasoningObserved: (request?.cliEvents?.assistantThinkingBytes ?? 0) > 0,
    visibleAssistantContentObserved: (request?.cliEvents?.assistantContentBytes ?? 0) > 0,
    successfulCliTerminal,
    kcoderTurnCompleted: summary.probeMode === "kcoder" && successfulCliTerminal,
    perf003Closed: false,
    perf003Boundary: "timestamps distinguish CLI/provider/SSE/terminal events; this run does not close the broader PERF-003 acceptance",
  };
}
