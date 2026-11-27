//! Owned idle polling. A stat change is a hint, never a delivery/wake grant.
use super::{
    idle_turn::{PeerIdleTurnContext, start_peer_idle_turn},
    service::PeerMessageService,
};
use crate::app_server::{ThreadManager, thread_runtime::PeerIdleRuntime, with_event_context};
use anyhow::{Context, Result, ensure};
use kcoder_engine::EngineEvent;
use kcoder_host_transport::protocol_io::notification;
use kcoder_state::{
    AppStateLifecycleIdentity, cross_session_messages::CrossSessionMessageObservationStamp,
};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const MAX_IDLE_JOBS: usize = 2;
const RETRY_DELAY: Duration = Duration::from_secs(2);

struct Hint {
    owner: AppStateLifecycleIdentity,
    stamp: Option<CrossSessionMessageObservationStamp>,
    empty: bool,
    retry_after: Instant,
}
struct Completed {
    thread: String,
    owner: AppStateLifecycleIdentity,
    stamp: Option<CrossSessionMessageObservationStamp>,
    empty: bool,
}
struct JobFinished(Arc<AtomicBool>);
impl Drop for JobFinished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
pub(in crate::app_server) struct PeerIdleDriver {
    context: PeerIdleTurnContext,
    cancel: CancellationToken,
    jobs: JoinSet<Completed>,
    maintenance: JoinSet<()>,
    in_flight: HashMap<String, Arc<AtomicBool>>,
    hints: HashMap<String, Hint>,
}
fn copy_context(context: &PeerIdleTurnContext) -> PeerIdleTurnContext {
    PeerIdleTurnContext {
        outbound: context.outbound.clone(),
        server_id: context.server_id.clone(),
        sequence: context.sequence.clone(),
        next_turn_id: context.next_turn_id.clone(),
        cancel: context.cancel.clone(),
        attended: context.attended,
    }
}
impl PeerIdleDriver {
    pub(in crate::app_server) fn verified_empty_pass_for(
        &self,
        thread: &str,
        owner: &AppStateLifecycleIdentity,
    ) -> bool {
        !self.in_flight.contains_key(thread)
            && self
                .hints
                .get(thread)
                .is_some_and(|hint| hint.empty && hint.owner.same_lifecycle(owner))
    }

    pub(in crate::app_server) fn completed_pass_for(
        &self,
        thread: &str,
        owner: &AppStateLifecycleIdentity,
    ) -> bool {
        !self.in_flight.contains_key(thread)
            && self
                .hints
                .get(thread)
                .is_some_and(|hint| hint.owner.same_lifecycle(owner))
    }
    pub(in crate::app_server) fn new(mut context: PeerIdleTurnContext) -> Self {
        let cancel = context.cancel.child_token();
        context.cancel = cancel.clone();
        Self {
            context,
            cancel,
            jobs: JoinSet::new(),
            maintenance: JoinSet::new(),
            in_flight: HashMap::new(),
            hints: HashMap::new(),
        }
    }
    /// Does not await a provider, filesystem body read or Source backchannel.
    /// Each spawned worker is tracked and owns only its selected runtime gate.
    pub(in crate::app_server) fn tick(
        &mut self,
        manager: &ThreadManager,
        service: Option<&Arc<PeerMessageService>>,
    ) {
        while let Some(result) = self.jobs.try_join_next() {
            if let Ok(done) = result {
                self.hints.insert(
                    done.thread,
                    Hint {
                        owner: done.owner,
                        stamp: done.stamp,
                        empty: done.empty,
                        retry_after: Instant::now() + RETRY_DELAY,
                    },
                );
            }
        }
        self.in_flight
            .retain(|_, finished| !finished.load(Ordering::Acquire));
        if self.cancel.is_cancelled() {
            return;
        }
        let Some(service) = service else {
            return;
        };
        while self.maintenance.try_join_next().is_some() {}
        if self.maintenance.is_empty() && service.has_loaded_mailbox() {
            let owner = service.clone();
            let cancel = self.cancel.clone();
            self.maintenance.spawn_blocking(move || {
                if !cancel.is_cancelled() {
                    // All reads are bounded regular-file metadata/queue reads;
                    // shutdown waits for this exact owned worker to finish.
                    let _ = owner.maintain_mailbox();
                }
            });
        }
        let observations = manager.peer_idle_observations();
        let current = observations
            .iter()
            .map(|row| row.thread_id.clone())
            .collect::<HashSet<_>>();
        self.hints.retain(|id, _| current.contains(id));
        for row in observations {
            if self.in_flight.len() >= MAX_IDLE_JOBS {
                break;
            }
            if self.in_flight.contains_key(&row.thread_id) {
                continue;
            }
            let stamp = row.stamp.unwrap_or_default();
            if let Some(hint) = self.hints.get(&row.thread_id)
                && hint.owner.same_lifecycle(&row.owner)
                && hint.stamp == stamp
            {
                // Only a verified empty queue may remain cold while its
                // namespace stamp is unchanged. Pending/unknown rows retry
                // fresh authorization even without a queue-file mutation.
                if hint.empty || Instant::now() < hint.retry_after {
                    continue;
                }
            }
            let Some(runtime) = manager.try_peer_idle_runtime(&row.thread_id) else {
                continue;
            };
            let context = copy_context(&self.context);
            let service = service.clone();
            let finished = Arc::new(AtomicBool::new(false));
            self.in_flight
                .insert(row.thread_id.clone(), finished.clone());
            self.jobs.spawn(async move {
                let _finished = JobFinished(finished);
                let outcome = run_idle(runtime, service, context).await;
                match outcome {
                    Ok(done) => done,
                    Err(_error) => Completed {
                        thread: row.thread_id,
                        owner: row.owner,
                        stamp,
                        empty: false,
                    },
                }
            });
        }
    }
    pub(in crate::app_server) async fn shutdown(&mut self) {
        self.cancel.cancel();
        while self.jobs.join_next().await.is_some() {}
        while self.maintenance.join_next().await.is_some() {}
        self.in_flight.clear();
        self.hints.clear();
    }
}
impl Drop for PeerIdleDriver {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.jobs.abort_all();
        self.maintenance.abort_all();
    }
}

