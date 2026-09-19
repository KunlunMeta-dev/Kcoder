use super::*;

#[derive(Debug)]
pub(super) struct HistoryFlusher {
    tx: mpsc::UnboundedSender<QueuedHistoryCommand>,
    pub(super) queue: Arc<HistoryFlusherQueue>,
}

#[derive(Debug)]
pub(super) struct HistoryFlusherQueue {
    pub(super) source: HistorySource,
    epoch: AtomicU64,
    batch: Mutex<HistoryBatch>,
}

#[derive(Debug, Default)]
struct HistoryBatch {
    entries: Vec<HistoryEntry>,
    fault: Option<String>,
}

#[derive(Debug)]
pub(super) struct QueuedHistoryCommand {
    pub(super) command: HistoryFlusherCommand,
    epoch: u64,
}

impl HistoryFlusher {
    pub(super) fn new(
        tx: mpsc::UnboundedSender<QueuedHistoryCommand>,
        source: HistorySource,
    ) -> Self {
        Self {
            tx,
            queue: Arc::new(HistoryFlusherQueue::new(source)),
        }
    }

    pub(super) fn send(
        &self,
        command: HistoryFlusherCommand,
    ) -> Result<(), Box<HistoryFlusherCommand>> {
        // The caller holds AppState's inner lock; enqueue never waits for disk I/O.
        self.tx
            .send(QueuedHistoryCommand {
                command,
                epoch: self.queue.epoch.load(Ordering::Acquire),
            })
            .map_err(|error| Box::new(error.0.command))
    }

    pub(super) fn process_direct(&self, path: &Path, command: HistoryFlusherCommand) {
        process_history_flusher_command(
            path,
            &self.queue,
            QueuedHistoryCommand {
                command,
                epoch: self.queue.epoch.load(Ordering::Acquire),
            },
        );
    }
}

impl HistoryBatch {
    fn check_fault(&self) -> anyhow::Result<()> {
        if let Some(fault) = &self.fault {
            anyhow::bail!(
                "history mutation is uncertain; save an explicit snapshot to recover: {fault}"
            );
        }
        Ok(())
    }

    fn record_result(&mut self, result: &anyhow::Result<()>) {
        if let Err(error) = result
            && crate::history_store::is_uncertain_mutation(error)
        {
            self.fault = Some(format!("{error:#}"));
        }
    }

    fn flush(&mut self, source: &HistorySource) -> anyhow::Result<()> {
        self.check_fault()?;
        let result = flush_bound_history_batch(source, &mut self.entries);
        self.record_result(&result);
        if result.is_err()
            && let Err(error) = source.check()
        {
            self.fault = Some(format!("{error:#}"));
        }
        result
    }
}

impl HistoryFlusherQueue {
    fn new(source: HistorySource) -> Self {
        Self {
            source,
            epoch: AtomicU64::new(0),
            batch: Mutex::default(),
        }
    }
    fn lock_batch(&self) -> MutexGuard<'_, HistoryBatch> {
        self.batch.lock().unwrap_or_else(|error| {
            let mut batch = error.into_inner();
            batch.fault.get_or_insert_with(|| {
                "history writer panicked while holding its mutation lock".to_string()
            });
            batch
        })
    }

    pub(super) fn write_fault(&self) -> Option<String> {
        self.lock_batch().fault.clone()
    }

    pub(super) fn flush(&self, _path: &Path) -> anyhow::Result<()> {
        self.lock_batch().flush(&self.source)
    }

    pub(super) fn replace_snapshot(
        &self,
        write: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        let mut batch = self.lock_batch();
        let next_epoch = self
            .epoch
            .load(Ordering::Acquire)
            .checked_add(1)
            .context("history snapshot queue epoch is exhausted")?;
        let result = write();
        if result.is_ok()
            || result
                .as_ref()
                .is_err_and(crate::history_store::is_uncertain_mutation)
        {
            // A possibly committed snapshot also invalidates old queued commands.
            self.epoch.store(next_epoch, Ordering::Release);
            batch.entries.clear();
            batch.fault = None;
            batch.record_result(&result);
            if result.is_ok() {
                self.batch.clear_poison();
            }
        }
        result
    }
}

struct HistoryWorkerGuard {
    queue: Arc<HistoryFlusherQueue>,
    rx: mpsc::UnboundedReceiver<QueuedHistoryCommand>,
    drained: bool,
}

