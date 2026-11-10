/** Capture only an owned process's existing redacted stderr channel, with bounded memory. */
export function captureOwnedRedactedStderr(context, label, {
  maxBytes = 256 * 1024, artifactName = `${label}-redacted-stderr.json`,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("redacted stderr capture capacity must be between 1 and 1048576 bytes");
  }
  if (typeof artifactName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(artifactName)) {
    throw new Error("redacted stderr capture requires an owned JSON artifact name");
  }
  const buffer = Buffer.alloc(maxBytes);
  let retainedBytes = 0, receivedBytes = 0, overflow = false, ended = false, finalized = false;
  let source = null;
  const reasons = new Set();
  try {
    const record = context.processes.get(label);
    if (record?.label === label && record.redactors?.[1] !== record.redactors?.[0]) source = record.redactors?.[1];
  } catch {
    reasons.add("owned-stderr-redactor-access-failed");
  }
  const available = source && typeof source.on === "function" && typeof source.off === "function";
  if (!available) reasons.add("owned-stderr-redactor-unavailable");
  if (available && (source.readableEnded || source.destroyed)) reasons.add("stderr-capture-started-after-stream-end");
  const onData = chunk => {
    try {
      // The existing binary-mode Transform emits Buffers. Reject drift without allocating an unbounded copy.
      if (!Buffer.isBuffer(chunk)) {
        reasons.add("stderr-capture-invalid-chunk");
        return;
      }
      const bytes = chunk;
      receivedBytes += bytes.length;
      const length = Math.min(bytes.length, maxBytes - retainedBytes);
      if (length > 0) bytes.copy(buffer, retainedBytes, 0, length);
      retainedBytes += length;
      if (length < bytes.length) {
        overflow = true;
        reasons.add("stderr-capture-capacity-exceeded");
      }
    } catch {
      reasons.add("stderr-capture-handler-failed");
    }
  };
  const onEnd = () => { ended = true; };
  const onError = () => { reasons.add("stderr-redactor-error"); };
  const onClose = () => {
    if (!ended && !source.readableEnded) reasons.add("stderr-redactor-closed-before-end");
  };
  if (available) {
    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
    source.on("close", onClose);
  }
  const snapshot = () => {
    const incompleteReasons = [...reasons];
    if (!finalized) incompleteReasons.push("stderr-capture-not-finalized");
    if (!ended) incompleteReasons.push("stderr-redactor-end-not-observed");
    return {
      schemaVersion: 1, evidenceClass: "owned-redacted-stderr-diagnostic", channel: "stderr",
      source: "RunContext.processes.redactors[1]", ownerLabel: label, artifactName,
      maxBytes, retainedBytes, receivedBytes, droppedBytes: receivedBytes - retainedBytes,
      pendingQueueBytes: 0, overflow, ended, finalized, complete: incompleteReasons.length === 0,
      incompleteReasons, text: buffer.toString("utf8", 0, retainedBytes),
    };
  };
  context.addCleanup(`persist redacted stderr diagnostic ${label}`, async () => {
    let stopError;
    try {
      // stopOwned awaits the original redactor flush. Keep the tap attached through its final data event.
      await context.stopOwned(label);
    } catch (error) {
      stopError = error;
      reasons.add("owned-process-stop-unconfirmed");
    } finally {
      if (available) {
        source.off("data", onData);
        source.off("end", onEnd);
        source.off("error", onError);
        source.off("close", onClose);
      }
      finalized = true;
    }
    await context.writeArtifactJsonInternal(artifactName, snapshot());
    if (stopError) throw stopError;
  });
  return { snapshot, artifactName };
}
