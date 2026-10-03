use crate::diagnostic_writer::{DiagnosticAttempt, DiagnosticPermit};
use crate::{AppState, DiagnosticWriter};
use kcoder_config::PrivateTempDir;
use kcoder_types::{MessagesRequest, StreamEvent, Usage};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio::sync::Notify;

mod size;
pub(crate) mod target;

/// A single owned provider request shared without duplicating its payload.
#[derive(Clone, Debug)]
pub struct DiagnosticRequest {
    request: Arc<MessagesRequest>,
    retained_bytes: Option<usize>,
}

impl DiagnosticRequest {
    pub fn new(request: MessagesRequest) -> Self {
        let retained_bytes = size::request(&request);
        Self {
            request: Arc::new(request),
            retained_bytes,
        }
    }

    pub fn request(&self) -> &MessagesRequest {
        &self.request
    }
}

#[derive(Debug, Default)]
pub(crate) struct DiagnosticContext {
    settings: RwLock<(DiagnosticWriter, Option<Arc<PrivateTempDir>>)>,
    scope: Arc<Scope>,
}

#[derive(Debug, Default)]
struct Scope {
    pending: Mutex<(u64, BTreeSet<u64>, bool)>,
    changed: Notify,
}

impl Scope {
    #[cfg(test)]
    fn begin(self: &Arc<Self>) -> Arc<Completion> {
        self.begin_with_attempt(None)
    }

    fn begin_with_attempt(self: &Arc<Self>, attempt: Option<DiagnosticAttempt>) -> Arc<Completion> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.1.len() >= 4096 || pending.0 == u64::MAX {
            pending.2 = true;
            self.changed.notify_waiters();
            tracing::warn!("LLM diagnostic completion scope exhausted; flush is degraded");
            return Arc::new(Completion {
                scope: self.clone(),
                id: None,
                _attempt: attempt,
            });
        }
        pending.0 += 1;
        let id = pending.0;
        pending.1.insert(id);
        Arc::new(Completion {
            scope: self.clone(),
            id: Some(id),
            _attempt: attempt,
        })
    }

    async fn flush(&self, deadline: Instant) -> bool {
        let through = self.pending.lock().unwrap_or_else(|e| e.into_inner()).0;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                if pending.2 {
                    return false;
                }
                if pending.1.range(..=through).next().is_none() {
                    return true;
                }
            }
            if tokio::time::timeout_at(deadline.into(), notified)
                .await
                .is_err()
            {
                return false;
            }
        }
    }
}

pub(crate) struct Completion {
    scope: Arc<Scope>,
    id: Option<u64>,
    _attempt: Option<DiagnosticAttempt>,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.scope
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .1
                .remove(&id);
        }
        self.scope.changed.notify_waiters();
    }
}

impl AppState {
    pub(crate) fn begin_diagnostic_scope(
        &self,
    ) -> (
        DiagnosticWriter,
        Option<Arc<PrivateTempDir>>,
        Arc<Completion>,
    ) {
        let (writer, owner) = self
            .diagnostic_context
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let completion = self
            .diagnostic_context
            .scope
            .begin_with_attempt(writer.begin_attempt());
        (writer, owner, completion)
    }
    pub fn set_diagnostic_context(
        &self,
        writer: DiagnosticWriter,
        owner: Option<Arc<PrivateTempDir>>,
    ) {
        *self
            .diagnostic_context
            .settings
            .write()
            .unwrap_or_else(|e| e.into_inner()) = (writer, owner);
    }

    pub fn diagnostic_writer(&self) -> DiagnosticWriter {
        self.diagnostic_context
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .clone()
    }

    pub async fn flush_diagnostics_until(&self, deadline: Instant) -> bool {
        self.diagnostic_context.scope.flush(deadline).await
    }

    pub async fn begin_llm_exchange(
        &self,
        request: DiagnosticRequest,
        session_memory: bool,
    ) -> LlmExchangeCapture {
        let (writer, owner) = self
            .diagnostic_context
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let completion = self
            .diagnostic_context
            .scope
            .begin_with_attempt(writer.begin_attempt());
        let mut capture = LlmExchangeCapture {
            model: request.request.model.clone(),
            usage_root: self
                .usage_history_root()
                .and_then(|root| std::path::absolute(root).ok()),
            usage: None,
            recorded: false,
            armed: false,
            payload: None,
            permit: None,
            completion: Some(completion),
        };
        if let Some((payload, permit)) = self
            .prepare_diagnostic(
                request,
                session_memory,
                capture.completion.as_ref().unwrap().clone(),
                writer,
                owner,
            )
            .await
        {
            capture.payload = Some(payload);
            capture.permit = Some(permit);
        }
        capture.armed = true;
        capture
    }

