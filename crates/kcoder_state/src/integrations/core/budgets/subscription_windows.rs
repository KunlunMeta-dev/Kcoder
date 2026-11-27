//! Publish a subscription window under the original ledger lock without resetting its ceiling.
use super::*;
impl NativeBudgetStore {
    /// Inspect the original journal even before this family has been installed.
    pub fn preview_subscription_window(
        &self,
        policy: &NativeBudgetPolicy,
    ) -> Result<BudgetWindowObservation> {
        ensure!(
            matches!(policy.record.scope, BudgetScope::Subscription(_)),
            "BUDGET_SUBSCRIPTION_WINDOW_INVALID"
        );
        let ledger = self.load()?;
        let mut effective = policy.clone();
        effective.record.subscription_window_accounting = true;
        if let Some(old) = ledger.windows.get(&policy.record.key()?) {
            effective.record.limits.tokens =
                minimum(old.limits.tokens, effective.record.limits.tokens);
            effective.record.limits.model_calls =
                minimum(old.limits.model_calls, effective.record.limits.model_calls);
        }
        ledger.observation(&effective.record)
    }
    /// Explicit configuration may increase the next window, never the current one.
    /// Admission and accounting still use the original reserve/usage methods.
    pub fn install_subscription_window(
        &self,
        policy: &NativeBudgetPolicy,
        now_ms: u64,
    ) -> Result<NativeBudgetPolicy> {
        ensure!(
            matches!(policy.record.scope, BudgetScope::Subscription(_))
                && policy.record.window.starts_at_ms <= now_ms
                && now_ms < policy.record.window.ends_at_ms
                && policy.record.window.ends_at_ms != u64::MAX
                && policy.record.limits.tokens.is_some_and(|value| value > 0)
                && policy
                    .record
                    .limits
                    .model_calls
                    .is_some_and(|value| value > 0),
            "BUDGET_SUBSCRIPTION_WINDOW_INVALID"
        );
        self.mutate(|ledger| {
            let mut effective = policy.clone();
            effective.record.subscription_window_accounting = true;
            if let Some(old) = ledger.windows.get(&policy.record.key()?) {
                effective.record.limits.tokens =
                    minimum(old.limits.tokens, effective.record.limits.tokens);
                effective.record.limits.model_calls =
                    minimum(old.limits.model_calls, effective.record.limits.model_calls);
                effective.record.limits.run_millis =
                    minimum(old.limits.run_millis, effective.record.limits.run_millis);
                effective.record.limits.cost_micros =
                    minimum(old.limits.cost_micros, effective.record.limits.cost_micros);
                effective.record.limits.concurrent_tasks = minimum(
                    old.limits.concurrent_tasks,
                    effective.record.limits.concurrent_tasks,
                );
                effective.record.limits.concurrent_calls = minimum(
                    old.limits.concurrent_calls,
                    effective.record.limits.concurrent_calls,
                );
            }
            effective.record.revision = digest(&(
                "subscription-window-ceiling-v1",
                &policy.record.revision,
                &effective.record.limits,
            ))?;
            ledger.install_policies(std::slice::from_ref(&effective))?;
            Ok(effective)
        })
    }
}
fn minimum<T: Ord>(left: Option<T>, right: Option<T>) -> Option<T> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::*;
    use std::sync::{Arc, Barrier};
    fn scope() -> IntegrationScope {
        IntegrationScope {
            account_id: "owned-account".into(),
            target_id: "owned-target".into(),
            workspace_id: IntegrationNullable::Null,
            organization_id: None,
            identity_generation: "generation".into(),
            target_revision: "revision".into(),
        }
    }
    pub(super) fn policy(version: u64, tokens: u64, start: u64) -> NativeBudgetPolicy {
        NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: "native-personal-automation-period".into(),
            version,
            revision: format!("explicit-config-{version}"),
            scope: BudgetScope::Subscription("original-subscription".into()),
            window: BudgetWindow {
                id: format!("utc-{start}"),
                starts_at_ms: start,
                ends_at_ms: start + 1000,
            },
            limits: BudgetLimits {
                tokens: Some(tokens),
                model_calls: Some(20),
                concurrent_calls: Some(2),
                concurrent_tasks: Some(1),
                ..Default::default()
            },
            currency: None,
        })
        .unwrap()
    }
    pub(super) fn request(id: &str, tokens: u64) -> NativeBudgetRequest {
        NativeBudgetRequest {
            reservation_id: id.into(),
            operation_id: format!("operation-{id}"),
            principal: NativeBudgetPrincipal::from_native_facts(
                "owned-account".into(),
                None,
                None,
                Some("original-subscription".into()),
            )
            .unwrap(),
            unit: BudgetUnit::ModelCall,
            task: BudgetTaskLink {
                root_operation_id: format!("separate-task-{id}"),
                root_task: Some(IntegrationEntityRef {
                    kind: IntegrationEntityKind::Turn,
                    id: format!("native-task-{id}"),
                    revision: None,
                }),
                actor: BudgetActor::Main,
                actor_attempt_id: format!("attempt-{id}"),
                parent_reservation_id: None,
            },
            estimate: BudgetCharge {
                tokens,
                model_calls: 1,
                run_millis: 1,
                cost_micros: None,
            },
        }
    }
    pub(super) fn fixture() -> (tempfile::TempDir, PrivateDirectory, NativeBudgetStore) {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("native-profile"))
            .unwrap();
        let store =
            NativeBudgetStore::create_in(&directory, OsStr::new("original-journal"), &scope())
                .unwrap();
        (temp, directory, store)
    }
    #[test]
    fn current_window_edits_preserve_original_charge_and_increase_only_the_next_window() {
        let (_temp, directory, store) = fixture();
        let first = store
            .install_subscription_window(&policy(1, 100, 0), 100)
            .unwrap();
        let reservation = store
            .reserve(&request("one", 70), std::slice::from_ref(&first), 100)
            .unwrap()
            .receipt()
            .clone();
        let changed = store
            .install_subscription_window(&policy(2, 1000, 0), 200)
            .unwrap();
        let observed = store.observe_policy(&changed).unwrap().unwrap();
        assert_eq!(observed.limits.tokens, Some(100));
        assert_eq!(observed.charged.tokens, 70);
        assert!(
            store
                .reserve(&request("two", 40), std::slice::from_ref(&changed), 200)
                .is_err()
        );
        let smaller = store
            .install_subscription_window(&policy(3, 80, 0), 200)
            .unwrap();
        assert_eq!(
            store
                .observe_policy(&smaller)
                .unwrap()
                .unwrap()
                .charged
                .tokens,
            70
        );
        assert!(
            store
                .install_subscription_window(&policy(2, 1000, 0), 200)
                .is_err()
        );
        let reopened =
            NativeBudgetStore::open_in(&directory, OsStr::new("original-journal"), &scope())
                .unwrap()
                .unwrap();
        assert_eq!(
            reopened.read_reservation("one").unwrap().unwrap(),
            reservation
        );
        let next = reopened
            .install_subscription_window(&policy(3, 80, 1000), 1100)
            .unwrap();
        let next_observation = reopened.observe_policy(&next).unwrap().unwrap();
        assert_eq!(next_observation.charged.tokens, 0);
        assert_eq!(
            next_observation.active_calls, 1,
            "an unconfirmed old call still occupies its original family across windows"
        );
        assert_eq!(
            reopened
                .observe_policy(&smaller)
                .unwrap()
                .unwrap()
                .charged
                .tokens,
            70
        );
    }
    #[test]
    fn independent_writers_cannot_reserve_the_same_period_balance_twice() {
        let (temp, _directory, store) = fixture();
        let installed = store
            .install_subscription_window(&policy(1, 100, 0), 100)
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|index| {
                let path = temp.path().join("native-profile");
                let barrier = barrier.clone();
                let policy = installed.clone();
                std::thread::spawn(move || {
                    let directory = PrivateDirectory::open_existing(&path).unwrap();
                    let store = NativeBudgetStore::open_in(
                        &directory,
                        OsStr::new("original-journal"),
                        &scope(),
                    )
                    .unwrap()
                    .unwrap();
                    barrier.wait();
                    store
                        .reserve(&request(&format!("racer-{index}"), 70), &[policy], 100)
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| usize::from(handle.join().unwrap()))
                .sum::<usize>(),
            1
        );
        assert_eq!(
            store
                .observe_policy(&installed)
                .unwrap()
                .unwrap()
                .charged
                .tokens,
            70
        );
    }
}

