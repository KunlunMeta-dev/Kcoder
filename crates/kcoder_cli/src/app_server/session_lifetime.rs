//! The original task host owns attachments and session survival, not UI submitters.
use super::*;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub(super) const RECONNECT_GRACE: Duration = Duration::from_secs(3);
const ATTACH_TTL: Duration = Duration::from_secs(90);

struct AttachedClient {
    owner: std::sync::Weak<dyn Send + Sync>,
    ended: CancellationToken,
    generation: String,
    renewed: Option<Instant>,
}

#[derive(Default)]
struct Activity {
    clients: BTreeMap<(usize, String), AttachedClient>,
    retired: BTreeMap<(usize, String), Instant>,
    empty_since: Option<Instant>,
}

#[derive(Default)]
pub(super) struct SessionActivity(
    StdMutex<Activity>,
    StdMutex<Option<Arc<dyn thread_runtime::PreparedThreadOwnerFence>>>,
);

impl Activity {
    fn count(&mut self, now: Instant) -> usize {
        self.retired.retain(|_, until| *until > now);
        self.clients.retain(|key, client| {
            let valid = client.owner.upgrade().is_some()
                && !client.ended.is_cancelled()
                && client
                    .renewed
                    .is_none_or(|renewed| now.saturating_duration_since(renewed) < ATTACH_TTL);
            if !valid && self.retired.len() < 256 {
                self.retired.insert(key.clone(), now + ATTACH_TTL);
            }
            valid
        });
        if self.clients.is_empty() {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
        self.clients.len()
    }

    fn stop_due(&mut self, now: Instant, authorized: bool) -> bool {
        if self.count(now) > 0 || authorized {
            self.empty_since = None;
            return false;
        }
        now.saturating_duration_since(*self.empty_since.get_or_insert(now)) >= RECONNECT_GRACE
    }
}

impl SessionActivity {
    pub(super) fn retain_background_authority(
        &self,
        fence: Arc<dyn thread_runtime::PreparedThreadOwnerFence>,
    ) {
        *self.1.lock().unwrap() = Some(fence);
    }
    pub(super) fn background_authorized(&self) -> bool {
        self.1
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|fence| fence.allows_ui_resume() && fence.verify().is_ok())
    }
    pub(super) fn admits(&self, engine: &QueryEngine) -> bool {
        self.allowed(
            !engine.native_input_requires_source_admission() || self.background_authorized(),
        )
    }

    pub(super) fn attach(
        &self,
        state: &ConnectionState,
        client_id: &str,
        generation: &str,
    ) -> Result<()> {
        ensure!(
            !state.native_source_dispatch && !state.input_ended.is_cancelled(),
            "SESSION_ATTACH_REAL_CLIENT_REQUIRED"
        );
        let owner: Arc<dyn Send + Sync> = state.source_management_owner.clone();
        self.attach_owner(
            &owner,
            state.input_ended.clone(),
            client_id,
            generation,
            Some(Instant::now()),
        )
    }

    /// An in-process observer has no network heartbeat. Its actual owner and
    /// original caller cancellation end the attachment, without background grants.
    pub(super) fn attach_runtime(
        &self,
        owner: &Arc<dyn Send + Sync>,
        ended: CancellationToken,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        self.attach_owner(owner, ended, &id, &id, None)
    }

    fn attach_owner(
        &self,
        owner: &Arc<dyn Send + Sync>,
        ended: CancellationToken,
        client_id: &str,
        generation: &str,
        renewed: Option<Instant>,
    ) -> Result<()> {
        ensure!(!ended.is_cancelled(), "SESSION_ATTACH_REAL_CLIENT_REQUIRED");
        ensure!(
            uuid::Uuid::parse_str(client_id).is_ok() && uuid::Uuid::parse_str(generation).is_ok(),
            "SESSION_ATTACH_ID_INVALID"
        );
        let mut activity = self.0.lock().unwrap();
        let now = Instant::now();
        activity.count(now);
        let key = (Arc::as_ptr(owner) as *const () as usize, client_id.into());
        ensure!(
            !activity.retired.contains_key(&key),
            "SESSION_ATTACH_RETIRED"
        );
        ensure!(
            activity.clients.contains_key(&key)
                || (activity.clients.len() < 128
                    && activity.clients.len() + activity.retired.len() < 256),
            "SESSION_ATTACH_CAPACITY"
        );
        if let Some(current) = activity.clients.get_mut(&key) {
            // Renewals cannot overwrite a later incarnation. A reconnect uses
            // a fresh client slot instead of guessing which generation is newer.
            ensure!(
                current.generation == generation,
                "SESSION_ATTACH_GENERATION_CONFLICT"
            );
            current.renewed = renewed;
        } else {
            activity.clients.insert(
                key,
                AttachedClient {
                    owner: Arc::downgrade(owner),
                    ended,
                    generation: generation.into(),
                    renewed,
                },
            );
        }
        activity.empty_since = None;
        Ok(())
    }