    async fn prepare_diagnostic(
        &self,
        request: DiagnosticRequest,
        session_memory: bool,
        completion: Arc<Completion>,
        writer: DiagnosticWriter,
        owner: Option<Arc<PrivateTempDir>>,
    ) -> Option<(Payload, DiagnosticPermit)> {
        let frozen = target::FrozenTarget::snapshot(self, session_memory, owner)?;
        let Some(bytes) = request.retained_bytes else {
            writer.note_dropped();
            return None;
        };
        let permit = writer.try_reserve(bytes.saturating_add(frozen.retained_bytes()))?;
        // Preparation retains its budget even when its awaiting future is cancelled.
        let preparation = Preparation {
            frozen,
            permit,
            completion,
        };
        let opened = tokio::task::spawn_blocking(move || preparation.open()).await;
        match opened {
            Ok(Prepared {
                target: Ok(target),
                permit,
                ..
            }) => {
                return Some((
                    Payload {
                        request: request.request,
                        events: Vec::new(),
                        target,
                        error: None,
                        timestamp: 0,
                    },
                    permit,
                ));
            }
            Ok(_) => tracing::warn!("failed to open LLM diagnostic target"),
            Err(_) => tracing::warn!("LLM diagnostic target preparation failed"),
        }
        None
    }
}

struct Preparation {
    frozen: target::FrozenTarget,
    permit: DiagnosticPermit,
    completion: Arc<Completion>,
}

impl Preparation {
    fn open(self) -> Prepared {
        Prepared {
            target: self.frozen.open(),
            permit: self.permit,
            _completion: self.completion,
        }
    }
}

struct Prepared {
    target: anyhow::Result<target::Target>,
    permit: DiagnosticPermit,
    _completion: Arc<Completion>,
}

/// Best-effort exchange payload with independently reliable usage accounting.
pub struct LlmExchangeCapture {
    model: String,
    usage_root: Option<PathBuf>,
    usage: Option<Usage>,
    recorded: bool,
    armed: bool,
    // Payloads and directory owners must be released before their budget or scope.
    payload: Option<Payload>,
    permit: Option<DiagnosticPermit>,
    completion: Option<Arc<Completion>>,
}

struct Payload {
    request: Arc<MessagesRequest>,
    events: Vec<StreamEvent>,
    target: target::Target,
    error: Option<kcoder_types::ProviderErrorSummary>,
    timestamp: u64,
}

struct Job {
    payload: Payload,
    _completion: Arc<Completion>,
}

impl Payload {
    fn write(&self) -> anyhow::Result<()> {
        let content = crate::llm_history::encode_llm_exchange_with_summary(
            &self.target.session_id,
            &self.request,
            &self.events,
            self.error.as_ref(),
            self.timestamp,
        )?;
        self.target.write(&content, self.timestamp)
    }
}

impl LlmExchangeCapture {
    pub fn finish_with_summary(self, error: kcoder_types::ProviderErrorSummary) {
        let bytes = error.as_str().len();
        self.finish_internal(Some(error), bytes);
    }

