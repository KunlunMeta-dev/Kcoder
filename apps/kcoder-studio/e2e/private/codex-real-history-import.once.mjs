import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { startApprovalModelFixture } from '../harness/approval-model.mjs'
import { startChromium } from '../harness/chromium.mjs'
import { startGateway, waitForGatewayRpcToken } from '../harness/gateway.mjs'
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../harness/rpc.mjs'
import { assertRendererBuildFresh } from '../harness/renderer-build.mjs'
import { repoRoot, runE2E, waitFor } from '../harness/run-context.mjs'

const gate = 'KCODER_E2E_CODEX_REAL_IMPORT'
const sourceListEnv = 'KCODER_E2E_CODEX_REAL_SOURCES_FILE'
const maxSourceBytes = 2 * 1024 * 1024
const sessionRoot = '/home/hyf/.codex/sessions'
const codePattern = /^(?:migration|history|external_history)_[a-z0-9_]+$/
process.umask(0o077)

function check(condition, code = 'probe_invariant_failed') {
  if (!condition) throw new Error(`PROBE:${code}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeFailure(error) {
  const message = error instanceof Error ? error.message : ''
  if (/^PROBE:[A-Za-z0-9_]+$/.test(message)) return message
  if (codePattern.test(message)) return message
  return 'PROBE:UNCLASSIFIED_FAILURE'
}

async function checkedBytes(path, { maxBytes, privateFile = false } = {}) {
  const before = await lstat(path, { bigint: true })
  check(before.isFile() && !before.isSymbolicLink(), 'source_not_regular_file')
  check(before.nlink === 1n && before.uid === BigInt(process.getuid()), 'source_identity_rejected')
  if (privateFile) check((before.mode & 0o077n) === 0n, 'source_manifest_permissions_rejected')
  check(before.size <= BigInt(maxBytes), 'source_size_rejected')
  const noFollow = fsConstants.O_NOFOLLOW
  check(Number.isInteger(noFollow), 'nofollow_unavailable')
  const file = await open(path, fsConstants.O_RDONLY | noFollow)
  try {
    const opened = await file.stat({ bigint: true })
    check(opened.isFile() && opened.nlink === 1n && opened.uid === BigInt(process.getuid()), 'source_identity_rejected')
    check(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'source_changed_during_open')
    const bytes = await file.readFile()
    check(BigInt(bytes.byteLength) === opened.size && bytes.byteLength <= maxBytes, 'source_size_changed')
    return bytes
  } finally {
    await file.close()
  }
}

async function readSourceList() {
  const listPath = process.env[sourceListEnv]
  check(typeof listPath === 'string' && isAbsolute(listPath), 'source_list_required')
  const listBytes = await checkedBytes(resolve(listPath), { maxBytes: 8192, privateFile: true })
  let entries
  try { entries = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(listBytes)) }
  catch { throw new Error('PROBE:source_list_invalid') }
  check(Array.isArray(entries) && entries.length === 2, 'exactly_two_sources_required')
  const refs = []
  for (const value of entries) {
    check(typeof value === 'string' && isAbsolute(value), 'source_path_invalid')
    const path = resolve(value)
    const rel = relative(sessionRoot, path)
    check(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'source_outside_codex_sessions')
    check(path.endsWith('.jsonl'), 'source_not_jsonl')
    check(await realpath(path) === path, 'source_path_identity_rejected')
    const bytes = await checkedBytes(path, { maxBytes: maxSourceBytes })
    refs.push({ path, relative: rel, bytes, sha256: sha256(bytes), oracle: sourceOracle(bytes) })
  }
  check(new Set(refs.map(item => item.sha256)).size === 2, 'duplicate_source_content')
  return refs
}

function sourceOracle(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('PROBE:source_not_utf8') }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  check(lines.length > 0, 'source_has_no_records')
  const byRecord = new Map(), messageRecords = new Map()
  let sessionId, sourceVersion
  const counts = { userMessages: 0, assistantMessages: 0, reasoningSegments: 0, functionCalls: 0, customToolCalls: 0, functionOutputs: 0, customToolOutputs: 0, supportedToolCalls: 0, supportedToolResults: 0 }
  const add = (record, item) => {
    const values = byRecord.get(record) ?? []
    values.push(item)
    byRecord.set(record, values)
  }
  for (let record = 0; record < lines.length; record++) {
    const line = lines[record].endsWith('\r') ? lines[record].slice(0, -1) : lines[record]
    check(line.length > 0, 'source_contains_empty_record')
    let row
    try { row = JSON.parse(line) } catch { throw new Error('PROBE:source_jsonl_invalid') }
    if (row?.type === 'session_meta') { sessionId ??= row.payload?.id; sourceVersion ??= row.payload?.cli_version }
    if (row?.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') continue
    const payload = row.payload
    if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      counts[payload.role === 'user' ? 'userMessages' : 'assistantMessages']++
      messageRecords.set(record, payload.role)
      for (const part of Array.isArray(payload.content) ? payload.content : []) {
        if (['input_text', 'output_text', 'text'].includes(part?.type) && Object.hasOwn(part, 'text')) {
          add(record, { kind: 'text', role: payload.role, hash: typeof part.text === 'string' ? sha256(Buffer.from(part.text, 'utf8')) : null })
        }
      }
    } else if (payload.type === 'reasoning') {
      for (const group of ['summary', 'content']) for (const part of Array.isArray(payload[group]) ? payload[group] : []) {
        if (Object.hasOwn(part ?? {}, 'text')) {
          counts.reasoningSegments++
          add(record, { kind: 'thinking', role: 'assistant', hash: typeof part.text === 'string' ? sha256(Buffer.from(part.text, 'utf8')) : null })
        }
      }
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      counts[payload.type === 'function_call' ? 'functionCalls' : 'customToolCalls']++
      const input = payload.type === 'function_call' ? payload.arguments : payload.input
      if (input !== undefined && input !== null) {
        counts.supportedToolCalls++
        add(record, { kind: 'tool_call', sourceType: payload.type, role: 'assistant', callId: payload.call_id, name: payload.name,
          structured: typeof input !== 'string', hash: sha256(Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8')) })
      }
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      counts[payload.type === 'function_call_output' ? 'functionOutputs' : 'customToolOutputs']++
      if (payload.output !== undefined && payload.output !== null) {
        counts.supportedToolResults++
        add(record, { kind: 'tool_result', role: 'tool', callId: payload.call_id, structured: typeof payload.output !== 'string',
          hash: sha256(Buffer.from(typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output), 'utf8')) })
      }
    }
  }
  check(counts.userMessages > 0 && counts.assistantMessages > 0, 'source_requires_user_and_assistant_messages')
  return { recordCount: lines.length, byRecord, messageRecords, counts, sessionId, sourceVersion }
}

async function copySources(context, sources) {
  const codexHome = context.pathInState('sources/codex')
  const sessions = resolve(codexHome, 'sessions')
  await mkdir(sessions, { recursive: true, mode: 0o700 })
  await chmod(codexHome, 0o700)
  await chmod(sessions, 0o700)
  for (const source of sources) {
    const destination = resolve(sessions, source.relative)
    const rel = relative(sessions, destination)
    check(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'copy_path_escape')
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await chmod(dirname(destination), 0o700)
    const file = await open(destination, 'wx', 0o600)
    try { await file.writeFile(source.bytes); await file.sync() }
    finally { await file.close() }
    await chmod(destination, 0o600)
  }
  return { codexHome, sessions }
}

async function readAllBodies(rpc, jobId, oracle) {
  const rows = []
  const diagnosticCodes = new Set()
  const pageCursors = new Set()
  let recordPages = 0
  const next = (seen, value) => {
    if (value === undefined || value === null) return undefined
    const key = JSON.stringify(value)
    check(!seen.has(key), 'repeated_page_cursor')
    seen.add(key)
    return value
  }
  let cursor
  let sourceSessionId
  do {
    check(++recordPages <= oracle.recordCount + 1, 'record_page_count_exceeded')
    const params = { jobId, ...(cursor === undefined ? {} : { cursor }) }
    const page = await rpc.request('migration/history/transcript', params)
    check(page.normalizationComplete === true, 'transcript_not_normalized')
    check(page.totalRecords === oracle.recordCount && Array.isArray(page.items), 'transcript_total_missing')
    if (sourceSessionId === undefined) sourceSessionId = page.sourceSessionId
    rows.push(...page.items)
    check(rows.length <= oracle.recordCount, 'transcript_page_bound_exceeded')
    cursor = next(pageCursors, page.nextCursor)
  } while (cursor !== undefined)
  check(rows.length === oracle.recordCount, 'transcript_record_count_mismatch')
  check(sourceSessionId === oracle.sessionId, 'source_session_identity_mismatch')
  check(rows.every((row, index) => row.record === index), 'transcript_physical_order_mismatch')
  const imported = new Map()
  let readBodies = 0
  for (const row of rows) {
    for (const diagnostic of row.diagnostics ?? []) {
      if (/^[a-z][a-z0-9_]+$/.test(diagnostic.code)) diagnosticCodes.add(diagnostic.code)
    }
    const blocks = []
    const blockCursors = new Set()
    let blockCursor
    let blockPages = 0
    do {
      check(++blockPages <= row.totalBlocks + 1, 'block_page_count_exceeded')
      const params = { jobId, record: row.record, ...(blockCursor === undefined ? {} : { cursor: blockCursor }) }
      const page = await rpc.request('migration/history/blocks', params)
      check(page.record === row.record && Array.isArray(page.blocks), 'transcript_block_page_invalid')
      blocks.push(...page.blocks)
      check(blocks.length <= row.totalBlocks, 'transcript_block_bound_exceeded')
      blockCursor = next(blockCursors, page.nextCursor)
    } while (blockCursor !== undefined)
    check(blocks.length === row.totalBlocks, 'transcript_block_count_mismatch')
    const bodyItems = []
    for (const block of blocks) {
      if (!block.bodyAvailable) continue
      let text = ''
      let textCursor
      const textCursors = new Set()
      let textPages = 0
      do {
        check(++textPages <= 4096, 'text_page_count_exceeded')
        const params = { jobId, record: row.record, blockIndex: block.index, ...(textCursor === undefined ? {} : { cursor: textCursor }) }
        const chunk = await rpc.request('migration/history/text', params)
        check(typeof chunk.text === 'string', 'transcript_text_chunk_invalid')
        text += chunk.text
        check(Buffer.byteLength(text) <= maxSourceBytes * 2, 'transcript_text_bound_exceeded')
        textCursor = next(textCursors, chunk.nextCursor)
      } while (textCursor !== undefined)
      let structuredHash = null
      try { structuredHash = sha256(Buffer.from(JSON.stringify(JSON.parse(text)), 'utf8')) } catch { /* Plain strings stay plain. */ }
      const body = { kind: block.kind, role: row.role ?? null, sourceType: block.sourceType ?? undefined,
        callId: block.callId, name: block.name, outcome: block.outcome, structuredHash, hash: sha256(Buffer.from(text, 'utf8')) }
      bodyItems.push(body)
      readBodies++
    }
    imported.set(row.record, { row, blocks, bodies: bodyItems })
  }
  let comparedBodies = 0
  for (const [record, expected] of oracle.byRecord) {
    const actual = imported.get(record)
    check(Boolean(actual), 'source_record_not_read')
    check(actual.bodies.length === expected.length, 'source_body_segment_count_mismatch')
    for (let index = 0; index < expected.length; index++) {
      const wanted = expected[index], received = actual.bodies[index]
      check(received.kind === wanted.kind && received.role === wanted.role, 'source_body_order_or_role_mismatch')
      if (wanted.sourceType) check(received.sourceType === wanted.sourceType, 'source_tool_type_mismatch')
      if (wanted.callId) check(received.callId === wanted.callId, 'source_tool_call_id_mismatch')
      if (wanted.name) check(received.name === wanted.name, 'source_tool_name_mismatch')
      if (wanted.kind === 'tool_result') check(received.outcome === 'recorded_result', 'historical_result_authority_changed')
      check(wanted.hash !== null && (wanted.structured ? received.structuredHash : received.hash) === wanted.hash, 'source_body_hash_mismatch')
      comparedBodies++
    }
    const sourceCalls = expected.filter(item => item.kind === 'tool_call').length
    const sourceResults = expected.filter(item => item.kind === 'tool_result').length
    check(actual.blocks.filter(item => item.kind === 'tool_call').length === sourceCalls, 'source_tool_call_count_mismatch')
    check(actual.blocks.filter(item => item.kind === 'tool_result').length === sourceResults, 'source_tool_result_count_mismatch')
  }
  const importedCounts = {
    userMessages: [...oracle.messageRecords].filter(([record, role]) => role === 'user' && rows[record]?.kind === 'message' && rows[record]?.role === role).length,
    assistantMessages: [...oracle.messageRecords].filter(([record, role]) => role === 'assistant' && rows[record]?.kind === 'message' && rows[record]?.role === role).length,
    functionCalls: [...imported.values()].flatMap(value => value.blocks).filter(block => block.kind === 'tool_call' && block.sourceType === 'function_call').length,
    customToolCalls: [...imported.values()].flatMap(value => value.blocks).filter(block => block.kind === 'tool_call' && block.sourceType === 'custom_tool_call').length,
    toolResults: [...imported.values()].flatMap(value => value.blocks).filter(block => block.kind === 'tool_result').length,
  }
  check(importedCounts.userMessages === oracle.counts.userMessages && importedCounts.assistantMessages === oracle.counts.assistantMessages, 'source_message_count_mismatch')
  check(importedCounts.functionCalls + importedCounts.customToolCalls === oracle.counts.supportedToolCalls, 'source_tool_call_total_mismatch')
  check(importedCounts.toolResults === oracle.counts.supportedToolResults, 'source_tool_result_total_mismatch')
  return {
    recordCount: rows.length,
    readBodies,
    comparedBodies,
    matchedBodies: comparedBodies,
    diagnosticCodes: [...diagnosticCodes].sort(),
    importedCounts,
  }
}

async function openHistory(page, gateway) {
  await page.goto(`${gateway.baseUrl}/settings/general`)
  await page.getByTestId('general-external-content-import-button').click()
  await page.getByTestId('migration-dialog').waitFor()
  await page.getByRole('button', { name: '历史档案', exact: true }).click()
  const history = page.getByTestId('migration-history')
  await history.locator('#migration-history-source').selectOption('codex')
  await history.getByRole('button', { name: '查找历史会话', exact: true }).click()
  await waitFor(async () => await history.locator('[data-testid^="migration-history-create-"]').count() === 2, 15_000, 'two Codex history candidates')
  return history
}

async function attemptBranchPrepare(rpc, jobId, available, transcript) {
  if (!available) return { attempted: false, status: 'capability_unavailable' }
  const current = transcript.getByRole('button', { name: '当前分支', exact: true })
  await waitFor(() => current.isEnabled(), 15_000, 'branch control enabled')
  await current.click()
  const controls = transcript.getByTestId('migration-branch-controls')
  await controls.getByRole('button', { name: '准备分支视图', exact: true }).click()
  const result = await waitFor(async () => {
    const value = await rpc.request('migration/history/branch/read', { jobId })
    return value.progress && ['ready', 'failed', 'cancelled'].includes(value.progress.stage) && !value.workerRunning ? value : null
  }, 60_000, 'branch reconstruction settled')
  const progress = result.progress
  const continuationVisible = await transcript.getByTestId('migration-continuation').count() > 0
  if (progress.structuralComplete === false) check(!continuationVisible, 'incomplete_branch_offers_continuation')
  return { attempted: true, status: progress.stage, structuralComplete: progress.structuralComplete,
    issues: progress.issues.filter(code => /^[a-z][a-z0-9_]+$/.test(code)),
    failureCode: codePattern.test(progress.failureCode ?? '') ? progress.failureCode : null,
    continuationVisible }
}

async function run(context) {
  let sources = []
  let phase = 'source_selection'
  try {
    sources = await readSourceList()
    const copied = await copySources(context, sources)
    const binary = process.env.KCODER_E2E_KCODER_BIN
    const renderer = process.env.KCODER_E2E_RENDERER_ROOT
    check(typeof binary === 'string' && isAbsolute(binary), 'explicit_binary_required')
    check(typeof renderer === 'string' && isAbsolute(renderer), 'explicit_renderer_root_required')
    const binaryHash = sha256(await readFile(binary))
    await assertRendererBuildFresh({ buildRoot: renderer })
    const workspace = context.pathInState('workspace')
    const profile = context.pathInState('target')
    const home = context.pathInState('home')
    const xdg = context.pathInState('xdg-config')
    const claudeHome = context.pathInState('empty-claude-home')
    for (const directory of [workspace, home, xdg, claudeHome]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
    }
    const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] })
    await context.writeStateJson('target/settings.json', {
      credential_store: 'file', active_provider: 'fixture', providers: {
        fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true, discover_models: false },
      },
    })
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    const launcher = context.pathInState('codex-history-launcher')
    const config = `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport HOME=${quote(home)}\nexport XDG_CONFIG_HOME=${quote(xdg)}\nexport CLAUDE_CONFIG_DIR=${quote(claudeHome)}\nexport CODEX_HOME=${quote(copied.codexHome)}\nexec ${quote(binary)} "$@"\n`
    const launcherFile = await open(launcher, 'wx', 0o700)
    try { await launcherFile.writeFile(config); await launcherFile.sync() }
    finally { await launcherFile.close() }
    const serversFile = await context.writeStateJson('servers.json', [{ id: 'probe-target', label: 'Codex history probe', transport: 'local', command: launcher, workspace }])
    const gateway = await startGateway(context, {
      workspace, serversFile, kcoderBin: binary, auth: true,
      env: { HOME: home, XDG_CONFIG_HOME: xdg, KCODER_CONFIG_DIR: profile, CODEX_HOME: copied.codexHome },
    })
    phase = 'browser_login'
    const browser = await startChromium(context)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
    context.addCleanup('close private history page', () => page.close())
    let externalRequestsBlocked = 0
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === gateway.baseUrl) return route.continue()
      externalRequestsBlocked++
      return route.abort()
    })
    await page.goto(`${gateway.baseUrl}/login?${new URLSearchParams({ token: gateway.authToken, returnTo: '/settings/general' })}`)
    await waitFor(() => !new URL(page.url()).pathname.startsWith('/login'), 15_000, 'owned browser login')
    const cookies = await page.context().cookies(gateway.baseUrl)
    for (const cookie of cookies) context.registerSecret(cookie.value)
    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    check(cookieHeader.length > 0, 'owned_browser_login_cookie_missing')
    const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie: cookieHeader } })
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'probe-target', token), { headers: { Cookie: cookieHeader, Origin: gateway.baseUrl } })
    context.addCleanup('close Codex history observer RPC', () => closeRpcAndWait(rpc))
    const initialized = await initializeRpc(rpc, 'codex-real-history-import')
    const caps = initialized.capabilities?.experimental ?? {}
    check(caps.migrationHistoryJobsV1 === true && caps.migrationHistoryReadV1 === true, 'history_capability_missing')
    const branchAvailable = caps.migrationHistoryBranchesV1 === true
    const imports = []
    for (let index = 0; index < 2; index++) {
      phase = `sample_${index + 1}_archive_ui`
      const history = await openHistory(page, gateway)
      const candidates = history.locator('[data-testid^="migration-history-create-"]')
      check(await candidates.count() === 2, 'candidate_count_changed')
      await candidates.nth(index).click()
      let jobId
      await waitFor(async () => {
        const text = await history.getByText(/^归档作业：/).textContent().catch(() => '')
        jobId = text.match(/[a-f0-9-]{36}/)?.[0]
        if (!jobId) return false
        const value = await rpc.request('migration/history/read', { jobId })
        return value.job?.stage === 'normalized' && value.workerRunning === false
      }, 120_000, 'Codex archive normalization')
      check(typeof jobId === 'string', 'archive_job_id_missing')
      const state = await rpc.request('migration/history/read', { jobId })
      check(state.job?.stage === 'normalized' && state.job.archived === true && state.workerRunning === false, 'archive_not_normalized')
      check(typeof state.job.archiveId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(state.job.archiveId), 'archive_id_missing')
      const sourceBytes = await readFile(resolve(profile, 'external-history', state.job.archiveId, 'source.bin'))
      const archiveHash = sha256(sourceBytes)
      const source = sources.find(item => item.sha256 === archiveHash)
      check(Boolean(source), 'archive_raw_hash_not_from_selected_sources')
      check(imports.every(item => item.sourceSha256 !== source.sha256), 'same_source_imported_twice')
      check(sourceBytes.byteLength === source.bytes.byteLength, 'archive_source_size_mismatch')
      const transcript = await history.getByTestId('migration-transcript')
      await transcript.getByTestId('historical-record').first().waitFor()
      phase = `sample_${index + 1}_text_readback`
      const readback = await readAllBodies(rpc, jobId, source.oracle)
      if (source.oracle.sourceVersion !== '0.163.0')
        check(readback.diagnosticCodes.includes('unsupported_codex_source_version'), 'unsupported_source_version_not_reported')
      phase = `sample_${index + 1}_branch_ui`
      const branch = await attemptBranchPrepare(rpc, jobId, branchAvailable, transcript)
      if (source.oracle.sourceVersion !== '0.163.0') check(branch.structuralComplete !== true && !branch.continuationVisible, 'unsupported_source_continuation_accepted')
      imports.push({
        sourceSha256: source.sha256, sourceBytes: source.bytes.byteLength,
        archiveSha256: archiveHash, archiveBytes: sourceBytes.byteLength,
        stage: state.job.stage, workerRunning: state.workerRunning,
        sourceRecords: source.oracle.recordCount,
        normalizedRecords: state.job.normalization?.normalizedRecords ?? null,
        sourceCounts: source.oracle.counts, importedCounts: readback.importedCounts,
        readBodies: readback.readBodies, comparedBodies: readback.comparedBodies, matchedBodies: readback.matchedBodies,
        sourceVersion: source.oracle.sourceVersion, diagnosticCodes: readback.diagnosticCodes,
        branch,
      })
      check(model.requests.length === 0, 'unexpected_model_request')
      if (index === 0) await page.goto(`${gateway.baseUrl}/settings/general`)
    }
    for (const source of sources) {
      const after = await checkedBytes(source.path, { maxBytes: maxSourceBytes })
      check(sha256(after) === source.sha256, 'original_source_hash_changed')
    }
    check(model.requests.length === 0, 'unexpected_model_request')
    await context.writeArtifactJson('codex-real-history-import.json', {
      sourceCount: sources.length,
      sources: sources.map(item => ({ bytes: item.bytes.byteLength, sha256: item.sha256, records: item.oracle.recordCount, counts: item.oracle.counts, originalUnchanged: true })),
      imports, rendererBuildRootProvided: true, binarySha256: binaryHash,
      modelRequests: model.requests.length, externalRequestsBlocked, authOrSourceSettingsCopied: false,
      copiedOnlySelectedJsonl: true, cleanupOwnsRunState: true,
    })
    return { imports: imports.length, sourceRecords: imports.reduce((sum, item) => sum + item.sourceRecords, 0), modelRequests: model.requests.length }
  } catch (error) {
    await context.writeArtifactJson('failure-phase.json', { phase, error: safeFailure(error) })
    throw new Error(safeFailure(error))
  }
}

check(process.env[gate] === '1', 'explicit_gate_required')
check(typeof process.env[sourceListEnv] === 'string', 'source_list_required')
check(typeof process.env.KCODER_E2E_KCODER_BIN === 'string', 'explicit_binary_required')
check(typeof process.env.KCODER_E2E_RENDERER_ROOT === 'string', 'explicit_renderer_root_required')
await runE2E(import.meta.url, {
  testId: 'private-codex-real-history-import-once', tier: 'manual-live',
  modelPolicy: 'two authorized read-only Codex archives; no model turn or continuation generation',
}, run)
