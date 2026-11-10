//! Durable business results and the atomic completion transition. Recording a
//! result preserves the watermarks it was produced under; completion is a
//! separate compare-and-swap that still has to verify input application,
//! delivery snapshot agreement and fencing. Neither call is native acceptance
//! or proof that an owned process already settled.
use super::*;
use kcoder_types::continuous_work::{ResultBasis, WorkInputState, WorkResult};

/// Every required input sequence must be applied or rejected. A gap, a queued or
/// an unconfirmed input keeps completion blocked.
fn settled_inputs(data: &StoreData, identity: &WorkIdentity, required: u64) -> Result<()> {
    let mut settled = std::collections::BTreeSet::new();
    for input in data.inputs.values() {
        let current = super::receipt(input)?;
        if current.work != *identity || current.sequence > required {
            continue;
        }
        ensure!(
            matches!(
                current.state,
                WorkInputState::Applied | WorkInputState::Rejected
            ),
            "CONTINUOUS_WORK_INPUT_PENDING"
        );
        settled.insert(current.sequence);
    }
    for sequence in 1..=required {
        ensure!(settled.contains(&sequence), "CONTINUOUS_WORK_INPUT_PENDING");
    }
    Ok(())
}

/// A change must not sort before the observation it supersedes.
fn touch_presentation(work: &mut WorkRecord) {
    if let Some(presentation) = work.presentation.as_mut() {
        let now = crate::now_millis();
        presentation.updated_at_ms = Some(
            presentation
                .updated_at_ms
                .map_or(now, |previous| previous.max(now)),
        );
    }
}

/// The exact watermarks a result must have been produced under.
fn current_basis(work: &WorkRecord) -> ResultBasis {
    ResultBasis {
        requirements_revision: work.revision.requirements_revision,
        control_epoch: work.revision.control_epoch,
        owner_epoch: work.revision.owner_epoch,
        applied_input_sequence: work.revision.applied_input_sequence,
    }
}

