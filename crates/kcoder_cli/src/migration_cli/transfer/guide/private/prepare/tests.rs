use super::*;

fn status() -> MigrationSourceCredentialPreparationResult {
    MigrationSourceCredentialPreparationResult {
        request_id: uuid::Uuid::new_v4().to_string(),
        job_id: format!("mig-{}", uuid::Uuid::new_v4().simple()),
        sequence: 7,
        phase: MigrationSourceCredentialPreparationPhase::Pending,
        original_plan_id: MigrationSourceCredentialPreparationPlan::Known("original-plan".into()),
        plan_id: MigrationSourceCredentialPreparationPlan::Known("canonical-private-plan".into()),
        offer_ids: MigrationSourceCredentialPreparationOffers::Known(vec![
            "00000000-0000-4000-8000-000000000001".into(),
            "00000000-0000-4000-8000-000000000002".into(),
        ]),
        expected_sequence: MigrationSourceCredentialPreparationSequence::Known(7),
        consent: MigrationSourceCredentialPreparationConsent::Known(
            MigrationSourceCredentialConsent {
                api_keys: true,
                mcp_private_fields: true,
            },
        ),
    }
}
fn request(
    value: &MigrationSourceCredentialPreparationResult,
) -> MigrationSourceCredentialPreparationReadParams {
    let draft = super::super::super::record::tests::draft();
    MigrationSourceCredentialPreparationReadParams {
        request_id: value.request_id.clone(),
        job_id: value.job_id.clone(),
        target: draft.recovery,
    }
}

#[test]
fn native_full_intent_recovers_original_ids_without_source_or_client_offer_parameters() {
    let result = status();
    let req = request(&result);
    validation::preparation(&result, &req).unwrap();
    let original = from_status(&result, req.target.clone()).unwrap();
    let ids = validation::offer_set(&original.input).unwrap();
    let mut draft = super::super::super::record::tests::draft();
    draft.request_id = result.request_id.clone();
    let mut journal = Journal::default();
    journal
        .preparations
        .insert(result.job_id.clone(), original.clone());
    journal.selected_offer = Some(ids[1].clone());
    assert!(
        journal.offers.is_empty(),
        "recovery never invents original source selections"
    );
    assert_eq!(journal.offer_ids(&result.job_id), ids);
    assert!(journal.offer_ids("another-job").is_empty());
    journal.validate(&draft).unwrap();
    let decoded: Journal = serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap();
    assert_eq!(decoded.offer_ids(&result.job_id), ids);
    assert_eq!(original.input.expected_sequence, 7);
    assert_eq!(
        original.canonical_plan_id.as_deref(),
        Some("canonical-private-plan")
    );
    let mut later = result.clone();
    later.phase = MigrationSourceCredentialPreparationPhase::Prepared;
    later.sequence = 31;
    validation::preparation(&later, &req).unwrap();
    matches_intent(&original, &later).unwrap();
    assert!(validation::same_preparation(&later, &result));
    let restored = from_status(&later, req.target).unwrap();
    assert_eq!(
        restored.input, original.input,
        "observed job sequence is never reused as the original prepare CAS"
    );
}

#[test]
fn changed_request_job_plan_set_cas_and_consent_cannot_rebind_a_saved_native_intent() {
    let result = status();
    let original = from_status(&result, request(&result).target).unwrap();
    let mut changes = Vec::new();
    let mut changed = result.clone();
    changed.request_id = uuid::Uuid::new_v4().to_string();
    changes.push(changed);
    let mut changed = result.clone();
    changed.job_id = format!("mig-{}", uuid::Uuid::new_v4().simple());
    changes.push(changed);
    let mut changed = result.clone();
    changed.original_plan_id = MigrationSourceCredentialPreparationPlan::Known("other".into());
    changes.push(changed);
    let mut changed = result.clone();
    changed.plan_id = MigrationSourceCredentialPreparationPlan::Known("other".into());
    changes.push(changed);
    let mut changed = result.clone();
    changed.offer_ids = MigrationSourceCredentialPreparationOffers::Known(vec![
        "00000000-0000-4000-8000-000000000001".into(),
    ]);
    changes.push(changed);
    let mut changed = result.clone();
    changed.expected_sequence = MigrationSourceCredentialPreparationSequence::Known(8);
    changes.push(changed);
    let mut changed = result.clone();
    changed.consent =
        MigrationSourceCredentialPreparationConsent::Known(MigrationSourceCredentialConsent {
            api_keys: false,
            mcp_private_fields: true,
        });
    changes.push(changed);
    for changed in changes {
        assert!(matches_intent(&original, &changed).is_err());
    }
    let mut changed = result.clone();
    changed.sequence = 6;
    assert!(
        !validation::same_preparation(&changed, &result),
        "observation cannot regress"
    );
    let mut duplicate = result.clone();
    duplicate.offer_ids = MigrationSourceCredentialPreparationOffers::Known(
        vec!["00000000-0000-4000-8000-000000000001".into(); 2],
    );
    assert!(validation::preparation(&duplicate, &request(&result)).is_err());
    let mut partial = result.clone();
    partial.consent = MigrationSourceCredentialPreparationConsent::Unknown(());
    assert!(validation::preparation(&partial, &request(&result)).is_err());
    let mut unknown = result.clone();
    unknown.phase = MigrationSourceCredentialPreparationPhase::Unknown;
    assert!(
        from_status(&unknown, request(&result).target).is_err(),
        "unknown does not authorize reconstruction for mutation"
    );
}