impl Drop for HistoryWorkerGuard {
    fn drop(&mut self) {
        if !self.drained {
            // Publish the fault before dropping rx, so closed-channel fallback cannot race it.
            self.queue.lock_batch().fault.get_or_insert_with(|| {
                "history worker stopped before confirming its accepted writes".to_string()
            });
        }
    }
}

#[derive(Debug)]
pub(super) enum HistoryFlusherCommand {
    Entry(HistoryEntry),
    Flush(oneshot::Sender<anyhow::Result<()>>),
    AppendCompaction {
        session_id: String,
        event: CompactionTranscriptEvent,
        metadata: CompactionTranscriptMetadata,
        done: oneshot::Sender<anyhow::Result<()>>,
    },
    AppendRewind {
        session_id: String,
        boundary_uuid: String,
        parent_uuid: Option<String>,
        anchor_uuid: Option<String>,
        turn: u64,
        done: oneshot::Sender<anyhow::Result<()>>,
    },
}

pub(super) fn start_history_flusher(
    handle: tokio::runtime::Handle,
    path: PathBuf,
    source: HistorySource,
) -> HistoryFlusher {
    // AppState already retains the same messages in memory, and finalized
    // messages arrive far less frequently than stream deltas. An unbounded
    // ingress lets synchronous add_message calls preserve exact order without
    // detached per-entry send tasks that can race one another.
    let (tx, rx) = mpsc::unbounded_channel();
    let flusher = HistoryFlusher::new(tx, source);
    let queue = flusher.queue.clone();
    handle.spawn(history_flusher_task(path, rx, queue));
    flusher
}

pub(super) fn history_flusher_task(
    path: PathBuf,
    rx: mpsc::UnboundedReceiver<QueuedHistoryCommand>,
    queue: Arc<HistoryFlusherQueue>,
) -> impl std::future::Future<Output = ()> + Send {
    // Construct the guard before spawning, so even an unpolled future is covered.
    let guard = HistoryWorkerGuard {
        queue: queue.clone(),
        rx,
        drained: false,
    };
    async move {
        let mut guard = guard;
        const BATCH_SIZE: usize = 32;
        const FLUSH_INTERVAL_MS: u64 = 500;

        let mut interval =
            tokio::time::interval(tokio::time::Duration::from_millis(FLUSH_INTERVAL_MS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                biased;
                command = guard.rx.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    process_history_flusher_command(&path, &queue, command);
                    // Pull as many pending commands as possible without awaiting,
                    // preserving barriers and compaction records in channel order.
                    while let Ok(command) = guard.rx.try_recv() {
                        process_history_flusher_command(&path, &queue, command);
                    }
                    let mut batch = queue.lock_batch();
                    if batch.entries.len() >= BATCH_SIZE && batch.fault.is_none() {
                        warn_history_flush_error(batch.flush(&queue.source));
                    }
                }
                _ = interval.tick() => {
                    let mut batch = queue.lock_batch();
                    if !batch.entries.is_empty() && batch.fault.is_none() {
                        warn_history_flush_error(batch.flush(&queue.source));
                    }
                }
                else => break,
            }
        }

        // Drain any remaining entries before the task ends.
        while let Ok(command) = guard.rx.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        let result = queue.flush(&path);
        guard.drained = result.is_ok();
        warn_history_flush_error(result);
    }
}

pub(super) fn process_history_flusher_command(
    path: &Path,
    queue: &HistoryFlusherQueue,
    queued: QueuedHistoryCommand,
) {
    let mut batch = queue.lock_batch();
    if queued.epoch != queue.epoch.load(Ordering::Acquire) {
        match queued.command {
            HistoryFlusherCommand::Entry(_) => {}
            HistoryFlusherCommand::Flush(done)
            | HistoryFlusherCommand::AppendCompaction { done, .. }
            | HistoryFlusherCommand::AppendRewind { done, .. } => {
                let _ = done.send(batch.check_fault().and_then(|()| queue.source.check()));
            }
        }
        return;
    }
    match queued.command {
        HistoryFlusherCommand::Entry(entry) => batch.entries.push(entry),
        HistoryFlusherCommand::Flush(done) => {
            let _ = done.send(batch.flush(&queue.source));
        }
        HistoryFlusherCommand::AppendCompaction {
            session_id,
            event,
            metadata,
            done,
        } => {
            let result = batch.flush(&queue.source).and_then(|()| {
                append_compaction_transcript_records(
                    &queue.source,
                    path,
                    &session_id,
                    &event,
                    &metadata,
                )
            });
            batch.record_result(&result);
            let _ = done.send(result);
        }
        HistoryFlusherCommand::AppendRewind {
            session_id,
            boundary_uuid,
            parent_uuid,
            anchor_uuid,
            turn,
            done,
        } => {
            let result = batch.flush(&queue.source).and_then(|()| {
                append_rewind_transcript_record(
                    &queue.source,
                    &session_id,
                    &boundary_uuid,
                    parent_uuid.as_deref(),
                    anchor_uuid.as_deref(),
                    turn,
                )
            });
            batch.record_result(&result);
            let _ = done.send(result);
        }
    }
}

