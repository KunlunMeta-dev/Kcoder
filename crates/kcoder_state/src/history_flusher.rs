use super::*;
mod confirmation;
mod flush_request;
mod live_row_receipt;
mod owned_slots;
mod worker_pool;
pub(super) use confirmation::{MessageCommitConfirmation, MessageCommitOutcome};
pub(super) use flush_request::flush_history;
pub use live_row_receipt::NativeHistoryRowReceipt;
pub(super) use owned_slots::{
    OwnedSlot, SlotError, take_reclaimable as take_reclaimable_owned_slots,
    try_insert as try_insert_owned_slot,
};
#[cfg(test)]
pub(super) use owned_slots::{inspect_poisoned_for_test, poison_for_test};

pub(super) fn spawn_input_owner(
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<tokio::task::Id, SlotError> {
    let handle = tokio::runtime::Handle::try_current().map_err(|_| SlotError::Unavailable)?;
    worker_pool::spawn_supervisor(&handle, future)
}

pub(super) async fn inspect_identified_history(
    source: HistorySource,
    queue: Option<Arc<HistoryFlusherQueue>>,
    uuid: String,
    session_id: String,
    message: kcoder_types::Message,
) -> anyhow::Result<bool> {
    let queue = queue.unwrap_or_else(|| Arc::new(HistoryFlusherQueue::new(source.clone())));
    anyhow::ensure!(
        !queue.worker_is_unknown() && !queue.worker_is_stopped(),
        "identified input history writer is unknown"
    );
    let (done, mut reply) = oneshot::channel();
    worker_pool::run(queue, move || {
        let _ = done.send(source.inspect_identified(&uuid, &session_id, &message));
    })
    .await?;
    reply
        .try_recv()
        .context("identified history inspection stopped before reporting a result")?
}

#[cfg(test)]
pub(super) fn abort_input_owner(id: tokio::task::Id) -> bool {
    worker_pool::abort_supervisor(id)
}

#[cfg(test)]
#[path = "history_flusher/worker_tests.rs"]
mod worker_tests;

#[derive(Debug, Clone)]
pub(super) struct HistoryFlusher {
    tx: mpsc::UnboundedSender<QueuedHistoryCommand>,
    pub(super) queue: Arc<HistoryFlusherQueue>,
}

#[derive(Debug)]
pub(super) struct HistoryFlusherQueue {
    pub(super) source: HistorySource,
    epoch: AtomicU64,
    worker_unknown: std::sync::atomic::AtomicBool,
    worker_stopped: std::sync::atomic::AtomicBool,
    ever_submitted: std::sync::atomic::AtomicBool,
    start_failure: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    jobs_started: AtomicU64,
    batch: Mutex<HistoryBatch>,
}

#[derive(Debug, Default)]
struct HistoryBatch {
    entries: Vec<HistoryEntry>,
    fault: Option<String>,
    next_rewind_parent: Option<crate::conversation_rewind::RewindParent>,
}

#[derive(Debug)]
pub(super) struct QueuedHistoryCommand {
    pub(super) command: HistoryFlusherCommand,
    pub(super) epoch: u64,
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
        self.send_queued(command)
            .map(|_| ())
            .map_err(|queued| Box::new(queued.command))
    }

    pub(super) fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    pub(super) fn send_queued(
        &self,
        command: HistoryFlusherCommand,
    ) -> Result<u64, Box<QueuedHistoryCommand>> {
        // The caller holds AppState's inner lock; enqueue never waits for disk I/O.
        let epoch = self.queue.epoch.load(Ordering::Acquire);
        if self.queue.worker_is_unknown() || self.queue.worker_is_stopped() {
            return Err(Box::new(QueuedHistoryCommand { command, epoch }));
        }
        self.queue.ever_submitted.store(true, Ordering::Release);
        self.tx
            .send(QueuedHistoryCommand { command, epoch })
            .map(|()| epoch)
            .map_err(|error| Box::new(error.0))
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

    fn record_result<T>(&mut self, result: &anyhow::Result<T>) {
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

    fn flush_original_input(
        &mut self,
        source: &HistorySource,
        uuid: &str,
    ) -> anyhow::Result<MessageCommitConfirmation> {
        self.check_fault()?;
        let count = self
            .entries
            .iter()
            .filter(|entry| entry.uuid.as_deref() == Some(uuid))
            .count();
        if count != 1 {
            self.fault =
                Some("original input identity is missing or ambiguous in its writer batch".into());
            anyhow::bail!("original input identity is missing or ambiguous in its writer batch");
        }
        let existing = match source.has_existing_body() {
            Ok(existing) => existing,
            Err(error) => {
                self.fault
                    .get_or_insert_with(|| format!("input source cannot be confirmed: {error:#}"));
                return Err(error);
            }
        };
        if !existing {
            let result = self.flush(source);
            if let Err(error) = &result {
                self.fault.get_or_insert_with(|| {
                    format!("original input batch commit was not confirmed: {error:#}")
                });
            }
            result?;
            return Ok(MessageCommitConfirmation::committed(None));
        }
        let result = live_row_receipt::flush_with_live_row_receipt(source, &mut self.entries, uuid);
        if let Err(error) = &result {
            // An uncertain append may already contain the row. Do not retry it.
            self.fault
                .get_or_insert_with(|| format!("input row commit was not confirmed: {error:#}"));
        }
        result.map(|receipt| MessageCommitConfirmation::committed(Some(receipt)))
    }

    fn flush_identified_original_input(
        &mut self,
        source: &HistorySource,
        uuid: &str,
        expected_message: &kcoder_types::Message,
    ) -> anyhow::Result<()> {
        self.check_fault()?;
        let matching = self
            .entries
            .iter()
            .filter(|entry| entry.uuid.as_deref() == Some(uuid))
            .count();
        anyhow::ensure!(
            matching == 1,
            "identified input identity is missing or ambiguous in its writer batch"
        );
        let entry = self
            .entries
            .last()
            .context("identified input is missing from its writer batch")?
            .clone();
        anyhow::ensure!(
            entry.uuid.as_deref() == Some(uuid) && &entry.message == expected_message,
            "identified input differs from its original writer ticket"
        );

        // Earlier queued history keeps its order and is committed before the
        // identified row. The source operation then atomically appends or
        // verifies that one row without replaying it.
        let mut preceding = self.entries[..self.entries.len() - 1].to_vec();
        let preceding_result = flush_bound_history_batch(source, &mut preceding);
        self.record_result(&preceding_result);
        if preceding_result.is_err()
            && let Err(error) = source.check()
        {
            self.fault = Some(format!("{error:#}"));
        }
        preceding_result?;
        self.entries.clear();
        let result = source.append_identified_or_verify(&entry).map(|_| ());
        if let Err(error) = &result {
            self.fault.get_or_insert_with(|| {
                format!("identified input commit was not confirmed: {error:#}")
            });
        }
        result
    }
}

impl HistoryFlusherQueue {
    pub(super) fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub(super) fn execute_rewind(
        &self,
        epoch: u64,
        write: impl FnOnce(
            &HistorySource,
        ) -> anyhow::Result<(
            ConversationRewindOutcome,
            Option<crate::conversation_rewind::RewindParent>,
        )>,
    ) -> anyhow::Result<ConversationRewindOutcome> {
        let mut batch = self.lock_batch();
        anyhow::ensure!(
            epoch == self.epoch.load(Ordering::Acquire),
            "history snapshot replaced the queued rewind; prepare it again"
        );
        batch.flush(&self.source)?;
        let result = write(&self.source);
        batch.record_result(&result);
        let (outcome, parent) = result?;
        batch.next_rewind_parent = parent;
        Ok(outcome)
    }
    fn new(source: HistorySource) -> Self {
        Self {
            source,
            epoch: AtomicU64::new(0),
            worker_unknown: std::sync::atomic::AtomicBool::new(false),
            worker_stopped: std::sync::atomic::AtomicBool::new(false),
            ever_submitted: std::sync::atomic::AtomicBool::new(false),
            start_failure: std::sync::atomic::AtomicU8::new(0),
            #[cfg(test)]
            jobs_started: AtomicU64::new(0),
            batch: Mutex::default(),
        }
    }
    fn lock_batch(&self) -> MutexGuard<'_, HistoryBatch> {
        let mut batch = self.batch.lock().unwrap_or_else(|error| {
            let mut batch = error.into_inner();
            batch.fault.get_or_insert_with(|| {
                "history writer panicked while holding its mutation lock".to_string()
            });
            batch
        });
        self.record_worker_unknown(&mut batch);
        batch
    }

    fn try_lock_batch(&self) -> Option<MutexGuard<'_, HistoryBatch>> {
        let mut batch = match self.batch.try_lock() {
            Ok(batch) => batch,
            Err(std::sync::TryLockError::WouldBlock) => return None,
            Err(std::sync::TryLockError::Poisoned(error)) => {
                let mut batch = error.into_inner();
                batch.fault.get_or_insert_with(|| {
                    "history writer panicked while holding its mutation lock".to_string()
                });
                batch
            }
        };
        self.record_worker_unknown(&mut batch);
        Some(batch)
    }

    fn mark_worker_unknown(&self) {
        self.worker_unknown.store(true, Ordering::Release);
    }

    pub(super) fn worker_is_unknown(&self) -> bool {
        self.worker_unknown.load(Ordering::Acquire)
    }

    pub(super) fn worker_is_stopped(&self) -> bool {
        self.worker_stopped.load(Ordering::Acquire)
    }

    pub(super) fn initial_start_failure(&self) -> Option<SlotError> {
        if self.ever_submitted.load(Ordering::Acquire) {
            return None;
        }
        match self.start_failure.load(Ordering::Acquire) {
            1 => Some(SlotError::Busy),
            2 => Some(SlotError::Full),
            3 => Some(SlotError::Unavailable),
            _ => None,
        }
    }

    fn record_worker_unknown(&self, batch: &mut HistoryBatch) {
        if self.worker_is_unknown() || self.worker_is_stopped() {
            batch.fault.get_or_insert_with(|| {
                "history worker stopped before confirming its accepted writes".to_string()
            });
        }
    }

    pub(super) fn write_fault(&self) -> Option<String> {
        if self.worker_is_unknown() || self.worker_is_stopped() {
            return Some("history worker stopped before confirming its accepted writes".into());
        }
        self.lock_batch().fault.clone()
    }

    pub(super) fn flush(&self, _path: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.worker_is_unknown() && !self.worker_is_stopped(),
            "history worker stopped before confirming its accepted writes"
        );
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
            batch.next_rewind_parent = None;
            batch.fault = None;
            batch.record_result(&result);
            if result.is_ok() {
                self.batch.clear_poison();
                self.worker_unknown.store(false, Ordering::Release);
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
        if !self.drained && self.queue.ever_submitted.load(Ordering::Acquire) {
            // Publish without waiting on a worker holding batch during I/O.
            self.queue.mark_worker_unknown();
        }
        self.queue.worker_stopped.store(true, Ordering::Release);
    }
}

