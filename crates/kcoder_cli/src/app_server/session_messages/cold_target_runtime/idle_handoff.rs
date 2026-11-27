//! Retirement protection for accepted work. It grants no restore or Provider authority.
use super::*;
use kcoder_state::cross_session_messages::{
    ColdWakeIdleHint, ColdWakeIdleObservation, CrossSessionMessageStore,
};

const HANDOFF_WINDOW: Duration = Duration::from_secs(30);
const IDLE_OBSERVATION_LIFETIME: Duration = Duration::from_millis(500);

#[derive(Default)]
struct State {
    namespace: String,
    hint: Option<ColdWakeIdleHint>,
    seen: HashMap<String, Instant>,
}
impl State {
    fn pending_count(&mut self, namespace: &str, current: HashSet<String>, now: Instant) -> usize {
        if self.namespace != namespace {
            self.seen.clear();
            self.namespace = namespace.to_owned();
        }
        self.seen.retain(|id, _| current.contains(id));
        for id in current {
            self.seen.entry(id).or_insert(now + HANDOFF_WINDOW);
        }
        self.seen.values().filter(|until| now < **until).count()
    }
}
#[derive(Default)]
pub(in crate::app_server) struct ColdIdleHandoff {
    state: Arc<Mutex<State>>,
}

pub(in crate::app_server) struct ColdIdleObservation {
    service: Option<Arc<PeerMessageService>>,
    expected_mailbox: Option<Arc<CrossSessionMessageStore>>,
    _queue: Option<ColdWakeIdleObservation>,
    pending: usize,
    valid_until: Instant,
}
impl ColdIdleObservation {
    pub(in crate::app_server) fn pending(&self) -> usize {
        self.pending
    }
    /// The queue lease remains held across both closing this service and the
    /// original host's synchronous admission commit, then is promptly released.
    pub(in crate::app_server) fn commit(self, commit: impl FnOnce()) -> Result<()> {
        ensure!(
            self.pending == 0 && Instant::now() <= self.valid_until,
            "peer_cold_idle_observation_expired"
        );
        if let Some(service) = &self.service {
            service.begin_idle_close(self.expected_mailbox.as_ref())?;
        }
        commit();
        Ok(())
    }
}

impl ColdIdleHandoff {
    pub(in crate::app_server) async fn observe(
        &self,
        service: Option<Arc<PeerMessageService>>,
        restoring: usize,
    ) -> Result<ColdIdleObservation> {
        if restoring != 0 {
            return Ok(ColdIdleObservation {
                service,
                expected_mailbox: None,
                _queue: None,
                pending: restoring,
                valid_until: Instant::now() + IDLE_OBSERVATION_LIFETIME,
            });
        }
        let Some(service) = service else {
            return Ok(ColdIdleObservation {
                service: None,
                expected_mailbox: None,
                _queue: None,
                pending: 0,
                valid_until: Instant::now() + IDLE_OBSERVATION_LIFETIME,
            });
        };
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || -> Result<_> {
            // Busy is not absence. This does not activate or create a profile.
            let Some(queue) = service.try_loaded_mailbox_for_idle()? else {
                return Ok(ColdIdleObservation {
                    service: Some(service),
                    expected_mailbox: None,
                    _queue: None,
                    pending: 0,
                    valid_until: Instant::now() + IDLE_OBSERVATION_LIFETIME,
                });
            };
            let mut state = state
                .lock()
                .map_err(|_| anyhow::anyhow!("peer_cold_idle_busy"))?;
            let observation = queue.observe_idle_wake_handoff(state.hint.as_ref())?;
            let policy = service.policy()?;
            if policy.enabled && policy.wake_idle {
                service.require_enabled(true)?;
            }
            let now = Instant::now();
            let now_ms = kcoder_app_events::now_millis();
            let current = observation
                .pending()
                .iter()
                .filter(|row| row.unexpired_at(now_ms))
                .map(|row| row.message_id().to_owned())
                .collect::<HashSet<_>>();
            let pending = if policy.enabled && policy.wake_idle {
                state.pending_count(observation.namespace(), current, now)
            } else {
                0
            };
            state.hint = Some(observation.hint());
            Ok(ColdIdleObservation {
                service: Some(service),
                expected_mailbox: Some(queue),
                _queue: Some(observation),
                pending,
                valid_until: Instant::now() + IDLE_OBSERVATION_LIFETIME,
            })
        })
        .await
        .context("peer_cold_idle_worker_unavailable")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_pending_work_cannot_renew_its_handoff_window() {
        let mut state = State::default();
        let now = Instant::now();
        let original = HashSet::from(["original-mid".to_owned()]);
        assert_eq!(
            state.pending_count("original-namespace", original.clone(), now),
            1
        );
        assert_eq!(
            state.pending_count("original-namespace", original.clone(), now + HANDOFF_WINDOW),
            0
        );
        assert_eq!(
            state.pending_count(
                "original-namespace",
                original.clone(),
                now + HANDOFF_WINDOW * 2
            ),
            0
        );
        let mut next = original;
        next.insert("new-original-mid".into());
        assert_eq!(
            state.pending_count("original-namespace", next, now + HANDOFF_WINDOW * 2),
            1
        );
        assert_eq!(
            state.pending_count(
                "original-namespace",
                HashSet::new(),
                now + HANDOFF_WINDOW * 2
            ),
            0
        );
    }

    #[tokio::test]
    async fn an_actual_restore_stays_busy_independently_of_the_short_handoff_window() {
        let handoff = ColdIdleHandoff::default();
        handoff
            .state
            .lock()
            .unwrap()
            .seen
            .insert("expired".into(), Instant::now() - HANDOFF_WINDOW);
        let active = handoff.observe(None, 1).await.unwrap();
        assert_eq!(active.pending(), 1);
        assert!(
            active
                .commit(|| panic!("an active restore cannot commit idle"))
                .is_err()
        );
        let quiet = handoff.observe(None, 0).await.unwrap();
        assert_eq!(quiet.pending(), 0);
        quiet.commit(|| {}).unwrap();
    }
}