fn warn_history_flush_error(result: anyhow::Result<()>) {
    if let Err(error) = result {
        warn!("failed to flush history batch: {error:#}");
    }
}

pub(super) fn flush_bound_history_batch(
    source: &HistorySource,
    batch: &mut Vec<HistoryEntry>,
) -> anyhow::Result<()> {
    if batch.is_empty() {
        return source.check();
    }

    let mut encoded = Vec::new();
    for entry in batch.iter() {
        serde_json::to_writer(&mut encoded, entry)?;
        encoded.push(b'\n');
    }
    source.append(&encoded)?;
    batch.clear();
    Ok(())
}

#[cfg(test)]
pub(super) fn flush_history_batch(
    path: &Path,
    batch: &mut Vec<HistoryEntry>,
) -> anyhow::Result<()> {
    flush_bound_history_batch(&HistorySource::bind(path)?, batch)
}

#[cfg(test)]
pub(super) fn append_history_entry(path: &Path, entry: &HistoryEntry) {
    match serde_json::to_string(entry) {
        Ok(line) => {
            if let Err(e) = append_line(path, &line) {
                warn!("failed to append history: {}", e);
            }
        }
        Err(e) => warn!("failed to serialize history entry: {}", e),
    }
}

pub(super) fn check_direct_history_fault(inner: &AppStateInner) -> anyhow::Result<()> {
    if let Some(fault) = &inner.history_write_fault {
        anyhow::bail!(
            "history persistence is faulted; save an explicit snapshot to recover: {fault}"
        );
    }
    if inner.history_path.is_some() {
        require_history_source(inner)?
            .check()
            .context("failed to validate bound history source")?;
    }
    Ok(())
}

pub(super) fn require_history_source(inner: &AppStateInner) -> anyhow::Result<&HistorySource> {
    inner
        .history_source
        .as_ref()
        .context("history source is not bound; configure a new session explicitly")
}

pub(super) fn direct_history_write(
    inner: &mut AppStateInner,
    write: impl FnOnce(&AppStateInner) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let result = check_direct_history_fault(inner).and_then(|()| write(inner));
    if let Err(error) = &result {
        // Direct writes have no retained retry batch, even when no bytes were committed.
        inner
            .history_write_fault
            .get_or_insert_with(|| format!("{error:#}"));
    }
    result
}

pub(super) fn append_compaction_transcript_records(
    source: &HistorySource,
    path: &Path,
    session_id: &str,
    event: &CompactionTranscriptEvent,
    metadata: &CompactionTranscriptMetadata,
) -> anyhow::Result<()> {
    let trigger = match event.trigger {
        CompactionTrigger::Manual => "manual",
        CompactionTrigger::Auto => "auto",
    };
    let now = now_millis();
    let timestamp = now_iso_timestamp();
    let boundary_uuid = metadata.boundary_uuid.clone();
    let summary_uuid = metadata.summary_uuid.clone();
    let preserved_segment = metadata.preserved_segment.as_ref().map(|segment| {
        serde_json::json!({
            "headUuid": segment.head_uuid,
            "anchorUuid": summary_uuid,
            "tailUuid": segment.tail_uuid,
        })
    });
    let boundary = serde_json::json!({
        "session_id": session_id,
        "timestamp_ms": now,
        "timestamp": timestamp,
        "uuid": boundary_uuid,
        "parentUuid": serde_json::Value::Null,
        "logicalParentUuid": metadata.parent_uuid,
        "type": "system",
        "subtype": "compact_boundary",
        "content": "Conversation compacted",
        "isMeta": false,
        "level": "info",
        "compactMetadata": {
            "trigger": trigger,
            "preTokens": event.pre_tokens,
            "postTokens": event.post_tokens,
            "preservedSegment": preserved_segment,
        },
    });
    let summary = serde_json::json!({
        "session_id": session_id,
        "timestamp_ms": now_millis(),
        "timestamp": now_iso_timestamp(),
        "uuid": summary_uuid,
        "parentUuid": boundary_uuid,
        "logicalParentUuid": metadata
            .preserved_segment
            .as_ref()
            .map(|segment| segment.tail_uuid.clone())
            .unwrap_or_else(|| summary_uuid.clone()),
        "role": "user",
        "content": [{
            "type": "text",
            "text": compact_user_summary_message(event, path),
        }],
        "isCompactSummary": true,
        "isVisibleInTranscriptOnly": true,
    });
    let mut encoded = serde_json::to_vec(&boundary)?;
    encoded.push(b'\n');
    serde_json::to_writer(&mut encoded, &summary)?;
    encoded.push(b'\n');
    source.append(&encoded)
}

