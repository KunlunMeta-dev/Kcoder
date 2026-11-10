import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { constants as fsConstants } from "node:fs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function procStartTicks(statText) {
  const close = statText.lastIndexOf(")");
  assert.ok(close > 0, "invalid process stat record");
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  assert.ok(/^\d+$/.test(fields[19] ?? ""), "process start ticks unavailable");
  return fields[19];
}

export async function currentProcessFence() {
  const pid = process.pid;
  const [statText, cmdline, exePath] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/cmdline`),
    realpath(`/proc/${pid}/exe`),
  ]);
  return { pid, startTicks: procStartTicks(statText), exePath, argvSha256: digest(cmdline) };
}

export async function inspectProcessFence(fence) {
  assert.deepEqual(Object.keys(fence).sort(), ["argvSha256", "exePath", "pid", "startTicks"]);
  assert.ok(Number.isSafeInteger(fence.pid) && fence.pid > 1);
  assert.match(fence.startTicks, /^\d+$/);
  assert.ok(fence.exePath.startsWith("/"));
  assert.match(fence.argvSha256, /^[a-f0-9]{64}$/);
  let statText;
  try {
    statText = await readFile(`/proc/${fence.pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "dead";
    throw error;
  }
  if (procStartTicks(statText) !== fence.startTicks) return "pid-reused";
  const [exePath, cmdline] = await Promise.all([
    realpath(`/proc/${fence.pid}/exe`),
    readFile(`/proc/${fence.pid}/cmdline`),
  ]);
  return exePath === fence.exePath && digest(cmdline) === fence.argvSha256 ? "alive" : "identity-mismatch";
}

export async function writeDurableRecoveryIntent(context, intent) {
  const path = await context.writeArtifactJsonInternal("production-caddy-443-recovery-intent.json", intent);
  const directory = await open(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return path;
}

export async function readPrivateRunJson(path, maxBytes = 16 * 1024) {
  assert.equal(await realpath(path), path);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o600);
  assert.ok(info.size <= maxBytes);
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    assert.equal(opened.ino, info.ino);
    assert.equal(opened.dev, info.dev);
    const bytes = await file.readFile();
    assert.ok(bytes.length <= maxBytes);
    return JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
}

