import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { makeMcpSyncScript, mergeSyncCheckpoint } from '../transport/mcp.mjs';

export async function atomicSyncJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export async function acquireSyncLock(path, owner) {
  const file = await open(path, 'wx', 0o600).catch(e => { if (e.code === 'EEXIST') throw new Error(`Another sync owns ${path}. Check its owner before removing a stale lock.`); throw e; });
  await file.writeFile(JSON.stringify(owner)); await file.close();
  return async () => {
    const current = JSON.parse(await readFile(path));
    if (current.jobId !== owner.jobId) throw new Error('Sync lock ownership changed');
    await unlink(path);
  };
}

export function decodeSyncResult(result) {
  if (result?.isError || result?.structuredContent?.error) {
    const error = new Error(result.structuredContent?.error?.message || result.content?.find(c => c.type === 'text')?.text || 'Figma tool failed');
    error.canvasRolledBack = result.structuredContent?.safeToRetryWithoutCanvasRead === true;
    throw error;
  }
  if (result?.structuredContent) return result.structuredContent;
  for (const c of result?.content || []) if (c.type === 'text') { try { return JSON.parse(c.text); } catch {} }
  throw new Error('Figma did not return a structured receipt');
}

/** Plan bounded requests deterministically; a too-large single state stops before writes. */
export async function planSyncBatches(bundle, { mode = 'apply' } = {}) {
  const batches = []; let current = [];
  for (const s of bundle.states) {
    if (mode === 'apply' && current.length >= 2) { batches.push(current); current = []; }
    try { await makeMcpSyncScript(bundle, { stateIds: [...current, s.id], mode }); current.push(s.id); }
    catch (error) {
      if (!/MCP script has/.test(error.message) || !current.length) throw error;
      batches.push(current); current = [s.id]; await makeMcpSyncScript(bundle, { stateIds: current, mode });
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** All policy/state belongs here; transports only move existing MCP requests. */
export async function synchronizeFigma({ bundle, call, sessionId, checkpointPath, journalPath, checkOnly = false, journal, onProgress = () => {}, makeScript = makeMcpSyncScript, planBatches = planSyncBatches }) {
  let checkpointText = await readFile(checkpointPath, 'utf8'), checkpoint = JSON.parse(checkpointText);
  if (checkpoint.fileKey !== bundle.checkpoint.fileKey || checkpoint.rootNodeId !== bundle.checkpoint.rootNodeId) throw new Error('Checkpoint/file mismatch');
  const job = journal || { schema: 1, jobId: randomUUID(), fileKey: checkpoint.fileKey, rootNodeId: checkpoint.rootNodeId, createdAt: new Date().toISOString(), completed: [], events: [] };
  const bundleDigest = createHash('sha256').update(JSON.stringify(bundle.states)).digest('hex');
  if (job.bundleDigest && job.bundleDigest !== bundleDigest) throw new Error('Resume requires the original frozen scene bundle');
  job.bundleDigest = bundleDigest;
  if (job.fileKey !== checkpoint.fileKey || job.rootNodeId !== checkpoint.rootNodeId) throw new Error('Resume journal belongs to another REF region');
  const save = () => atomicSyncJson(journalPath, job);
  job.status ||= 'preflighting'; await save();
  const receiptCheckpoint = job.pendingReceipt ? mergeSyncCheckpoint(checkpoint, job.pendingReceipt.checkpointDelta) : checkpoint;
  bundle = { ...bundle, checkpoint: receiptCheckpoint };
  const previews = [], previewBatches = await planBatches(bundle, {mode:'preview'});
  const invoke = async (ids, mode) => decodeSyncResult(await call('use_figma', { fileKey: checkpoint.fileKey, sessionId,
    skillNames: 'figma-use,figma-generate-design', description: `KCoder deterministic ${mode}: ${ids.join(', ')}`,
    code: await makeScript(bundle, { stateIds: ids, mode }) }));
  // Read every affected frame before the first mutation; never skip a prior
  // unknown write. A successful preview reconciles its baseline without replay.
  for (const ids of previewBatches) {
    const plan = await invoke(ids, 'preview'); previews.push(plan);
    if (plan.conflicts?.length) { job.status = 'conflict'; job.conflicts = plan.conflicts; await save(); throw new Error(`Figma conflict: ${JSON.stringify(plan.conflicts)}. No conflicting content was overwritten.`); }
    onProgress({ phase: 'preview', states: ids });
  }
  if (await readFile(checkpointPath, 'utf8') !== checkpointText) throw new Error('Checkpoint changed during preflight');
  job.preflight = { states: bundle.states.length, changes: previews.flatMap(p => p.entries).filter(e => e.action === 'update').length };
  if (checkOnly) { job.status = 'checked'; await save(); return { job, checkpoint }; }
  if (job.pendingReceipt) {
    checkpoint = receiptCheckpoint; await atomicSyncJson(checkpointPath, checkpoint); checkpointText = await readFile(checkpointPath, 'utf8');
    job.completed.push(...job.pendingReceipt.ids.filter(id => !job.completed.includes(id))); delete job.pendingReceipt;
  }
  delete job.inFlight; delete job.conflicts;
  for (const entry of previews.flatMap(p=>p.entries)) if (entry.action === 'unchanged' && !job.completed.includes(entry.stateId)) job.completed.push(entry.stateId);
  await save();
  const changedIds = new Set(previews.flatMap(p=>p.entries).filter(e=>e.action==='update').map(e=>e.stateId));
  const batches = await planBatches({...bundle,states:bundle.states.filter(s=>changedIds.has(s.id))}, {mode:'apply'});
  for (const ids of batches) {
    if (ids.every(id => job.completed.includes(id))) continue;
    if (await readFile(checkpointPath, 'utf8') !== checkpointText) throw new Error('Checkpoint changed before write');
    job.inFlight = { ids, startedAt: new Date().toISOString() }; job.status = 'applying'; await save();
    let result;
    try { result = await invoke(ids, 'apply'); }
    catch (error) { job.status = error.canvasRolledBack ? 'failed-no-write' : 'unknown'; job.error = error.message; await save(); throw error; }
    if (!['updated', 'unchanged'].includes(result.status)) { job.status = 'conflict'; job.conflicts = result.plan?.conflicts; await save(); throw new Error('Figma refused the update'); }
    // Persist the authoritative receipt before touching the shared checkpoint.
    job.pendingReceipt = { ids, checkpointDelta: result.checkpointDelta }; await save();
    if (await readFile(checkpointPath, 'utf8') !== checkpointText) throw new Error('Checkpoint changed after Figma applied; saved receipt requires reconciliation');
    checkpoint = mergeSyncCheckpoint(checkpoint, result.checkpointDelta);
    await atomicSyncJson(checkpointPath, checkpoint); checkpointText = await readFile(checkpointPath, 'utf8'); bundle.checkpoint = checkpoint;
    job.completed.push(...ids.filter(id => !job.completed.includes(id)));
    job.events.push({ ids, status: result.status, absentControls: result.skippedAbsent || [], disabledControls: result.skippedDisabled || [], createdCount: result.createdNodeIds?.length || 0 });
    delete job.pendingReceipt; delete job.inFlight; await save(); onProgress({ phase: 'apply', states: ids, done: job.completed.length, total: bundle.states.length });
  }
  job.status = 'complete'; job.finishedAt = new Date().toISOString(); delete job.error; await save();
  return { job, checkpoint };
}