impl ContinuousWorkStore {
    /// Record the business result produced under the current watermarks. The
    /// host verifies the result itself; this call only freezes it, so a stale
    /// basis, a mismatched delivery snapshot or an unworkable phase is rejected
    /// without changing storage.
    pub fn record_result(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        expected_revision: u64,
        result: WorkResult,
    ) -> Result<WorkRecord> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(atom(&result.result_id), "CONTINUOUS_WORK_RESULT_INVALID");
        self.update(|data| {
            require_known_inputs(data, &identity)?;
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            ensure!(
                work.revision.revision == expected_revision,
                "CONTINUOUS_WORK_REVISION_CONFLICT"
            );
            ensure!(
                !matches!(work.phase, WorkPhase::Stopped | WorkPhase::Completed),
                "CONTINUOUS_WORK_RESULT_NOT_ACCEPTED"
            );
            ensure!(
                result.basis == current_basis(&work),
                "CONTINUOUS_WORK_RESULT_STALE"
            );
            // The accepted requirements are the authoritative snapshot: a
            // result can neither drop a required delivery nor invent one, and a
            // repeated id cannot stand in for the original set.
            let mut accepted: Vec<&str> = stored
                .accepted_deliveries
                .iter()
                .map(|delivery| delivery.delivery_id.as_str())
                .collect();
            let mut claimed: Vec<&str> = result
                .required_delivery_ids
                .iter()
                .map(String::as_str)
                .collect();
            accepted.sort_unstable();
            claimed.sort_unstable();
            ensure!(
                accepted == claimed,
                "CONTINUOUS_WORK_DELIVERY_SNAPSHOT_REQUIRED"
            );
            work.result = Some(result);
            work.validate_shape().map_err(anyhow::Error::msg)?;
            work.revision.revision = next(work.revision.revision)?;
            touch_presentation(&mut work);
            stored.record = serde_json::to_value(&work)?;
            Ok((work, true))
        })
    }

    /// Complete the business work only for the exact result basis, after every
    /// accepted input was applied and no owned claim or pending control remains.
    /// A repeat of an already committed completion is the same outcome and does
    /// not advance the revision; a different basis is a conflicting request.
    pub fn complete_work(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        expected_revision: u64,
        basis: ResultBasis,
    ) -> Result<WorkRecord> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.update(|data| {
            require_known_inputs(data, &identity)?;
            // Input settlement is checked on the read-only view so the mutable
            // borrow below stays confined to the record update.
            {
                let stored = data
                    .works
                    .get(&work_key(&identity)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?;
                let observed = record(stored)?;
                ensure!(
                    observed.revision.required_input_sequence
                        == observed.revision.accepted_input_sequence,
                    "CONTINUOUS_WORK_INPUT_PENDING"
                );
                settled_inputs(
                    data,
                    &observed.identity,
                    observed.revision.required_input_sequence,
                )?;
            }
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            if work.phase == WorkPhase::Completed {
                ensure!(
                    work.result
                        .as_ref()
                        .is_some_and(|result| result.basis == basis),
                    "CONTINUOUS_WORK_REVISION_CONFLICT"
                );
                return Ok((work, false));
            }
            ensure!(
                work.revision.revision == expected_revision,
                "CONTINUOUS_WORK_REVISION_CONFLICT"
            );
            ensure!(
                matches!(
                    work.phase,
                    WorkPhase::Pending
                        | WorkPhase::Running
                        | WorkPhase::WaitingUser
                        | WorkPhase::WaitingEvent
                ),
                "CONTINUOUS_WORK_PHASE_NOT_COMPLETABLE"
            );
            let recorded = work
                .result
                .as_ref()
                .context("CONTINUOUS_WORK_RESULT_MISSING")?;
            ensure!(
                recorded.basis == current_basis(&work),
                "CONTINUOUS_WORK_RESULT_STALE"
            );
            // The caller's basis must be the exact result basis; a mismatched
            // basis would otherwise complete work with another result.
            ensure!(recorded.basis == basis, "CONTINUOUS_WORK_RESULT_STALE");
            ensure!(
                stored.active_claim.is_none() && stored.pending_control.is_none(),
                "CONTINUOUS_WORK_COMPLETION_FENCED"
            );
            // A required delivery without a confirmed observation keeps the
            // work open; a result alone never proves delivery.
            super::deliveries::required_deliveries_confirmed(stored)?;
            // A completed work has no unresolved wait; keep the native wait
            // fact out of the completed record so completion checks stay valid.
            work.waiting = None;
            work.phase = WorkPhase::Completed;
            work.revision.revision = next(work.revision.revision)?;
            touch_presentation(&mut work);
            work.validate_shape().map_err(anyhow::Error::msg)?;
            stored.record = serde_json::to_value(&work)?;
            Ok((work, true))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::PrivateTempDir;
    use kcoder_types::continuous_work::{
        ResultBasis, WorkConfirmationLevel, WorkDelivery, WorkDeliveryRequirement,
        WorkDeliveryState, WorkRecord, WorkResult,
    };
    use serde_json::json;

    const DELIVERY: &str = "delivery-chat";

    fn scope() -> WorkScope {
        WorkScope {
            account_id: "a".into(),
            target_id: "t".into(),
            workspace_id: "w".into(),
        }
    }

    fn source() -> WorkInputSource {
        WorkInputSource {
            kind: "foreground".into(),
            instance_id: "target-thread".into(),
            conversation_id: "thread".into(),
        }
    }

    fn attempt() -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            attempt_id: "attempt".into(),
        }
    }

    fn initial_record() -> WorkRecord {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "identity": {"scope": scope(), "workId": "work"},
            "origin": {"kind": "foreground", "initialAttempt": attempt()},
            "linkedThreadIds": ["thread"],
            "phase": "pending",
            "presentation": {"title": "reduce latency", "updatedAtMs": 1},
            "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
                "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
                "appliedInputSequence": 0}
        }))
        .unwrap()
    }

    fn deliveries() -> Vec<WorkDeliveryRequirement> {
        vec![WorkDeliveryRequirement {
            delivery_id: DELIVERY.into(),
            minimum_confirmation: WorkConfirmationLevel::Accepted,
        }]
    }

    /// A confirmed delivery at the frozen minimum, so completion can proceed.
    fn confirm_delivery(store: &ContinuousWorkStore) -> Result<()> {
        store.record_delivery(
            &scope(),
            "work",
            WorkDelivery {
                delivery_id: DELIVERY.into(),
                required_for_completion: true,
                state: WorkDeliveryState::Confirmed,
                minimum_confirmation: WorkConfirmationLevel::Accepted,
                observed_confirmation: Some(WorkConfirmationLevel::Accepted),
                receipt_ref: Some("receipt-1".into()),
            },
        )?;
        Ok(())
    }

    fn admit(store: &ContinuousWorkStore) -> Result<()> {
        assert!(matches!(
            store.admit(
                &scope(),
                initial_record(),
                &source(),
                "initial",
                json!({"text": "original"}),
                deliveries(),
            )?,
            InitialAdmission::Accepted(_)
        ));
        Ok(())
    }

    fn result(basis: &ResultBasis) -> WorkResult {
        WorkResult {
            result_id: "result-1".into(),
            basis: basis.clone(),
            artifact_refs: vec!["artifact-1".into()],
            evidence_refs: vec!["evidence-1".into()],
            required_delivery_ids: vec![DELIVERY.into()],
        }
    }

    /// Claim, apply the initial input and release the claim: the only state in
    /// which completion is both unfenced and fully applied.
    fn ready(store: &ContinuousWorkStore) -> Result<WorkRecord> {
        admit(store)?;
        assert!(matches!(
            store.claim(
                &scope(),
                "work",
                1,
                0,
                "claim",
                "thread",
                ClaimTrigger::Input
            )?,
            ClaimOutcome::Acquired(_)
        ));
        store.mark_input_applied(
            &scope(),
            "work",
            &source(),
            "initial",
            "claim",
            1,
            0,
            AppliedInputReference {
                attempt: attempt(),
                history_uuid: "history-1".into(),
            },
        )?;
        store.release_claim(&scope(), "work", "claim", 1, ClaimSettlement::Completed)?;
        confirm_delivery(store)?;
        store
            .read_work(&scope(), "work")?
            .context("work must exist")
    }

    #[test]
    fn recorded_result_completes_the_applied_unclaimed_work() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-result")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let work = ready(&store)?;
        assert_eq!(work.revision.applied_input_sequence, 1);
        let basis = current_basis(&work);
        let recorded =
            store.record_result(&scope(), "work", work.revision.revision, result(&basis))?;
        assert_eq!(
            recorded.result.as_ref().map(|value| &value.basis),
            Some(&basis)
        );
        assert_eq!(recorded.phase, work.phase);
        assert_eq!(recorded.revision.revision, work.revision.revision + 1);
        assert!(
            recorded
                .presentation
                .as_ref()
                .and_then(|value| value.updated_at_ms)
                .is_some_and(|updated| updated > 1),
            "an updated record must advance its display timestamp"
        );
        let completed = store.complete_work(&scope(), "work", recorded.revision.revision, basis)?;
        assert_eq!(completed.phase, WorkPhase::Completed);
        assert_eq!(completed.revision.revision, recorded.revision.revision + 1);
        assert_eq!(
            store.read_work(&scope(), "work")?.context("work")?,
            completed
        );
        Ok(())
    }

    #[test]
    fn stale_basis_is_rejected_and_leaves_the_record_unchanged() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-result-stale")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let work = ready(&store)?;
        let mut stale = current_basis(&work);
        stale.applied_input_sequence = stale.applied_input_sequence.saturating_sub(1);
        let error = store
            .record_result(&scope(), "work", work.revision.revision, result(&stale))
            .unwrap_err();
        assert!(
            error.to_string().contains("CONTINUOUS_WORK_RESULT_STALE"),
            "{error}"
        );
        assert_eq!(store.read_work(&scope(), "work")?.context("work")?, work);
        Ok(())
    }

    #[test]
    fn unapplied_input_blocks_completion() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-input-pending")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        admit(&store)?;
        let work = store.read_work(&scope(), "work")?.context("work")?;
        assert_eq!(
            (
                work.revision.accepted_input_sequence,
                work.revision.applied_input_sequence
            ),
            (1, 0)
        );
        let error = store
            .complete_work(
                &scope(),
                "work",
                work.revision.revision,
                current_basis(&work),
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("CONTINUOUS_WORK_INPUT_PENDING"),
            "{error}"
        );
        assert_eq!(store.read_work(&scope(), "work")?.context("work")?, work);
        Ok(())
    }

    #[test]
    fn result_must_echo_the_accepted_delivery_snapshot() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-result-deliveries")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let work = ready(&store)?;
        let basis = current_basis(&work);
        for required_delivery_ids in [
            vec![],
            vec![DELIVERY.to_owned(), "delivery-email".into()],
            vec![DELIVERY.to_owned(), DELIVERY.to_owned()],
        ] {
            let mut mismatched = result(&basis);
            mismatched.required_delivery_ids = required_delivery_ids;
            let error = store
                .record_result(&scope(), "work", work.revision.revision, mismatched)
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("CONTINUOUS_WORK_DELIVERY_SNAPSHOT_REQUIRED"),
                "{error}"
            );
            assert_eq!(store.read_work(&scope(), "work")?.context("work")?, work);
        }
        Ok(())
    }

    #[test]
    fn repeated_completion_with_the_same_basis_is_idempotent() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-complete-replay")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let work = ready(&store)?;
        let basis = current_basis(&work);
        let recorded =
            store.record_result(&scope(), "work", work.revision.revision, result(&basis))?;
        let completed =
            store.complete_work(&scope(), "work", recorded.revision.revision, basis.clone())?;
        assert_eq!(completed.phase, WorkPhase::Completed);
        // A retry of a lost receipt still carries the pre-completion revision.
        let replay =
            store.complete_work(&scope(), "work", recorded.revision.revision, basis.clone())?;
        assert_eq!(replay, completed);
        assert_eq!(replay.revision.revision, completed.revision.revision);
        let mut conflicting = basis;
        conflicting.control_epoch += 1;
        let error = store
            .complete_work(&scope(), "work", completed.revision.revision, conflicting)
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("CONTINUOUS_WORK_REVISION_CONFLICT"),
            "{error}"
        );
        assert_eq!(
            store.read_work(&scope(), "work")?.context("work")?,
            completed
        );
        Ok(())
    }

    #[test]
    fn completion_rejects_a_basis_that_is_not_the_recorded_one() -> Result<()> {
        let (store, revision, basis, _temp) = ready_with_result()?;
        let mut other = basis.clone();
        other.applied_input_sequence = basis.applied_input_sequence.saturating_sub(1);
        assert!(
            store
                .complete_work(&scope(), "work", revision, other)
                .is_err()
        );
        let unchanged = store
            .read_work(&scope(), "work")?
            .context("work must exist")?;
        assert_ne!(unchanged.phase, WorkPhase::Completed);
        Ok(())
    }

    /// Admit, claim, apply, release, record a result and return everything the
    /// completion tests need.
    fn ready_with_result() -> Result<(ContinuousWorkStore, u64, ResultBasis, PrivateTempDir)> {
        let temp = kcoder_config::create_private_temp_dir("continuous-work-result")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        admit(&store)?;
        assert!(matches!(
            store.claim(
                &scope(),
                "work",
                1,
                0,
                "claim",
                "thread",
                ClaimTrigger::Input
            )?,
            ClaimOutcome::Acquired(_)
        ));
        store.mark_input_applied(
            &scope(),
            "work",
            &source(),
            "initial",
            "claim",
            1,
            0,
            AppliedInputReference {
                attempt: attempt(),
                history_uuid: "history-1".into(),
            },
        )?;
        store.release_claim(&scope(), "work", "claim", 1, ClaimSettlement::Completed)?;
        confirm_delivery(&store)?;
        let work = store
            .read_work(&scope(), "work")?
            .context("work must exist")?;
        let basis = current_basis(&work);
        let recorded =
            store.record_result(&scope(), "work", work.revision.revision, result(&basis))?;
        Ok((store, recorded.revision.revision, basis, temp))
    }
}