async fn run_idle(
    runtime: PeerIdleRuntime,
    service: Arc<PeerMessageService>,
    context: PeerIdleTurnContext,
) -> Result<Completed> {
    runtime.verify_service(&service)?;
    let thread = runtime.engine.session_id();
    let owner = runtime.owner.clone();
    let apply_cancel = context.cancel.child_token();
    let apply_engine = runtime
        .engine
        .clone()
        .with_cancel_token(apply_cancel.clone());
    let apply = apply_engine.apply_peer_messages_at_idle();
    tokio::pin!(apply);
    let witnesses = tokio::select! {
        biased;
        _ = context.cancel.cancelled() => {
            apply_cancel.cancel();
            // The original call propagates cancellation to its bounded storage
            // worker. Drain it before releasing this actual registration/lease.
            let _ = apply.await;
            anyhow::bail!("peer_idle_owner_cancelled");
        },
        value = &mut apply => value.map_err(anyhow::Error::msg)?,
    };

    runtime.verify_owner()?;
    for witness in &witnesses {
        ensure!(
            witness.is_current()
                && witness
                    .target_state()
                    .shares_state_with(&runtime.engine.state),
            "peer_idle_history_owner_changed"
        );
        if !witness.newly_inserted_into_context() && witness.has_pending_idle_wake_admission() {
            continue;
        }
        // Keep the canonical Engine event as the presentation boundary. An idle
        // history update has no fabricated turn identity or user prompt.
        let event = EngineEvent::PeerAgentMessageAdded {
            history_uuid: witness.history_uuid().to_owned(),
            message: witness.message().clone(),
        };
        let notification = project_idle_event(&context, &thread, event)?;
        tokio::select! {
            biased;
            _ = context.cancel.cancelled() => anyhow::bail!("peer_idle_owner_cancelled"),
            sent = context.outbound.send(notification) => sent.context("peer_idle_output_closed")?,
        }
        runtime.verify_owner()?;
    }
    let queue_service = service.clone();
    let target = thread.clone();
    let mut observed = tokio::task::spawn_blocking(move || -> Result<_> {
        queue_service.require_enabled(false)?;
        let store = queue_service.mailbox()?;
        let before = store.observation_stamp()?;
        let empty = store.pending_for_target(&target)?.is_empty()
            && !store.has_pending_peer_idle_wake_for_target(&target)?;
        let after = store.observation_stamp()?;
        Ok((after.clone(), empty && before == after))
    });
    let (stamp, empty) = tokio::select! {
        biased;
        _ = context.cancel.cancelled() => {
            observed.abort();
            // The bounded regular-file read owns no provider/append authority.
            // Wait for an already-running read rather than detaching its handles.
            let _ = observed.await;
            anyhow::bail!("peer_idle_owner_cancelled");
        },
        value = &mut observed => value.context("peer_idle_observation_worker_failed")??,
    };

    runtime.verify_owner()?;
    // The runner consumes these exact original opaque admissions, rechecks wake
    // policy/budget and retains registration until the real ActiveTurn exists.
    if witnesses
        .iter()
        .any(|witness| witness.has_pending_idle_wake_admission())
    {
        let cancel = context.cancel.clone();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("peer_idle_owner_cancelled"),
            result = start_peer_idle_turn(runtime, witnesses, context) => {
                result?;

            },
        }
    }
    Ok(Completed {
        thread,
        owner,
        stamp: Some(stamp),
        empty,
    })
}

fn project_idle_event(
    context: &PeerIdleTurnContext,
    thread: &str,
    event: EngineEvent,
) -> Result<serde_json::Value> {
    let EngineEvent::PeerAgentMessageAdded {
        history_uuid,
        message,
    } = event
    else {
        anyhow::bail!("peer_idle_event_kind_changed");
    };
    let (metadata, text) = message
        .peer_agent_data()
        .context("peer_idle_message_metadata_missing")?;
    ensure!(
        metadata.target_thread_id == thread,
        "peer_idle_message_target_changed"
    );
    Ok(notification(
        "item/completed",
        with_event_context(
            &context.server_id,
            thread,
            None,
            &context.sequence,
            json!({"item":{"id":history_uuid,"type":"peerAgentMessage","role":"peer_agent","origin":"peer_agent",
            "agentMessage":metadata,"text":text,"status":"applied","timestamp":kcoder_app_events::now_millis()}}),
        ),
    ))
}