    pub(super) fn detach(&self, state: &ConnectionState, client_id: &str, generation: &str) {
        let mut activity = self.0.lock().unwrap();
        let key = (
            Arc::as_ptr(&state.source_management_owner) as usize,
            client_id.into(),
        );
        if activity
            .clients
            .get(&key)
            .is_some_and(|client| client.generation == generation)
        {
            activity.clients.remove(&key);
            if activity.retired.len() < 256 {
                activity.retired.insert(key, Instant::now() + ATTACH_TTL);
            }
        }
        activity.count(Instant::now());
    }

    pub(super) fn count(&self) -> usize {
        self.0.lock().unwrap().count(Instant::now())
    }

    pub(super) fn allowed(&self, authorized: bool) -> bool {
        self.count() > 0 || authorized
    }

    fn stop_due(&self, authorized: bool) -> bool {
        self.0.lock().unwrap().stop_due(Instant::now(), authorized)
    }
}

impl ThreadManager {
    pub(super) fn session_pause_reason(&self, thread: &str) -> Result<Option<&'static str>> {
        let engine = self
            .engine(thread)
            .context("SESSION_ORIGINAL_TASK_REQUIRED")?;
        let followups = self
            .followups(thread)
            .context("SESSION_ORIGINAL_TASK_REQUIRED")?;
        if followups.session_activity.count() > 0
            || !engine.native_input_requires_source_admission()
            || self.has_background_lifetime(thread)
        {
            return Ok(None);
        }
        Ok(Some("SESSION_BACKGROUND_AUTHORIZATION_REQUIRED"))
    }
    pub(super) fn session_admission(&self, thread: &str) -> Result<()> {
        if let Some(reason) = self.session_pause_reason(thread)? {
            anyhow::bail!(reason);
        }
        Ok(())
    }

    /// Cancellation only signals the original turn. Its safe settlement keeps
    /// the existing execution gate closed until the actual receipt is final.
    pub(super) async fn enforce_session_lifetimes(&self) {
        for engine in self.resident_engines() {
            let thread = engine.session_id();
            let Some(turn) = self.turn_state(&thread) else {
                continue;
            };
            if !turn.running.load(Ordering::SeqCst) {
                continue;
            }
            let Some(followups) = self.followups(&thread) else {
                continue;
            };
            let background = !engine.native_input_requires_source_admission()
                || self.has_background_lifetime(&thread);
            if followups.session_activity.stop_due(background) {
                if let Some(active) = turn.active_turn.lock().await.as_ref() {
                    active.cancel.cancel();
                }
                // Automatic followups are not queued user inputs. Suspend only
                // when the original source authority is no longer available.
                followups.goals.lock().unwrap().suspend();
                followups.notify.notify_waiters();
            }
        }
    }
}

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    state: &ConnectionState,
    _origin: &QueryEngine,
    manager: &ThreadManager,
    outbound: &mpsc::Sender<Value>,
) -> Result<DispatchControl> {
    use kcoder_app_protocol::*;
    let result = (|| -> Result<ThreadLifetimeResult> {
        ensure!(state.session_lifetime_v1, "SESSION_LIFETIME_NOT_NEGOTIATED");
        #[cfg(target_os = "linux")]
        ensure!(
            state.native_acp_receiver_binding.is_none(),
            "REMOTE_RECEIVER_CONNECTION_METHOD_DENIED"
        );
        let thread = params
            .get("threadId")
            .and_then(Value::as_str)
            .context("SESSION_THREAD_REQUIRED")?;
        let engine = manager
            .engine(thread)
            .context("SESSION_ORIGINAL_TASK_REQUIRED")?;
        ensure_active_thread(&engine, manager.lease(thread), thread)?;
        // A resident task and its held SessionLease establish this connection's
        // task ownership. Attachment/lifetime control is not channel authorization.
        ensure!(
            !state.input_ended.is_cancelled() && state.initialized,
            "SESSION_CLIENT_AUTHORITY_REQUIRED"
        );
        let followups = manager
            .followups(thread)
            .context("SESSION_ORIGINAL_TASK_REQUIRED")?;
        match method {
            METHOD_THREAD_ATTACH | METHOD_THREAD_DETACH => {
                let input: ThreadAttachParams = serde_json::from_value(params.clone())?;
                if method == METHOD_THREAD_ATTACH {
                    followups.session_activity.attach(
                        state,
                        &input.client_id,
                        &input.generation,
                    )?;
                } else {
                    followups
                        .session_activity
                        .detach(state, &input.client_id, &input.generation);
                }
            }
            METHOD_THREAD_LIFETIME_SET => {
                let input: ThreadLifetimeSetParams = serde_json::from_value(params.clone())?;
                engine
                    .state
                    .set_session_lifetime(input.expected_revision, input.mode)?;
                followups.session_activity.0.lock().unwrap().empty_since = Some(Instant::now());
            }
            METHOD_THREAD_LIFETIME_READ => {
                let _: ThreadLifetimeReadParams = serde_json::from_value(params.clone())?;
            }
            _ => anyhow::bail!("SESSION_METHOD_UNSUPPORTED"),
        }
        followups.notify.notify_waiters();
        let setting = engine.state.session_lifetime();
        let attached_clients = followups.session_activity.count() as u32;
        let source_required = engine.native_input_requires_source_admission();
        let background_authorized = !source_required || manager.has_background_lifetime(thread);
        let paused_reason = if attached_clients > 0 {
            None
        } else if !background_authorized {
            Some("background_authorization_required".into())
        } else {
            None
        };
        Ok(ThreadLifetimeResult {
            thread_id: thread.into(),
            setting,
            attached_clients,
            reconnect_grace_ms: if source_required {
                RECONNECT_GRACE.as_millis() as u64
            } else {
                0
            },
            background_authorized,
            paused_reason,
        })
    })();
    match result {
        Ok(result) => {
            send(
                outbound,
                success_response(id, serde_json::to_value(result)?),
            )
            .await?
        }
        Err(error) => send(outbound, error_response(id, -32091, &error.to_string())).await?,
    }
    Ok(DispatchControl::Continue)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ids() -> (String, String) {
        (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        )
    }

    #[test]
    fn attachments_are_observations_and_source_authority_survives_last_detach() {
        let activity = SessionActivity::default();
        let a = ConnectionState::default();
        let b = ConnectionState::default();
        let (slot_a, gen_a) = ids();
        let (slot_b, gen_b) = ids();
        activity.attach(&a, &slot_a, &gen_a).unwrap();
        activity.attach(&b, &slot_b, &gen_b).unwrap();
        activity.attach(&b, &slot_b, &gen_b).unwrap();
        assert_eq!(activity.count(), 2);
        activity.detach(&a, &slot_a, &gen_a);
        assert!(activity.allowed(false));
        activity.detach(&b, &slot_b, &gen_b);
        let now = Instant::now();
        let mut inner = activity.0.lock().unwrap();
        assert!(!inner.stop_due(now, true));
        assert!(!inner.stop_due(now + RECONNECT_GRACE, true));
        assert!(!inner.stop_due(now + RECONNECT_GRACE, false));
        assert!(inner.stop_due(now + RECONNECT_GRACE * 2, false));
    }

    #[test]
    fn reconnect_and_stale_cleanup_cannot_remove_another_transport_or_incarnation() {
        let activity = SessionActivity::default();
        let old = ConnectionState::default();
        let current = ConnectionState::default();
        let (slot, generation) = ids();
        activity.attach(&old, &slot, &generation).unwrap();
        old.input_ended.cancel();
        activity.attach(&current, &slot, &generation).unwrap();
        activity.detach(&old, &slot, &generation);
        activity.detach(&current, &slot, &uuid::Uuid::new_v4().to_string());
        assert_eq!(activity.count(), 1);
        assert!(!activity.stop_due(false));
    }

    #[test]
    fn background_preference_is_not_a_grant_and_channel_is_not_an_attachment() {
        let activity = SessionActivity::default();
        let state = ConnectionState {
            native_source_dispatch: true,
            ..Default::default()
        };
        let (slot, generation) = ids();
        assert!(activity.attach(&state, &slot, &generation).is_err());
        assert!(!activity.allowed(false));
        assert!(activity.allowed(true));
        assert_eq!(activity.count(), 0);
    }
    #[test]
    fn runtime_observer_ends_with_its_source_without_detaching_a_peer() {
        let activity = SessionActivity::default();
        let peer = ConnectionState::default();
        let (slot, generation) = ids();
        activity.attach(&peer, &slot, &generation).unwrap();
        let owner: Arc<dyn Send + Sync> = Arc::new(());
        let ended = CancellationToken::new();
        activity.attach_runtime(&owner, ended.clone()).unwrap();
        assert_eq!(activity.count(), 2);
        ended.cancel();
        assert_eq!(activity.count(), 1);
        assert!(activity.attach_runtime(&owner, ended).is_err());
        assert!(activity.allowed(false));
    }
    #[test]
    fn runtime_observer_uses_live_process_ownership_instead_of_a_network_heartbeat() {
        let activity = SessionActivity::default();
        let owner: Arc<dyn Send + Sync> = Arc::new(());
        activity
            .attach_runtime(&owner, CancellationToken::new())
            .unwrap();
        assert_eq!(
            activity
                .0
                .lock()
                .unwrap()
                .count(Instant::now() + ATTACH_TTL * 2),
            1
        );
        drop(owner);
        assert_eq!(activity.count(), 0);
        assert!(!activity.allowed(false));
    }
    #[test]
    fn retired_renewal_cannot_resurrect_a_closed_view() {
        let activity = SessionActivity::default();
        let source = ConnectionState::default();
        let (slot, generation) = ids();
        activity.attach(&source, &slot, &generation).unwrap();
        activity.detach(&source, &slot, &generation);
        assert!(activity.attach(&source, &slot, &generation).is_err());
        let (new_slot, new_generation) = ids();
        activity
            .attach(&source, &new_slot, &new_generation)
            .unwrap();
        activity.detach(&source, &slot, &generation);
        assert_eq!(activity.count(), 1);
    }

    #[tokio::test]
    async fn original_host_keeps_unattended_tasks_running_until_explicitly_stopped() {
        let root = tempfile::tempdir().unwrap();
        let runtime = thread_runtime::test_support::test_runtime(
            "session-lifetime",
            &root.path().join("history.jsonl"),
        );
        let thread = runtime.engine().session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        assert!(manager.session_admission(&thread).is_ok());
        let followups = manager.followups(&thread).unwrap();
        assert_eq!(followups.session_activity.count(), 0);
        let turn = manager.turn_state(&thread).unwrap();
        let original_cancel = CancellationToken::new();
        *turn.active_turn.lock().await = Some(ActiveTurn {
            desktop_owner: None,
            attempt: None,
            origin: request_origin::RequestOrigin::ClientFrame,
            input_owner: None,
            cancel: original_cancel.clone(),
            handle: tokio::spawn(std::future::pending()),
            thread_id: thread.clone(),
            turn_id: "original".into(),
        });
        turn.running.store(true, Ordering::SeqCst);
        let a = ConnectionState::default();
        let b = ConnectionState::default();
        let (slot_a, gen_a) = ids();
        let (slot_b, gen_b) = ids();
        followups
            .session_activity
            .attach(&a, &slot_a, &gen_a)
            .unwrap();
        followups
            .session_activity
            .attach(&b, &slot_b, &gen_b)
            .unwrap();
        a.input_ended.cancel();
        manager.enforce_session_lifetimes().await;
        assert!(!original_cancel.is_cancelled());
        b.input_ended.cancel();
        manager.enforce_session_lifetimes().await;
        assert!(!original_cancel.is_cancelled());
        followups.session_activity.0.lock().unwrap().empty_since =
            Some(Instant::now() - RECONNECT_GRACE);
        manager.enforce_session_lifetimes().await;
        assert!(!original_cancel.is_cancelled());
        assert!(manager.session_admission(&thread).is_ok());
        assert!(
            followups
                .session_activity
                .admits(&manager.engine(&thread).unwrap())
        );
        let source_bound = manager
            .engine(&thread)
            .unwrap()
            .with_required_native_host_source_admission()
            .unwrap();
        assert!(!followups.session_activity.admits(&source_bound));
        turn_interrupt::pause_goal_and_cancel(
            &turn,
            Some(&followups),
            manager.engine(&thread).as_ref(),
            &original_cancel,
        )
        .await;
        assert!(original_cancel.is_cancelled());
        assert!(
            turn.running.load(Ordering::SeqCst),
            "signal is not a settlement receipt"
        );
        assert!(
            !turn.try_claim_turn(),
            "unknown in-flight work cannot be bypassed"
        );
        assert!(manager.owns(&thread));
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }
}
