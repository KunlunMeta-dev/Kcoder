//! Publish original wire notifications only after outbound capacity and current ownership are known.
use super::*;
use tokio::time::Instant;

const STREAM_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const MAX_READY_BATCH_FRAMES: usize = 128;
const MAX_BUFFERED_DELTA_BYTES: usize = 4 * 1024;

pub(in crate::app_server) enum StreamObservation {
    Exact(agent_run_constraint::AgentRunObservation),
    Parent {
        target: PathBuf,
        owner: std::sync::Weak<AtomicBool>,
    },
}

impl StreamObservation {
    pub(super) fn capture(
        engine: &QueryEngine,
        lease: &SessionLease,
        params: &AgentStreamSubscribeParams,
    ) -> Result<Self> {
        ensure_active_thread(engine, Some(lease), &params.thread_id)?;
        if let Some(expected) = &params.expected_background_run {
            return Ok(Self::Exact(
                agent_run_constraint::AgentRunObservation::capture(
                    engine,
                    lease,
                    &params.thread_id,
                    &params.agent_id,
                    expected,
                )?,
            ));
        }
        Ok(Self::Parent {
            target: lease.target().to_owned(),
            owner: lease.owner_liveness(),
        })
    }

    pub(super) fn verify(
        &self,
        engine: &QueryEngine,
        params: &AgentStreamSubscribeParams,
    ) -> Result<()> {
        match self {
            Self::Exact(exact) => exact.verify(engine),
            Self::Parent { target, owner } => {
                anyhow::ensure!(
                    owner
                        .upgrade()
                        .is_some_and(|alive| alive.load(Ordering::Acquire))
                        && *target == engine.session_lease_target()
                        && engine.session_id() == params.thread_id
                        && engine
                            .state
                            .is_subagent_of(&params.agent_id, &params.thread_id),
                    "agent_not_found_or_not_owned"
                );
                Ok(())
            }
        }
    }
}

pub(super) fn small_stream_delta(delta: &AgentConversationDelta) -> bool {
    match delta {
        AgentConversationDelta::Event(EngineEvent::AssistantTextDelta(text)) => {
            text.len() <= MAX_BUFFERED_DELTA_BYTES
        }
        AgentConversationDelta::ThinkingDelta { text, .. } => {
            text.as_str().len() <= MAX_BUFFERED_DELTA_BYTES
        }
        _ => false,
    }
}

pub(super) struct StreamDelivery<'a> {
    pub(super) pending: Vec<Value>,
    pub(super) next_flush: Instant,
    engine: &'a QueryEngine,
    observer: &'a StreamObservation,
    params: &'a AgentStreamSubscribeParams,
    outbound: &'a mpsc::Sender<Value>,
}

impl<'a> StreamDelivery<'a> {
    pub(super) fn new(
        engine: &'a QueryEngine,
        observer: &'a StreamObservation,
        params: &'a AgentStreamSubscribeParams,
        outbound: &'a mpsc::Sender<Value>,
    ) -> Self {
        Self {
            pending: Vec::new(),
            next_flush: Instant::now(),
            engine,
            observer,
            params,
            outbound,
        }
    }

    pub(super) fn should_flush(&self, immediate: bool) -> bool {
        !self.pending.is_empty()
            && (immediate
                || matches!(self.observer, StreamObservation::Parent { .. })
                || self.pending.len() >= MAX_READY_BATCH_FRAMES
                || Instant::now() >= self.next_flush)
    }

    pub(super) async fn flush(&mut self) -> Result<bool> {
        while !self.pending.is_empty() {
            // A blocked client can release just one slot. Never wait for a whole
            // window to fit, or use a verification performed before the wait.
            let count = self.pending.len().min(self.outbound.capacity().max(1));
            let mut permits = self
                .outbound
                .reserve_many(count)
                .await
                .context("app-server outbound queue closed")?;
            if let Err(error) = crate::app_server::task_spawn::blocking(|| {
                self.observer.verify(self.engine, self.params)
            }) {
                if let StreamObservation::Exact(exact) = self.observer {
                    let closed = exact.closed(&self.params.subscription_id, &error);
                    permits
                        .next()
                        .expect("at least one reserved slot")
                        .send(notification(
                            kcoder_app_protocol::AGENT_STREAM_CLOSED,
                            serde_json::to_value(closed)?,
                        ));
                }
                return Ok(false);
            }
            // All frames in this publication already exist. Never reuse this
            // verification for another wait, future delta, or connection.
            for (permit, frame) in permits.zip(self.pending.drain(..count)) {
                permit.send(frame);
            }
        }
        self.next_flush = Instant::now() + STREAM_FRAME_INTERVAL;
        Ok(true)
    }
}
