//! Actual cold targets enter the ordinary manager and peer idle driver. No
//! queue observation creates a User prompt, Goal, model loop or wake permit.
use super::{backchannel::PeerRouterBackchannel, service::PeerMessageService};
use crate::app_server::{
    AppServerEngineFactory, InteractionReceipts, ResidentTurnState, ThreadManager,
    connection_state::build_resident_thread_runtime_for_restore,
    session_discovery::session_directory::{
        DirectorySourceView,
        cold_target::{ColdPeerTargetFence, PreparedColdPeerTarget},
    },
    thread_runtime::ThreadRuntime,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::cross_session_router::{
    PeerRouterCheckOriginalParams, PeerRouterHistoryAccess, PeerRouterMessageV1,
};
use kcoder_state::{
    cross_session_messages::CrossSessionMessageRecord, peer_agent_history::PeerHistoryAccess,
};
use kcoder_types::session_address::SessionAddressV1;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicU64},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};
use tokio_util::sync::CancellationToken;
mod idle_handoff;
mod owned;
pub(in crate::app_server) use idle_handoff::{ColdIdleHandoff, ColdIdleObservation};
pub(crate) use owned::OwnedPeerColdTargets;
#[cfg(all(test, target_os = "linux"))]
mod tests;

#[derive(Clone)]
struct ContextOwner {
    factory: AppServerEngineFactory,
    service: Arc<PeerMessageService>,
    workspace: PathBuf,
    storage: PathBuf,
    history: Option<PathBuf>,
    bridge: Option<Arc<PeerRouterBackchannel>>,
    outbound: mpsc::Sender<Value>,
    server: String,
    sequence: Arc<AtomicU64>,
    interactions: Arc<AtomicU64>,
    receipts: Arc<Mutex<InteractionReceipts>>,
    cancel: CancellationToken,
    local_hosts: bool,
}
impl ColdPeerTargetFence for ContextOwner {
    fn check_current(&self, target: &SessionAddressV1) -> Result<()> {
        self.service.check_selected_cold_transport()?;
        ensure!(
            !self.cancel.is_cancelled()
                && self.service.identity()?.contains(target)
                && self.service.workspace_matches(&self.workspace),
            "peer_cold_target_owner_changed"
        );
        self.service.require_enabled(true)
    }
}
impl ContextOwner {
    fn view<'a>(
        &'a self,
        binding: &str,
        verify: &'a (dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<DirectorySourceView<'a>> {
        DirectorySourceView::from_host(
            &self.workspace,
            &self.storage,
            self.history.as_deref(),
            binding,
            verify,
        )
    }
}

pub(in crate::app_server) struct ColdTargetDriver {
    owner: ContextOwner,
    inventory: JoinSet<Result<ColdInventory>>,
    jobs: JoinSet<(String, Result<ThreadRuntime>)>,
    in_flight: HashSet<String>,
    task_ids: HashMap<tokio::task::Id, String>,
    cursor: Option<String>,
    candidates: VecDeque<String>,
    next_inventory: Instant,
    retry_hints: HashMap<String, ColdRetryHint>,
    generations: HashMap<String, u64>,
    #[cfg(test)]
    restore_errors: Vec<String>,
}
struct ColdInventory {
    targets: Vec<(String, u64)>,
}
struct ColdRetryHint {
    /// The target's newest queued sequence when the attempt was scheduled.
    generation: Option<u64>,
    backoff: ColdRetryBackoff,
}
#[derive(Debug, Clone)]
struct ColdWakeFailure {
    message_id: String,
    reason: &'static str,
}
impl std::fmt::Display for ColdWakeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for ColdWakeFailure {}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColdWakeStage {
    /// Observation, kernel lease and history preparation before any Engine exists.
    Prepare,
    /// Source check, Engine restore and final verification.
    Restore,
}

