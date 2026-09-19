use kcoder_tools::cron::{
    APP_PROJECT_CRON_OWNER, CronFire, CronScheduler, SessionCronSubscription,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

pub(super) struct ProjectAutomations {
    scheduler: Arc<CronScheduler>,
    enabled: bool,
    warned: bool,
    subscription: Option<SessionCronSubscription>,
    pending: BTreeMap<String, CronFire>,
    requests: VecDeque<(Value, Option<CronFire>)>,
    last_counts: Option<(usize, usize)>,
}

impl ProjectAutomations {
    /// Final shutdown step: unsubscribe while schedule writes and firing remain fenced.
    pub(super) fn stop_if_idle(&mut self) -> bool {
        let Ok(Some(_reservation)) = self.scheduler.try_reserve_idle() else {
            return false;
        };
        if !self.pending.is_empty()
            || !self.requests.is_empty()
            || self
                .subscription
                .as_ref()
                .is_some_and(SessionCronSubscription::has_pending_events)
        {
            return false;
        }
        self.subscription.take();
        self.enabled = false;
        true
    }
    pub(super) fn resource_activity(&self) -> (Option<usize>, usize, bool) {
        (
            self.last_counts.map(|counts| counts.0),
            self.pending.len() + self.requests.len(),
            self.subscription.is_some(),
        )
    }
    pub(super) fn new(scheduler: Arc<CronScheduler>, enabled: bool) -> Self {
        Self {
            scheduler,
            enabled,
            warned: false,
            subscription: None,
            pending: BTreeMap::new(),
            requests: VecDeque::new(),
            last_counts: None,
        }
    }

    pub(super) fn activate(&mut self) {
        if !self.enabled || self.subscription.is_some() {
            return;
        }
        match self.scheduler.migrate_app_jobs_to_project() {
            Ok(_) => {
                self.subscription = Some(
                    self.scheduler
                        .subscribe_session(APP_PROJECT_CRON_OWNER.to_string()),
                )
            }
            Err(error) if !self.warned => {
                self.warned = true;
                tracing::warn!(%error, "project automation migration is not ready");
            }
            Err(_) => {}
        }
    }

    pub(super) async fn receive(&mut self) {
        match self.subscription.as_mut() {
            Some(subscription) => {
                if let Ok(fire) = subscription.recv().await {
                    self.pending
                        .entry(fire.id.clone())
                        .and_modify(|old| {
                            old.coalesced = old
                                .coalesced
                                .saturating_add(fire.coalesced)
                                .saturating_add(1);
                        })
                        .or_insert(fire);
                }
            }
            None => std::future::pending().await,
        }
    }

    pub(super) fn queue_if_idle(&mut self, idle: bool) {
        if idle
            && self.requests.is_empty()
            && let Some((_, fire)) = self.pending.pop_first()
        {
            self.requests
                .push_back((json!({"method":"thread/start","params":{}}), Some(fire)));
        }
    }

    pub(super) fn next_request(&mut self) -> Option<(Value, Option<CronFire>)> {
        self.requests.pop_front()
    }

    pub(super) fn take_state_change(&mut self) -> Option<Value> {
        self.subscription.as_ref()?;
        let job_count = self
            .scheduler
            .list_for_session(APP_PROJECT_CRON_OWNER)
            .ok()?
            .len();
        let pending_count = self.pending.len() + self.requests.len();
        if self.last_counts == Some((job_count, pending_count)) {
            return None;
        }
        self.last_counts = Some((job_count, pending_count));
        Some(json!(kcoder_app_protocol::AutomationStateChangedParams {
            job_count,
            pending_count
        }))
    }

    pub(super) fn start_turn(&mut self, fire: &CronFire, thread_id: &str) {
        let prompt = format!(
            "[scheduled task {} due at {}] {}\nAdditional missed triggers coalesced: {}.",
            fire.id, fire.scheduled_at, fire.prompt, fire.coalesced
        );
        self.requests.push_front((json!({"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":prompt}]}}), None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn state_notifications_are_changed_only_and_disabled_profiles_do_not_subscribe() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = Arc::new(CronScheduler::load(root.path()));
        let mut disabled = ProjectAutomations::new(Arc::clone(&scheduler), false);
        disabled.activate();
        assert!(disabled.take_state_change().is_none());
        assert_eq!(disabled.resource_activity(), (None, 0, false));
        let mut enabled = ProjectAutomations::new(scheduler, true);
        enabled.activate();
        assert_eq!(
            enabled.take_state_change().unwrap(),
            json!({"jobCount":0,"pendingCount":0})
        );
        assert!(enabled.take_state_change().is_none());
        assert_eq!(enabled.resource_activity(), (Some(0), 0, true));
        assert!(enabled.stop_if_idle());
        enabled.activate();
        assert!(!enabled.resource_activity().2);
    }

    #[test]
    fn due_work_waits_for_idle_and_starts_a_new_thread_before_its_turn() {
        let root = tempfile::tempdir().unwrap();
        let mut automation =
            ProjectAutomations::new(Arc::new(CronScheduler::load(root.path())), true);
        automation.activate();
        automation.pending.insert(
            "job".to_string(),
            CronFire {
                session_id: Some(APP_PROJECT_CRON_OWNER.to_string()),
                id: "job".to_string(),
                prompt: "standalone task".to_string(),
                scheduled_at: Utc::now(),
                coalesced: 2,
            },
        );
        assert_eq!(automation.resource_activity(), (None, 1, true));
        assert!(!automation.stop_if_idle());
        automation.queue_if_idle(false);
        assert!(automation.next_request().is_none());
        automation.queue_if_idle(true);
        assert_eq!(automation.resource_activity().1, 1);
        let (start, fire) = automation.next_request().unwrap();
        assert_eq!(start["method"], "thread/start");
        assert!(start["params"].get("threadId").is_none());
        automation.start_turn(&fire.unwrap(), "fresh-thread");
        let (turn, _) = automation.next_request().unwrap();
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["threadId"], "fresh-thread");
        assert!(
            turn["params"]["input"][0]["text"]
                .as_str()
                .unwrap()
                .contains("standalone task")
        );
    }
}