    pub fn observe(&mut self, event: &StreamEvent) {
        let usage = match event {
            StreamEvent::MessageStart { message } => message.usage.as_ref(),
            StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
            _ => None,
        };
        if let Some(usage) = usage {
            let fixed = Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                iterations: None,
            };
            match &mut self.usage {
                Some(current) => current.merge_stream_update(&fixed),
                None => self.usage = Some(fixed),
            }
        }
        let Some(payload) = &mut self.payload else {
            return;
        };
        let Some(bytes) = size::event(event) else {
            self.discard();
            return;
        };
        let additional_slots = if payload.events.len() == payload.events.capacity() {
            payload.events.capacity().max(4)
        } else {
            0
        };
        // Charge the replacement allocation while the previous allocation is still live.
        let allocation_bytes = if additional_slots > 0 {
            payload
                .events
                .capacity()
                .saturating_add(additional_slots)
                .saturating_mul(std::mem::size_of::<StreamEvent>())
        } else {
            0
        };
        if !self
            .permit
            .as_mut()
            .is_some_and(|permit| permit.try_grow(bytes.saturating_add(allocation_bytes)))
        {
            self.discard();
            return;
        }
        if additional_slots > 0 && payload.events.try_reserve_exact(additional_slots).is_err() {
            self.discard();
            return;
        }
        payload.events.push(match event {
            StreamEvent::Error { error } => StreamEvent::Error {
                error: error.diagnostic_projection(),
            },
            _ => event.clone(),
        });
    }

    fn discard(&mut self) {
        drop(self.payload.take());
        drop(self.permit.take());
    }

    fn record_usage(&mut self, timestamp: u64) {
        if self.recorded || !self.armed {
            return;
        }
        self.recorded = true;
        if let Some(root) = &self.usage_root
            && let Err(error) = crate::usage_history::record_usage(
                root,
                &self.model,
                self.usage.as_ref(),
                timestamp,
            )
        {
            tracing::warn!("failed to persist token usage counters: {error}");
        }
    }

    pub fn finish(self, error: Option<&str>) {
        self.finish_internal(
            error.map(|_| kcoder_types::ProviderErrorSummary::new("unknown_error", None)),
            error.map_or(0, str::len),
        );
    }

    fn finish_internal(
        mut self,
        error: Option<kcoder_types::ProviderErrorSummary>,
        error_bytes: usize,
    ) {
        let timestamp = crate::now_millis();
        self.record_usage(timestamp);
        if error.is_some()
            && !self
                .permit
                .as_mut()
                .is_some_and(|permit| permit.try_grow(error_bytes))
        {
            self.discard();
        }
        if let (Some(mut payload), Some(permit)) = (self.payload.take(), self.permit.take()) {
            payload.timestamp = timestamp;
            payload.error = error;
            let job = Job {
                payload,
                _completion: self.completion.take().expect("capture owns its completion"),
            };
            permit.submit(Box::new(move || {
                let result = job.payload.write();
                if result.is_err() {
                    tracing::warn!("failed to persist LLM request/response artifact");
                }
                drop(job);
                result
            }));
        }
    }
}