#[derive(Debug)]
pub(super) enum HistoryFlusherCommand {
    Entry(HistoryEntry),
    EntryWithCommit {
        entry: HistoryEntry,
        done: oneshot::Sender<anyhow::Result<MessageCommitConfirmation>>,
    },
    EntryWithIdentifiedCommit {
        entry: HistoryEntry,
        done: oneshot::Sender<anyhow::Result<MessageCommitConfirmation>>,
    },
    Flush(oneshot::Sender<anyhow::Result<()>>),
    AppendCompaction {
        session_id: String,
        event: CompactionTranscriptEvent,
        metadata: CompactionTranscriptMetadata,
        done: oneshot::Sender<anyhow::Result<()>>,
    },
    RewindTransaction {
        operation: Box<crate::conversation_rewind::PreparedRewind>,
        done: oneshot::Sender<anyhow::Result<ConversationRewindOutcome>>,
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
    let future = history_flusher_task(path, rx, queue);
    if let Err(error) = worker_pool::spawn_supervisor(&handle, future) {
        flusher.queue.start_failure.store(
            match error {
                SlotError::Busy => 1,
                SlotError::Full => 2,
                SlotError::Unavailable => 3,
            },
            Ordering::Release,
        );
    }
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
                    // One bounded job at a time preserves this session's FIFO
                    // order while keeping locks and disk I/O off the runtime.
                    let mut commands = vec![command];
                    while commands.len() < BATCH_SIZE {
                        match guard.rx.try_recv() {
                            Ok(command) => commands.push(command),
                            Err(_) => break,
                        }
                    }
                    let job_queue = Arc::clone(&queue);
                    let job_path = path.clone();
                    let result = worker_pool::run(Arc::clone(&queue), move || {
                        for command in commands {
                            process_history_flusher_command(&job_path, &job_queue, command);
                        }
                        if let Some(mut batch) = job_queue.try_lock_batch()
                            && batch.entries.len() >= BATCH_SIZE
                            && batch.fault.is_none()
                        {
                            warn_history_flush_error(batch.flush(&job_queue.source));
                        }
                    }).await;
                    if let Err(error) = result {
                        warn_history_flush_error(Err(error));
                        return;
                    }
                }
                _ = interval.tick() => {
                    let job_queue = Arc::clone(&queue);
                    let result = worker_pool::run(Arc::clone(&queue), move || {
                        if let Some(mut batch) = job_queue.try_lock_batch()
                            && !batch.entries.is_empty()
                            && batch.fault.is_none()
                        {
                            warn_history_flush_error(batch.flush(&job_queue.source));
                        }
                    }).await;
                    if let Err(error) = result {
                        warn_history_flush_error(Err(error));
                        return;
                    }
                }
                else => break,
            }
        }

        // recv() reports channel closure only after all queued commands have
        // been received and each of their jobs has finished.
        let job_queue = Arc::clone(&queue);
        let job_path = path.clone();
        let (done, mut finished) = oneshot::channel();
        let result = worker_pool::run(Arc::clone(&queue), move || {
            let _ = done.send(job_queue.flush(&job_path));
        })
        .await
        .and_then(|()| {
            finished
                .try_recv()
                .context("history final flush did not report its result")?
        });
        guard.drained = result.is_ok();
        warn_history_flush_error(result);
    }
}

