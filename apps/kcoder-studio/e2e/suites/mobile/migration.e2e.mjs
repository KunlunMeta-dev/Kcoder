import { seedProjectsFixture, exerciseProjectsUi } from '../browser/migration-projects.mjs';
import { seedAgentAdaptationFixture, exerciseAgentAdaptationUi } from '../browser/migration-agent-adaptation.mjs';
import { seedProjectMcpFixture, exerciseProjectMcpUi } from '../browser/migration-project-mcp.mjs';
import { seedUploadedPluginFixture, exerciseUploadedPluginUi } from '../browser/migration-uploaded-plugins.mjs';
import { seedInstructionFixture, exerciseInstructionUi } from '../browser/migration-instructions.mjs';
import { seedHistoryFamilies, exerciseHistoryFamilies } from '../browser/migration-history-families.mjs';
import { installBudgetReceiptFault, exerciseResourceBudgetUi } from '../browser/migration-resource-budget.mjs';
import { seedProjectPluginFixture, exerciseProjectPluginUi } from '../browser/migration-project-plugins.mjs';
import { seedDefinitionFixture, exerciseDefinitionUi } from '../browser/migration-definitions.mjs';
import { seedMobileDirectory, exerciseMobileDirectory } from './migration-source-directory.mjs';
import { seedBrowserUploadFixture } from '../browser/migration-browser-upload.mjs';
import { exerciseMobileSourceUpload } from './migration-source-upload.mjs';
import { seedMobileMemory, exerciseMobileMemory } from "./migration-memory.mjs";
import { seedCodexLayerFixture, exerciseCodexLayers } from "../browser/migration-codex-layers.mjs";
import { assertLegacyUploadCollectionRetained, exerciseManagedMobileUploadCollection } from "./migration-upload-collection.mjs";
import { seedConfigurationLayerFixture, exerciseConfigurationLayers } from "../browser/migration-configuration-layers.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { runE2E, repoRoot, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { archiveMobileWebExport, inspectMobileWebExportSourceIdentity, restoreMobileWebExportArchive, verifyMobileWebExportUnchanged } from "../../harness/mobile-web-export-archive.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { createLegacyHistoryFixture } from "../browser/migration-legacy-history.mjs";
import { openOwnedMobileRpc } from "../../harness/owned-mobile-rpc.mjs";
import { exerciseMobileHistoryLifecycle } from "./migration-history-lifecycle.mjs";
import { exerciseMobilePrivateCredentials } from './migration-private-credentials.mjs';
const privateCredentialsOnly = process.env.KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY === '1';
const instructionsOnly = process.env.KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY === '1';
const historyFamiliesOnly = process.env.KCODER_E2E_MIGRATION_HISTORY_FAMILIES_ONLY === '1';
const budgetOnly = ["1", "cas", "initial", "legacy"].includes(process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY);
const agentAdaptationOnly = process.env.KCODER_E2E_MIGRATION_AGENT_ADAPTATION_ONLY === '1';
const projectsOnly = process.env.KCODER_E2E_MIGRATION_PROJECTS_ONLY === '1';
const projectMcpOnly = process.env.KCODER_E2E_MIGRATION_PROJECT_MCP_ONLY === '1';
const uploadedPluginsOnly = process.env.KCODER_E2E_MIGRATION_UPLOADED_PLUGINS_ONLY === '1';
const projectPluginsOnly = process.env.KCODER_E2E_MIGRATION_PROJECT_PLUGINS_ONLY === "1";
const definitionsOnly = process.env.KCODER_E2E_MIGRATION_DEFINITIONS_ONLY === "1";
const directoryOnly = process.env.KCODER_E2E_MIGRATION_SOURCE_DIRECTORY_ONLY === "1";
const sourceUploadOnly = process.env.KCODER_E2E_MIGRATION_SOURCE_UPLOAD_ONLY === "1";
const memoryOnly = process.env.KCODER_E2E_MIGRATION_MEMORY_ONLY === "1";
const codexOnly = process.env.KCODER_E2E_MIGRATION_CODEX_LAYERS_ONLY === "1";
const layersOnly = process.env.KCODER_E2E_MIGRATION_LAYERS_ONLY === "1";
const runtimeImageOnly = process.env.KCODER_E2E_MIGRATION_RUNTIME_IMAGE_ONLY === "1";
const searchOnly = process.env.KCODER_E2E_MIGRATION_SEARCH_ONLY === "1";
const childOnly = process.env.KCODER_E2E_MIGRATION_HISTORY_CHILD_ONLY === "1";
const lifecycleOnly = process.env.KCODER_E2E_MIGRATION_HISTORY_LIFECYCLE_ONLY === "1";
const requireWorkerState = process.env.KCODER_E2E_MIGRATION_WORKER_STATE === "1";
const boundaryRecords = childOnly ? 3000 : 13;
assert.ok([projectsOnly,agentAdaptationOnly,projectMcpOnly,uploadedPluginsOnly,instructionsOnly,historyFamiliesOnly,privateCredentialsOnly,budgetOnly,projectPluginsOnly, codexOnly, layersOnly, runtimeImageOnly, searchOnly, childOnly, lifecycleOnly, memoryOnly, sourceUploadOnly, directoryOnly, definitionsOnly].filter(Boolean).length <= 1, "choose one explicit targeted Mobile boundary");