#[cfg(test)]
mod existing_usage_tests {
    use super::*;
    #[test]
    fn first_period_configuration_counts_existing_original_subscription_spend() {
        let (_temp, _directory, store) = super::tests::fixture();
        let mut old = super::tests::policy(1, 1000, 0);
        old.record.id = "original-per-task".into();
        old.record.scope = BudgetScope::Task("separate-task-before".into());
        store
            .reserve(&super::tests::request("before", 70), &[old], 100)
            .unwrap();
        let preview = store
            .preview_subscription_window(&super::tests::policy(1, 100, 0))
            .unwrap();
        assert_eq!(preview.charged.tokens, 70);
        assert!(
            store
                .observe_policy(&super::tests::policy(1, 100, 0))
                .unwrap()
                .is_none()
        );
        let installed = store
            .install_subscription_window(&super::tests::policy(1, 100, 0), 200)
            .unwrap();
        let snapshot = store.observe_policy(&installed).unwrap().unwrap();
        assert_eq!(snapshot.charged.tokens, 70);
        assert!(
            store
                .reserve(&super::tests::request("after", 40), &[installed], 200)
                .is_err()
        );
        assert_eq!(
            store
                .read_reservation("before")
                .unwrap()
                .unwrap()
                .charged
                .tokens,
            70
        );
    }
}