/// Closed deferred reasons. The receipt stays `queued`; a reason only explains
/// why this automatic wake attempt did not start and never settles the message.
fn cold_wake_reason(error: &anyhow::Error, stage: ColdWakeStage) -> &'static str {
    let messages = error
        .chain()
        .map(|cause| cause.to_string())
        .collect::<Vec<_>>();
    let is = |code: &str| messages.iter().any(|message| message == code);
    let contains = |code: &str| messages.iter().any(|message| message.contains(code));
    let typed_timeout = error.chain().any(|cause| {
        cause.is::<tokio::time::error::Elapsed>()
            || cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::TimedOut)
    });
    if is("peer_cold_target_archived") {
        "cold_target_archived"
    } else if is("peer_cold_target_original_turn_unsettled")
        || is("peer_cold_target_terminal_unobserved")
    {
        "cold_target_original_turn_unsettled"
    } else if is("observed session still has its original owner")
        || is("observed session lease was replaced during acquisition")
    {
        // Another owner (an open client, another process or an in-flight
        // resume) holds the session; it delivers the queue once resident.
        "cold_target_lease_busy"
    } else if is("CHAT_TASK_LIFECYCLE_BUSY") {
        "cold_target_lifecycle_busy"
    } else if is("peer_cold_target_source_check") {
        "cold_target_source_unavailable"
    } else if contains("history_catalog_busy")
        || is("history_job_execution_busy")
        || is("history_retirement_observation_busy")
    {
        "cold_target_history_busy"
    } else if typed_timeout || contains("_timeout") {
        "cold_target_timeout"
    } else if is("peer_cold_target_independent_session_required") {
        "cold_target_not_independent"
    } else if [
        "peer_cold_target_scope_changed",
        "peer_cold_target_restore_scope_changed",
        "peer_cold_target_owner_changed",
        "peer_cold_target_workspace_unobserved",
        "peer_cold_target_selected_transport_unavailable",
    ]
    .iter()
    .any(|code| is(code))
    {
        "cold_target_scope_changed"
    } else {
        match stage {
            ColdWakeStage::Prepare => "cold_target_restore_preparation_failed",
            ColdWakeStage::Restore => "cold_target_restore_unavailable",
        }
    }
}

fn failed_wake(
    error: anyhow::Error,
    record: &CrossSessionMessageRecord,
    stage: ColdWakeStage,
) -> anyhow::Error {
    let reason = cold_wake_reason(&error, stage);
    error.context(ColdWakeFailure {
        message_id: record.receipt.message_id.clone(),
        reason,
    })
}

/// Per-target exponential backoff. Unrelated namespace writes (other targets,
/// maintenance, the deferred-reason note itself) must not reset it, otherwise
/// a busy workspace retries a failing restore on every inventory pass.
#[derive(Debug, Clone, Copy)]
struct ColdRetryBackoff {
    until: Instant,
    delay: Duration,
}
const COLD_RETRY_MIN: Duration = Duration::from_secs(2);
const COLD_RETRY_MAX: Duration = Duration::from_secs(60);
impl ColdRetryBackoff {
    fn after_failure(previous: Option<&Self>, now: Instant) -> Self {
        let delay = previous.map_or(COLD_RETRY_MIN, |previous| {
            (previous.delay * 2).min(COLD_RETRY_MAX)
        });
        Self {
            until: now + delay,
            delay,
        }
    }
    fn ready(&self, now: Instant) -> bool {
        now >= self.until
    }
}

