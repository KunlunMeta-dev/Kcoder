//! Recover the complete original prepare intent after a crash before any claim.
use super::*;
#[test]
fn catalog_intent_precedes_all_claims_and_reopens_original_set_sequence_consent_and_plan() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    let status = || {
        p.store
            .received_credential_preparation_status(
                &p.job.job_id,
                &p.f.request,
                p.f.source.authority(),
                p.f.target.authority(),
            )
            .unwrap()
    };
    assert!(matches!(
        status().phase,
        PrivateCredentialPreparationPhase::NotStarted
    ));
    MigrationStore::lose_next_received_bundle_intent_reply();
    assert_eq!(
        p.store
            .prepare_received_batch_credentials_bundle(
                &p.job.job_id,
                p.job.sequence,
                &received,
                consent(),
                &targets
            )
            .err()
            .unwrap()
            .to_string(),
        "private_credentials_outcome_unknown"
    );
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
    assert_eq!(
        p.store
            .cancel(&p.job.job_id, p.job.sequence)
            .err()
            .unwrap()
            .to_string(),
        "private_credentials_preparation_pending"
    );
    assert_eq!(p.store.read(&p.job.job_id).unwrap(), p.job);
    let pending = status();
    assert!(matches!(
        pending.phase,
        PrivateCredentialPreparationPhase::Pending
    ));
    let mut ids = received
        .iter()
        .map(|offer| offer.offer_id().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(pending.offer_ids.as_ref(), Some(&ids));
    assert_eq!(pending.expected_sequence, Some(p.job.sequence));
    let accepted = pending.consent.unwrap();
    assert!(accepted.api_keys && accepted.mcp_private_fields);
    for offer in &received {
        assert!(
            offer
                .release_unpublished_key(&p.f.target_profile, &backend)
                .is_err()
        );
    }
    let error = p
        .store
        .run_batch(
            &p.job.job_id,
            p.job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "must-not-run-before-prepare",
            p.job.sequence,
            false,
            &targets,
        )
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "private_credentials_preparation_pending");
    let provider = p
        .job
        .inventory
        .items
        .iter()
        .find(|item| item.provider.is_some())
        .unwrap();
    let choice = BatchResolution::Provider(ProviderResolution {
        item_id: provider.preview.id.clone(),
        target_name: "must-not-replan".into(),
        endpoint: None,
        model: None,
        limits: Some(ModelLimits {
            context_window_tokens: 64000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
        }),
    });
    assert_eq!(
        p.store
            .prepare_batch(&p.job.job_id, p.job.sequence, &[choice], &targets)
            .err()
            .unwrap()
            .to_string(),
        "private_credentials_preparation_pending"
    );
    std::fs::rename(&p.f.files, p.f.files.with_extension("offline")).unwrap();
    let before = original_files(&p.f.target_profile);
    let reopened = MigrationStore::open_existing(&p.f.target_profile).unwrap();
    let recovered = reopened
        .received_credential_preparation_status(
            &p.job.job_id,
            &p.f.request,
            p.f.source.authority(),
            p.f.target.authority(),
        )
        .unwrap();
    assert_eq!(original_files(&p.f.target_profile), before);
    let bindings = recovered
        .offer_ids
        .as_ref()
        .unwrap()
        .iter()
        .map(|id| {
            read_target_private_credentials(
                &p.f.target,
                p.f.source.authority(),
                &p.f.request,
                id,
                &backend,
            )
            .unwrap()
            .received
            .unwrap()
        })
        .collect::<Vec<_>>();
    let prepared = reopened
        .prepare_received_batch_credentials_bundle(
            &p.job.job_id,
            recovered.expected_sequence.unwrap(),
            &bindings,
            PrivateCredentialConsent {
                api_keys: accepted.api_keys,
                mcp_private_fields: accepted.mcp_private_fields,
            },
            &targets,
        )
        .unwrap();
    assert_eq!(prepared.batch.as_ref().unwrap().plan_id, recovered.plan_id);
    assert!(matches!(
        reopened
            .received_credential_preparation_status(
                &p.job.job_id,
                &p.f.request,
                p.f.source.authority(),
                p.f.target.authority()
            )
            .unwrap()
            .phase,
        PrivateCredentialPreparationPhase::Prepared
    ));
}

