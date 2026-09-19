import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function collectHistoryEvidence(projectDir) {
  return collectDirectoryEvidence(projectDir, '.jsonl');
}

export async function collectRequestEvidence(requestsDir) {
  return collectDirectoryEvidence(requestsDir, '.json');
}

export async function waitForHistoryEvidence(projectDir, options) {
  return waitForDirectoryEvidence(projectDir, '.jsonl', options);
}

export async function waitForRequestEvidence(requestsDir, options) {
  return waitForDirectoryEvidence(requestsDir, '.json', options);
}

export async function collectLiveSteerRequestEvidence(requestsDir, secondMessage) {
  const evidence = {
    requestsDir,
    secondMessage,
    matchedFile: null,
    ordered: false,
    assistantBetweenToolResultAndSteer: null,
  };
  let entries;
  try {
    entries = await readdir(requestsDir, { withFileTypes: true });
  } catch (error) {
    evidence.error = error?.message || String(error);
    return evidence;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(requestsDir, entry.name);
    try {
      const record = JSON.parse(await readFile(file, 'utf8'));
      const messages = record?.body?.messages;
      if (!Array.isArray(messages)) continue;
      const toolResultIndex = messages.findIndex((message) =>
        message?.role === 'user' && message.content?.some((block) => block?.type === 'tool_result'),
      );
      const steerIndex = messages.findIndex((message, index) =>
        index > toolResultIndex &&
        message?.role === 'user' &&
        message.content?.some(
          (block) => block?.type === 'text' && String(block.text || '').includes(secondMessage),
        ),
      );
      if (toolResultIndex < 0 || steerIndex < 0) continue;
      const assistantBetween = messages
        .slice(toolResultIndex + 1, steerIndex)
        .some((message) => message?.role === 'assistant');
      evidence.matchedFile = file;
      evidence.toolResultIndex = toolResultIndex;
      evidence.steerIndex = steerIndex;
      evidence.assistantBetweenToolResultAndSteer = assistantBetween;
      evidence.ordered = steerIndex === toolResultIndex + 1 && !assistantBetween;
      return evidence;
    } catch (error) {
      evidence.lastReadError = error?.message || String(error);
    }
  }
  return evidence;
}

export async function waitForSubagentEvidence(projectDir, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let evidence = await collectSubagentEvidence(projectDir);
  while (!evidence.hasAllRequired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence = await collectSubagentEvidence(projectDir);
  }
  return evidence;
}

export async function waitForTargetedSubagentSteerEvidence(
  projectDir,
  { targetAgentId, siblingAgentIds, sentinel, timeoutMs },
) {
  const deadline = Date.now() + timeoutMs;
  let evidence = await collectTargetedSubagentSteerEvidence(projectDir, {
    targetAgentId,
    siblingAgentIds,
    sentinel,
  });
  while (!evidence.hasAllRequired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence = await collectTargetedSubagentSteerEvidence(projectDir, {
      targetAgentId,
      siblingAgentIds,
      sentinel,
    });
  }
  return evidence;
}

export async function waitForTargetedSubagentStopEvidence(
  projectDir,
  { targetAgentId, siblingAgentIds, timeoutMs },
) {
  const deadline = Date.now() + timeoutMs;
  let evidence = await collectTargetedSubagentStopEvidence(projectDir, {
    targetAgentId,
    siblingAgentIds,
  });
  while (!evidence.hasAllRequired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence = await collectTargetedSubagentStopEvidence(projectDir, {
      targetAgentId,
      siblingAgentIds,
    });
  }
  return evidence;
}

export async function waitForOrchestrateControlEvidence(projectDir, sessionId, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let evidence = await collectOrchestrateControlEvidence(projectDir, sessionId);
  while (!evidence.hasAllRequired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence = await collectOrchestrateControlEvidence(projectDir, sessionId);
  }
  return evidence;
}