/// Append a rewind boundary record to the transcript. The record marks that
/// the conversation was truncated at `anchor_uuid` (the history uuid of the
/// last surviving message; `None` means everything before the boundary was
/// discarded), so a later resume reconstructs the rewound context instead of
/// replaying the full append-only history.
pub(super) fn append_rewind_transcript_record(
    source: &HistorySource,
    session_id: &str,
    boundary_uuid: &str,
    parent_uuid: Option<&str>,
    anchor_uuid: Option<&str>,
    turn: u64,
) -> anyhow::Result<()> {
    let boundary = serde_json::json!({
        "session_id": session_id,
        "timestamp_ms": now_millis(),
        "timestamp": now_iso_timestamp(),
        "uuid": boundary_uuid,
        "parentUuid": serde_json::Value::Null,
        "logicalParentUuid": parent_uuid,
        "type": "system",
        "subtype": "rewind_boundary",
        "content": format!("Conversation rewound to checkpoint turn {turn}"),
        "isMeta": false,
        "level": "info",
        "rewindMetadata": {
            "turn": turn,
            "anchorUuid": anchor_uuid,
        },
    });
    let mut encoded = serde_json::to_vec(&boundary)?;
    encoded.push(b'\n');
    source.append(&encoded)
}

pub(super) fn build_compaction_transcript_metadata(
    inner: &AppStateInner,
    compacted_messages: &[Message],
) -> CompactionTranscriptMetadata {
    let boundary_uuid = generate_transcript_uuid();
    let summary_uuid = generate_transcript_uuid();
    let parent_uuid = inner.last_history_uuid.clone();
    let preserved_ids = preserved_history_ids_for_compacted_messages(
        &inner.messages,
        &inner.message_history_ids,
        compacted_messages,
    );
    let preserved_segment = preserved_segment_from_ids(&preserved_ids);
    CompactionTranscriptMetadata {
        boundary_uuid,
        summary_uuid,
        parent_uuid,
        preserved_ids,
        preserved_segment,
    }
}

pub(super) fn compacted_message_history_ids(
    compacted_messages: &[Message],
    metadata: &CompactionTranscriptMetadata,
) -> Vec<Option<String>> {
    let mut ids = Vec::with_capacity(compacted_messages.len());
    if compacted_messages.is_empty() {
        return ids;
    }
    ids.push(Some(metadata.summary_uuid.clone()));
    ids.extend(
        metadata
            .preserved_ids
            .iter()
            .cloned()
            .chain(std::iter::repeat(None))
            .take(compacted_messages.len().saturating_sub(1)),
    );
    ids
}

fn preserved_segment_from_ids(ids: &[Option<String>]) -> Option<PreservedTranscriptSegment> {
    if ids.is_empty() || ids.iter().any(Option::is_none) {
        return None;
    }
    let head_uuid = ids.first()?.as_ref()?.clone();
    let tail_uuid = ids.last()?.as_ref()?.clone();
    Some(PreservedTranscriptSegment {
        head_uuid,
        tail_uuid,
    })
}

fn preserved_history_ids_for_compacted_messages(
    old_messages: &kcoder_types::SharedMessages,
    old_ids: &[Option<String>],
    compacted_messages: &[Message],
) -> Vec<Option<String>> {
    let Some(compacted_tail) = compacted_messages.get(1..) else {
        return Vec::new();
    };
    if compacted_tail.is_empty() || old_messages.is_empty() || old_ids.len() != old_messages.len() {
        return Vec::new();
    }

    let mut best_start = None;
    let mut best_len = 0usize;
    for start in 0..old_messages.len() {
        let mut len = 0usize;
        while start + len < old_messages.len()
            && len < compacted_tail.len()
            && messages_equivalent_for_transcript(&old_messages[start + len], &compacted_tail[len])
        {
            len += 1;
        }
        if len > best_len || (len == best_len && best_start.is_none_or(|best| start > best)) {
            best_start = Some(start);
            best_len = len;
        }
    }

    let Some(start) = best_start else {
        return Vec::new();
    };
    if best_len == 0 {
        return Vec::new();
    }
    old_ids[start..start + best_len].to_vec()
}