#[test]
fn preparation_status_holds_one_existing_journal_snapshot_across_intent_and_job_reads() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    let status = p
        .store
        .received_credential_preparation_status_observed(
            &p.job.job_id,
            &p.f.request,
            p.f.source.authority(),
            p.f.target.authority(),
            || {
                // Insert the real short prepare exactly after the old job read.
                // It must not publish a newer intent into this observation.
                let error = p
                    .store
                    .prepare_received_batch_credentials_bundle(
                        &p.job.job_id,
                        p.job.sequence,
                        &received,
                        consent(),
                        &targets,
                    )
                    .err()
                    .unwrap();
                assert_eq!(error.to_string(), "migration_busy");
                Ok(())
            },
        )
        .unwrap();
    assert!(matches!(
        status.phase,
        PrivateCredentialPreparationPhase::NotStarted
    ));
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
    p.store
        .prepare_received_batch_credentials_bundle(
            &p.job.job_id,
            p.job.sequence,
            &received,
            consent(),
            &targets,
        )
        .unwrap();
    assert!(matches!(
        p.store
            .received_credential_preparation_status(
                &p.job.job_id,
                &p.f.request,
                p.f.source.authority(),
                p.f.target.authority(),
            )
            .unwrap()
            .phase,
        PrivateCredentialPreparationPhase::Prepared
    ));
}

#[test]
fn missing_born_catalog_is_unknown_and_missing_journal_lock_is_never_recreated_by_status() {
    let p = planned();
    let backend = Backend::new(false);
    let _received = offers(&p, &backend);
    let status = || {
        p.store.received_credential_preparation_status(
            &p.job.job_id,
            &p.f.request,
            p.f.source.authority(),
            p.f.target.authority(),
        )
    };
    let catalog =
        p.f.target_profile
            .join("migrations/source-transfer/private-credentials/catalog.json");
    let held = catalog.with_extension("withheld");
    std::fs::rename(&catalog, &held).unwrap();
    let before = original_files(&p.f.target_profile);
    let unknown = status().unwrap();
    assert!(matches!(
        unknown.phase,
        PrivateCredentialPreparationPhase::Unknown
    ));
    assert!(
        unknown.offer_ids.is_none()
            && unknown.consent.is_none()
            && unknown.expected_sequence.is_none()
    );
    assert_eq!(original_files(&p.f.target_profile), before);
    assert_eq!(
        p.store
            .cancel(&p.job.job_id, p.job.sequence)
            .err()
            .unwrap()
            .to_string(),
        "private_credentials_publication_unknown"
    );
    assert_eq!(p.store.read(&p.job.job_id).unwrap(), p.job);
    assert_eq!(original_files(&p.f.target_profile), before);
    std::fs::rename(&held, &catalog).unwrap();
    let lock = p.f.target_profile.join("migrations/.lock");
    let held = lock.with_extension("withheld");
    std::fs::rename(&lock, &held).unwrap();
    let before = original_files(&p.f.target_profile);
    assert!(status().is_err());
    assert!(!lock.exists());
    assert_eq!(original_files(&p.f.target_profile), before);
    std::fs::rename(&held, &lock).unwrap();
}

#[test]
fn pending_prepare_cannot_rebase_original_sequence_consent_or_authenticated_request() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    MigrationStore::lose_next_received_bundle_intent_reply();
    assert!(
        p.store
            .prepare_received_batch_credentials_bundle(
                &p.job.job_id,
                p.job.sequence,
                &received,
                consent(),
                &targets,
            )
            .is_err()
    );
    let before = original_files(&p.f.target_profile);
    for (sequence, selected) in [
        (p.job.sequence + 1, consent()),
        (
            p.job.sequence,
            PrivateCredentialConsent {
                api_keys: true,
                mcp_private_fields: false,
            },
        ),
    ] {
        assert!(
            p.store
                .prepare_received_batch_credentials_bundle(
                    &p.job.job_id,
                    sequence,
                    &received,
                    selected,
                    &targets,
                )
                .is_err()
        );
    }
    assert!(
        p.store
            .received_credential_preparation_status(
                &p.job.job_id,
                &uuid::Uuid::new_v4().to_string(),
                p.f.source.authority(),
                p.f.target.authority(),
            )
            .is_err()
    );
    assert_eq!(original_files(&p.f.target_profile), before);
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
}