async function collectOrchestrateControlEvidence(projectDir, sessionId) {
  const sessionDir = path.join(projectDir, sessionId);
  const statePath = path.join(sessionDir, 'state.json');
  const eventPath = path.join(sessionDir, 'runtime-events.jsonl');
  const result = {
    projectDir,
    sessionId,
    statePath,
    eventPath,
    agents: [],
    eventKindCounts: {},
    hasPausedAgent: false,
    hasQueuedDelivery: false,
    hasRequiredEvents: false,
    hasAllRequired: false,
  };

  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const tasks = state?.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : [];
    result.agents = tasks
      .filter((task) => task?.kind === 'subagent')
      .map((task) => {
        const queue = Array.isArray(task.message_queue) ? task.message_queue : [];
        const queueStatusCounts = {};
        for (const message of queue) {
          const status = String(message?.status || 'unknown');
          queueStatusCounts[status] = (queueStatusCounts[status] || 0) + 1;
        }
        return {
          agentId: String(task.id || ''),
          status: String(task.status || ''),
          runMode: String(task.control?.run_mode || ''),
          controlRevision: Number(task.control?.revision || 0),
          queueLength: queue.length,
          queueStatusCounts,
          breakerStage: String(task.breaker?.stage || ''),
        };
      });
    result.hasPausedAgent = result.agents.some(
      (agent) => agent.status === 'paused' && agent.runMode === 'paused' && agent.controlRevision >= 2,
    );
    result.hasQueuedDelivery = result.agents.some(
      (agent) => agent.queueLength >= 1 && Number(agent.queueStatusCounts.queued || 0) >= 1,
    );
  } catch (error) {
    result.stateError = error?.message || String(error);
  }

  try {
    const lines = (await readFile(eventPath, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      const kind = String(event?.kind || 'unknown');
      result.eventKindCounts[kind] = (result.eventKindCounts[kind] || 0) + 1;
    }
    const requiredKinds = ['control_requested', 'control_applied', 'message_queued', 'fleet_injected'];
    result.hasRequiredEvents = requiredKinds.every(
      (kind) => Number(result.eventKindCounts[kind] || 0) >= 1,
    );
  } catch (error) {
    result.eventError = error?.message || String(error);
  }

  result.hasAllRequired =
    result.hasPausedAgent && result.hasQueuedDelivery && result.hasRequiredEvents;
  return result;
}

async function waitForDirectoryEvidence(dir, extension, { mustContain, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let evidence = await collectDirectoryEvidence(dir, extension, mustContain);
  while (!evidence.hasAllRequired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence = await collectDirectoryEvidence(dir, extension, mustContain);
  }
  return evidence;
}

async function collectDirectoryEvidence(dir, extension, mustContain = []) {
  const required = Array.isArray(mustContain) ? mustContain : [];
  const result = {
    dir,
    files: [],
    fileCount: 0,
    hasAllRequired: required.length === 0,
    required,
  };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
  result.fileCount = files.length;
  for (const name of files) {
    const file = path.join(dir, name);
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      result.files.push({
        file,
        bytes: 0,
        readError: error?.message || String(error),
    });
      continue;
    }
    const searchableText = normalizeArtifactTextForSearch(text);
    const contains = Object.fromEntries(
      required.map((needle) => {
        const jsonEscapedNeedle = JSON.stringify(String(needle)).slice(1, -1);
        return [
          needle,
          searchableText.includes(needle) || searchableText.includes(jsonEscapedNeedle),
        ];
      }),
    );
    result.files.push({
      file,
      bytes: Buffer.byteLength(text, 'utf8'),
      contains,
      hasLspDiagnostics: searchableText.includes('<diagnostics source="lsp"'),
      hasPyright: searchableText.includes('server="pyright"'),
      hasReportArgumentType: searchableText.includes('reportArgumentType'),
      hasOcrCommand: searchableText.includes('OpenCodeReview command:'),
      hasOcrPreview: searchableText.includes('ocr review') && searchableText.includes('--preview'),
    });
  }
  result.hasAllRequired =
    required.length === 0 ||
    result.files.some((file) => required.every((needle) => file.contains?.[needle]));
  return result;
}