#[test]
fn recovered_private_cache_remains_bound_to_original_request_target_and_cancel_owner() {
    let result = status();
    let mut draft = super::super::super::record::tests::draft();
    draft.request_id = result.request_id.clone();
    let mut journal = Journal::default();
    journal.preparations.insert(
        result.job_id.clone(),
        from_status(&result, draft.recovery.clone()).unwrap(),
    );
    let id = journal.offer_ids(&result.job_id)[0].clone();
    journal.selected_offer = Some(id.clone());
    journal.controls.insert(
        format!("{id}:target"),
        CancelIntent {
            command_id: uuid::Uuid::new_v4().to_string(),
            expected: MigrationSourceCredentialExpectedControl {
                sequence: 4,
                cancel_watermark: 2,
            },
        },
    );
    journal.validate(&draft).unwrap();
    draft.target.target_id = "wrong-target".into();
    assert!(journal.validate(&draft).is_err());
    draft.target.target_id = "target".into();
    draft.request_id = uuid::Uuid::new_v4().to_string();
    assert!(journal.validate(&draft).is_err());
    draft.request_id = result.request_id;
    journal.controls.insert(
        "another-offer:target".into(),
        CancelIntent {
            command_id: uuid::Uuid::new_v4().to_string(),
            expected: MigrationSourceCredentialExpectedControl {
                sequence: 4,
                cancel_watermark: 2,
            },
        },
    );
    assert!(journal.validate(&draft).is_err());
}

#[test]
fn observations_keep_unknown_distinct_and_reject_contradictory_receipts_or_terminal_phases() {
    let result = status();
    let locator = from_status(&result, request(&result).target)
        .unwrap()
        .input
        .locator;
    let control = MigrationSourceTransferObservedControl::Present(MigrationSourceTransferControl {
        sequence: 4,
        cancel_watermark: 0,
        cancelled: false,
        ready: true,
    });
    let observed = MigrationSourceCredentialResult {
        request_id: locator.request_id.clone(),
        offer_id: locator.offer_id.clone(),
        phase: MigrationSourceCredentialPhase::Received,
        source_control: MigrationSourceTransferObservedControl::Absent(()),
        target_control: control,
        source_observed: false,
        target_observed: true,
        source_worker_running: MigrationSourceCredentialObservedWorker::Unobserved(()),
        target_worker_running: MigrationSourceCredentialObservedWorker::Observed(false),
        received: true,
        key_released: false,
    };
    validation::observation(&observed, &locator, false).unwrap();
    for mutation in 0..6 {
        let mut changed = observed.clone();
        match mutation {
            0 => changed.offer_id = uuid::Uuid::new_v4().to_string(),
            1 => changed.request_id = uuid::Uuid::new_v4().to_string(),
            2 => {
                changed.source_worker_running =
                    MigrationSourceCredentialObservedWorker::Observed(false)
            }
            3 => {
                changed.target_worker_running =
                    MigrationSourceCredentialObservedWorker::Unobserved(())
            }
            4 => changed.phase = MigrationSourceCredentialPhase::Released,
            _ => changed.received = false,
        }
        assert!(validation::observation(&changed, &locator, false).is_err());
    }
    assert!(
        validation::observation(&observed, &locator, true).is_err(),
        "source-only read cannot claim target receipt"
    );
}

#[test]
fn private_errors_are_a_closed_code_set_and_never_echo_values_or_unreviewed_codes() {
    assert!(super::super::is_error_code(
        "private_credentials_receive_unconfirmed"
    ));
    for value in [
        "private_credentials_secret_literal",
        "private_credentials_SECRET_VALUE",
        "PRIVATE_CANARY_BODY",
    ] {
        assert!(!super::super::is_error_code(value));
        let error = anyhow::anyhow!("{value}");
        assert_eq!(
            safe_error(&error),
            "migration_transfer_failed_read_original_request"
        );
    }
}

#[test]
fn unrelated_unused_offer_is_not_claimed_by_another_canonical_bundle_and_unknown_never_means_unused()
 {
    let mut native = status();
    let offer = "00000000-0000-4000-8000-000000000001";
    assert!(validation::key_bound_to_preparation(&native, offer).unwrap());
    assert!(
        !validation::key_bound_to_preparation(&native, "00000000-0000-4000-8000-000000000003")
            .unwrap()
    );
    native.phase = MigrationSourceCredentialPreparationPhase::Prepared;
    assert!(validation::key_bound_to_preparation(&native, offer).unwrap());
    native.phase = MigrationSourceCredentialPreparationPhase::Unknown;
    assert!(validation::key_bound_to_preparation(&native, offer).is_err());
    native.phase = MigrationSourceCredentialPreparationPhase::NotStarted;
    assert!(!validation::key_bound_to_preparation(&native, offer).unwrap());
}