impl Drop for LlmExchangeCapture {
    fn drop(&mut self) {
        self.record_usage(crate::now_millis());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use kcoder_types::{Message, MessageDeltaFields, MessagesRequest, StreamEvent, Usage};
    use std::time::{Duration, Instant};

    fn request() -> DiagnosticRequest {
        DiagnosticRequest::new(MessagesRequest::new(
            "test-model",
            vec![Message::user_text("hello")],
        ))
    }

    fn usage_event(output: u32) -> StreamEvent {
        StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 3,
                    output_tokens: output,
                    total_tokens: Some(3 + output),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(2),
                    iterations: Some(vec![kcoder_types::UsageIteration {
                        input_tokens: 3,
                        output_tokens: output,
                    }]),
                }),
            },
        }
    }

    fn state_at(tmp: &Path, writer: DiagnosticWriter) -> AppState {
        let state = AppState::new(tmp);
        let logs = tmp.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        state.with_llm_request_history_dir(logs, "session-a");
        state.set_usage_history_root(Some(&tmp.join("profile")));
        state.set_diagnostic_context(writer, None);
        state
    }

    fn block_writer(writer: &DiagnosticWriter) -> std::sync::mpsc::Sender<()> {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        writer.try_reserve(0).unwrap().submit(Box::new(move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        }));
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release_tx
    }

    fn counters(state: &AppState) -> crate::usage_history::UsageCounters {
        crate::usage_history::read_usage(&state.usage_history_root().unwrap())
            .unwrap()
            .unwrap()
            .days
            .values()
            .next()
            .unwrap()["test-model"]
            .clone()
    }

    fn records(dir: &Path) -> Vec<serde_json::Value> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                (path.extension().is_some_and(|ext| ext == "json"))
                    .then(|| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
            })
            .collect()
    }

    #[tokio::test]
    async fn workspace_flush_waits_for_other_states_usage_without_payload() {
        for no_target in [false, true] {
            for finish in [false, true] {
                let tmp = tempfile::tempdir().unwrap();
                let writer = DiagnosticWriter::with_limits(0, 0);
                let a = AppState::new(tmp.path());
                a.set_diagnostic_context(writer.clone(), None);
                let b = if no_target {
                    let b = AppState::new(tmp.path());
                    b.set_diagnostic_context(writer.clone(), None);
                    b.set_usage_history_root(Some(&tmp.path().join("profile")));
                    b
                } else {
                    state_at(tmp.path(), writer.clone())
                };
                let mut capture = b.begin_llm_exchange(request(), false).await;
                capture.observe(&usage_event(17));
                assert!(capture.payload.is_none());
                assert!(a.flush_diagnostics_until(Instant::now()).await);
                let premature = a.diagnostic_writer().flush_until(Instant::now());
                if finish {
                    capture.finish(None);
                } else {
                    drop(capture);
                }
                assert!(
                    !premature,
                    "workspace flush omitted another state's attempt"
                );
                assert!(a.diagnostic_writer().flush_until(Instant::now()));
                assert_eq!(counters(&b).requests, 1);
                assert_eq!(counters(&b).output_tokens, 17);
            }
        }
    }

    #[tokio::test]
    async fn workspace_close_keeps_existing_and_new_usage_attempts_tracked() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let state = state_at(tmp.path(), writer.clone());
        let mut existing = state.begin_llm_exchange(request(), false).await;
        existing.observe(&usage_event(11));
        writer.close();
        let mut rejected = state.begin_llm_exchange(request(), false).await;
        rejected.observe(&usage_event(17));
        assert!(rejected.payload.is_none());
        assert_eq!(writer.stats().pending_attempts, 2);
        assert!(!writer.flush_until(Instant::now()));
        existing.finish(None);
        assert_eq!(writer.stats().reserved_jobs, 0);
        assert_eq!(writer.stats().pending_attempts, 1);
        assert!(!writer.flush_until(Instant::now()));
        drop(rejected);
        assert!(writer.flush_until(Instant::now()));
        assert_eq!(counters(&state).requests, 2);
        assert_eq!(counters(&state).output_tokens, 28);
    }

    #[tokio::test]
    async fn no_target_and_overflow_still_keep_usage_scope_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        let capture = state.begin_llm_exchange(request(), false).await;
        assert!(!state.flush_diagnostics_until(Instant::now()).await);
        capture.finish(None);
        assert!(state.flush_diagnostics_until(Instant::now()).await);
        let state = state_at(tmp.path(), DiagnosticWriter::with_limits(2, 4096));
        let mut capture = state.begin_llm_exchange(request(), false).await;
        capture.observe(&StreamEvent::ContentBlockDelta {
            index: 0,
            delta: kcoder_types::ContentDelta::TextDelta {
                text: "x".repeat(8192),
            },
        });
        assert!(capture.payload.is_none());
        assert!(!state.flush_diagnostics_until(Instant::now()).await);
        capture.finish(None);
        assert!(state.flush_diagnostics_until(Instant::now()).await);
    }

    #[test]
    fn cancelled_blocking_preparation_does_not_record_unstarted_attempt() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let tmp = tempfile::tempdir().unwrap();
            let state = state_at(tmp.path(), DiagnosticWriter::default());
            let copied = state.clone();
            let preparing =
                tokio::spawn(async move { copied.begin_llm_exchange(request(), false).await });
            tokio::time::timeout(Duration::from_secs(2), async {
                while state.diagnostic_writer().stats().reserved_jobs == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            preparing.abort();
            assert!(preparing.await.is_err());
            assert!(
                !state
                    .usage_history_root()
                    .unwrap()
                    .join("usage.json")
                    .exists()
            );
            assert_eq!(state.diagnostic_writer().stats().reserved_jobs, 1);
            assert_eq!(state.diagnostic_writer().stats().pending_attempts, 1);
            assert!(!state.diagnostic_writer().flush_until(Instant::now()));
            assert!(!state.flush_diagnostics_until(Instant::now()).await);
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            assert!(
                state
                    .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                    .await
            );
            assert!(
                state
                    .diagnostic_writer()
                    .flush_until(Instant::now() + Duration::from_secs(2))
            );
            assert_eq!(state.diagnostic_writer().stats().pending_attempts, 0);
            assert!(
                !state
                    .usage_history_root()
                    .unwrap()
                    .join("usage.json")
                    .exists()
            );
        });
    }

    #[test]
    fn context_switch_during_begin_keeps_attempt_and_preparation_on_original_writer() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            });
            started_rx.await.unwrap();
            let owner =
                Arc::new(kcoder_config::create_private_temp_dir("diagnostic-context").unwrap());
            let old_root = owner.path().to_path_buf();
            let weak_owner = Arc::downgrade(&owner);
            let original = DiagnosticWriter::default();
            let replacement = DiagnosticWriter::default();
            let state = state_at(&old_root, original.clone());
            state.set_diagnostic_context(original.clone(), Some(owner));
            let copied = state.clone();
            let preparing =
                tokio::spawn(async move { copied.begin_llm_exchange(request(), false).await });
            tokio::time::timeout(Duration::from_secs(2), async {
                while original.stats().reserved_jobs == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            state.set_diagnostic_context(replacement.clone(), None);
            assert_eq!(original.stats().pending_attempts, 1);
            assert_eq!(replacement.stats().pending_attempts, 0);
            assert_eq!(replacement.stats().reserved_jobs, 0);
            assert!(weak_owner.upgrade().is_some());
            assert!(!original.flush_until(Instant::now()));
            assert!(replacement.flush_until(Instant::now()));
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            let mut capture = preparing.await.unwrap();
            assert!(capture.payload.is_some());
            assert_eq!(original.stats().reserved_jobs, 1);
            capture.observe(&usage_event(5));
            drop(capture);
            assert!(original.flush_until(Instant::now() + Duration::from_secs(2)));
            assert_eq!(original.stats().pending_attempts, 0);
            assert_eq!(replacement.stats().pending_attempts, 0);
            assert!(weak_owner.upgrade().is_none());
            assert!(!old_root.exists());
        });
    }

    #[tokio::test]
    async fn scope_exhaustion_never_claims_a_successful_flush() {
        let scope = Arc::new(Scope::default());
        scope.pending.lock().unwrap().0 = u64::MAX;
        let _guard = scope.begin();
        assert!(!scope.flush(Instant::now()).await);
    }

    #[tokio::test]
    async fn scope_snapshot_tracks_old_ids_not_later_completion_counts() {
        use std::future::Future;
        let scope = Arc::new(Scope::default());
        let first = scope.begin();
        let second = scope.begin();
        let flush = scope.flush(Instant::now() + Duration::from_secs(2));
        tokio::pin!(flush);
        std::future::poll_fn(|cx| {
            assert!(flush.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(second);
        let later = scope.begin();
        drop(scope.begin());
        std::future::poll_fn(|cx| {
            assert!(flush.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(first);
        assert!(flush.await);
        drop(later);
    }

    #[tokio::test]
    async fn scope_pending_set_is_bounded_and_degrades_explicitly() {
        let scope = Arc::new(Scope::default());
        let guards = (0..4097).map(|_| scope.begin()).collect::<Vec<_>>();
        assert_eq!(scope.pending.lock().unwrap().1.len(), 4096);
        assert!(!scope.flush(Instant::now()).await);
        drop(guards);
        assert!(!scope.flush(Instant::now()).await);
    }

    #[tokio::test]
    async fn relative_targets_and_usage_match_borrowed_process_cwd_semantics() {
        let process_cwd = std::env::current_dir().unwrap();
        let unrelated_cwd = tempfile::tempdir().unwrap();
        for subagent in [false, true] {
            let tmp = tempfile::tempdir_in(&process_cwd).unwrap();
            let relative_root = tmp.path().strip_prefix(&process_cwd).unwrap();
            let state = AppState::new(unrelated_cwd.path());
            state.with_history_path(relative_root.join("parent.jsonl"));
            if subagent {
                state.with_llm_request_history_dir(
                    crate::subagent_llm_request_history_dir_path(relative_root, "parent", "child"),
                    "child",
                );
            }
            state.set_usage_history_root(Some(&relative_root.join("profile")));
            let expected_logs = process_cwd.join(state.llm_request_history_dir().unwrap());
            let request = request();
            let event = usage_event(5);
            state.record_llm_exchange(request.request(), std::slice::from_ref(&event), None);
            assert_eq!(records(&expected_logs).len(), 1);
            let mut capture = state.begin_llm_exchange(request, false).await;
            capture.observe(&event);
            capture.finish(None);
            assert!(
                state
                    .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                    .await
            );
            assert_eq!(records(&expected_logs).len(), 2);
            assert_eq!(counters(&state).requests, 2);
            assert_eq!(counters(&state).output_tokens, 10);
            assert!(!unrelated_cwd.path().join(relative_root).exists());
        }
    }

    #[tokio::test]
    async fn error_budget_failure_and_closed_writer_release_owners_and_keep_usage() {
        for close in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let writer = DiagnosticWriter::with_limits(2, 8192);
            let state = state_at(tmp.path(), writer.clone());
            let mut capture = state.begin_llm_exchange(request(), false).await;
            capture.observe(&usage_event(12));
            if close {
                writer.close();
            }
            capture.finish(Some(&"x".repeat(if close { 0 } else { 16384 })));
            assert!(state.flush_diagnostics_until(Instant::now()).await);
            assert_eq!(writer.stats().reserved_jobs, 0);
            assert_eq!(counters(&state).requests, 1);
            assert_eq!(counters(&state).output_tokens, 12);
            assert!(records(&tmp.path().join("logs")).is_empty());
        }
    }

    #[tokio::test]
    async fn vector_growth_is_charged_before_event_payload_cloning() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let state = state_at(tmp.path(), writer.clone());
        let request = request();
        let request_bytes = request.retained_bytes.unwrap();
        let mut capture = state.begin_llm_exchange(request, false).await;
        for count in 1..=17 {
            capture.observe(&StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "x".repeat(1024),
                },
            });
            let payload = capture.payload.as_ref().unwrap();
            assert_eq!(payload.events.len(), count);
            assert!(
                writer.stats().reserved_bytes
                    >= request_bytes
                        + count * 1024
                        + payload.events.capacity() * std::mem::size_of::<StreamEvent>()
            );
        }
    }

    #[tokio::test]
    async fn provider_error_summary_capture_retains_typed_status_and_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_at(tmp.path(), DiagnosticWriter::default());
        let mut capture = state.begin_llm_exchange(request(), false).await;
        capture.observe(&StreamEvent::Error {
            error: kcoder_types::ApiError {
                error_type: "authentication_error".into(),
                message: "SENTINEL_PRIVATE Bearer multiple words".repeat(1000),
            },
        });
        capture.finish_with_summary(kcoder_types::ProviderErrorSummary::new(
            "authentication_error",
            Some(401),
        ));
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        let records = records(&tmp.path().join("logs"));
        let error = records[0]["response"]["error"].as_str().unwrap();
        assert!(error.contains("401"));
        assert!(error.contains("authentication_error"));
        assert!(
            !serde_json::to_string(&records)
                .unwrap()
                .contains("SENTINEL_PRIVATE")
        );
        assert!(error.len() <= 512);
    }

    #[tokio::test]
    async fn blocked_worker_finish_moves_shared_request_and_returns_before_sink() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let release = block_writer(&writer);
        let state = state_at(tmp.path(), writer.clone());
        let request = request();
        let mut capture = state.begin_llm_exchange(request.clone(), false).await;
        assert_eq!(Arc::strong_count(&request.request), 2);
        capture.observe(&usage_event(5));
        assert!(capture.usage.as_ref().unwrap().iterations.is_none());
        assert!(capture.payload.as_ref().unwrap().events.len() == 1);
        capture.finish(Some("provider failed"));
        assert_eq!(Arc::strong_count(&request.request), 2);
        assert_eq!(counters(&state).requests, 1);
        assert!(records(&tmp.path().join("logs")).is_empty());
        assert!(!state.flush_diagnostics_until(Instant::now()).await);
        release.send(()).unwrap();
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(Arc::strong_count(&request.request), 1);
        let records = records(&tmp.path().join("logs"));
        assert_eq!(
            records[0]["response"]["error"],
            kcoder_types::provider_error_summary("unknown_error", None)
        );
        assert_eq!(
            records[0]["response"]["usage"]["iterations"][0]["output_tokens"],
            5
        );
    }

    #[tokio::test]
    async fn full_writer_and_overflow_keep_last_usage_once() {
        for full in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let writer = DiagnosticWriter::with_limits(if full { 0 } else { 2 }, 4096);
            let state = state_at(tmp.path(), writer.clone());
            let mut capture = state.begin_llm_exchange(request(), false).await;
            capture.observe(&usage_event(1));
            capture.observe(&StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "x".repeat(8192),
                },
            });
            assert!(capture.payload.is_none());
            assert_eq!(writer.stats().reserved_jobs, 0);
            capture.observe(&usage_event(17));
            capture.finish(None);
            assert_eq!(counters(&state).requests, 1);
            assert_eq!(counters(&state).output_tokens, 17);
            assert!(records(&tmp.path().join("logs")).is_empty());
        }
    }

    #[tokio::test]
    async fn rejected_request_size_and_depth_count_one_drop_but_keep_usage() {
        for deep in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let writer = DiagnosticWriter::default();
            let state = state_at(tmp.path(), writer.clone());
            let mut value = MessagesRequest::new("test-model", Vec::new());
            if deep {
                let mut schema = serde_json::Value::Null;
                for _ in 0..100 {
                    schema = serde_json::Value::Array(vec![schema]);
                }
                value.response_json_schema =
                    Some(kcoder_types::ResponseJsonSchema::new("deep", schema));
            } else {
                value.system = Some(String::with_capacity(64 * 1024 * 1024 + 1));
            }
            let request = DiagnosticRequest::new(value);
            assert!(request.retained_bytes.is_none());
            let memory_state = AppState::new(tmp.path());
            memory_state
                .begin_llm_exchange(request.clone(), false)
                .await
                .finish(None);
            assert_eq!(memory_state.diagnostic_writer().stats().dropped, 0);
            let mut capture = state.begin_llm_exchange(request, false).await;
            assert!(capture.payload.is_none());
            capture.observe(&usage_event(13));
            capture.finish(None);
            assert_eq!(writer.stats().dropped, 1);
            assert_eq!(writer.stats().reserved_jobs, 0);
            assert_eq!(counters(&state).requests, 1);
            assert_eq!(counters(&state).output_tokens, 13);
        }
    }

    #[tokio::test]
    async fn cancelled_capture_records_usage_once_and_releases_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let state = state_at(tmp.path(), writer.clone());
        let mut capture = state.begin_llm_exchange(request(), false).await;
        capture.observe(&usage_event(9));
        drop(capture);
        assert_eq!(counters(&state).requests, 1);
        assert_eq!(counters(&state).output_tokens, 9);
        assert_eq!(writer.stats().reserved_bytes, 0);
        assert!(state.flush_diagnostics_until(Instant::now()).await);
        assert!(records(&tmp.path().join("logs")).is_empty());
    }

    #[tokio::test]
    async fn routing_and_usage_profile_are_frozen_before_state_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let release = block_writer(&writer);
        let state = state_at(tmp.path(), writer);
        let mut capture = state.begin_llm_exchange(request(), false).await;
        let previous_usage_root = state.usage_history_root().unwrap();
        capture.observe(&usage_event(6));
        let b = tmp.path().join("b");
        std::fs::create_dir(&b).unwrap();
        state.with_llm_request_history_dir(&b, "session-b");
        state.set_usage_history_root(Some(&tmp.path().join("profile-b")));
        capture.finish(None);
        release.send(()).unwrap();
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(
            records(&tmp.path().join("logs"))[0]["session_id"],
            "session-a"
        );
        assert!(records(&b).is_empty());
        assert!(previous_usage_root.join("usage.json").exists());
        assert!(!tmp.path().join("profile-b").exists());
    }

    #[tokio::test]
    async fn deleted_anchor_cannot_recreate_or_prune_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let release = block_writer(&writer);
        let state = AppState::new(tmp.path());
        state.with_session_artifact_project_dir(tmp.path(), "session-a");
        let root = crate::session_dir_path(tmp.path(), "session-a");
        std::fs::create_dir_all(&root).unwrap();
        state.set_diagnostic_context(writer, None);
        let capture = state.begin_llm_exchange(request(), false).await;
        capture.finish(None);
        std::fs::remove_dir(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        let replacement_logs = root.join("llm-requests");
        std::fs::create_dir(&replacement_logs).unwrap();
        for index in 0..35 {
            std::fs::write(replacement_logs.join(format!("{index:03}.json")), b"{}").unwrap();
        }
        release.send(()).unwrap();
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(records(&replacement_logs).len(), 35);
        assert_eq!(state.diagnostic_writer().stats().written, 1);
    }

    #[tokio::test]
    async fn queued_owner_lives_until_payload_release_not_writer_lifetime() {
        let owner =
            Arc::new(kcoder_config::create_private_temp_dir("kcoder-diagnostic-owner").unwrap());
        let weak = Arc::downgrade(&owner);
        let path = owner.path().to_path_buf();
        let writer = DiagnosticWriter::default();
        let release = block_writer(&writer);
        let state = state_at(&path, writer.clone());
        state.set_diagnostic_context(writer.clone(), Some(owner.clone()));
        let scope = state.diagnostic_context.scope.clone();
        state
            .begin_llm_exchange(request(), false)
            .await
            .finish(None);
        drop(owner);
        drop(state);
        assert!(weak.upgrade().is_some());
        release.send(()).unwrap();
        assert!(scope.flush(Instant::now() + Duration::from_secs(2)).await);
        assert!(weak.upgrade().is_none());
        assert!(!path.exists());
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(2)));
    }

    #[tokio::test]
    async fn state_scope_does_not_wait_for_another_states_long_capture() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let a = state_at(&tmp.path().join("a"), writer.clone());
        let b = state_at(&tmp.path().join("b"), writer.clone());
        let pending_b = b.begin_llm_exchange(request(), false).await;
        a.begin_llm_exchange(request(), false).await.finish(None);
        assert!(
            a.flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        assert!(!b.flush_diagnostics_until(Instant::now()).await);
        assert!(!writer.flush_until(Instant::now()));
        drop(pending_b);
    }

    #[tokio::test]
    async fn missing_targets_and_missing_session_roots_never_create_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state
            .begin_llm_exchange(request(), false)
            .await
            .finish(None);
        state.with_session_artifact_project_dir(tmp.path(), "missing");
        state
            .begin_llm_exchange(request(), false)
            .await
            .finish(None);
        state.with_llm_request_history_dir(tmp.path().join("missing-override"), "other");
        state.begin_llm_exchange(request(), true).await.finish(None);
        assert!(state.flush_diagnostics_until(Instant::now()).await);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fifo_in_log_directory_does_not_stall_this_or_another_states_job() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let a = state_at(&tmp.path().join("a"), writer.clone());
        let b = state_at(&tmp.path().join("b"), writer.clone());
        let logs = a.llm_request_history_dir().unwrap();
        let fifo = logs.join("block.json");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo_name is a valid NUL-terminated path owned exclusively by this test.
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        for state in [&a, &b] {
            let mut capture = state.begin_llm_exchange(request(), false).await;
            capture.observe(&usage_event(7));
            capture.finish(None);
        }
        let completed_without_writer = a
            .flush_diagnostics_until(Instant::now() + Duration::from_millis(500))
            .await;
        // Rescue the old blocking open before failing so no diagnostic worker leaks from a red test.
        let rescue = (!completed_without_writer).then(|| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
                .open(&fifo)
                .unwrap()
        });
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(2)));
        drop(rescue);
        assert!(
            completed_without_writer,
            "the first diagnostic stalled on FIFO pruning"
        );
        assert!(b.flush_diagnostics_until(Instant::now()).await);
        assert_eq!(writer.stats().written, 2);
        assert_eq!(counters(&a).requests, 1);
        assert_eq!(counters(&b).requests, 1);
        assert_eq!(counters(&a).output_tokens, 7);
        assert_eq!(counters(&b).output_tokens, 7);
        assert!(
            std::fs::symlink_metadata(&fifo)
                .unwrap()
                .file_type()
                .is_fifo()
        );
        assert_eq!(
            std::fs::read_dir(&logs)
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_file())
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn normal_and_memory_v2_prune_current_directory_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(tmp.path().join("session-a.jsonl"));
        let logs = state.llm_request_history_dir().unwrap();
        for memory in [false, true] {
            let mut request = MessagesRequest::new("test-model", vec![Message::user_text("hello")]);
            request.debug_session_id = Some("debug-a".into());
            request.reasoning_effort = Some(kcoder_types::ReasoningEffort::Custom("custom".into()));
            request.response_json_schema = Some(kcoder_types::ResponseJsonSchema::new(
                "result",
                serde_json::json!({"type":"object"}),
            ));
            let mut capture = state
                .begin_llm_exchange(DiagnosticRequest::new(request), memory)
                .await;
            capture.observe(&usage_event(8));
            capture.finish(None);
            assert!(
                state
                    .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                    .await
            );
            let dir = if memory {
                logs.join("session-memory")
            } else {
                logs.clone()
            };
            let first = records(&dir).pop().unwrap();
            assert_eq!(first["request_metadata"]["debug_session_id"], "debug-a");
            assert_eq!(first["request_metadata"]["reasoning_effort"], "custom");
            assert_eq!(first["request_metadata"]["has_response_json_schema"], true);
            assert_eq!(first["response"]["prompt_cache"]["status"], "hit");
            for index in 0..35 {
                std::fs::write(dir.join(format!("0000000000000-{index:03}.json")), b"{}").unwrap();
            }
            state
                .begin_llm_exchange(super::tests::request(), memory)
                .await
                .finish(None);
            assert!(
                state
                    .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                    .await
            );
            assert_eq!(records(&dir).len(), 30);
            assert!(!dir.join("0000000000000-000.json").exists());
        }
    }

    #[tokio::test]
    async fn diagnostic_capture_real_file_and_reliable_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        let logs = tmp.path().join("logs");
        std::fs::create_dir(&logs).unwrap();
        state.with_llm_request_history_dir(&logs, "session-a");
        state.set_usage_history_root(Some(&tmp.path().join("profile")));
        let request = DiagnosticRequest::new(MessagesRequest::new(
            "test-model",
            vec![Message::user_text("hello")],
        ));
        let shared = request.clone();
        assert!(std::ptr::eq(request.request(), shared.request()));
        let mut capture = state.begin_llm_exchange(request, false).await;
        capture.observe(&StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 3,
                    output_tokens: 4,
                    total_tokens: Some(7),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(2),
                    iterations: None,
                }),
            },
        });
        capture.finish(None);
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        let paths = std::fs::read_dir(&logs)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(paths.len(), 1);
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(paths[0].path()).unwrap()).unwrap();
        assert_eq!(record["schema"], "kcoder.llm_exchange.v2");
        assert_eq!(record["session_id"], "session-a");
        assert_eq!(record["response"]["usage"]["output_tokens"], 4);
        assert!(tmp.path().join("profile/usage.json").exists());
    }
}