fn messages_equivalent_for_transcript(a: &Message, b: &Message) -> bool {
    match (a, b) {
        (Message::User { content: left }, Message::User { content: right }) => left == right,
        (Message::Assistant { content: left, .. }, Message::Assistant { content: right, .. }) => {
            left == right
        }
        _ => false,
    }
}

fn compact_user_summary_message(
    event: &CompactionTranscriptEvent,
    transcript_path: &Path,
) -> String {
    let mut summary = format!(
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n{}",
        event.summary.trim()
    );
    summary.push_str(&format!(
        "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: {}",
        transcript_path.display()
    ));
    summary.push_str("\n\nRecent messages are preserved verbatim.");
    summary.push_str("\nContinue the conversation from where it left off without asking the user any further questions. Resume directly - do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.");
    summary
}

#[cfg(test)]
fn append_line(path: &Path, line: &str) -> anyhow::Result<()> {
    let mut encoded = line.as_bytes().to_vec();
    encoded.push(b'\n');
    crate::history_store::append_records(path, &encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn unpolled_worker_abort_cannot_acknowledge_lost_queued_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("aborted.jsonl");
        let state = AppState::new(temp.path());
        let (tx, rx) = mpsc::unbounded_channel();
        let flusher = HistoryFlusher::new(tx, HistorySource::bind(&path).unwrap());
        let worker = tokio::spawn(history_flusher_task(
            path.clone(),
            rx,
            flusher.queue.clone(),
        ));
        {
            let mut inner = state.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_source = Some(flusher.queue.source.clone());
            inner.history_flusher = Some(flusher);
        }
        state.add_message(Message::user_text("accepted but not received"));
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(state.flush_history().await.is_err());
        assert!(!path.exists());
        state.save_history().unwrap();
        state.flush_history().await.unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 1);
    }

    #[test]
    fn snapshot_panic_keeps_empty_batch_faulted_until_successful_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("panic.jsonl");
        let queue = HistoryFlusherQueue::new(HistorySource::bind(&path).unwrap());
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = queue.replace_snapshot(|| panic!("injected snapshot panic"));
        }));
        assert!(panic.is_err());
        assert!(queue.flush(&path).is_err());
        assert!(queue.write_fault().is_some());
        queue
            .replace_snapshot(|| crate::history_store::replace_records(&path, b"{}\n"))
            .unwrap();
        queue.flush(&path).unwrap();
        assert!(queue.write_fault().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_sidecar_failure_keeps_writer_faulted_and_retries_without_duplicates() {
        for queued in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("snapshot.jsonl");
            let state = AppState::new(temp.path());
            state.with_deferred_history_path(&path);
            if !queued {
                state.write_inner().history_flusher = None;
            }
            state.add_message(Message::user_text("once"));
            let sidecar = state.session_state_path().unwrap();
            std::fs::create_dir_all(&sidecar).unwrap();
            state.set_goal("recover latest session state", None);
            let error = state
                .save_history()
                .expect_err("sidecar failure must reject snapshot success");
            assert!(format!("{error:#}").contains("session"));
            assert_eq!(load_history(&path).unwrap().len(), 1);
            assert!(state.flush_history().await.is_err());
            state.add_message(Message::user_text("accepted during recovery"));
            std::fs::remove_dir(&sidecar).unwrap();
            assert!(
                state.flush_history().await.is_err(),
                "fixing storage alone is not snapshot recovery"
            );
            state.save_history().unwrap();
            state.flush_history().await.unwrap();
            let restored = AppState::new(temp.path());
            restored.resume_from_history(&path).unwrap();
            assert_eq!(restored.messages().len(), 2);
            assert_eq!(
                restored.goal().unwrap().objective,
                "recover latest session state"
            );
            assert_eq!(load_history(&path).unwrap().len(), 2);
        }
    }

    #[test]
    fn exhausted_snapshot_epoch_rejects_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let queue = HistoryFlusherQueue::new(
            HistorySource::bind(&temp.path().join("epoch.jsonl")).unwrap(),
        );
        queue.epoch.store(u64::MAX, Ordering::Release);
        let mut wrote = false;
        let result = queue.replace_snapshot(|| {
            wrote = true;
            Ok(())
        });
        assert!(result.is_err());
        assert!(!wrote);
        assert_eq!(queue.epoch.load(Ordering::Acquire), u64::MAX);
    }
}
