import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeArtifactTextForSearch } from './evidence.mjs';
import { platformShell } from './platform-adapter.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeJsonArtifact(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
  await chmod(file, 0o644);
}

export function makeSessionMemoryCompactRecentPayload(recentMarker) {
  const chunk = `${recentMarker} recent tail payload keeps enough tokens after compact. `;
  return chunk.repeat(2);
}

export async function writeSessionMemoryCompactSettings(artifacts, configHome) {
  const configDir = path.join(configHome, 'kcoder');
  await mkdir(configDir, { recursive: true, mode: 0o755 });
  await writeJsonArtifact(path.join(configDir, 'settings.json'), {
    memory_directory: path.join(artifacts.dir, 'memory'),
    session_memory: {
      enabled: true,
      update_enabled: false,
      compact_enabled: true,
      update_interval_turns: 1,
      init_min_tokens: 10000,
      update_min_token_delta: 5000,
      tool_call_threshold: 3,
      max_update_messages: 80,
      update_max_tokens: 12000,
      compact_min_chars: 20,
      compact_min_recent_tokens: 1,
      compact_max_recent_tokens: 220,
      compact_min_recent_messages: 4,
    },
  });
}

export async function countRequestFiles(requestsDir) {
  try {
    const entries = await readdir(requestsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export function extractTuiSessionId(text) {
  const match = String(text).match(/Session:\s+([0-9A-Za-z-]+)/);
  if (!match) {
    throw new Error('could not find TUI session id in welcome screen');
  }
  return match[1];
}

export async function waitForProjectDirForSession(configDir, sessionId, timeoutMs) {
  const projectsRoot = path.join(configDir, 'projects');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(projectsRoot, entry.name);
        if (existsSync(path.join(projectDir, `${sessionId}.jsonl`))) return projectDir;
      }
    } catch {
      // The projects directory can appear just after the first history flush.
    }
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`timed out locating project transcript for session ${sessionId} below ${projectsRoot}`);
}