export async function readOptionalPrivateRunJson(path, maxBytes) {
  try { return await readPrivateRunJson(path, maxBytes); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function writePrivateRecoveryAck(path, value) {
  assert.equal(await realpath(dirname(path)), dirname(path));
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeFixtureJson(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

function validateRecoveryRequired(runRoot, intent, recoveryRequired) {
  assert.deepEqual(Object.keys(recoveryRequired).sort(), ["candidateConfigSha256", "exactRecoveryCommand",
    "forwardAndRelayRetained", "originalConfigSha256", "runId", "runRoot", "state"].sort());
  assert.equal(recoveryRequired.state, "RECOVERY_REQUIRED");
  assert.equal(recoveryRequired.runRoot, runRoot);
  assert.equal(recoveryRequired.runId, intent.runId);
  assert.equal(recoveryRequired.originalConfigSha256, intent.transaction.originalConfigSha256);
  assert.equal(recoveryRequired.candidateConfigSha256, intent.transaction.candidateConfigSha256);
  assert.equal(recoveryRequired.exactRecoveryCommand, intent.exactRecoveryCommand);
  assert.equal(recoveryRequired.forwardAndRelayRetained, true);
}

export function validateProductionRecoveryPlan({ runRoot, manifest, recoveryRequired, transaction, intent,
  ownerState, source, testId, expectedPin, expectedExecutable, expectedRecoveryCommand }) {
  assert.equal(manifest.source, source);
  assert.equal(manifest.testId, testId);
  assert.ok(["running", "cleaning", "failed"].includes(manifest.status));
  assert.ok(["alive", "dead"].includes(ownerState), "owner must be exactly alive or absent");
  assert.deepEqual(Object.keys(intent).sort(), ["exactRecoveryCommand", "ownerFence", "runId", "runRoot", "state", "transaction", "version"].sort());
  assert.equal(intent.version, 1);
  assert.equal(intent.state, "READY_FOR_APPLY");
  assert.equal(intent.runRoot, runRoot);
  assert.match(intent.runId, /^[a-f0-9]{24}$/);
  assert.deepEqual(Object.keys(intent.ownerFence).sort(), ["argvSha256", "exePath", "pid", "startTicks"]);
  assert.ok(Number.isSafeInteger(intent.ownerFence.pid) && intent.ownerFence.pid > 1);
  assert.match(intent.ownerFence.startTicks, /^\d+$/);
  assert.equal(intent.ownerFence.exePath, expectedExecutable);
  assert.match(intent.ownerFence.argvSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(transaction).sort(), ["backupLeaf", "candidateConfigSha256", "configPath", "mode",
    "originalConfigSha256", "pin", "routeSnippetSha256", "runId", "selectedGatewayFingerprint", "version"].sort());
  assert.deepEqual(intent.transaction, transaction);
  assert.equal(transaction.version, 1);
  assert.equal(transaction.mode, "production-caddy-443-selected-gateway-route");
  assert.equal(transaction.runId, intent.runId);
  assert.equal(transaction.configPath, expectedPin.configPath);
  assert.deepEqual(transaction.pin, expectedPin);
  assert.equal(transaction.originalConfigSha256, expectedPin.configSha256);
  assert.match(transaction.candidateConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(transaction.backupLeaf, ".Caddyfile.kcux-" + intent.runId + ".backup");
  assert.match(transaction.routeSnippetSha256, /^[a-f0-9]{64}$/);
  assert.match(transaction.selectedGatewayFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(intent.exactRecoveryCommand, expectedRecoveryCommand);
  if (recoveryRequired) validateRecoveryRequired(runRoot, intent, recoveryRequired);
  if (ownerState === "alive") {
    assert.equal(manifest.status, "failed");
    assert.ok(recoveryRequired, "live owner recovery requires its failure receipt and acknowledgment path");
  } else {
    assert.ok(["running", "cleaning", "failed"].includes(manifest.status));
  }
  return { runId: intent.runId, candidateConfigSha256: transaction.candidateConfigSha256, ownerState };
}


export function productionAtomicFsCoreSource() {
  return [
    "def _read_owned_file(path,uid,gid,mode,max_bytes=1048576):",
    " st=os.lstat(path); assert stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode)",
    " assert (st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_nlink)==(uid,gid,mode,1) and st.st_size<=max_bytes",
    " fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
    " try:",
    "  opened=os.fstat(fd); assert (opened.st_dev,opened.st_ino)==(st.st_dev,st.st_ino)",
    "  chunks=[]; total=0",
    "  while True:",
    "   chunk=os.read(fd,min(65536,max_bytes+1-total))",
    "   if not chunk: break",
    "   chunks.append(chunk); total+=len(chunk); assert total<=max_bytes",
    "  return b''.join(chunks),opened",
    " finally: os.close(fd)",
    "def _write_owned_exclusive(dirfd,leaf,data,uid,gid,mode,fail_after=None):",
    " fd=os.open(leaf,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode,dir_fd=dirfd)",
    " opened=None",
    " try:",
    "  opened=os.fstat(fd)",
    "  os.fchown(fd,uid,gid); os.fchmod(fd,mode); view=memoryview(data); written=0",
    "  while view:",
    "   if fail_after is not None and written>=fail_after: raise OSError('injected owned write failure')",
    "   chunk=view if fail_after is None else view[:max(1,min(len(view),fail_after-written))]",
    "   n=os.write(fd,chunk); assert n>0; view=view[n:]; written+=n",
    "  if fail_after is not None and written>=fail_after: raise OSError('injected owned write failure')",
    "  os.fsync(fd); st=os.fstat(fd)",
    "  assert stat.S_ISREG(st.st_mode) and (st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_nlink)==(uid,gid,mode,1)",
    " except BaseException:",
    "  try:",
    "   assert opened is not None",
    "   current=os.stat(leaf,dir_fd=dirfd,follow_symlinks=False)",
    "   assert (current.st_dev,current.st_ino)==(opened.st_dev,opened.st_ino)",
    "   assert stat.S_ISREG(current.st_mode) and (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode),current.st_nlink)==(uid,gid,mode,1)",
    "   os.unlink(leaf,dir_fd=dirfd); os.fsync(dirfd)",
    "  except FileNotFoundError: pass",
    "  except Exception as cleanup_error: raise RuntimeError('owned partial file cleanup failed') from cleanup_error",
    "  raise",
    " finally: os.close(fd)",
    "def _atomic_replace(dirfd,stage_leaf,destination_leaf,uid=None,gid=None,mode=None):",
    " st=os.stat(stage_leaf,dir_fd=dirfd,follow_symlinks=False); assert stat.S_ISREG(st.st_mode) and st.st_nlink==1",
    " if uid is not None: assert (st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))==(uid,gid,mode)",
    " os.replace(stage_leaf,destination_leaf,src_dir_fd=dirfd,dst_dir_fd=dirfd); os.fsync(dirfd)",
    "def _stat_key(st): return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)",
    "def _assert_config_unchanged(raw,st,expected_sha,expected_stat):",
    " assert hashlib.sha256(raw).hexdigest()==expected_sha and _stat_key(st)==_stat_key(expected_stat)",
    "def _commit_staged_config(dirfd,directory,stage_leaf,destination_leaf,stage_sha,current_sha,current_stat,uid,gid,mode,final_guard=None):",
    " staged,stage_stat=_read_owned_file(os.path.join(directory,stage_leaf),uid,gid,mode); assert hashlib.sha256(staged).hexdigest()==stage_sha",
    " current,current_meta=final_guard() if final_guard else _read_owned_file(os.path.join(directory,destination_leaf),uid,gid,mode)",
    " _assert_config_unchanged(current,current_meta,current_sha,current_stat); _atomic_replace(dirfd,stage_leaf,destination_leaf,uid,gid,mode)",
    "def _restore_owned_config(config_path,backup_path,stage_leaf,candidate_sha,original_sha,uid,gid,mode,final_guard=None):",
    " directory=os.path.dirname(config_path); leaf=os.path.basename(config_path)",
    " assert os.path.realpath(directory)==directory and os.path.realpath(config_path)==config_path",
    " dirst=os.lstat(directory); assert stat.S_ISDIR(dirst.st_mode) and not stat.S_ISLNK(dirst.st_mode)",
    " dirfd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try:",
    "  current,current_stat=_read_owned_file(config_path,uid,gid,mode)",
    "  current_sha=hashlib.sha256(current).hexdigest(); assert current_sha in (candidate_sha,original_sha)",
    "  if current_sha==candidate_sha:",
    "   original,backup_stat=_read_owned_file(backup_path,uid,gid,0o600)",
    "   assert hashlib.sha256(original).hexdigest()==original_sha",
    "   if not os.path.lexists(os.path.join(directory,stage_leaf)): _write_owned_exclusive(dirfd,stage_leaf,original,uid,gid,mode)",
    "   _commit_staged_config(dirfd,directory,stage_leaf,leaf,original_sha,candidate_sha,current_stat,uid,gid,mode,final_guard)",
    "  restored,restored_stat=_read_owned_file(config_path,uid,gid,mode)",
    "  assert hashlib.sha256(restored).hexdigest()==original_sha",
    "  return restored_stat",
    " finally: os.close(dirfd)",
  ].join("\n");
}

export function productionCandidateStageSource() {
  return [
    "def _prepare_candidate_files(directory,dirfd,backup_leaf,stage_leaf,original,candidate,original_sha,candidate_sha,uid,gid,fail_leaf=None):",
    " assert not os.path.lexists(os.path.join(directory,backup_leaf)) and not os.path.lexists(os.path.join(directory,stage_leaf))",
    " _write_owned_exclusive(dirfd,backup_leaf,original,uid,gid,0o600,3 if fail_leaf==backup_leaf else None); os.fsync(dirfd)",
    " backup,_=_read_owned_file(os.path.join(directory,backup_leaf),uid,gid,0o600)",
    " assert hashlib.sha256(backup).hexdigest()==original_sha",
    " _write_owned_exclusive(dirfd,stage_leaf,candidate,uid,gid,0o644,4 if fail_leaf==stage_leaf else None); os.fsync(dirfd)",
    " staged,_=_read_owned_file(os.path.join(directory,stage_leaf),uid,gid,0o644)",
    " assert hashlib.sha256(staged).hexdigest()==candidate_sha",
  ].join("\n");
}