impl ColdTargetDriver {
    fn defer_target(&mut self, thread: String) {
        let generation = self.generations.get(&thread).copied();
        let backoff = ColdRetryBackoff::after_failure(
            self.retry_hints.get(&thread).map(|hint| &hint.backoff),
            Instant::now(),
        );
        if self.retry_hints.len() >= 128
            && !self.retry_hints.contains_key(&thread)
            && let Some(oldest) = self
                .retry_hints
                .iter()
                .min_by_key(|(_, hint)| hint.backoff.until)
                .map(|(id, _)| id.clone())
        {
            self.retry_hints.remove(&oldest);
        }
        self.retry_hints.insert(
            thread,
            ColdRetryHint {
                generation,
                backoff,
            },
        );
    }
    fn note_retired(&mut self, runtime: &ThreadRuntime, empty: bool) {
        let id = runtime.engine().session_id();
        if empty {
            self.retry_hints.remove(&id);
        } else {
            self.defer_target(id);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::app_server) fn new(
        factory: AppServerEngineFactory,
        service: Arc<PeerMessageService>,
        storage: PathBuf,
        bridge: Option<Arc<PeerRouterBackchannel>>,
        outbound: mpsc::Sender<Value>,
        server: String,
        sequence: Arc<AtomicU64>,
        interactions: Arc<AtomicU64>,
        receipts: Arc<Mutex<InteractionReceipts>>,
        local_hosts: bool,
        cancel: Option<CancellationToken>,
    ) -> Result<Self> {
        let workspace = factory.continuation_workspace().to_owned();
        ensure!(
            service.workspace_matches(&workspace)
                && dunce::canonicalize(factory.profile_paths()?.config_dir)?
                    == dunce::canonicalize(service.profile_path())?,
            "peer_cold_factory_owner_changed"
        );
        let cancel = cancel.unwrap_or_default();
        service.bind_cold_target_owner(cancel.clone())?;
        let owner = ContextOwner {
            history: factory.peer_message_history_directory(),
            factory,
            service,
            workspace,
            storage,
            bridge,
            outbound,
            server,
            sequence,
            interactions,
            receipts,
            cancel,
            local_hosts,
        };
        Ok(Self {
            owner,
            inventory: JoinSet::new(),
            jobs: JoinSet::new(),
            in_flight: HashSet::new(),
            task_ids: HashMap::new(),
            cursor: None,
            candidates: VecDeque::new(),
            next_inventory: Instant::now(),
            retry_hints: HashMap::new(),
            generations: HashMap::new(),
            #[cfg(test)]
            restore_errors: Vec::new(),
        })
    }

    pub(in crate::app_server) async fn tick(&mut self, manager: &mut ThreadManager) {
        while let Some(result) = self.jobs.try_join_next() {
            if let Ok((thread, runtime)) = result {
                self.task_ids.retain(|_, owner| owner != &thread);
                self.in_flight.remove(&thread);
                if let Ok(runtime) = runtime {
                    // A started restore resets the backoff; a later non-empty
                    // retirement records its own retry hint.
                    self.retry_hints.remove(&thread);
                    if self.owner.cancel.is_cancelled()
                        || self.owner.service.check_selected_cold_transport().is_err()
                        || self.owner.service.require_enabled(true).is_err()
                    {
                        runtime.shutdown().await;
                    } else {
                        match manager.insert_cold_peer(runtime) {
                            Ok(Some(evicted)) => {
                                evicted.shutdown().await;
                            }
                            Err(rejected) => {
                                (*rejected).shutdown().await;
                            }
                            Ok(None) => {}
                        }
                    }
                } else if let Err(_error) = runtime {
                    let reason = _error
                        .downcast_ref::<ColdWakeFailure>()
                        .map_or("cold_target_restore_unavailable", |failure| failure.reason);
                    self.defer_target(thread.clone());
                    #[cfg(test)]
                    if self.restore_errors.len() < 16 {
                        self.restore_errors.push(format!("{thread}: {_error:#}"));
                    }
                    let retry_after_ms = self
                        .retry_hints
                        .get(&thread)
                        .map_or(0, |hint| hint.backoff.delay.as_millis() as u64);
                    // The queued message is untouched; only this wake attempt deferred.
                    tracing::warn!(code = "peer_cold_target_restore_unavailable", thread_id = %thread,
                        reason, retry_after_ms,
                        "Original cold target requires reconciliation");
                }
                manager.release_cold_peer(&thread);
            } else if let Err(error) = result
                && let Some(thread) = self.task_ids.remove(&error.id())
            {
                self.in_flight.remove(&thread);
                manager.release_cold_peer(&thread);
            }
        }
        while let Some(result) = self.inventory.try_join_next() {
            match result {
                Ok(Ok(ColdInventory { targets })) => {
                    self.cursor = targets.last().map(|(target, _)| target.clone());
                    if self.generations.len() > 256 {
                        self.generations.clear();
                    }
                    for (target, generation) in &targets {
                        self.generations.insert(target.clone(), *generation);
                    }
                    self.candidates = targets.into_iter().map(|(target, _)| target).collect();
                }
                Ok(Err(_error)) =>
                {
                    #[cfg(test)]
                    if self.restore_errors.len() < 16 {
                        self.restore_errors
                            .push(format!("cold inventory: {_error:#}"));
                    }
                }
                Err(_) => {}
            }
        }
        if self.owner.cancel.is_cancelled()
            || self.owner.service.check_selected_cold_transport().is_err()
        {
            return;
        }
        if self.inventory.is_empty()
            && Instant::now() >= self.next_inventory
            && self.owner.service.has_loaded_mailbox()
        {
            self.next_inventory = Instant::now() + Duration::from_secs(2);
            let owner = self.owner.clone();
            let cursor = self.cursor.clone();
            self.inventory.spawn_blocking(move || {
                ensure!(
                    !owner.cancel.is_cancelled(),
                    "peer_cold_target_owner_closed"
                );
                owner.service.require_enabled(true)?;
                owner.service.check_selected_cold_transport()?;
                let store = owner.service.mailbox()?;
                let before = store.observation_stamp()?;
                let targets = store.cold_wake_target_generations_after(8, cursor.as_deref())?;
                let stamp = store.observation_stamp()?;
                ensure!(before == stamp, "peer_cold_inventory_changed");
                Ok(ColdInventory { targets })
            });
        }
        while self.jobs.len() < 2 {
            let Some(thread) = self.candidates.pop_front() else {
                break;
            };
            if self.in_flight.contains(&thread) || manager.is_resume_preparing(&thread) {
                continue;
            }
            // Back off per target. The shared namespace stamp also moves for
            // unrelated targets and for the deferred-reason note itself, which
            // previously reset the delay; only a newly queued message for this
            // target rechecks early, and its delay history is kept.
            if let Some(hint) = self.retry_hints.get(&thread)
                && hint.generation == self.generations.get(&thread).copied()
                && !hint.backoff.ready(Instant::now())
            {
                continue;
            }
            let Ok(evicted) = manager.reserve_cold_peer(&thread) else {
                if manager.engine(&thread).is_none() {
                    // Resident capacity is full of active runtimes. Explain the
                    // deferral once per backoff window; never spin on it.
                    self.in_flight.insert(thread.clone());
                    let owner = self.owner.clone();
                    let held_thread = thread.clone();
                    let job = self.jobs.spawn(async move {
                        let explained = thread.clone();
                        let captured = owner.clone();
                        let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                            let record = trigger(&captured, &explained)?;
                            captured.check_current(&captured.service.address(&explained)?)?;
                            captured.service.mailbox()?.note_cold_wake_deferred(
                                &record.receipt.message_id,
                                "cold_target_resident_capacity",
                            )
                        })
                        .await;
                        let failure = ColdWakeFailure {
                            message_id: String::new(),
                            reason: "cold_target_resident_capacity",
                        };
                        (thread, Err(anyhow::Error::new(failure)))
                    });
                    self.task_ids.insert(job.id(), held_thread);
                }
                continue;
            };
            if let Some(evicted) = evicted {
                evicted.shutdown().await;
            }
            self.in_flight.insert(thread.clone());

            let owner = self.owner.clone();
            let held_thread = thread.clone();
            let job = self.jobs.spawn(async move {
                let started = Instant::now();
                let runtime = activate(&owner, &thread).await;
                if let Err(error) = &runtime {
                    let reason = error
                        .downcast_ref::<ColdWakeFailure>()
                        .map_or("cold_target_restore_unavailable", |failure| failure.reason);
                    // Bounded, deduplicated diagnostics keep the closed reason and
                    // the innermost closed code; raw causes never leave the host.
                    super::errors::report_failure(
                        "cold.wake",
                        "app_server_cold_target",
                        reason,
                        Some(error),
                        started,
                    );
                }
                if let Err(error) = &runtime
                    && let Some(failure) = error.downcast_ref::<ColdWakeFailure>().cloned()
                {
                    let captured = owner.clone();
                    let explained_thread = thread.clone();
                    // This tracked restore job owns the explanation write;
                    // ordinary resource observations never mutate receipts.
                    let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                        captured.check_current(&captured.service.address(&explained_thread)?)?;
                        captured
                            .service
                            .mailbox()?
                            .note_cold_wake_deferred(&failure.message_id, failure.reason)
                    })
                    .await;
                }
                (thread, runtime)
            });
            self.task_ids.insert(job.id(), held_thread);
        }
    }
    pub(in crate::app_server) async fn shutdown(&mut self, manager: &mut ThreadManager) {
        self.owner.cancel.cancel();
        while let Some(result) = self.jobs.join_next().await {
            if let Ok((thread, runtime)) = result {
                if let Ok(runtime) = runtime {
                    runtime.shutdown().await;
                }
                manager.release_cold_peer(&thread);
            }
        }
        while self.inventory.join_next().await.is_some() {}
        for thread in self.in_flight.drain() {
            manager.release_cold_peer(&thread);
        }
    }
}