pub(super) fn process_history_flusher_command(
    path: &Path,
    queue: &HistoryFlusherQueue,
    queued: QueuedHistoryCommand,
) {
    if queue.worker_is_unknown() || queue.worker_is_stopped() {
        reject_unconfirmed_command(queued.command);
        return;
    }
    let command = match queued.command {
        HistoryFlusherCommand::RewindTransaction { operation, done } => {
            // This path owns the state/persistence locks before acquiring batch.
            // The reply receiver may be gone; authority still must finalize.
            let result = operation.commit_queued(path, queue, queued.epoch);
            let _ = done.send(result);
            return;
        }
        command => command,
    };
    let mut batch = queue.lock_batch();
    if queued.epoch != queue.epoch.load(Ordering::Acquire) {
        match command {
            HistoryFlusherCommand::Entry(_) => {}
            HistoryFlusherCommand::EntryWithCommit { done, .. } => {
                let _ = done.send(Err(anyhow::anyhow!(
                    "original input was superseded before its writer batch committed"
                )));
            }
            HistoryFlusherCommand::EntryWithIdentifiedCommit { done, .. } => {
                let _ = done.send(Err(anyhow::anyhow!(
                    "identified input was superseded before its writer batch committed"
                )));
            }
            HistoryFlusherCommand::Flush(done)
            | HistoryFlusherCommand::AppendCompaction { done, .. } => {
                let _ = done.send(Err(anyhow::anyhow!(
                    "history barrier was superseded before its writer batch committed"
                )));
            }
            HistoryFlusherCommand::RewindTransaction { .. } => unreachable!(),
        }
        return;
    }
    match command {
        HistoryFlusherCommand::Entry(entry) => queue_history_entry(&mut batch, entry),
        HistoryFlusherCommand::EntryWithCommit { entry, done } => {
            let Some(uuid) = entry.uuid.clone() else {
                let _ = done.send(Err(anyhow::anyhow!("original input identity is missing")));
                return;
            };
            queue_history_entry(&mut batch, entry);
            let _ = done.send(batch.flush_original_input(&queue.source, &uuid));
        }
        HistoryFlusherCommand::EntryWithIdentifiedCommit { entry, done } => {
            let Some(uuid) = entry.uuid.clone() else {
                let _ = done.send(Err(anyhow::anyhow!("identified input identity is missing")));
                return;
            };
            let expected_message = entry.message.clone();
            queue_history_entry(&mut batch, entry);
            let result =
                batch.flush_identified_original_input(&queue.source, &uuid, &expected_message);
            let _ = done.send(result.map(|()| MessageCommitConfirmation::committed(None)));
        }
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
        HistoryFlusherCommand::RewindTransaction { .. } => unreachable!(),
    }
}