export async function waitForStableRequestCount(requestsDir, settleMs = 900, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let previous = await countRequestFiles(requestsDir);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = await countRequestFiles(requestsDir);
    if (current === previous) {
      if (Date.now() - stableSince >= settleMs) {
        return current;
      }
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
  return previous;
}

export async function waitForRequestCountAtLeast(requestsDir, minCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = await countRequestFiles(requestsDir);
  while (current < minCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    current = await countRequestFiles(requestsDir);
  }
  if (current < minCount) {
    throw new Error(`timed out waiting for ${minCount} request files; saw ${current}`);
  }
  return current;
}

export function inspectWindowsUserOnlyAcl(filePath) {
  if (process.platform !== 'win32') {
    return { applicable: false, userOnly: false };
  }
  const shell = platformShell(process.platform, process.env);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:KCODER_TUI_LAB_ACL_PATH
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allow = @($acl.Access | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })
$foreign = @($allow | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $me.Value })
if (-not $acl.AreAccessRulesProtected -or $allow.Count -eq 0 -or $foreign.Count -gt 0) { exit 9 }
`;
  const inspected = spawnSync(shell.file, [...shell.commandArgs, script], {
    encoding: 'utf8',
    env: { ...process.env, KCODER_TUI_LAB_ACL_PATH: filePath },
    windowsHide: true,
  });
  return {
    applicable: true,
    userOnly: inspected.status === 0,
    exitCode: inspected.status,
    error: inspected.error?.message || inspected.stderr?.trim() || undefined,
  };
}

export function secureWindowsUserOnlyAcl(filePath, directory) {
  if (process.platform !== 'win32') return;
  const shell = platformShell(process.platform, process.env);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:KCODER_TUI_LAB_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = if ($env:KCODER_TUI_LAB_ACL_IS_DIR -eq '1') {
  [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [Security.AccessControl.InheritanceFlags]::None
}
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $me,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
  const secured = spawnSync(shell.file, [...shell.commandArgs, script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KCODER_TUI_LAB_ACL_PATH: filePath,
      KCODER_TUI_LAB_ACL_IS_DIR: directory ? '1' : '0',
    },
    windowsHide: true,
  });
  if (secured.status !== 0) {
    throw new Error(
      `failed to secure Windows TUI fixture ${filePath}: ${secured.stderr?.trim() || secured.error?.message || `exit ${secured.status}`}`,
    );
  }
}

export async function collectSessionMemoryCompactStateEvidence({
  projectDir,
  transcriptPath,
  sessionStatePath,
  summaryPath,
  oldMarker,
  recentMarker,
  memorySentinel,
}) {
  const result = {
    projectDir,
    transcriptPath,
    sessionStatePath,
    summaryPath,
    transcriptExists: false,
    sessionStateExists: false,
    summaryExists: false,
    hasLegacyHistoryStateFile: false,
    stateHasCompactedMessages: false,
    hasCompactBoundary: false,
    compactBoundaryHasUuid: false,
    compactBoundaryHasPreservedSegment: false,
    hasCompactSummaryRecord: false,
    hasClaudeContinuationSummary: false,
    hasSessionMemoryCompact: false,
    hasMemorySentinel: false,
    hasRecentMarker: false,
    hasOldRawMarker: false,
    boundaryPreservedSegmentRefsTranscriptUuids: false,
    reconstructedResumeHasSummaryFirst: false,
    reconstructedResumeKeepsRecentTail: false,
    reconstructedResumeDropsOldRawMarker: false,
    transcriptLineCount: 0,
  };
  try {
    const transcript = await readFile(transcriptPath, 'utf8');
    result.transcriptExists = true;
    const lines = transcript.split(/\n/).filter((line) => line.trim().length > 0);
    result.transcriptLineCount = lines.length;
    const parsedLines = [];
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      parsedLines.push(parsed);
      const text = normalizeArtifactTextForSearch(JSON.stringify(parsed));
      if (parsed.subtype === 'compact_boundary') {
        result.hasCompactBoundary = true;
        result.compactBoundaryHasUuid ||= typeof parsed.uuid === 'string' && parsed.uuid.length > 0;
        const preserved = parsed.compactMetadata?.preservedSegment;
        result.compactBoundaryHasPreservedSegment ||= Boolean(
          preserved?.headUuid && preserved?.anchorUuid && preserved?.tailUuid,
        );
      }
      if (parsed.isCompactSummary === true) {
        result.hasCompactSummaryRecord = true;
        result.hasClaudeContinuationSummary ||= text.includes('This session is being continued');
        result.hasSessionMemoryCompact ||= text.includes('Session memory compact');
        result.hasMemorySentinel ||= text.includes(memorySentinel);
        result.hasRecentMarker ||= text.includes(recentMarker);
        result.hasOldRawMarker ||= text.includes(oldMarker);
      }
    }
    const reconstructed = reconstructModelVisibleFromCompactTranscript(parsedLines);
    const reconstructedText = normalizeArtifactTextForSearch(JSON.stringify(reconstructed));
    result.reconstructedResumeHasSummaryFirst = reconstructed.length > 0 && reconstructed[0]?.isCompactSummary === true;
    result.reconstructedResumeKeepsRecentTail = reconstructedText.includes(recentMarker);
    result.reconstructedResumeDropsOldRawMarker = !reconstructedText.includes(oldMarker);
    result.boundaryPreservedSegmentRefsTranscriptUuids = compactBoundaryRefsRealTranscriptUuids(parsedLines);
  } catch (error) {
    result.transcriptError = error?.message || String(error);
  }

  try {
    const stateRaw = await readFile(sessionStatePath, 'utf8');
    result.sessionStateExists = true;
    const parsed = JSON.parse(stateRaw);
    result.stateHasCompactedMessages = Array.isArray(parsed.compacted_messages);
  } catch (error) {
    result.sessionStateError = error?.code === 'ENOENT' ? null : error?.message || String(error);
  }

  try {
    const summaryRaw = await readFile(summaryPath, 'utf8');
    const summaryStat = await stat(summaryPath);
    result.summaryExists = true;
    result.summaryMode = (summaryStat.mode & 0o777).toString(8).padStart(3, '0');
    result.summaryPosixModeApplicable = process.platform !== 'win32';
    if (process.platform === 'win32') {
      result.summaryWindowsAcl = inspectWindowsUserOnlyAcl(summaryPath);
      result.summaryPermissionsPrivate = result.summaryWindowsAcl.userOnly;
    } else {
      result.summaryPermissionsPrivate = result.summaryMode === '600';
    }
    const summaryText = normalizeArtifactTextForSearch(summaryRaw);
    result.summaryHasMemorySentinel = summaryText.includes(memorySentinel);
    result.summaryUsesClaudeHeadings =
      summaryText.includes('# Current State') && !summaryText.includes('## Current State');
    result.summaryKeepsClaudeItalicDescriptions =
      summaryText.includes(
        '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
      ) && summaryText.includes('_Step by step, what was attempted, done? Very terse summary for each step_');
  } catch (error) {
    result.summaryError = error?.message || String(error);
  }

  try {
    const projectEntries = await readdir(projectDir, { withFileTypes: true });
    result.hasLegacyHistoryStateFile = projectEntries.some(
      (entry) => entry.isFile() && entry.name.endsWith('.state.json'),
    );
  } catch {
    // The transcript read above already captures the useful failure mode.
  }

  return result;
}

export function compactBoundaryRefsRealTranscriptUuids(parsedLines) {
  const uuidSet = new Set(
    parsedLines
      .filter((line) => line?.role === 'user' || line?.role === 'assistant')
      .map((line) => line.uuid)
      .filter(Boolean),
  );
  return parsedLines.some((line) => {
    if (line?.subtype !== 'compact_boundary') {
      return false;
    }
    const preserved = line.compactMetadata?.preservedSegment;
    return Boolean(
      preserved?.headUuid && preserved?.tailUuid && uuidSet.has(preserved.headUuid) && uuidSet.has(preserved.tailUuid),
    );
  });
}

export function reconstructModelVisibleFromCompactTranscript(parsedLines) {
  let entries = [];
  let pendingPreserved = null;
  for (const line of parsedLines) {
    if (line?.type === 'system' || line?.subtype === 'compact_boundary') {
      if (line?.subtype === 'compact_boundary') {
        pendingPreserved = preservedEntriesForBoundary(entries, line);
        entries = [];
      }
      continue;
    }
    if (line?.isCompactSummary === true) {
      entries.push(line);
      if (pendingPreserved) {
        entries.push(...pendingPreserved);
        pendingPreserved = null;
      }
      continue;
    }
    if (line?.role === 'user' || line?.role === 'assistant') {
      entries.push(line);
    }
  }
  return entries;
}

export function preservedEntriesForBoundary(entries, boundary) {
  const preserved = boundary.compactMetadata?.preservedSegment;
  if (!preserved?.headUuid || !preserved?.tailUuid) {
    return [];
  }
  const start = entries.findIndex((entry) => entry.uuid === preserved.headUuid);
  const end = entries.findIndex((entry) => entry.uuid === preserved.tailUuid);
  if (start < 0 || end < start) {
    return [];
  }
  return entries.slice(start, end + 1);
}

export async function collectSessionMemoryCompactRequestEvidence({
  requestsDir,
  llmHistoryDir,
  transcriptPath,
  oldMarker,
  recentMarker,
  memorySentinel,
  probeMarker,
}) {
  const result = {
    requestsDir,
    llmHistoryDir,
    requestFiles: [],
    fileCount: 0,
    postCompactProbeFile: null,
    hasPostCompactProbeRequest: false,
    probeHasClaudeContinuationSummary: false,
    probeHasSessionMemoryCompact: false,
    probeHasTranscriptPath: false,
    probeHasMemorySentinel: false,
    probeHasRecentMarker: false,
    probeHasOldRawMarker: false,
    llmHistoryFiles: [],
    llmHistoryFileCount: 0,
    llmHistoryExists: false,
    llmHistoryKeepsAtMostThirty: false,
    llmHistoryPostCompactProbeFile: null,
    llmHistoryHasExchangeSchema: false,
    llmHistoryProbeHasRequest: false,
    llmHistoryProbeHasResponseEvents: false,
    llmHistoryProbeHasFinalResponse: false,
    llmHistoryProbeHasError: false,
  };
  let entries = [];
  try {
    entries = await readdir(requestsDir, { withFileTypes: true });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(requestsDir, entry.name))
    .sort();
  result.requestFiles = files;
  result.fileCount = files.length;
  for (const file of files) {
    let text = '';
    try {
      text = normalizeArtifactTextForSearch(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!text.includes(probeMarker)) {
      continue;
    }
    result.postCompactProbeFile = file;
    result.hasPostCompactProbeRequest = true;
    result.probeHasClaudeContinuationSummary = text.includes('This session is being continued');
    result.probeHasSessionMemoryCompact = text.includes('Session memory compact');
    const jsonEscapedTranscriptPath = JSON.stringify(transcriptPath).slice(1, -1);
    result.probeHasTranscriptPath = text.includes(transcriptPath) || text.includes(jsonEscapedTranscriptPath);
    result.probeHasMemorySentinel = text.includes(memorySentinel);
    result.probeHasRecentMarker = text.includes(recentMarker);
    result.probeHasOldRawMarker = text.includes(oldMarker);
  }
  let llmEntries = [];
  try {
    llmEntries = await readdir(llmHistoryDir, { withFileTypes: true });
    result.llmHistoryExists = true;
  } catch (error) {
    result.llmHistoryError = error?.message || String(error);
    return result;
  }
  const llmFiles = llmEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(llmHistoryDir, entry.name))
    .sort();
  result.llmHistoryFiles = llmFiles;
  result.llmHistoryFileCount = llmFiles.length;
  result.llmHistoryKeepsAtMostThirty = llmFiles.length <= 30;
  for (const file of llmFiles) {
    let text = '';
    let parsed = null;
    try {
      const raw = await readFile(file, 'utf8');
      text = normalizeArtifactTextForSearch(raw);
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    result.llmHistoryHasExchangeSchema ||=
      parsed?.schema === 'kcoder.llm_exchange.v1' || parsed?.schema === 'kcoder.llm_exchange.v2';
    if (!text.includes(probeMarker)) {
      continue;
    }
    result.llmHistoryPostCompactProbeFile = file;
    result.llmHistoryProbeHasRequest ||= text.includes(probeMarker);
    result.llmHistoryProbeHasResponseEvents ||=
      Array.isArray(parsed?.response?.events) && parsed.response.events.length > 0;
    result.llmHistoryProbeHasFinalResponse ||= text.includes('tui-lab-final-sentinel');
    result.llmHistoryProbeHasError ||= typeof parsed?.response?.error === 'string';
  }
  return result;
}

export function runSessionMemoryCompactAssertions({
  text,
  afterCompactText,
  stateEvidence,
  requestEvidence,
  requestCountBeforeCompact,
  requestCountAfterCompact,
}) {
  const checks = [];
  const add = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });
  add('ui-reports-compact-completed', afterCompactText.includes('Context compaction completed'));
  add('compact-did-not-call-summary-provider', requestCountAfterCompact === requestCountBeforeCompact, {
    requestCountBeforeCompact,
    requestCountAfterCompact,
  });
  add('transcript-jsonl-created', stateEvidence.transcriptExists, {
    transcriptPath: stateEvidence.transcriptPath,
  });
  add('transcript-has-compact-boundary', stateEvidence.hasCompactBoundary);
  add('transcript-boundary-has-uuid', stateEvidence.compactBoundaryHasUuid);
  add('transcript-boundary-has-preserved-segment', stateEvidence.compactBoundaryHasPreservedSegment);
  add(
    'transcript-boundary-preserved-segment-refs-real-uuids',
    stateEvidence.boundaryPreservedSegmentRefsTranscriptUuids,
  );
  add('resume-reconstruction-has-summary-first', stateEvidence.reconstructedResumeHasSummaryFirst);
  add('resume-reconstruction-keeps-recent-tail', stateEvidence.reconstructedResumeKeepsRecentTail);
  add('resume-reconstruction-drops-old-raw-marker', stateEvidence.reconstructedResumeDropsOldRawMarker);
  add('transcript-has-compact-summary-record', stateEvidence.hasCompactSummaryRecord);
  add('transcript-summary-uses-claude-continuation', stateEvidence.hasClaudeContinuationSummary);
  add('transcript-summary-is-session-memory-compact', stateEvidence.hasSessionMemoryCompact);
  add('session-memory-summary-file-created', stateEvidence.summaryExists, {
    summaryPath: stateEvidence.summaryPath,
  });
  add('session-memory-summary-file-is-private', stateEvidence.summaryPermissionsPrivate, {
    summaryMode: stateEvidence.summaryMode,
    summaryPosixModeApplicable: stateEvidence.summaryPosixModeApplicable,
    summaryWindowsAcl: stateEvidence.summaryWindowsAcl,
  });
  add('session-memory-summary-uses-claude-headings', stateEvidence.summaryUsesClaudeHeadings);
  add('session-memory-summary-keeps-claude-italic-descriptions', stateEvidence.summaryKeepsClaudeItalicDescriptions);
  add('state-sidecar-has-no-compacted-messages', !stateEvidence.stateHasCompactedMessages, {
    sessionStatePath: stateEvidence.sessionStatePath,
  });
  add('no-legacy-history-state-file', !stateEvidence.hasLegacyHistoryStateFile);
  add('transcript-keeps-memory-sentinel', stateEvidence.hasMemorySentinel);
  add('transcript-summary-drops-old-raw-marker', !stateEvidence.hasOldRawMarker);
  add('post-compact-request-captured', requestEvidence.hasPostCompactProbeRequest, {
    postCompactProbeFile: requestEvidence.postCompactProbeFile,
  });
  add('post-compact-request-uses-claude-continuation', requestEvidence.probeHasClaudeContinuationSummary);
  add('post-compact-request-uses-session-memory', requestEvidence.probeHasSessionMemoryCompact);
  add('post-compact-request-includes-transcript-path', requestEvidence.probeHasTranscriptPath);
  add('post-compact-request-keeps-memory-sentinel', requestEvidence.probeHasMemorySentinel);
  add('post-compact-request-keeps-recent-tail', requestEvidence.probeHasRecentMarker);
  add('post-compact-request-drops-old-raw-marker', !requestEvidence.probeHasOldRawMarker);
  add('session-llm-history-dir-created', requestEvidence.llmHistoryExists, {
    llmHistoryDir: requestEvidence.llmHistoryDir,
    llmHistoryError: requestEvidence.llmHistoryError,
  });
  add('session-llm-history-keeps-at-most-30', requestEvidence.llmHistoryKeepsAtMostThirty, {
    llmHistoryFileCount: requestEvidence.llmHistoryFileCount,
  });
  add('session-llm-history-uses-exchange-schema', requestEvidence.llmHistoryHasExchangeSchema);
  add('session-llm-history-captures-post-compact-request', requestEvidence.llmHistoryProbeHasRequest, {
    llmHistoryPostCompactProbeFile: requestEvidence.llmHistoryPostCompactProbeFile,
  });
  add(
    'session-llm-history-captures-post-compact-response',
    requestEvidence.llmHistoryProbeHasResponseEvents && requestEvidence.llmHistoryProbeHasFinalResponse,
  );
  add('session-llm-history-post-compact-has-no-error', !requestEvidence.llmHistoryProbeHasError);
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    stateEvidence,
    requestEvidence,
  };
}