impl Drop for ColdTargetDriver {
    fn drop(&mut self) {
        self.owner.cancel.cancel();
        self.jobs.abort_all();
        self.inventory.abort_all();
    }
}

fn trigger(owner: &ContextOwner, thread: &str) -> Result<CrossSessionMessageRecord> {
    owner.service.require_enabled(true)?;
    let record = owner
        .service
        .mailbox()?
        .cold_wake_trigger_for_target(thread)?
        .context("peer_cold_target_original_wake_unavailable")?;
    if owner.local_hosts {
        let source = record
            .source
            .address
            .as_ref()
            .context("peer_cold_target_original_source_required")?;
        ensure!(
            owner
                .service
                .authority()?
                .store()?
                .read_incoming(source, &record.intent.client_message_id)?
                .is_none(),
            "peer_cold_target_native_catalog_route_required"
        );
    }
    Ok(record)
}

async fn fresh_source(
    owner: &ContextOwner,
    prepared: &PreparedColdPeerTarget,
    record: &CrossSessionMessageRecord,
) -> Result<()> {
    let destination = owner.service.address(&record.intent.target_thread_id)?;
    owner.check_current(&destination)?;
    let source = record
        .source
        .address
        .as_ref()
        .context("peer_cold_target_original_source_required")?;
    let incoming = owner
        .service
        .authority()?
        .store()?
        .read_incoming(source, &record.intent.client_message_id)?;
    if incoming.is_some() {
        let incoming =
            super::remote_delivery::validate_cold_import(&owner.service, record, &destination)?;
        let bridge = owner
            .bridge
            .as_ref()
            .context("peer_cold_target_current_route_unavailable")?;
        bridge
            .verify_cold_target_original(
                &owner.service,
                &destination,
                &prepared.history_path(),
                &prepared.native_lease()?,
                PeerRouterCheckOriginalParams {
                    attestation: incoming.attestation,
                    access: PeerRouterHistoryAccess::Wake,
                    message: Some(PeerRouterMessageV1 {
                        reply_to_message_id: record.intent.reply_to_message_id.clone(),
                        client_message_id: record.intent.client_message_id.clone(),
                        mode: record.intent.mode,
                        expected_turn_id: record.intent.expected_turn_id.clone(),
                        text: record.intent.text.clone(),
                    }),
                },
            )
            .await?;
    } else {
        let service = owner.service.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || {
            let cold = service.cold_source_verifier()?;
            crate::peer_sessions::cold_source::verify_local_source_for_delivery(
                &service,
                &record,
                PeerHistoryAccess::Wake,
                cold.as_deref(),
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("peer_cold_target_source_worker_unavailable")??;
    }
    owner.check_current(&destination)
}

async fn activate(owner: &ContextOwner, thread: &str) -> Result<ThreadRuntime> {
    let address = owner.service.address(thread)?;
    owner.check_current(&address)?;
    let captured = owner.clone();
    let target = address.clone();
    let (mut prepared, record) = tokio::task::spawn_blocking(move || {
        let record = trigger(&captured, &target.thread_id)?;
        let verify = || captured.check_current(&target);
        let binding = format!("peer-cold-target-{}", target.thread_id);
        let view = captured
            .view(&binding, &verify)
            .map_err(|error| failed_wake(error, &record, ColdWakeStage::Prepare))?;
        let prepared =
            PreparedColdPeerTarget::prepare_wake(&captured.service, &view, &target, &captured)
                .map_err(|error| failed_wake(error, &record, ColdWakeStage::Prepare))?;
        Ok::<_, anyhow::Error>((prepared, record))
    })
    .await
    .context("peer_cold_target_prepare_worker_unavailable")??;
    let result = async {
        fresh_source(owner, &prepared, &record)
            .await
            .context("peer_cold_target_source_check")?;
        let verify = || owner.check_current(&address);
        let binding = format!("peer-cold-target-{}", address.thread_id);
        let view = owner.view(&binding, &verify)?;
        let template = prepared
            .settings_template()
            .map(|binding| {
                kcoder_config::settings_templates::SettingsTemplateStore::open(
                    owner.service.profile_path(),
                )?
                .observe_recorded_session_path(binding)
            })
            .transpose()?;
        let permission = prepared.permission_mode_at_creation();
        let count = prepared.client_turn_count();
        let material = prepared.take_prepared(&owner.service, &view, owner)?;
        let mut turn_state = ResidentTurnState::new(
            owner.outbound.clone(),
            kcoder_config::PermissionMode::DontAsk,
            owner.interactions.clone(),
            owner.receipts.clone(),
        );
        let (engine, _, _) = owner
            .factory
            .resume_cold_peer_target(
                prepared.artifact_root(),
                prepared.artifact_identity(),
                template,
                permission,
                material,
                turn_state.user_questioner.clone(),
            )
            .await?;
        let checked = async {
            fresh_source(owner, &prepared, &record)
                .await
                .context("peer_cold_target_source_check")?;
            prepared.finish_restore(&engine, &owner.service, &view, owner)
        }
        .await;
        if let Err(error) = checked {
            let retirement = engine.state.capture_history_writer_retirement()?;
            retirement.request_retirement();
            retirement.retain_until_writer_released(prepared);
            return Err(error);
        }
        let (lease, artifacts) = prepared.into_restored()?;
        turn_state.configure_for_engine(&engine);
        engine.activate_client_session();
        let runtime = build_resident_thread_runtime_for_restore(
            engine,
            lease,
            count,
            turn_state,
            owner.outbound.clone(),
            owner.server.clone(),
            owner.sequence.clone(),
            false,
        )
        .with_cold_peer_artifacts(artifacts);
        Ok(if owner.local_hosts {
            runtime.with_local_peer_hosts()
        } else {
            runtime
        })
    };
    result
        .await
        .map_err(|error| failed_wake(error, &record, ColdWakeStage::Restore))
}

#[cfg(test)]
mod wake_reason_tests {
    use super::*;

    fn chain(codes: &[&'static str]) -> anyhow::Error {
        let mut iter = codes.iter().rev();
        let mut error = anyhow::anyhow!(*iter.next().unwrap());
        for code in iter {
            error = error.context(*code);
        }
        error
    }

    #[tokio::test]
    async fn real_restore_causes_are_not_collapsed_into_the_catch_all() {
        use ColdWakeStage::{Prepare, Restore};
        let cases: &[(&[&'static str], ColdWakeStage, &str)] = &[
            (
                &["peer_cold_target_archived"],
                Prepare,
                "cold_target_archived",
            ),
            (
                &["peer_cold_target_original_turn_unsettled"],
                Prepare,
                "cold_target_original_turn_unsettled",
            ),
            (
                &[
                    "observed session still has its original owner",
                    "Resource temporarily unavailable",
                ],
                Prepare,
                "cold_target_lease_busy",
            ),
            (
                &["CHAT_TASK_LIFECYCLE_BUSY"],
                Prepare,
                "cold_target_lifecycle_busy",
            ),
            (
                &[
                    "peer_cold_target_source_check",
                    "peer_message_router_outcome_unknown",
                    "peer_message_router_timeout",
                ],
                Restore,
                "cold_target_source_unavailable",
            ),
            (
                &["history_catalog_busy"],
                Restore,
                "cold_target_history_busy",
            ),
            (
                &["peer_message_router_timeout"],
                Restore,
                "cold_target_timeout",
            ),
            (
                &["peer_cold_target_independent_session_required"],
                Prepare,
                "cold_target_not_independent",
            ),
            (
                &["peer_cold_target_restore_scope_changed"],
                Prepare,
                "cold_target_scope_changed",
            ),
            (
                &["unexplained private detail /home/user"],
                Prepare,
                "cold_target_restore_preparation_failed",
            ),
            (
                &["unexplained private detail /home/user"],
                Restore,
                "cold_target_restore_unavailable",
            ),
        ];
        for (codes, stage, expected) in cases {
            let reason = cold_wake_reason(&chain(codes), *stage);
            assert_eq!(reason, *expected, "{codes:?}");
            assert!(
                kcoder_state::cross_session_messages::COLD_WAKE_DEFERRED_REASONS.contains(&reason),
                "{reason} must be accepted by the store"
            );
        }
        let elapsed = tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>())
            .await
            .unwrap_err();
        assert_eq!(
            cold_wake_reason(&anyhow::Error::new(elapsed), Restore),
            "cold_target_timeout"
        );
    }

    #[test]
    fn repeated_failures_back_off_instead_of_spinning() {
        let now = Instant::now();
        let first = ColdRetryBackoff::after_failure(None, now);
        assert_eq!(first.delay, COLD_RETRY_MIN);
        assert!(!first.ready(now));
        assert!(first.ready(now + COLD_RETRY_MIN));
        let mut previous = first;
        for _ in 0..10 {
            let next = ColdRetryBackoff::after_failure(Some(&previous), now);
            assert!(next.delay >= previous.delay);
            assert!(next.delay <= COLD_RETRY_MAX);
            previous = next;
        }
        assert_eq!(previous.delay, COLD_RETRY_MAX);
    }
}