fn reject_unconfirmed_command(command: HistoryFlusherCommand) {
    let error = || anyhow::anyhow!("history worker stopped before confirming its accepted writes");
    match command {
        HistoryFlusherCommand::Entry(_) => {}
        HistoryFlusherCommand::EntryWithCommit { done, .. } => {
            let _ = done.send(Err(error()));
        }
        HistoryFlusherCommand::EntryWithIdentifiedCommit { done, .. } => {
            let _ = done.send(Err(error()));
        }
        HistoryFlusherCommand::Flush(done)
        | HistoryFlusherCommand::AppendCompaction { done, .. } => {
            let _ = done.send(Err(error()));
        }
        HistoryFlusherCommand::RewindTransaction { done, .. } => {
            let _ = done.send(Err(error()));
        }
    }
}

fn queue_history_entry(batch: &mut HistoryBatch, mut entry: HistoryEntry) {
    if let Some(parent) = batch.next_rewind_parent.as_ref() {
        if entry.session_id == parent.owner
            && entry.uuid.as_deref() == Some(parent.first_entry.as_str())
        {
            entry.parent_uuid = Some(parent.boundary.clone());
            batch.next_rewind_parent = None;
        } else {
            batch.fault.get_or_insert_with(|| {
                "rewind tail enqueue order changed; explicit snapshot recovery is required".into()
            });
        }
    }
    batch.entries.push(entry);
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
        require_history_source(inner)?.check().map_err(|error| {
            // Consumers often display only Display, not anyhow's full chain.
            // Keep the concrete filesystem/control-record failure visible there.
            let message = format!("failed to validate bound history source: {error:#}");
            error.context(message)
        })?;
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
            "contextSource": metadata.context_source,
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
        "origin": "compaction",
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
    let retained = preserved_ids
        .iter()
        .flatten()
        .collect::<std::collections::HashSet<_>>();
    let removed = inner
        .message_history_ids
        .iter()
        .zip(inner.messages.iter())
        .filter(|(id, _)| id.as_ref().is_none_or(|id| !retained.contains(id)))
        .collect::<Vec<_>>();
    let context_source = kcoder_types::context_archive::ContextBlockSource {
        schema_version: 1,
        message_ids: removed
            .iter()
            .filter_map(|(id, _)| id.as_ref().cloned())
            .collect(),
        complete: inner.message_history_ids.len() == inner.messages.len()
            && removed.iter().all(|(id, message)| {
                id.is_some() || kcoder_types::public_conversation_message(message).is_none()
            }),
    };
    CompactionTranscriptMetadata {
        boundary_uuid,
        summary_uuid,
        parent_uuid,
        preserved_ids,
        preserved_segment,
        context_source,
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
        (
            Message::User {
                content: left,
                origin: lo,
            },
            Message::User {
                content: right,
                origin: ro,
            },
        ) => left == right && lo == ro,
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
    use std::time::{Duration, Instant};

    #[tokio::test(flavor = "current_thread")]
    async fn idle_tick_does_not_block_the_runtime_when_snapshot_holds_batch() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("busy-batch.jsonl");
        let queue = Arc::new(HistoryFlusherQueue::new(
            HistorySource::bind(&path).unwrap(),
        ));
        let (tx, rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(history_flusher_task(path, rx, queue.clone()));
        // The first interval tick is immediate. Hold the batch for the next one.
        tokio::time::sleep(Duration::from_millis(25)).await;
        let (ready_tx, ready_rx) = oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = queue.lock_batch();
            let _ = ready_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(3));
        });
        ready_rx.await.unwrap();
        let start = Instant::now();
        tokio::time::sleep(Duration::from_millis(700)).await;
        let elapsed = start.elapsed();
        let _ = release_tx.send(());
        holder.join().unwrap();
        drop(tx);
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(
            elapsed < Duration::from_secs(2),
            "idle frame timer was blocked for {elapsed:?}"
        );
    }

    #[test]
    fn idle_tick_observes_poisoned_batch_as_faulted() {
        let temp = tempfile::tempdir().unwrap();
        let queue = HistoryFlusherQueue::new(
            HistorySource::bind(&temp.path().join("poison.jsonl")).unwrap(),
        );
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = queue.batch.lock().unwrap();
            panic!("injected batch panic");
        }));
        let batch = queue
            .try_lock_batch()
            .expect("poisoned batch must be observed");
        assert!(batch.fault.is_some());
    }

    #[test]
    fn bound_history_validation_display_includes_missing_record_reason() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("missing-record.jsonl");
        let state = AppState::new(temp.path());
        let source = HistorySource::bind(&path).unwrap();
        source.materialize().unwrap();
        std::fs::remove_file(path.with_extension("hctl").join("source.json")).unwrap();
        let mut inner = state.write_inner();
        inner.history_path = Some(path);
        inner.history_source = Some(source);
        let error = check_direct_history_fault(&inner).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("failed to validate bound history source")
        );
        assert!(error.to_string().contains("its record is missing"));
        assert!(error.chain().count() > 1);
    }

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
            state.set_goal("recover latest session state", None);
            std::fs::remove_file(&sidecar).unwrap();
            std::fs::create_dir_all(&sidecar).unwrap();
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
