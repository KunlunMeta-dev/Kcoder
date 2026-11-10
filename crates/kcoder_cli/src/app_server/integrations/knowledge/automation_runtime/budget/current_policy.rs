//! Journal changes require fresh original-policy checks; unrelated writes are not revocation.
use super::*;

pub(super) struct CurrentBudgetPolicy {
    principal: NativeBudgetPrincipal,
    root_operation: String,
    expected: Vec<BudgetPolicyReference>,
    epoch: Mutex<Option<String>>,
}
impl CurrentBudgetPolicy {
    pub(super) fn capture(
        ledger: &NativeBudgetStore,
        principal: NativeBudgetPrincipal,
        root_operation: String,
        expected: Vec<BudgetPolicyReference>,
        now_ms: u64,
    ) -> Result<Self> {
        ensure!(!expected.is_empty(), "AUTOMATION_BUDGET_POLICY_MISSING");
        let result = Self {
            principal,
            root_operation,
            expected,
            epoch: Mutex::new(None),
        };
        result.check(ledger, now_ms)?;
        Ok(result)
    }

    pub(super) fn check(&self, ledger: &NativeBudgetStore, now_ms: u64) -> Result<()> {
        self.check_observed(ledger, now_ms, || Ok(()))
    }

    fn check_observed(
        &self,
        ledger: &NativeBudgetStore,
        now_ms: u64,
        mut after_read: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        ensure!(
            self.expected.iter().all(|reference| {
                reference.window.starts_at_ms <= now_ms && now_ms < reference.window.ends_at_ms
            }),
            "AUTOMATION_RUNTIME_DEADLINE"
        );
        let mut epoch = self
            .epoch
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_BUDGET_POLICY_UNAVAILABLE"))?;
        for _ in 0..3 {
            let before = ledger.observation_epoch()?;
            if epoch.as_ref() == Some(&before) {
                return Ok(());
            }
            // The epoch only invalidates. Every change, including our own measured
            // usage, requires the original verified journal and all current upper
            // policy families. New policies cannot silently authorize the old call.
            let policies = ledger.current_applicable_policies(
                &self.principal,
                &self.root_operation,
                now_ms,
            )?;
            ensure!(
                policies.len() == self.expected.len(),
                "AUTOMATION_BUDGET_POLICY_CHANGED"
            );
            for policy in policies {
                let observed = ledger
                    .observe_policy(&policy)?
                    .context("AUTOMATION_BUDGET_POLICY_MISSING")?;
                ensure!(
                    self.expected.contains(&observed.policy),
                    "AUTOMATION_BUDGET_POLICY_CHANGED"
                );
                ensure!(
                    observed
                        .limits
                        .tokens
                        .is_none_or(|limit| observed.charged.tokens <= limit)
                        && observed
                            .limits
                            .model_calls
                            .is_none_or(|limit| observed.charged.model_calls <= limit)
                        && observed
                            .limits
                            .run_millis
                            .is_none_or(|limit| observed.charged.run_millis <= limit)
                        && observed.limits.cost_micros.is_none_or(|limit| observed
                            .charged
                            .cost_micros
                            .is_some_and(|actual| actual <= limit))
                        && observed
                            .limits
                            .concurrent_tasks
                            .is_none_or(|limit| observed.active_tasks <= limit)
                        && observed
                            .limits
                            .concurrent_calls
                            .is_none_or(|limit| observed.active_calls <= limit),
                    "BUDGET_EXHAUSTED"
                );
            }
            after_read()?;
            if ledger.observation_epoch()? == before {
                *epoch = Some(before);
                return Ok(());
            }
            // A different task may append to the shared journal. Re-read the
            // original principal, all applicable policies and their real limits;
            // never turn a changed stamp into a new authorization grant.
            *epoch = None;
        }
        anyhow::bail!("AUTOMATION_BUDGET_REVALIDATION_BUSY")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn fixture() -> Result<(
        kcoder_config::PrivateTempDir,
        NativeBudgetStore,
        NativeBudgetPrincipal,
    )> {
        let temporary = kcoder_config::create_private_temp_dir("native-policy-observation")?;
        let directory = kcoder_config::PrivateDirectory::open_existing(temporary.path())?;
        let scope = IntegrationScope {
            account_id: "actual-budget-account".into(),
            target_id: "actual-budget-target".into(),
            workspace_id: IntegrationNullable::Null,
            identity_generation: "actual-identity".into(),
            target_revision: "actual-config".into(),
            organization_id: None,
        };
        let ledger = NativeBudgetStore::create_in(&directory, OsStr::new("ledger"), &scope)?;
        let principal =
            NativeBudgetPrincipal::from_native_facts(scope.account_id, None, None, None)?;
        Ok((temporary, ledger, principal))
    }
    fn policy(id: &str, version: u64, end: u64) -> Result<NativeBudgetPolicy> {
        NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: id.into(),
            version,
            revision: format!("actual-revision-{version}"),
            scope: BudgetScope::Account("actual-budget-account".into()),
            window: BudgetWindow {
                id: "actual-window".into(),
                starts_at_ms: 0,
                ends_at_ms: end,
            },
            limits: BudgetLimits {
                tokens: Some(1000),
                ..Default::default()
            },
            currency: None,
        })
    }
    fn capture(
        ledger: &NativeBudgetStore,
        principal: NativeBudgetPrincipal,
    ) -> Result<CurrentBudgetPolicy> {
        let current = ledger.current_applicable_policies(&principal, "actual-operation", 100)?;
        let references = current
            .iter()
            .map(|policy| {
                Ok(ledger
                    .observe_policy(policy)?
                    .context("policy missing")?
                    .policy)
            })
            .collect::<Result<Vec<_>>>()?;
        CurrentBudgetPolicy::capture(
            ledger,
            principal,
            "actual-operation".into(),
            references,
            100,
        )
    }

    fn unrelated_policy(version: u64) -> Result<NativeBudgetPolicy> {
        NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: "unrelated-task".into(),
            version,
            revision: format!("unrelated-revision-{version}"),
            scope: BudgetScope::Task("another-original-operation".into()),
            window: BudgetWindow {
                id: "unrelated-window".into(),
                starts_at_ms: 0,
                ends_at_ms: 1000,
            },
            limits: BudgetLimits {
                tokens: Some(1000),
                ..Default::default()
            },
            currency: None,
        })
    }

    #[test]
    fn unrelated_task_journal_write_during_observation_rechecks_the_original_policy() -> Result<()>
    {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        *captured.epoch.lock().unwrap() = None;
        let mut reads = 0;
        let outcome = captured.check_observed(&ledger, 200, || {
            reads += 1;
            if reads == 1 {
                ledger.install_policies(&[unrelated_policy(1)?])?;
            }
            Ok(())
        });
        assert!(
            outcome.is_ok(),
            "An unrelated task cannot revoke the original policy: {outcome:?}"
        );
        assert_eq!(reads, 2);
        Ok(())
    }

    #[test]
    fn original_policy_change_during_observation_is_not_retried_as_unrelated_noise() -> Result<()> {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        *captured.epoch.lock().unwrap() = None;
        let mut reads = 0;
        let outcome = captured.check_observed(&ledger, 200, || {
            reads += 1;
            ledger.install_policies(&[policy("account", 2, 1000)?])?;
            Ok(())
        });
        assert_eq!(
            outcome.unwrap_err().to_string(),
            "AUTOMATION_BUDGET_POLICY_CHANGED"
        );
        assert_eq!(reads, 1);
        assert!(captured.epoch.lock().unwrap().is_none());
        Ok(())
    }

    #[test]
    fn continuous_unrelated_churn_is_bounded_and_never_cached_as_an_allow() -> Result<()> {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        *captured.epoch.lock().unwrap() = None;
        let mut reads = 0;
        let outcome = captured.check_observed(&ledger, 200, || {
            reads += 1;
            ledger.install_policies(&[unrelated_policy(reads)?])?;
            Ok(())
        });
        assert_eq!(
            outcome.unwrap_err().to_string(),
            "AUTOMATION_BUDGET_REVALIDATION_BUSY"
        );
        assert_eq!(reads, 3);
        assert!(captured.epoch.lock().unwrap().is_none());
        captured.check(&ledger, 200)?;
        Ok(())
    }

    #[test]
    fn actual_journal_version_change_invalidates_a_live_policy_snapshot() -> Result<()> {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        captured.check(&ledger, 200)?;
        ledger.install_policies(&[policy("account", 2, 1000)?])?;
        assert!(captured.check(&ledger, 200).is_err());
        Ok(())
    }

    #[test]
    fn newly_installed_upper_family_is_not_ignored_by_a_live_call() -> Result<()> {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        ledger.install_policies(&[policy("additional-account-policy", 1, 1000)?])?;
        assert!(captured.check(&ledger, 200).is_err());
        Ok(())
    }

    #[test]
    fn unchanged_metadata_does_not_extend_the_original_policy_window() -> Result<()> {
        let (_temporary, ledger, principal) = fixture()?;
        ledger.install_policies(&[policy("account", 1, 1000)?])?;
        let captured = capture(&ledger, principal)?;
        let epoch = ledger.observation_epoch()?;
        captured.check(&ledger, 999)?;
        assert!(captured.check(&ledger, 1000).is_err());
        assert_eq!(ledger.observation_epoch()?, epoch);
        Ok(())
    }
}