await runE2E(import.meta.url, { testId: projectsOnly ? "mobile-migration-project-inventory" : agentAdaptationOnly ? "mobile-migration-agent-adaptation" : projectMcpOnly ? "mobile-migration-project-mcp" : uploadedPluginsOnly ? "mobile-migration-uploaded-plugins" : instructionsOnly ? "mobile-migration-scoped-instructions" : historyFamiliesOnly ? "mobile-migration-history-families" : privateCredentialsOnly ? "mobile-migration-private-credentials" : budgetOnly ? "mobile-migration-resource-budget" : projectPluginsOnly ? "mobile-migration-project-plugins" : definitionsOnly ? "mobile-migration-pending-definitions" : directoryOnly ? "mobile-migration-source-directory" : sourceUploadOnly ? "mobile-migration-source-upload" : memoryOnly ? "mobile-migration-memory" : lifecycleOnly ? "mobile-migration-history-lifecycle" : codexOnly ? "mobile-migration-codex-layers" : layersOnly ? "mobile-migration-configuration-layers" : childOnly ? "mobile-migration-history-child-observation" : searchOnly ? "mobile-migration-historical-search" : runtimeImageOnly ? "mobile-migration-runtime-image-boundary" : "mobile-migration-native-workbench", tier: "full-integration", modelPolicy: "model-independent Mobile Web/real Gateway/Native source selection, receipts, explicit control and undo; no model turn", retainSuccessLogs: true }, async context => {
  const selectedMobileRoot = resolve(process.env.KCODER_E2E_MOBILE_SOURCE_ROOT || resolve(repoRoot, 'apps/kcoder-studio/mobile'));
  if (process.env.KCODER_E2E_MOBILE_SOURCE_ROOT) assert.ok(projectsOnly || privateCredentialsOnly || agentAdaptationOnly || budgetOnly && ['initial', 'legacy'].includes(process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY), 'explicit frozen input is scoped to private credential, Agent adaptation or initial/legacy history budget acceptance');
  const sourceRoots = [
    { name: 'mobile', path: selectedMobileRoot, destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(selectedMobileRoot, '../shared'), destination: 'apps/kcoder-studio/shared' },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({ sourceRoots });
  const archivePath = process.env.KCODER_E2E_MIGRATION_MOBILE_ARCHIVE;
  const archiveSha256 = process.env.KCODER_E2E_MIGRATION_MOBILE_ARCHIVE_SHA256;
  assert.equal(!!archivePath, !!archiveSha256, "archive path and exact SHA-256 must be supplied together");
  const mobile = archivePath ? await restoreMobileWebExportArchive(context, { archivePath, expectedArchiveSha256: archiveSha256, sourceIdentity }) : await exportMobileWeb(context, { mobileRoot: selectedMobileRoot, sourceRoots, dependencyRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'), label: "migration-mobile-export", outputName: "migration-mobile-web", timeoutMs: 10 * 60_000 });
  if (!archivePath) {
    const archived = await archiveMobileWebExport(context, { exportResult: mobile, sourceIdentity });
    await context.writeArtifactJson("mobile-build-archive.json", { path: archived.path, sha256: archived.sha256, bundleSha256: archived.bundleSha256, sourceTreeSha256: sourceIdentity.sourceTreeSha256 });
  }
  const { path: workspaceRoot } = await materializeWorkspace(context, "minimal");
  let workspace = workspaceRoot;
  const binary = context.pathInState("bin/kcoder");
  await mkdir(resolve(binary, ".."), { recursive: true, mode: 0o700 });
  await copyFile(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), binary); await chmod(binary, 0o700);
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  if (projectsOnly || agentAdaptationOnly || projectMcpOnly || uploadedPluginsOnly || privateCredentialsOnly || historyFamiliesOnly || instructionsOnly || budgetOnly && ["initial", "legacy"].includes(process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY)) {
    assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/, 'private credential acceptance pins its Native input');
    assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  }
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: "assistant", content: "UNEXPECTED_MODEL_CALL" }, finishReason: "stop" }] });
  const original = { credential_store: "file", active_provider: "fixture", providers: { fixture: { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: model.baseUrl, default_model: "fixture", context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 1024, discover_models: false, no_proxy: true } } };
  const profile = context.pathInState("profile"), peer = context.pathInState("peer-profile"), source = context.pathInState("source-home/.claude");
  for (const path of [profile, peer, source]) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
  await writeFile(resolve(profile, "settings.json"), JSON.stringify(original), { mode: 0o600 });
  await writeFile(resolve(peer, "settings.json"), JSON.stringify(original), { mode: 0o600 });
  const apiKey = "SYNTHETIC_MOBILE_MIGRATION_PROVIDER_SECRET", mcpKey = "SYNTHETIC_MOBILE_MIGRATION_MCP_SECRET";
  context.registerSecret(apiKey); context.registerSecret(mcpKey);
  const marker = context.pathInState("SOURCE_PROGRAM_MUST_NOT_EXECUTE"), command = context.pathInState("source-program.sh");
  await writeFile(command, `#!/bin/sh\nprintf invoked > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  const mcpEnvironment = { TOKEN: mcpKey };
  for (let index = 0; index < 11; index++) { const value = `SYNTHETIC_MOBILE_UNSELECTED_PRIVATE_${index}`; mcpEnvironment[`EXTRA_${index}`] = value; context.registerSecret(value); }
  const sourceSettings = JSON.stringify({ model: "mobile-source-model", env: { ANTHROPIC_BASE_URL: "https://mobile-migration.example.invalid/v1", ANTHROPIC_API_KEY: apiKey }, mcpServers: { documents: { command: "sh", args: [command], env: mcpEnvironment } } });
  await writeFile(resolve(source, "settings.json"), sourceSettings, { mode: 0o600 });
  await writeFile(resolve(source, "CLAUDE.md"), "Keep original office documents unchanged.\n", { mode: 0o600 });
  for (let index = 0; index < 12; index++) {
    const skill = resolve(source, `skills/office-${String(index).padStart(2, "0")}`);
    await mkdir(skill, { recursive: true, mode: 0o700 });
    await writeFile(resolve(skill, "SKILL.md"), `---\nname: office-${index}\ndescription: Check supplied documents\n---\nCite supplied sources.\n`, { mode: 0o600 });
  }
  const layerFixture = layersOnly ? await seedConfigurationLayerFixture(context, workspace, source, profile) : null;
  const history = [];
  const embeddedText = "Archived Mobile attachment, unchanged.\n", nestedText = "Nested Mobile attachment ";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  for (let index = 0; index < 12; index++) {
    const sessionId = randomUUID(), file = resolve(source, `projects/owned/${sessionId}.jsonl`);
    await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 });
    const rows = index === 0 ? 5000 : index === 1 ? 16 : 2;
    let bytes = Array.from({ length: rows }, (_, row) => JSON.stringify({ type: row === 1 ? "assistant" : "user", uuid: `message-${row}`, sessionId, version: "2.1.301", message: { role: row === 1 ? "assistant" : "user", content: row === 0 ? `Mobile archive ${index}` : row === 1 ? [{ type: "tool_use", id: "old-tool", name: "Bash", input: { command: `sh ${command}` } }] : row === 2 ? [{ type: "tool_result", tool_use_id: "old-tool", content: "Recorded historical output" }] : "Owned historical office record. ".repeat(8) } })).join("\n") + "\n";
    if (index === 1) bytes = Array.from({ length: rows }, (_, row) => JSON.stringify({ type: row === 1 ? "assistant" : "user", uuid: `h4-${row}`, ...(row ? { parentUuid: `h4-${row - 1}` } : {}), sessionId, version: "2.1.301", message: { role: row === 1 ? "assistant" : "user", content: row === 0 ? "Mobile H4 continuation" : row === 1 ? [{ type: "tool_use", id: "old-h4-tool", name: "Bash", input: { command: `sh ${command}` } }] : row === 2 ? [{ type: "tool_result", tool_use_id: "old-h4-tool", content: [{ type: "text", text: "Recorded result only" }, ...Array.from({ length: 12 }, (_, item) => ({ type: "document", title: `nested-${item}.txt`, source: { type: "text", media_type: "text/plain", data: nestedText + item } }))] }] : row === 3 ? [{ type: "document", title: "archived.txt", source: { type: "text", media_type: "text/plain", data: embeddedText } }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] : row === 4 ? [{ type: "document", path: "/NEVER_AUTHORIZED/original.pdf", title: "old-local.pdf", media_type: "application/pdf" }] : `Saved continuation record ${row}` } })).join("\n") + "\n";
    if (index === 1 && runtimeImageOnly) bytes = [{ type: "user", uuid: "runtime-root", sessionId, version: "2.1.301", message: { role: "user", content: "Mobile runtime image boundary" } }, { type: "user", uuid: "runtime-image", parentUuid: "runtime-root", sessionId, version: "2.1.301", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] } }].map(row => JSON.stringify(row)).join("\n") + "\n";
    if (index === 1 && (searchOnly || childOnly)) bytes = Array.from({ length: boundaryRecords }, (_, row) => JSON.stringify({ type: "user", uuid: `search-${row}`, ...(row ? { parentUuid: `search-${row - 1}` } : {}), sessionId, version: "2.1.301", message: { role: "user", content: row === 0 ? "Mobile historical search boundary" : row === 1 ? "Needle Office 1\n<script>globalThis.MIGRATION_SEARCH_EXECUTED=true</script>\n" + "bounded original source text. ".repeat(9000) + "\nMOBILE_SEARCH_BODY_END" : `Needle Office ${row}${row === 12 ? " 北京" : ""}` } })).join("\n") + "\n";
    await writeFile(file, bytes, { mode: 0o600 }); history.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const installed = {};
  for (let index = 0; index < 12; index++) {
    const name = `office-pack-${String(index).padStart(2, "0")}`, path = resolve(source, `plugins/cache/market/${name}/1.0.0`);
    await mkdir(resolve(path, ".claude-plugin"), { recursive: true, mode: 0o700 });
    await mkdir(resolve(path, "skills/check"), { recursive: true, mode: 0o700 });
    await writeFile(resolve(path, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0", mcpServers: { documents: { command: "sh", args: [command] } }, hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }), { mode: 0o600 });
    await writeFile(resolve(path, "skills/check/SKILL.md"), "---\nname: check\ndescription: Check office documents\n---\nPreserve sources.\n", { mode: 0o600 });
    installed[`${name}@market`] = [{ scope: "user", installPath: path, version: "1.0.0" }];
  }
  await writeFile(resolve(source, "plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }), { mode: 0o600 });
  const codexRoot = context.pathInState("source-home/.codex");
  const historyFamilyFixture = historyFamiliesOnly ? await seedHistoryFamilies(context, codexRoot, command) : null;
  const codexFixture = codexOnly ? await seedCodexLayerFixture(context, workspaceRoot, codexRoot, profile) : null;
  if (codexFixture) workspace = codexFixture.cwd;
  const projectInventoryFixture = projectsOnly ? await seedProjectsFixture(context, profile, workspace, binary) : null;
  const projectMcpFixture = projectMcpOnly ? await seedProjectMcpFixture(context, profile, workspace, binary) : null;
  const uploadedPluginFixture = uploadedPluginsOnly ? await seedUploadedPluginFixture(context, profile, workspace) : null;
  const projectPluginFixture = projectPluginsOnly ? await seedProjectPluginFixture(context, source, codexRoot, profile, workspace) : null;
  const agentAdaptationFixture = agentAdaptationOnly ? await seedAgentAdaptationFixture(context, source, codexRoot) : null;
  const definitionsFixture = definitionsOnly ? await seedDefinitionFixture(context, source, codexRoot) : null;
  const directoryFixture = directoryOnly ? await seedMobileDirectory(context) : null;
  const sourceUploadFixture = sourceUploadOnly || directoryOnly ? await seedBrowserUploadFixture(context) : null;
  const memoryFixture = memoryOnly ? await seedMobileMemory(context, source, codexRoot, workspace, profile) : null;
  const instructionFixture = instructionsOnly ? await seedInstructionFixture(context, profile, workspace) : null;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const servers = [];
  for (const [id, config] of [["migration-target", profile], ["peer-target", peer]]) {
    const launcher = context.pathInState(`${id}-launcher`);
    await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(config)}\nexport HOME=${quote(context.pathInState("source-home"))}\nexport CLAUDE_CONFIG_DIR=${quote(source)}\nexport CODEX_HOME=${quote(codexRoot)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    servers.push({ id, label: id, transport: "local", command: launcher, workspace });
  }
  if (projectInventoryFixture) servers.push(projectInventoryFixture.server);
  const serversFile = await context.writeStateJson("servers.json", servers);
  const gateway = await startGateway(context, { auth: true, label: "migration-mobile-gateway", workspace, kcoderBin: binary, serversFile, env: { KCODER_STUDIO_WEB_ROOT: mobile.path } });
  const browser = await startChromium(context, { label: "migration-mobile-chromium" });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const observations = [], errors = [];
  await page.addInitScript(() => { Object.defineProperty(globalThis, "showSaveFilePicker", { value: undefined, configurable: true }); });
  let dropFirstRun = !projectsOnly && !agentAdaptationOnly && !projectMcpOnly && !uploadedPluginsOnly && !instructionsOnly && !historyFamiliesOnly && !privateCredentialsOnly && !budgetOnly && !projectPluginsOnly && !definitionsOnly && !directoryOnly && !sourceUploadOnly && !memoryOnly && !lifecycleOnly && !codexOnly && !layersOnly && !runtimeImageOnly && !searchOnly && !childOnly, lostRun = null, dropContinuation = !projectsOnly && !agentAdaptationOnly && !projectMcpOnly && !uploadedPluginsOnly && !instructionsOnly && !historyFamiliesOnly && !privateCredentialsOnly && !budgetOnly && !projectPluginsOnly && !definitionsOnly && !directoryOnly && !sourceUploadOnly && !memoryOnly && !lifecycleOnly && !codexOnly && !layersOnly && !runtimeImageOnly && !searchOnly && !childOnly, lostContinuation = null;
  let dropMemory = memoryOnly, lostMemory = null;
  let holdSourcePart = sourceUploadOnly && (!process.env.KCODER_E2E_MIGRATION_SOURCE_UPLOAD_CASES || process.env.KCODER_E2E_MIGRATION_SOURCE_UPLOAD_CASES.split(',').includes('configuration')), heldSourcePart = null;
  page.on("pageerror", error => errors.push(error.message));
  const budgetTransport = budgetOnly ? await installBudgetReceiptFault(page, { attachment: process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY === 'legacy', withholdFirst: process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY === 'cas', history: ['initial', 'legacy'].includes(process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY) }) : null;
  if (!budgetOnly) await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer(), pending = new Map();
    const serverId = new URL(socket.url()).searchParams.get("server");
    socket.onMessage(raw => {
      try { const value = JSON.parse(String(raw)); if (value.method?.startsWith("migration/") || value.method === "initialize") { const row = { method: value.method, serverId, jobId: value.params?.jobId, requestJobId: value.params?.jobId, operationId: value.params?.operationId, requestId: value.params?.requestId, mode: value.params?.mode, memoryEnabled: value.params?.enabled, memoryId: value.params?.id, sourceJobId: value.params?.sourceJobId, viewId: value.params?.viewId, query: value.params?.query, caseSensitive: value.params?.caseSensitive, cursorPresent: !!value.params?.cursor, ...(value.method === "initialize" ? { requestedWorkerState: value.params?.capabilities?.experimental?.migrationHistoryWorkerStateClientV1 === true, requestedNativeWorkerState: value.params?.capabilities?.experimental?.migrationHistoryWorkerStateV1 === true } : {}) }; observations.push(row); pending.set(value.id, row); } }
      catch { /* Non-JSON frames are forwarded unchanged. */ }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      try {
        const value = JSON.parse(String(raw)), row = pending.get(value.id);
        if (row) {
          pending.delete(value.id); const result = value.result, job = result?.state?.job ?? result?.job;
          row.totalItems = job?.totalItems;
          if (row.method === "migration/items") row.providerCount = result?.providers?.length;
          if (["migration/configuration/layers", "migration/codex/layers/read"].includes(row.method)) { row.reportStatus = result?.status; row.reportRows = result?.fields?.length; row.reportTargetJobId = result?.target?.jobId; }
          row.error = value.error?.code; row.responseJobId = job?.jobId; row.responseOperationId = job?.operationId; row.stage = job?.status ?? job?.stage; row.workerRunning = result?.workerRunning; row.historyPhase = result?.progress?.history?.phase; row.historyProcessed = result?.progress?.history?.processed;
          row.workerState = result?.workerState; row.workerError = result?.workerError;
          row.collection = result?.collection; row.workerScheduled = result?.workerScheduled;
          if (row.method === "initialize") row.workerStateCapability = result?.capabilities?.experimental?.migrationHistoryWorkerStateV1 === true;
          row.viewId = result?.choice?.viewId ?? result?.state?.viewId ?? row.viewId; row.branchStage = result?.progress?.stage; row.toolsStage = result?.state?.run?.stage; row.uploadStage = result?.upload?.stage; row.uploadedBytes = result?.upload?.receivedBytes; row.localStage = result?.upload?.localJob?.state?.stage; row.uploadOperationId = result?.upload?.operationId; row.threadId = job?.threadId; row.localBindings = job?.options?.localAttachments?.length; row.historicalContentVerified = result?.upload?.localJob?.historicalContentVerified;
          if (holdSourcePart && row.method === "migration/source/upload/part" && result?.upload) { holdSourcePart = false; heldSourcePart = { socket, raw }; row.heldReply = true; return; }
          if (row.method === "migration/memory/list") { row.memoryTotal = result?.totalRecords; row.memoryEnabled = result?.items?.map(note => note.enabled); row.memoryScopes = result?.items?.map(note => note.scope?.kind); row.memoryFacts = result?.items?.map(note => note.provenance?.factsVerified); }
          if (row.method === "migration/memory/read") row.memoryBytes = typeof result?.text === "string" ? Buffer.byteLength(result.text) : null;
          if (row.method === "migration/memory/control" && dropMemory && row.memoryEnabled === true && result?.receipt) { dropMemory = false; lostMemory = row; row.droppedReply = true; void upstream.close({ code: 1011, reason: "owned memory receipt fault" }); void socket.close({ code: 1011, reason: "owned memory receipt fault" }); return; }
          if (row.method === "migration/discover") row.sources = result?.sources;
          if (row.method === "migration/jobs/list") row.jobIds = result?.jobs?.map(item => item.job.jobId);
          if (row.method === "migration/history/read") row.normalization = result?.job?.normalization;
          if (row.method === "migration/history/search") { row.searchHitCount = result?.items?.length; row.searchHasNext = !!result?.nextCursor; row.searchBodyGrants = result?.items?.every(item => !!item.bodyCursor); }
          if (["migration/history/text", "migration/history/branch/text"].includes(row.method) && typeof result?.text === "string") { row.bodyWindowBytes = Buffer.byteLength(result.text); row.bodyWindowHasNext = !!result.nextCursor; row.bodyWindowHasEnd = result.text.includes("MOBILE_SEARCH_BODY_END"); }
          if (row.method === "migration/history/transcript") row.recordCount = result?.items?.length;
          if (row.method === "migration/items") { row.items = result?.items?.map(({ id, category, sourceName }) => ({ id, category, sourceName })); row.planned = result?.planned; }
          if (row.method === "migration/history/continuation/create" && dropContinuation && result) { dropContinuation = false; lostContinuation = row; row.droppedReply = true; void upstream.close({ code: 1011, reason: "owned continuation receipt fault" }); return; }
          if (row.method === "migration/batch/run" && row.mode === "apply" && dropFirstRun && result) { dropFirstRun = false; lostRun = row; row.droppedReply = true; void upstream.close({ code: 1011, reason: "owned migration receipt fault" }); return; }
        }
      } catch { /* Unexpected frames remain visible to the actual client. */ }
      socket.send(raw);
    });
  });
  const screen = () => page.locator("body").innerText();
  const shot = name => page.screenshot({ path: context.pathInArtifacts(name), fullPage: true });
  const confirm = async keyword => { await page.getByTestId("migration-batch-confirm-input").fill(keyword); await page.getByTestId("migration-batch-confirm-submit").click(); };
  const selectTarget = async id => { await page.getByTestId("settings-runtime-target-selector").click(); await page.getByTestId(`settings-runtime-target-option-${id}`).click(); await waitFor(async () => await page.getByTestId("migration-workbench").count() > 0 || await page.getByTestId("migration-results-list").count() > 0, 30000, "target-owned migration view"); };
  const confirmControl = async (prefix, keyword) => { await page.getByTestId(`${prefix}-input`).fill(keyword); await page.getByTestId(`${prefix}-submit`).click(); };
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken); await page.locator('button[type="submit"]').click();
    await page.getByTestId("welcome-direct-connection").click(); await page.getByTestId("gateway-token").fill(gateway.authToken); await page.getByTestId("gateway-connect").click();
    await page.getByTestId("new-workspace").waitFor({ timeout: 30000 });
    await page.goto(`${gateway.baseUrl}/settings-section?section=migration_results`);
    await selectTarget("migration-target");
    if (agentAdaptationOnly) { const result = await exerciseAgentAdaptationUi({ context, page, gateway, profile, workspace, fixture: agentAdaptationFixture, model, mobile: true }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (projectsOnly) { const result = await exerciseProjectsUi({context,page,gateway,profile,workspace,fixture:projectInventoryFixture,model,mobile:true}); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (projectMcpOnly) { const result = await exerciseProjectMcpUi({ context, page, gateway, profile, workspace, fixture: projectMcpFixture, model, mobile: true }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (instructionsOnly) { const result = await exerciseInstructionUi({ context, page, gateway, profile, workspace, fixtures: instructionFixture, model, mobile: true }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (historyFamiliesOnly) { const result = await exerciseHistoryFamilies({ context, page, gateway, profile, workspace, fixture: historyFamilyFixture, sourceProgram: command, model, mobile: true }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (privateCredentialsOnly) {
      const result = await exerciseMobilePrivateCredentials({ context, page, gateway, profile, workspace, sourceRoot: source, marker, model, observations });
      assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (budgetOnly) { const result = await exerciseResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot: source, model, transport: budgetTransport, mobile: true }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (uploadedPluginsOnly) { const result = await exerciseUploadedPluginUi({ context, page, gateway, profile, workspace, fixture: uploadedPluginFixture, model, mobile: true, observations }); assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result; }
    if (projectPluginsOnly) return await exerciseProjectPluginUi({ context, page, gateway, profile, workspace, fixture: projectPluginFixture, model, mobile: true });
    if (definitionsOnly) {
      const result = await exerciseDefinitionUi({ context, page, gateway, profile, workspace, fixture: definitionsFixture, model, mobile: true });
      assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (directoryOnly) {
      const result = await exerciseMobileDirectory({ context, page, gateway, profile, workspace, fixture: directoryFixture, model });
      // The catalog changed: one direct uploaded-source consumer guards its unchanged path.
      process.env.KCODER_E2E_MIGRATION_SOURCE_UPLOAD_CASES = 'asset';
      await exerciseMobileSourceUpload({ context, page, gateway, profile, workspace, fixture: sourceUploadFixture, observations, heldPart: () => null, releasePart: () => {}, model });
      assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return { ...result, uploadedAssetConsumer: true };
    }
    if (sourceUploadOnly) {
      const result = await exerciseMobileSourceUpload({ context, page, gateway, profile, workspace, fixture: sourceUploadFixture, observations, heldPart: () => heldSourcePart, releasePart: () => { if (heldSourcePart) heldSourcePart.socket.send(heldSourcePart.raw); heldSourcePart = null; }, model });
      assert.deepEqual(errors, []); await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (memoryOnly) {
      const result = await exerciseMobileMemory({ context, page, gateway, profile, fixture: memoryFixture, observations, lostMemory: () => lostMemory, model });
      await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (lifecycleOnly) {
      const owned = await openOwnedMobileRpc(context, gateway, "migration-target", workspace);
      const result = await exerciseMobileHistoryLifecycle({ context, page, observer: owned.rpc, profile, sourceRoot: source, observations });
      assert.equal(model.requests.length, 0); assert.deepEqual(errors, []);
      await verifyMobileWebExportUnchanged(mobile); await owned.close(); return result;
    }
    if (codexOnly) {
      const result = await exerciseCodexLayers({ context, page, gateway, model, fixture: codexFixture, mobile: true, observations });
      await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (layersOnly) {
      const result = await exerciseConfigurationLayers({ context, page, gateway, model, fixture: layerFixture, mobile: true, observations });
      await verifyMobileWebExportUnchanged(mobile); return result;
    }
    if (runtimeImageOnly || searchOnly || childOnly) {
      await page.getByTestId("migration-source-claude-code").click(); await page.getByTestId("migration-discover-history").click();
      const list = page.getByTestId("migration-history-sources"); await list.waitFor();
      const boundaryTitle = searchOnly || childOnly ? /Mobile historical search boundary$/ : /Mobile runtime image boundary$/;
      if (!await list.getByRole("button", { name: boundaryTitle }).count()) { await list.getByRole("button", { name: "Next", exact: true }).click(); await list.getByRole("button", { name: boundaryTitle }).waitFor(); }
      await list.getByRole("button", { name: boundaryTitle }).click(); await page.getByTestId("migration-scan-selection").click();
      await page.getByTestId("migration-batch-editor").waitFor(); await page.locator('[data-testid^="migration-item-edit-"]').first().click(); await page.getByTestId("migration-item-save").click(); await page.getByTestId("migration-preview-plan").click();
      await page.getByTestId("migration-batch-import").click(); await confirm("IMPORT");
      await waitFor(() => observations.some(row => row.method === "migration/batch/run" && row.mode === "apply" && row.workerRunning === true), 15000, "the original explicit parent run acknowledgement");
      if (searchOnly) await waitFor(() => observations.some(row => row.method === "migration/batch/read" && ["completed", "completed_with_issues"].includes(row.stage) && row.workerRunning === false), 30000, "parent batch authoritative completion before isolated search");
      const beforeChild = observations.length;
      const child = page.locator('[data-testid^="migration-open-history-"]').first(); await child.waitFor({ timeout: 30000 });
      await waitFor(async () => await child.getAttribute("aria-disabled") !== "true", 10000, "parent confirmation is settled before child navigation"); await child.click();
      if (childOnly) {
        await page.getByTestId("migration-archive-search").waitFor({ timeout: 30000 });
        if (requireWorkerState) await waitFor(() => observations.slice(beforeChild).some(row => row.method === "migration/history/read" && row.stage === "normalized" && row.workerState === "stopped" && row.workerRunning === false), 30000, "authoritative owner release after the terminal checkpoint");
        const reads = observations.slice(beforeChild).filter(row => row.method === "migration/history/read");
        assert.ok(reads.some(row => row.normalization?.normalizationComplete === true && row.normalization.normalizedRecords === boundaryRecords), "the selected child must refresh to its durable completed state");
        assert.equal(observations.filter(row => row.method === "migration/batch/run").length, 1, "the one explicitly confirmed parent run is not replayed");
        assert.ok(!observations.slice(beforeChild).some(row => /migration\/history\/(?:run|resume|cancel)$/.test(row.method)), "child observation cannot dispatch child control");
        const checkpoints = reads.map(row => ({ stage: row.stage, workerRunning: row.workerRunning, workerState: row.workerState, normalizedRecords: row.normalization?.normalizedRecords }));
        if (requireWorkerState) {
          assert.ok(observations.some(row => row.method === "initialize" && row.requestedWorkerState && row.workerStateCapability), "Mobile explicitly negotiated the Native owner observation");
          assert.ok(!observations.some(row => row.method === "initialize" && row.requestedNativeWorkerState), "the Gateway-only alias cannot enroll an old shared backend in new Native fields");
          assert.ok(reads.some(row => row.workerState === "running" && row.workerRunning === true), "the parent batch's active child owner must be observed beyond the local worker map");
          assert.ok((await page.getByTestId("migration-history-worker-state").innerText()).includes("No active execution owner"));
          const jobId = reads.at(-1).responseJobId;
          assert.match(jobId, /^[a-f0-9-]{36}$/);
          const lease = resolve(profile, `migrations/history/${jobId}.execution.lock`), withheld = context.pathInState("withheld-owned-execution.lock");
          // Move only the isolated job's released lease; observation must not repair or recreate it.
          await rename(lease, withheld);
          try {
            const beforeMissing = observations.length; await page.getByTestId("migration-history-refresh").click();
            await waitFor(() => observations.slice(beforeMissing).some(row => row.method === "migration/history/read" && row.workerState === "unknown" && row.workerError === "history_job_execution_unknown"), 10000, "missing released Native lease remains unknown");
            await waitFor(async () => (await page.getByTestId("migration-history-worker-state").innerText()).includes("Execution ownership is unconfirmed"), 10000, "Mobile displays unknown ownership without inventing idle");
            assert.equal(await page.getByTestId("migration-history-run").getAttribute("aria-disabled"), "true"); assert.equal(await page.getByTestId("migration-history-resume").getAttribute("aria-disabled"), "true");
            assert.equal(await access(lease).then(() => true, () => false), false, "read-only observation cannot replace missing ownership evidence");
            await shot("mobile-history-owner-unknown.png");
          } finally { await rename(withheld, lease); }
          const beforeRestored = observations.length; await page.getByTestId("migration-history-refresh").click();
          await waitFor(() => observations.slice(beforeRestored).some(row => row.method === "migration/history/read" && row.workerState === "stopped"), 10000, "the same owned lease identity is observed after restoration");
          const journal = resolve(profile, `migrations/history/${jobId}.json`), birth = resolve(profile, `migrations/history/${jobId}.execution.birth`);
          const currentJournal = JSON.parse(await readFile(journal, "utf8"));
          assert.ok(currentJournal.executionIdentity && currentJournal.executionBirthSha256, "the original new job had durable execution ownership");
          // This is an owned persistent pre-execution-identity fixture, not a claim that a vendor emitted this journal.
          const legacyJournal = { ...currentJournal }; delete legacyJournal.executionIdentity; delete legacyJournal.executionBirthSha256;
          await rename(lease, context.pathInState("legacy-original-execution.lock")); await rename(birth, context.pathInState("legacy-original-execution.birth"));
          await writeFile(journal, JSON.stringify(legacyJournal), { mode: 0o600 });
          const beforeLegacy = observations.length; await page.getByTestId("migration-history-refresh").click();
          await waitFor(() => observations.slice(beforeLegacy).some(row => row.method === "migration/history/read" && row.workerState === "unknown" && row.workerError === "history_job_execution_untracked" && row.stage === "normalized"), 10000, "legacy normalized ownership is explicitly classified");
          await waitFor(async () => await page.getByTestId("migration-history-resume").getAttribute("aria-disabled") !== "true", 10000, "completed legacy ownership check remains discoverable");
          assert.equal(await page.getByTestId("migration-history-cancel").getAttribute("aria-disabled"), "true"); assert.equal(await page.getByTestId("migration-history-run").getAttribute("aria-disabled"), "true");
          assert.ok((await page.getByTestId("migration-history-resume").innerText()).includes("Check legacy task status"));
          await page.getByTestId("migration-history-resume").click(); await confirmControl("migration-history-confirm", "RESUME");
          await waitFor(() => observations.slice(beforeLegacy).some(row => row.method === "migration/history/resume" && row.workerState === "stopped" && row.stage === "normalized"), 10000, "explicit completed legacy metadata-only recovery");
          const upgraded = JSON.parse(await readFile(journal, "utf8"));
          assert.ok(upgraded.executionIdentity && upgraded.executionBirthSha256); assert.equal(upgraded.normalizationRevision, currentJournal.normalizationRevision);
          assert.deepEqual(upgraded.binding, currentJournal.binding); assert.equal(upgraded.view.archiveId, currentJournal.view.archiveId); assert.equal(upgraded.view.stage, "normalized"); assert.deepEqual(upgraded.view.normalization, currentJournal.view.normalization);
          assert.equal(observations.slice(beforeLegacy).filter(row => row.method === "migration/history/resume").length, 1);
          assert.ok(!observations.slice(beforeLegacy).some(row => ["migration/history/run", "migration/history/cancel"].includes(row.method)), "completed legacy ownership recovery cannot cancel or run the old parser");
          await shot("mobile-history-legacy-normalized-recovered.png");
        }
        assert.equal(model.requests.length, 0); assert.deepEqual(errors, []);
        for (const item of history) assert.equal(createHash("sha256").update(await readFile(item.file)).digest("hex"), item.sha256);
        await context.writeArtifactJson("mobile-history-child-observation.json", { passed: true, platform: "Mobile Web Chromium", binarySha256, checkpoints, reachedNormalized: true, noControlReplay: true, ...(requireWorkerState ? { workerStateNegotiated: true, activeParentOwner: "running", releasedOwner: "stopped", missingOwnedLease: "unknown", restoredOwnedLease: "stopped", legacyNormalizedFixture: "owned pre-execution-identity persistent header", completedLegacyOwnershipOnlyRecovery: true, noLegacyCancelOrRun: true, archiveAndInterpretationUnchanged: true } : {}), modelRequests: 0 }); await verifyMobileWebExportUnchanged(mobile); return;
      }
      let searchSourceJob = null, searchRequestsBegin = 0, bodyWindows = 0;
      if (searchOnly) {
        await page.getByTestId("migration-archive-search").waitFor();
        await waitFor(() => observations.some(row => row.method === "migration/history/read" && row.normalization?.normalizedRecords === 13), 10000, "authoritative search archive");
        searchSourceJob = [...observations].reverse().find(row => row.method === "migration/history/read" && row.normalization?.normalizedRecords === 13).responseJobId;
        assert.ok(searchSourceJob); await rename(source, resolve(source, "../source-withheld")); searchRequestsBegin = observations.length;
        const panel = page.getByTestId("migration-archive-search");
        await panel.getByTestId("migration-search-query").fill("needle"); assert.equal(observations.slice(searchRequestsBegin).filter(row => row.method === "migration/history/search").length, 0, "typing cannot dispatch a search");
        await panel.getByTestId("migration-search-submit").click(); await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 10, 15000, "ten archive search hits");
        assert.ok(observations.some(row => row.method === "migration/history/search" && row.searchBodyGrants && !row.viewId));
        await panel.getByRole("button", { name: "Next", exact: true }).click(); await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 2, 10000, "archive hit page two");
        await panel.getByRole("button", { name: "First page", exact: true }).click(); await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 10, 10000, "archive first hit page");
        await panel.getByTestId("migration-search-hit-0").click(); await panel.getByTestId("migration-search-body").waitFor();
        await page.getByText("<script>globalThis.MIGRATION_SEARCH_EXECUTED=true</script>", { exact: false }).waitFor(); assert.equal(await page.evaluate(() => globalThis.MIGRATION_SEARCH_EXECUTED), undefined);
        const bodyReplies = () => observations.filter(row => row.method === "migration/history/text" && row.bodyWindowBytes !== undefined);
        while (bodyReplies().at(-1)?.bodyWindowHasNext && bodyWindows < 16) { const before = bodyReplies().length; await panel.getByTestId("migration-search-body").getByRole("button", { name: "Next", exact: true }).click(); bodyWindows++; await waitFor(() => bodyReplies().length > before, 10000, "next signed body response"); }
        await waitFor(async () => (await panel.getByTestId("migration-search-body").innerText()).includes("MOBILE_SEARCH_BODY_END"), 10000, "final body window visible"); assert.ok(bodyWindows > 0);
        await shot("mobile-archived-search-body.png"); await panel.getByTestId("migration-search-back").click();
        await panel.getByTestId("migration-search-case").click(); await panel.getByTestId("migration-search-submit").click(); await waitFor(() => observations.some(row => row.method === "migration/history/search" && row.caseSensitive && row.query === "needle" && row.searchHitCount === 0), 10000, "Native case-sensitive no-match result");
        await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 0, 10000, "old insensitive hits removed");
        await panel.getByTestId("migration-search-query").fill("北京"); await panel.getByTestId("migration-search-submit").click(); await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 1, 10000, "Unicode source match");
        assert.ok(observations.slice(searchRequestsBegin).every(row => ["migration/history/search", "migration/history/text", "migration/history/read"].includes(row.method)), "search and hit bodies are read-only operations");
      }
      await page.getByTestId("migration-history-branch-tab").waitFor(); await page.getByTestId("migration-history-branch-tab").click(); await page.getByTestId("migration-branch-choose").click(); await page.getByTestId("migration-branch-prepare").click(); await confirmControl("migration-branch-confirm", "PREPARE");
      await waitFor(async () => await page.getByTestId("migration-branch-run").getAttribute("aria-disabled") !== "true", 10000, "runtime-image branch selected"); await page.getByTestId("migration-branch-run").click(); await confirmControl("migration-branch-confirm", "RUN");
      if (searchOnly) {
        const panel = page.getByTestId("migration-branch-search"); await panel.waitFor(); await panel.getByTestId("migration-search-query").fill("needle"); await panel.getByTestId("migration-search-submit").click();
        await waitFor(async () => await panel.locator('[data-testid^="migration-search-row-"]').count() === 10, 10000, "branch search hits"); await panel.getByTestId("migration-search-hit-0").click(); await panel.getByTestId("migration-search-body").waitFor();
        await page.getByText("<script>globalThis.MIGRATION_SEARCH_EXECUTED=true</script>", { exact: false }).waitFor(); assert.ok(observations.some(row => row.method === "migration/history/branch/text" && row.cursorPresent));
        assert.equal(await page.evaluate(() => globalThis.MIGRATION_SEARCH_EXECUTED), undefined);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes("migration-intents")).some(key => /needle|北京|MOBILE_SEARCH_BODY_END|<script>/i.test(localStorage.getItem(key) ?? ""))), false, "queries and body text cannot enter receipt metadata");
        const peerBegin = observations.length; await selectTarget("peer-target");
        if (await page.getByTestId("migration-tab-records").count()) await page.getByTestId("migration-tab-records").click();
        await waitFor(() => observations.slice(peerBegin).some(row => row.method === "migration/jobs/list" && row.serverId === "peer-target" && Array.isArray(row.jobIds)), 15000, "peer's own authoritative catalog");
        assert.ok(!observations.slice(peerBegin).some(row => row.serverId === "peer-target" && row.jobId === searchSourceJob), "old history locator cannot be forwarded to a peer target");
        assert.equal(await page.getByTestId("migration-history-workspace").count(), 0); assert.ok(!(await screen()).includes("MOBILE_SEARCH_BODY_END"));
        for (const item of history) assert.equal(createHash("sha256").update(await readFile(item.file.replace(source, resolve(source, "../source-withheld")))).digest("hex"), item.sha256);
        assert.equal(model.requests.length, 0); assert.deepEqual(errors, []); assert.equal(await access(marker).then(() => true, () => false), false);
        await context.writeArtifactJson("mobile-migration-search-results.json", { passed: true, platform: "Mobile Web Chromium", binarySha256, sourceJobId: searchSourceJob, pageSize: 10, secondPage: 2, signedBodyWindows: bodyWindows + 1, archiveAndBranchBodyRead: true, caseSensitive: true, unicodeQuery: true, historyReadWithoutSource: true, bodyHtmlInert: true, directTargetSwitchIsolated: true, queryAndBodyNotJournaled: true, modelRequests: 0, observations });
        await verifyMobileWebExportUnchanged(mobile); return;
      }
      await page.getByTestId("migration-branch-record-1").waitFor(); await page.getByTestId("migration-branch-record-1").click(); await page.getByTestId("migration-branch-attachment-0").click(); await page.getByTestId("migration-attachment-run").click(); await confirmControl("migration-attachment-confirm", "RUN"); await page.getByTestId("migration-attachment-download").waitFor();
      await page.getByTestId("migration-continuation-prepare").click(); await confirmControl("migration-continuation-create-confirm", "CREATE"); await page.getByTestId("migration-continuation-operation").waitFor();
      const created = [...observations].reverse().find(row => row.method === "migration/history/continuation/create"); assert.ok(created?.responseJobId);
      await waitFor(async () => await page.getByTestId("migration-continuation-run").getAttribute("aria-disabled") !== "true", 10000, "runtime-image creation receipt"); await page.getByTestId("migration-continuation-run").click(); await confirmControl("migration-continuation-confirm", "RUN");
      await waitFor(() => observations.some(row => row.method === "migration/history/continuation/read" && row.responseJobId === created.responseJobId && row.stage === "imported" && row.workerRunning === false), 30000, "runtime-image Native idle publication");
      const published = [...observations].reverse().find(row => row.method === "migration/history/continuation/read" && row.stage === "imported"); assert.ok(published.threadId);
      await waitFor(async () => await page.getByTestId("migration-continuation-open").getAttribute("aria-disabled") !== "true", 10000, "runtime-image safe navigation"); await page.getByTestId("migration-continuation-open").click(); await page.waitForURL(`**/task/migration-target/${published.threadId}**`); await page.getByTestId("message-input").waitFor();
      const visible = await screen(); await shot("mobile-runtime-image-boundary.png");
      assert.ok(!visible.includes("[image]") && !visible.includes('"historicalContentVerified"'), "Runtime-origin content must not become visible user transcript");
      await page.goto(`${gateway.baseUrl}/settings-section?section=migration_results`); await page.getByTestId("migration-workbench").waitFor(); await page.getByTestId("migration-archive-open").click(); await page.getByRole("button", { name: "Known continuation ID", exact: true }).click();
      await page.getByTestId("migration-known-continuation-id").fill(created.responseJobId); await page.getByTestId("migration-known-continuation-read").click(); await waitFor(async () => await page.getByTestId("migration-undo-preview").getAttribute("aria-disabled") !== "true", 10000, "opened session canonical lookup"); await page.getByTestId("migration-undo-preview").click();
      await page.getByText("historical_undo_busy", { exact: true }).waitFor(); assert.equal(await page.getByTestId("migration-undo-create").count(), 0); assert.equal(observations.filter(row => row.method === "migration/history/undo/create").length, 0);
      assert.equal(model.requests.length, 0); assert.deepEqual(errors, []); assert.equal(await access(marker).then(() => true, () => false), false);
      await context.writeArtifactJson("mobile-runtime-image-results.json", { passed: true, platform: "Mobile Web Chromium", binarySha256, continuationId: created.responseJobId, threadId: published.threadId, runtimeImageHidden: true, openedEngineRetirement: "historical_undo_busy", noUndoMutation: true, modelRequests: 0, observations });
      await verifyMobileWebExportUnchanged(mobile); return;
    }
    await page.getByTestId("migration-source-claude-code").click();
    await page.getByTestId("migration-discover-config").click();
    await page.getByTestId("migration-config-sources").waitFor();
    let sourcePages = 0;
    for (;;) {
      const group = page.getByTestId("migration-config-sources"), rows = group.locator('[data-testid^="migration-config-source-"]');
      assert.ok(await rows.count() <= 10);
      for (const row of await rows.all()) await row.click();
      sourcePages++;
      const next = group.getByRole("button", { name: "Next", exact: true });
      if (await next.getAttribute("aria-disabled") === "true") break;
      await next.click();
    }
    assert.ok(sourcePages >= 1, "Native discovery bundles asset directories; all returned source pages stay bounded");
    await page.getByTestId("migration-discover-history").click();
    const histories = page.getByTestId("migration-history-sources"); await histories.waitFor();
    assert.equal(await histories.locator('[data-testid^="migration-history-source-"]').count(), 10);
    await histories.getByRole("button", { name: "Next", exact: true }).click();
    await waitFor(async () => await histories.locator('[data-testid^="migration-history-source-"]').count() === 2, 10000, "second history page");
    await histories.getByRole("button", { name: "Previous", exact: true }).click();
    await waitFor(async () => await histories.locator('[data-testid^="migration-history-source-"]').count() === 10 && await histories.locator('[data-testid^="migration-history-source-"]').first().getAttribute("aria-disabled") !== "true", 10000, "first history page settled");
    let targetHistory = histories.getByRole("button", { name: /Mobile archive 0$/ });
    if (!await targetHistory.count()) { await histories.getByRole("button", { name: "Next", exact: true }).click(); await waitFor(async () => await histories.locator('[data-testid^="migration-history-source-"]').count() === 2 && await histories.locator('[data-testid^="migration-history-source-"]').first().getAttribute("aria-disabled") !== "true", 10000, "selected history page settled"); targetHistory = histories.getByRole("button", { name: /Mobile archive 0$/ }); }
    await targetHistory.click();
    await page.getByTestId("migration-discover-plugins").click();
    const plugins = page.getByTestId("migration-plugin-sources"); await plugins.waitFor();
    assert.equal(await plugins.locator('[data-testid^="migration-plugin-candidate-"]').count(), 10);
    await plugins.getByRole("button", { name: "Next", exact: true }).click();
    await waitFor(async () => await plugins.locator('[data-testid^="migration-plugin-candidate-"]').count() === 2, 10000, "second plugin page");
    await plugins.locator('[data-testid^="migration-plugin-candidate-"]').first().click();
    await page.getByTestId("migration-plugin-prepare").click();
    await page.getByTestId("migration-plugin-copy").waitFor({ timeout: 30000 });
    await page.getByTestId("migration-plugin-copy").click(); await page.getByTestId("migration-plugin-confirm-input").fill("COPY"); await page.getByTestId("migration-plugin-confirm-submit").click();
    await page.getByTestId("migration-plugin-use").waitFor({ timeout: 30000 }); await shot("mobile-plugin-static-review.png"); await page.getByTestId("migration-plugin-use").click();
    await page.getByTestId("migration-scan-selection").click();
    await page.getByTestId("migration-batch-editor").waitFor();
    const selected = new Set();
    for (let count = 0; count < 30; count++) {
      await waitFor(async () => await page.locator('[data-testid^="migration-item-edit-"]').count() > 0, 10000, "inventory page");
      const rowIds = await page.locator('[data-testid^="migration-item-edit-"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-testid").replace("migration-item-edit-", "")));
      const last = [...observations].reverse().find(row => row.method === "migration/items" && row.items?.some(item => rowIds.includes(item.id)));
      assert.ok(last); assert.ok(rowIds.length <= 10);
      const item = last.items.find(row => ["provider", "mcp", "instructions", "skill", "history", "plugin"].includes(row.category) && !selected.has(row.category));
      if (!item) {
        if (selected.size === 6) break;
        const next = page.getByTestId("migration-batch-editor").getByRole("button", { name: "Next", exact: true });
        assert.notEqual(await next.getAttribute("aria-disabled"), "true", JSON.stringify([...selected])); await next.click(); continue;
      }
      await page.getByTestId(`migration-item-edit-${item.id}`).click();
      if (await page.getByTestId("migration-item-name").count()) await page.getByTestId("migration-item-name").fill(`mobile-${item.category}`);
      if (item.category === "provider") { await page.getByTestId("migration-provider-context").fill("128000"); await page.getByTestId("migration-provider-headroom").fill("4096"); await page.getByTestId("migration-provider-output").fill("4096"); await page.getByTestId("migration-credential-configuration").click(); }
      if (item.category === "mcp") {
        const fields = page.getByTestId("migration-mcp-private-fields");
        assert.equal(await fields.locator('[data-testid^="migration-private-"]').count(), 10);
        const firstPage = await page.getByTestId("migration-private-environment-TOKEN").count() > 0;
        if (!firstPage) await fields.getByRole("button", { name: "Next", exact: true }).click();
        await page.getByTestId("migration-private-environment-TOKEN").click();
        await fields.getByRole("button", { name: firstPage ? "Next" : "Previous", exact: true }).click();
        await fields.getByRole("button", { name: firstPage ? "Previous" : "Next", exact: true }).click();
        assert.ok((await page.getByTestId("migration-private-environment-TOKEN").innerText()).startsWith("☑"), "private selection survives page changes");
      }
      if (["skill", "instructions"].includes(item.category)) { await page.getByTestId("migration-asset-preview").click(); await page.getByText(item.category === "skill" ? "Cite supplied sources." : "Keep original office documents unchanged.", { exact: false }).waitFor(); }
      await page.getByTestId("migration-item-save").click(); selected.add(item.category);
    }
    assert.equal(selected.size, 6);
    await page.getByTestId("migration-preview-plan").click(); await page.getByTestId("migration-batch-operation").waitFor();
    assert.deepEqual(JSON.parse(await readFile(resolve(profile, "settings.json"), "utf8")), original, "preview cannot publish");
    await page.getByTestId("migration-batch-import").click(); assert.equal(await page.getByTestId("migration-batch-confirm-submit").getAttribute("aria-disabled"), "true");
    await page.getByTestId("migration-batch-confirm-input").fill("NO"); assert.equal(await page.getByTestId("migration-batch-confirm-submit").getAttribute("aria-disabled"), "true"); await shot("mobile-plan-confirmation.png"); await confirm("IMPORT");
    await waitFor(() => !!lostRun, 15000, "lost authoritative Native run reply");
    const jobId = lostRun.responseJobId; assert.ok(jobId);
    await page.reload(); await page.getByTestId("migration-workbench").waitFor({ timeout: 30000 });
    assert.equal(observations.filter(row => row.method === "migration/batch/run").length, 1, "reopening must not replay a run");
    await page.getByTestId("migration-tab-recovery").click();
    await waitFor(async () => (await screen()).includes(lostRun.requestId), 10000, "persisted original request identity"); await shot("mobile-unknown-receipt-recovery.png");
    await page.getByTestId("migration-tab-records").click(); await page.getByTestId(`migration-batch-record-${jobId}`).click();
    await waitFor(async () => await page.getByTestId("migration-batch-cancel").getAttribute("aria-disabled") !== "true" || await page.getByTestId("migration-batch-resume").getAttribute("aria-disabled") !== "true", 15000, "authoritative active or resumable state");
    if (await page.getByTestId("migration-batch-cancel").getAttribute("aria-disabled") === "true") { await page.getByTestId("migration-batch-resume").click(); await confirm("RESUME"); }
    await waitFor(() => observations.some(row => row.method === "migration/batch/read" && row.responseJobId === jobId && row.workerRunning === true && row.historyPhase === "normalizing" && row.historyProcessed > 0), 30000, "actual history normalization progress");
    await page.getByTestId("migration-batch-cancel").click(); await confirm("CANCEL");
    await waitFor(async () => await page.getByTestId("migration-batch-resume").getAttribute("aria-disabled") !== "true", 30000, "owned cancellation settled"); await shot("mobile-cancelled-worker.png");
    await page.getByTestId("migration-batch-resume").click(); await confirm("RESUME");
    await waitFor(() => observations.some(row => row.method === "migration/batch/read" && row.responseJobId === jobId && ["completed", "completed_with_issues"].includes(row.stage) && row.workerRunning === false), 120000, "same Native batch completes");
    await shot("mobile-native-results.png");
    assert.equal(await readFile(resolve(source, "settings.json"), "utf8"), sourceSettings);
    for (const item of history) assert.equal(createHash("sha256").update(await readFile(item.file)).digest("hex"), item.sha256);
    assert.equal(await access(marker).then(() => true, () => false), false);
    const body = await screen(); assert.ok(!body.includes(apiKey) && !body.includes(mcpKey));
    await rename(source, resolve(source, "../source-withheld"));
    await page.getByTestId("migration-archive-open").click(); await page.getByRole("button", { name: "History tasks", exact: true }).click();
    await waitFor(async () => await page.locator('[data-testid^="migration-job-"]').count() === 1, 10000, "one authoritative imported history job"); await page.locator('[data-testid^="migration-job-"]').first().click();
    await page.getByTestId("migration-record-0").waitFor({ timeout: 30000 });
    const archived = [...observations].reverse().find(row => row.method === "migration/history/read" && row.normalization);
    assert.equal(archived?.normalization.normalizedRecords, 5000); assert.equal(archived.normalization.normalizationComplete, true);
    assert.equal(await page.locator('[data-testid^="migration-record-"]').count(), 10);
    await page.getByTestId("migration-record-0").click(); await page.getByRole("button", { name: "Read text", exact: true }).first().click();
    await page.getByText("Mobile archive 0", { exact: false }).waitFor(); await shot("mobile-archived-text-without-source.png");
    await page.reload(); await page.getByTestId("migration-workbench").waitFor({ timeout: 30000 });
    await page.getByTestId("migration-tab-records").click(); await page.getByTestId(`migration-batch-record-${jobId}`).click();
    await page.getByTestId("migration-batch-undo").click(); await confirm("UNDO");
    await waitFor(() => observations.some(row => row.method === "migration/batch/read" && row.responseJobId === jobId && row.stage === "rolled_back" && row.workerRunning === false), 30000, "owned batch undo after all historical readers are released");
    assert.deepEqual(JSON.parse(await readFile(resolve(profile, "settings.json"), "utf8")), original);
    await page.getByTestId("migration-tab-plugins").click(); await page.locator('[data-testid^="migration-plugin-record-"]').first().click();
    await waitFor(() => observations.some(row => row.method === "migration/plugin/read" && row.stage === "undone"), 15000, "same plugin undone without source"); await shot("mobile-plugin-undone.png");
    await selectTarget("peer-target"); await page.getByTestId("migration-tab-records").click();
    await waitFor(() => observations.some(row => row.method === "migration/jobs/list" && row.serverId === "peer-target" && Array.isArray(row.jobIds) && row.jobIds.length === 0 && !row.error), 15000, "authoritative empty peer catalog");
    assert.equal(await page.locator('[data-testid^="migration-batch-record-"]').count(), 0);
    await page.getByTestId("migration-tab-recovery").click(); assert.ok(!(await screen()).includes(jobId)); await shot("mobile-target-isolation.png");
    // The short linear fixture exercises H4 independently of the correctly bounded 5000-record archive.
    await rename(resolve(source, "../source-withheld"), source);
    await selectTarget("migration-target"); await page.getByTestId("migration-tab-new").click();
    await page.getByTestId("migration-source-claude-code").click(); await page.getByTestId("migration-discover-history").click();
    const h4Sources = page.getByTestId("migration-history-sources"); await h4Sources.waitFor();
    if (!await h4Sources.getByRole("button", { name: /Mobile H4 continuation$/ }).count()) { await h4Sources.getByRole("button", { name: "Next", exact: true }).click(); await waitFor(async () => await h4Sources.getByRole("button", { name: /Mobile H4 continuation$/ }).count() === 1, 10000, "H4 explicit source page"); }
    await h4Sources.getByRole("button", { name: /Mobile H4 continuation$/ }).click(); await page.getByTestId("migration-scan-selection").click();
    await page.getByTestId("migration-batch-editor").waitFor(); await page.locator('[data-testid^="migration-item-edit-"]').first().click(); await page.getByTestId("migration-item-save").click();
    const beforeH4 = observations.length;
    await page.getByTestId("migration-preview-plan").click(); await page.getByTestId("migration-batch-import").click(); await confirm("IMPORT");
    await waitFor(() => observations.slice(beforeH4).some(row => row.method === "migration/batch/read" && ["completed", "completed_with_issues"].includes(row.stage) && row.workerRunning === false), 30000, "short history batch complete");
    await page.locator('[data-testid^="migration-open-history-"]').first().click(); await page.getByTestId("migration-history-workspace").waitFor();
    await waitFor(() => observations.some(row => row.method === "migration/history/read" && row.normalization?.normalizedRecords === 16), 10000, "authoritative short history read");
    const h4Original = [...observations].reverse().find(row => row.method === "migration/history/read" && row.normalization?.normalizedRecords === 16)?.responseJobId;
    assert.ok(h4Original);
    const legacy = await createLegacyHistoryFixture(context, profile, h4Original);
    const legacyJournalPath = resolve(profile, `migrations/history/${legacy.jobId}.json`);
    let legacyJournalBefore = await readFile(legacyJournalPath), legacyOwnerRecovered = false;
    await rename(source, resolve(source, "../source-withheld"));
    const openArchive = async id => {
      await page.goto(`${gateway.baseUrl}/settings-section?section=migration_results`); await page.getByTestId("migration-workbench").waitFor({ timeout: 30000 });
      await page.getByTestId("migration-archive-open").click(); await page.getByRole("button", { name: "History tasks", exact: true }).click();
      await page.getByTestId(`migration-job-${id}`).click(); await page.getByTestId("migration-history-workspace").waitFor();
    };
    const localConfirm = async (prefix, keyword) => { await page.getByTestId(`${prefix}-input`).fill(keyword); await page.getByTestId(`${prefix}-submit`).click(); };
    await openArchive(legacy.jobId);
    await waitFor(() => observations.some(row => row.method === "migration/history/read" && row.responseJobId === legacy.jobId), 10000, "legacy history observation before explicit recovery");
    const legacyObservation = [...observations].reverse().find(row => row.method === "migration/history/read" && row.responseJobId === legacy.jobId);
    if (legacyObservation.workerState === "unknown" && legacyObservation.workerError === "history_job_execution_untracked") {
      assert.equal(await page.getByTestId("migration-history-run").getAttribute("aria-disabled"), "true");
      if (!["normalized", "failed", "cancelled"].includes(legacyObservation.stage)) { await page.getByTestId("migration-history-cancel").click(); await localConfirm("migration-history-confirm", "CANCEL"); }
      await waitFor(async () => await page.getByTestId("migration-history-resume").getAttribute("aria-disabled") !== "true", 10000, "Native recorded legacy cancellation before ownership recovery");
      await page.getByTestId("migration-history-resume").click(); await localConfirm("migration-history-confirm", "RESUME");
      await waitFor(() => observations.some(row => row.method === "migration/history/read" && row.responseJobId === legacy.jobId && row.workerState === "stopped"), 10000, "explicit legacy ownership recovery receipt");
      legacyOwnerRecovered = true; legacyJournalBefore = await readFile(legacyJournalPath);
    }
    await page.getByTestId("migration-reinterpret-preview").click();
    await page.getByTestId("migration-reinterpret-confirm-input").waitFor();
    await localConfirm("migration-reinterpret-confirm", "REINTERPRET");
    await waitFor(() => observations.some(row => row.method === "migration/history/reinterpret/create" && row.responseJobId), 10000, "explicit new interpretation receipt");
    const reinterpreted = [...observations].reverse().find(row => row.method === "migration/history/reinterpret/create").responseJobId;
    assert.notEqual(reinterpreted, legacy.jobId); await page.getByTestId("migration-history-run").click(); await localConfirm("migration-history-confirm", "RUN");
    await page.getByTestId("migration-history-branch-tab").waitFor({ timeout: 30000 }); await page.getByTestId("migration-history-branch-tab").click();
    await page.getByTestId("migration-branch-choose").click(); await page.getByTestId("migration-branch-prepare").click(); await localConfirm("migration-branch-confirm", "PREPARE");
    await waitFor(async () => await page.getByTestId("migration-branch-run").getAttribute("aria-disabled") !== "true", 10000, "Native selected branch receipt");
    await page.getByTestId("migration-branch-run").click(); await localConfirm("migration-branch-confirm", "RUN");
    await page.getByTestId("migration-branch-record-0").waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-testid^="migration-branch-record-"]').count(), 10);
    const branchRecords = page.getByTestId("migration-branch-records");
    await branchRecords.getByRole("button", { name: "Next", exact: true }).click();
    await waitFor(async () => await page.locator('[data-testid^="migration-branch-record-"]').count() === 6, 10000, "branch second page");
    await branchRecords.getByRole("button", { name: "Previous", exact: true }).click(); await page.getByTestId("migration-branch-record-0").waitFor();
    await page.getByTestId("migration-branch-tools-tab").click(); await page.getByTestId("migration-tools-run").click(); await localConfirm("migration-tools-confirm", "RUN");
    await waitFor(() => observations.some(row => row.method === "migration/history/branch/tools/read" && row.toolsStage === "ready"), 15000, "recorded tool correlation only");
    await page.getByText("Linked", { exact: false }).waitFor(); await page.getByTestId("migration-branch-records-tab").click();
    const saveAttachment = async expected => {
      const pendingDownload = page.waitForEvent("download"); await page.getByTestId("migration-attachment-download").click();
      const download = await pendingDownload, path = context.pathInArtifacts(`verified-${randomUUID()}.bin`); await download.saveAs(path);
      assert.deepEqual(await readFile(path), Buffer.from(expected));
    };
    await page.getByTestId("migration-branch-record-3").click(); await page.getByTestId("migration-branch-attachment-0").click();
    await page.getByTestId("migration-attachment-run").click(); await localConfirm("migration-attachment-confirm", "RUN"); await page.getByTestId("migration-attachment-download").waitFor(); await saveAttachment(embeddedText);
    await page.getByRole("button", { name: "Back to content", exact: true }).click(); await page.getByTestId("migration-branch-attachment-1").click();
    await page.getByTestId("migration-attachment-run").click(); await localConfirm("migration-attachment-confirm", "RUN"); await page.getByTestId("migration-attachment-download").waitFor(); await saveAttachment(png);
    await page.getByRole("button", { name: "Back to content", exact: true }).click(); await page.getByRole("button", { name: "Back to records", exact: true }).click();
    await page.getByTestId("migration-branch-record-2").click(); await page.getByTestId("migration-branch-attachment-0").click();
    await page.getByTestId("migration-attachment-run").click(); await localConfirm("migration-attachment-confirm", "RUN");
    await waitFor(async () => await page.locator('[data-testid^="migration-tool-attachment-"]').count() === 10, 15000, "typed-tool attachment page");
    // Each old embedded attachment needs its own durable receipt before the Native compiler can admit it.
    for (let index = 0; index < 12; index++) {
      if (index === 10) { await page.getByTestId("migration-attachment-workspace").getByRole("button", { name: "Next", exact: true }).click(); await page.getByTestId("migration-tool-attachment-11").waitFor(); assert.equal(await page.locator('[data-testid^="migration-tool-attachment-"]').count(), 2); }
      await page.getByTestId(`migration-tool-attachment-${index}`).click(); await page.getByTestId("migration-attachment-run").click(); await localConfirm("migration-attachment-confirm", "RUN");
      await page.getByTestId("migration-attachment-download").waitFor();
      if (index === 11) await saveAttachment(nestedText + index);
      else await page.getByRole("button", { name: "Back to attachment catalog", exact: true }).click();
    }
    await page.getByRole("button", { name: "Back to content", exact: true }).click(); await page.getByRole("button", { name: "Back to records", exact: true }).click();
    await page.getByTestId("migration-branch-record-4").click(); await page.getByTestId("migration-branch-attachment-0").click();
    await page.getByTestId("migration-attachment-run").click(); await localConfirm("migration-attachment-confirm", "RUN");
    await page.getByTestId("migration-local-new").waitFor(); await page.getByTestId("migration-local-new").click();
    const supplied = Buffer.alloc(400000, "a"), suppliedPath = context.pathInState("selected-user-supplement.txt"); await writeFile(suppliedPath, supplied);
    const chooserEvent = page.waitForEvent("filechooser"); await localConfirm("migration-local-confirm", "UPLOAD"); const chooser = await chooserEvent; await chooser.setFiles(suppliedPath);
    await waitFor(() => observations.some(row => row.method === "migration/history/local-attachment/part" && row.uploadedBytes === supplied.length), 30000, "all three 192KiB parts acknowledged");
    const partCalls = observations.filter(row => row.method === "migration/history/local-attachment/part"); assert.equal(partCalls.length, 3);
    const uploadId = partCalls.at(-1).uploadOperationId; assert.ok(uploadId);
    const preparedIndex = observations.findIndex(row => row.method === "migration/history/local-attachment/prepare" && row.uploadOperationId === uploadId);
    assert.ok(preparedIndex >= 0 && preparedIndex < observations.findIndex(row => row.method === "migration/history/local-attachment/begin"));
    await rename(suppliedPath, context.pathInState("selected-supplement-withheld.txt"));
    await page.getByTestId("migration-local-cancel").click();
    await waitFor(async () => await page.getByTestId("migration-local-resume").getAttribute("aria-disabled") !== "true", 15000, "upload cancellation authority");
    await page.getByTestId("migration-local-resume").click(); await localConfirm("migration-local-confirm", "RESUME");
    await waitFor(async () => await page.getByTestId("migration-local-finish").getAttribute("aria-disabled") !== "true", 15000, "same upload explicitly resumed");
    await page.getByTestId("migration-local-finish").click(); await localConfirm("migration-local-confirm", "FINISH");
    await waitFor(async () => await page.getByTestId("migration-local-run").getAttribute("aria-disabled") !== "true", 15000, "source-free upload authorization");
    await page.getByTestId("migration-local-cancel").click();
    await waitFor(async () => await page.getByTestId("migration-local-resume").getAttribute("aria-disabled") !== "true", 15000, "authorized upload cancellation watermark");
    await page.getByTestId("migration-local-resume").click(); await localConfirm("migration-local-confirm", "RESUME");
    await waitFor(async () => await page.getByTestId("migration-local-run").getAttribute("aria-disabled") !== "true", 15000, "upload resume permits sequence-checked local-copy resume");
    await page.getByTestId("migration-local-run").click(); await localConfirm("migration-local-confirm", "RUN");
    await page.getByTestId("migration-local-bind").waitFor({ timeout: 15000 }); await page.getByTestId("migration-local-bind").click();
    assert.ok((await screen()).includes("Historical content equivalence remains false"));
    const localDownload = page.waitForEvent("download"); await page.getByTestId("migration-local-download").click(); const downloaded = await localDownload;
    const suppliedOutput = context.pathInArtifacts("verified-user-supplement.txt"); await downloaded.saveAs(suppliedOutput); assert.deepEqual(await readFile(suppliedOutput), supplied);
    await shot("mobile-h4-user-supplement-bound.png");
    await page.getByTestId("migration-continuation-prepare").click(); await localConfirm("migration-continuation-create-confirm", "CREATE");
    await waitFor(() => !!lostContinuation, 15000, "lost continuation creation receipt");
    const continuationId = lostContinuation.responseJobId; assert.equal(lostContinuation.localBindings, 1); assert.ok(continuationId);
    const openKnown = async () => {
      await page.goto(`${gateway.baseUrl}/settings-section?section=migration_results`); await page.getByTestId("migration-workbench").waitFor({ timeout: 30000 }); await page.getByTestId("migration-archive-open").click();
      await page.getByRole("button", { name: "Known continuation ID", exact: true }).click(); await page.getByTestId("migration-known-continuation-id").fill(continuationId); await page.getByTestId("migration-known-continuation-read").click();
      await page.getByTestId("migration-continuation-operation").waitFor();
    };
    await openKnown(); assert.equal(observations.filter(row => row.method === "migration/history/continuation/create").length, 1, "reopening never replaces or repeats creation");
    await waitFor(async () => await page.getByTestId("migration-continuation-run").getAttribute("aria-disabled") !== "true", 10000, "original planned continuation readback");
    await page.getByTestId("migration-continuation-run").click(); await localConfirm("migration-continuation-confirm", "RUN");
    await waitFor(() => observations.some(row => row.method === "migration/history/continuation/read" && row.responseJobId === continuationId && row.stage === "imported" && row.workerRunning === false), 30000, "idle continuation publication");
    const published = [...observations].reverse().find(row => row.method === "migration/history/continuation/read" && row.stage === "imported"); assert.ok(published.threadId); assert.equal(published.localBindings, 1);
    await waitFor(async () => await page.getByTestId("migration-continuation-open").getAttribute("aria-disabled") !== "true", 10000, "canonical retirement lookup before navigation");
    // Retire the unopened idle session. A loaded Engine correctly holds a busy lease and must not be forcibly removed.
    await page.getByTestId("migration-undo-preview").click(); await page.getByTestId("migration-undo-create").waitFor(); await page.getByTestId("migration-undo-create").click(); await localConfirm("migration-undo-confirm", "UNDO");
    await waitFor(async () => await page.getByTestId("migration-undo-run").getAttribute("aria-disabled") !== "true", 10000, "canonical retirement prepared");
    await page.getByTestId("migration-undo-run").click(); await localConfirm("migration-undo-confirm", "RUN");
    await waitFor(() => observations.some(row => row.method === "migration/history/undo/read" && row.stage === "undone" && row.workerRunning === false), 15000, "same published continuation retired");
    assert.equal(await page.getByTestId("migration-continuation-open").getAttribute("aria-disabled"), "true"); await shot("mobile-h4-retired-session.png");
    await openKnown(); await waitFor(async () => (await screen()).includes("New session retired"), 10000, "canonical undone state after reopen"); assert.equal(await page.getByTestId("migration-continuation-open").getAttribute("aria-disabled"), "true");
    // A second explicitly chosen option family exercises opening without bypassing the first session's retirement.
    await openArchive(reinterpreted); await page.getByTestId("migration-history-branch-tab").click();
    await page.getByTestId("migration-branch-record-4").click(); await page.getByTestId("migration-branch-attachment-0").click();
    await page.getByTestId(`migration-local-record-${uploadId}`).click(); await page.getByTestId("migration-local-bind").waitFor(); await page.getByTestId("migration-local-bind").click();
    await page.getByTestId("migration-continuation-mode-kworker").click(); await page.getByTestId("migration-continuation-prepare").click(); await localConfirm("migration-continuation-create-confirm", "CREATE");
    await page.getByTestId("migration-continuation-operation").waitFor();
    const secondCreation = [...observations].reverse().find(row => row.method === "migration/history/continuation/create"); assert.ok(secondCreation?.responseJobId); assert.notEqual(secondCreation.responseJobId, continuationId);
    await waitFor(async () => await page.getByTestId("migration-continuation-run").getAttribute("aria-disabled") !== "true", 10000, "second explicit creation readback");
    await page.getByTestId("migration-continuation-run").click(); await localConfirm("migration-continuation-confirm", "RUN");
    await waitFor(() => observations.some(row => row.method === "migration/history/continuation/read" && row.responseJobId === secondCreation.responseJobId && row.stage === "imported" && row.workerRunning === false), 30000, "second option family idle publication");
    const navigated = [...observations].reverse().find(row => row.method === "migration/history/continuation/read" && row.responseJobId === secondCreation.responseJobId && row.stage === "imported");
    await assertLegacyUploadCollectionRetained({context,page,profile,operationId:uploadId,observations});
    await exerciseManagedMobileUploadCollection({context,page,profile,gatewayBaseUrl:gateway.baseUrl,historyJobId:h4Original});
    await waitFor(async () => await page.getByTestId("migration-continuation-open").getAttribute("aria-disabled") !== "true", 10000, "canonical navigation safety check");
    await page.getByTestId("migration-continuation-open").click(); await page.waitForURL(`**/task/migration-target/${navigated.threadId}**`, { timeout: 15000 }); await page.getByTestId("message-input").waitFor({ timeout: 15000 });
    const visibleTask = await screen();
    assert.ok(!visibleTask.includes('"historicalContentVerified"'), "Runtime context is not emitted as user message JSON");
    assert.ok(!visibleTask.includes("[image]"), "a Runtime-origin historical image must not become a user bubble");
    assert.equal(await access(marker).then(() => true, () => false), false);
    assert.deepEqual(await readFile(legacyJournalPath), legacyJournalBefore, "explicit reinterpretation must preserve the legacy journal after any user-confirmed execution-metadata recovery");
    for (const item of history) assert.equal(createHash("sha256").update(await readFile(item.file.replace(source, resolve(source, "../source-withheld")))).digest("hex"), item.sha256);
    await context.writeArtifactJson("mobile-migration-h4.json", { passed: true, platform: "Mobile Web Chromium", h4Original, legacyJobId: legacy.jobId, legacyFixtureKind: "harness-owned legacy-journal clone", legacyOwnerRecovered, legacyJournalUnchangedAfterExplicitOwnerRecovery: true, reinterpreted, continuationId, threadId: published.threadId, navigatedContinuationId: secondCreation.responseJobId, navigatedThreadId: navigated.threadId, uploadedBytes: supplied.length, partCount: partCalls.length, sourceWithheldBeforeBranch: true, selectedFileWithheldBeforeFinish: true, historicalContentVerified: false, explicitBindings: 1, originalAndNestedDownloadsVerified: true, lostCreateReply: true, sameCreationCount: 1, secondExplicitOptionsFamily: true, nativeIdlePublished: true, nativeSessionNavigation: true, runtimeImageHidden: true, canonicalRetirement: "undone", reopenedNavigationDisabled: true, modelRequests: model.requests.length });
    await page.goto(`${gateway.baseUrl}/settings-section?section=migration_results`); await selectTarget("migration-target");
    const lifecycleObserver = await openOwnedMobileRpc(context, gateway, "migration-target", workspace);
    await exerciseMobileHistoryLifecycle({ context, page, observer: lifecycleObserver.rpc, profile, sourceRoot: source, observations });
    await lifecycleObserver.close();
    assert.equal(model.requests.length, 0); assert.deepEqual(errors, []);
    await context.writeArtifactJson("mobile-migration-results.json", { passed: true, platform: "Mobile Web Chromium", binarySha256, jobId, selectedCategories: [...selected], sourcePages, lostRunReply: true, noImplicitReplay: true, explicitCancelResume: true, normalizedRecords: archived.normalization.normalizedRecords, sourceWithheldTextRead: true, originalPluginUndoneAfterSourceWithheld: true, historicalRetirementOutcome: "rolled_back", targetIsolation: true, modelRequests: model.requests.length, observations });
    await verifyMobileWebExportUnchanged(mobile);
  } catch (error) { await shot("failure.png").catch(() => {}); await context.writeArtifactJson("failure.json", { message: String(error), text: (await screen().catch(() => "")).slice(-20000), observations, errors }); throw error; }
});