async function collectSubagentEvidence(projectDir) {
  const result = {
    projectDir,
    agents: [],
    agentCount: 0,
    hasAllRequired: false,
  };
  let sessions;
  try {
    sessions = await readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }

  for (const sessionEntry of sessions.filter((entry) => entry.isDirectory())) {
    const sessionId = sessionEntry.name;
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    let agents;
    try {
      agents = await readdir(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agentEntry of agents.filter((entry) => entry.isDirectory())) {
      const agentId = agentEntry.name;
      const agentDir = path.join(subagentsDir, agentId);
      const transcript = path.join(agentDir, 'transcript.json');
      const output = path.join(agentDir, 'output.md');
      const llmDir = path.join(agentDir, 'llm-requests');
      const evidence = {
        sessionId,
        agentId,
        agentDir,
        transcript,
        output,
        llmDir,
        transcriptExists: existsSync(transcript),
        outputExists: existsSync(output),
        llmRequestFiles: [],
        llmRequestCount: 0,
        transcriptIsArray: false,
        transcriptMessages: 0,
        outputBytes: 0,
        outputHasWorkerSentinel: false,
        llmRecordHasRequest: false,
        llmRecordHasResponse: false,
        llmRecordSessionMatches: false,
      };

      try {
        const transcriptValue = JSON.parse(await readFile(transcript, 'utf8'));
        evidence.transcriptIsArray = Array.isArray(transcriptValue);
        evidence.transcriptMessages = Array.isArray(transcriptValue) ? transcriptValue.length : 0;
      } catch (error) {
        evidence.transcriptError = error?.message || String(error);
      }

      try {
        const outputText = await readFile(output, 'utf8');
        evidence.outputBytes = Buffer.byteLength(outputText, 'utf8');
        evidence.outputHasWorkerSentinel = outputText.includes('tui-lab-subagent-worker-done');
      } catch (error) {
        evidence.outputError = error?.message || String(error);
      }

      try {
        evidence.llmRequestFiles = (await readdir(llmDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => path.join(llmDir, entry.name))
          .sort();
        evidence.llmRequestCount = evidence.llmRequestFiles.length;
        if (evidence.llmRequestFiles.length > 0) {
          const record = JSON.parse(await readFile(evidence.llmRequestFiles[0], 'utf8'));
          evidence.llmRecordHasRequest = Boolean(record.request);
          evidence.llmRecordHasResponse = Boolean(record.response);
          evidence.llmRecordSessionMatches = record.session_id === sessionId;
        }
      } catch (error) {
        evidence.llmRequestError = error?.message || String(error);
      }

      evidence.complete =
        evidence.transcriptExists &&
        evidence.transcriptIsArray &&
        evidence.transcriptMessages > 0 &&
        evidence.outputExists &&
        evidence.outputBytes > 0 &&
        evidence.llmRequestCount > 0 &&
        evidence.llmRecordHasRequest &&
        evidence.llmRecordHasResponse &&
        evidence.llmRecordSessionMatches;
      result.agents.push(evidence);
    }
  }

  result.agentCount = result.agents.length;
  result.hasAllRequired = result.agents.some((agent) => agent.complete);
  return result;
}

async function collectTargetedSubagentSteerEvidence(
  projectDir,
  { targetAgentId, siblingAgentIds, sentinel },
) {
  const result = {
    projectDir,
    targetAgentId,
    siblingAgentIds,
    sentinel,
    sessionId: null,
    targetTranscript: null,
    targetOutput: null,
    targetRequestFiles: [],
    targetTranscriptContainsSentinel: false,
    targetRequestContainsSentinel: false,
    targetOutputHasWorkerSentinel: false,
    parentHistoryFileCount: 0,
    parentHistoryContainsSentinel: false,
    siblingEvidence: [],
    siblingsContainSentinel: false,
    taskStatuses: {},
    allAgentsCompleted: false,
    hasAllRequired: false,
  };
  if (!safeArtifactSegment(targetAgentId) || !siblingAgentIds.every(safeArtifactSegment)) {
    result.error = 'agent ids must be safe artifact path segments';
    return result;
  }

  let sessions;
  try {
    sessions = await readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  const sessionEntry = sessions
    .filter((entry) => entry.isDirectory())
    .find((entry) => existsSync(path.join(projectDir, entry.name, 'subagents', targetAgentId)));
  if (!sessionEntry) return result;

  result.sessionId = sessionEntry.name;
  const sessionDir = path.join(projectDir, sessionEntry.name);
  const targetDir = path.join(sessionDir, 'subagents', targetAgentId);
  result.targetTranscript = path.join(targetDir, 'transcript.json');
  const targetTranscriptText = await readArtifactText(result.targetTranscript, result, 'targetTranscriptError');
  result.targetTranscriptContainsSentinel = artifactContains(targetTranscriptText, sentinel);
  result.targetOutput = path.join(targetDir, 'output.md');
  const targetOutputText = await readArtifactText(result.targetOutput, result, 'targetOutputError');
  result.targetOutputHasWorkerSentinel = targetOutputText.includes('tui-lab-subagent-worker-done');
  const targetRequests = await collectNestedJsonEvidence(path.join(targetDir, 'llm-requests'), sentinel);
  result.targetRequestFiles = targetRequests.files;
  result.targetRequestContainsSentinel = targetRequests.contains;
  if (targetRequests.error) result.targetRequestError = targetRequests.error;

  const parentHistory = await collectDirectoryEvidence(projectDir, '.jsonl', [sentinel]);
  result.parentHistoryFileCount = parentHistory.fileCount;
  result.parentHistoryContainsSentinel = parentHistory.files.some(
    (file) => file.contains?.[sentinel] === true,
  );
  if (parentHistory.error) result.parentHistoryError = parentHistory.error;

  for (const siblingAgentId of siblingAgentIds) {
    const siblingDir = path.join(sessionDir, 'subagents', siblingAgentId);
    const transcript = path.join(siblingDir, 'transcript.json');
    const transcriptText = await readArtifactText(transcript, result, 'siblingTranscriptError');
    const requests = await collectNestedJsonEvidence(path.join(siblingDir, 'llm-requests'), sentinel);
    result.siblingEvidence.push({
      agentId: siblingAgentId,
      transcript,
      requestFiles: requests.files,
      transcriptContainsSentinel: artifactContains(transcriptText, sentinel),
      requestContainsSentinel: requests.contains,
      complete: Boolean(transcriptText) && requests.files.length > 0,
    });
  }
  result.siblingsContainSentinel = result.siblingEvidence.some(
    (evidence) => evidence.transcriptContainsSentinel || evidence.requestContainsSentinel,
  );
  try {
    const state = JSON.parse(await readFile(path.join(sessionDir, 'state.json'), 'utf8'));
    for (const agentId of [targetAgentId, ...siblingAgentIds]) {
      result.taskStatuses[agentId] = String(state?.tasks?.[agentId]?.status || 'missing');
    }
    result.allAgentsCompleted = Object.values(result.taskStatuses).every(
      (status) => status === 'completed',
    );
  } catch (error) {
    result.stateError = error?.message || String(error);
  }
  result.hasAllRequired =
    result.targetTranscriptContainsSentinel &&
    result.targetRequestContainsSentinel &&
    result.targetOutputHasWorkerSentinel &&
    result.parentHistoryFileCount > 0 &&
    !result.parentHistoryContainsSentinel &&
    result.siblingEvidence.length === siblingAgentIds.length &&
    result.siblingEvidence.every((evidence) => evidence.complete) &&
    !result.siblingsContainSentinel &&
    result.allAgentsCompleted;
  return result;
}

async function collectTargetedSubagentStopEvidence(
  projectDir,
  { targetAgentId, siblingAgentIds },
) {
  const result = {
    projectDir,
    targetAgentId,
    siblingAgentIds,
    sessionId: null,
    targetStatus: 'missing',
    siblingStatuses: {},
    targetCancelled: false,
    siblingsCompleted: false,
    hasAllRequired: false,
  };
  if (!safeArtifactSegment(targetAgentId) || !siblingAgentIds.every(safeArtifactSegment)) {
    result.error = 'agent ids must be safe artifact path segments';
    return result;
  }

  let sessions;
  try {
    sessions = await readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  const sessionEntry = sessions
    .filter((entry) => entry.isDirectory())
    .find((entry) => existsSync(path.join(projectDir, entry.name, 'subagents', targetAgentId)));
  if (!sessionEntry) return result;

  result.sessionId = sessionEntry.name;
  try {
    const state = JSON.parse(
      await readFile(path.join(projectDir, sessionEntry.name, 'state.json'), 'utf8'),
    );
    result.targetStatus = String(state?.tasks?.[targetAgentId]?.status || 'missing');
    for (const siblingAgentId of siblingAgentIds) {
      result.siblingStatuses[siblingAgentId] = String(
        state?.tasks?.[siblingAgentId]?.status || 'missing',
      );
    }
    result.targetCancelled = result.targetStatus === 'cancelled';
    result.siblingsCompleted =
      siblingAgentIds.length > 0 &&
      Object.values(result.siblingStatuses).every((status) => status === 'completed');
    result.hasAllRequired = result.targetCancelled && result.siblingsCompleted;
  } catch (error) {
    result.stateError = error?.message || String(error);
  }
  return result;
}

function safeArtifactSegment(value) {
  return typeof value === 'string' && value.length > 0 && path.basename(value) === value && !value.includes('..');
}

async function readArtifactText(file, result, errorKey) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    result[errorKey] = error?.message || String(error);
    return '';
  }
}

async function collectNestedJsonEvidence(dir, sentinel) {
  const result = { files: [], contains: false };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))) {
    const file = path.join(dir, entry.name);
    result.files.push(file);
    const text = await readArtifactText(file, result, 'readError');
    result.contains ||= artifactContains(text, sentinel);
  }
  result.files.sort();
  return result;
}

function artifactContains(text, needle) {
  if (!text) return false;
  const searchableText = normalizeArtifactTextForSearch(text);
  const jsonEscapedNeedle = JSON.stringify(String(needle)).slice(1, -1);
  return searchableText.includes(needle) || searchableText.includes(jsonEscapedNeedle);
}

export function normalizeArtifactTextForSearch(text) {
  return String(text)
    .replaceAll('\\"', '"')
    .replaceAll('\\n', '\n')
    .replaceAll('&quot;', '"');
}
