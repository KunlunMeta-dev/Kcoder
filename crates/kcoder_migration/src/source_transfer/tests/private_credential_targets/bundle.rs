//! A complete original offer set joins one existing native publication group.
use super::super::private_credentials::{Backend, consent};
use super::*;
use crate::{credentials::CredentialTarget, store::CredentialTargets};
use kcoder_config::{
    CredentialStoreMode,
    imported_credentials::{CredentialGroupOutcome, ImportState, ImportedCredentialStore},
};

fn selections(p: &Planned, index: usize) -> Vec<PrivateCredentialSelection> {
    let mut candidates = page(p, index);
    map(p, &mut candidates).unwrap();
    candidates
        .items
        .into_iter()
        .map(|candidate| match candidate {
            PrivateCredentialCandidate::Provider {
                source_name,
                endpoint,
                api_format,
                selectors,
                targets,
                ..
            } => {
                let PrivateCredentialCandidateTarget::Provider { target_name, .. } = &targets[0]
                else {
                    panic!("wrong_native_target")
                };
                PrivateCredentialSelection::Provider {
                    source_name: source_name.unwrap(),
                    target_name: target_name.clone(),
                    endpoint: endpoint.unwrap(),
                    api_format,
                    selector: selectors[0].clone(),
                }
            }
            PrivateCredentialCandidate::Mcp {
                source_name,
                definition_sha256,
                fields,
                targets,
                ..
            } => {
                let PrivateCredentialCandidateTarget::Mcp { target_name, .. } = &targets[0] else {
                    panic!("wrong_native_target")
                };
                PrivateCredentialSelection::Mcp {
                    source_name: source_name.unwrap(),
                    target_name: target_name.clone(),
                    fields,
                    definition_sha256: definition_sha256.unwrap(),
                }
            }
        })
        .collect()
}
fn receive(
    p: &Planned,
    index: usize,
    selected: Vec<PrivateCredentialSelection>,
    backend: &Backend,
) -> ReceivedPrivateCredentialBinding {
    let offer = prepare_private_credential_offer(
        &p.f.target,
        PrivateCredentialOfferInput {
            request: &p.f.request,
            authenticated_source: p.f.source.authority(),
            receipt: &p.receipt,
            entry: &p.manifest.entries[index].id,
            offer_id: &uuid::Uuid::new_v4().to_string(),
            selections: selected,
            consent: consent(),
            policy: CredentialStoreMode::File,
        },
        backend,
    )
    .unwrap();
    let envelope =
        seal_private_credentials(&p.f.source, p.f.target.authority(), &offer, consent()).unwrap();
    accept_private_credential_envelope(
        &p.f.target,
        p.f.source.authority(),
        &p.receipt,
        &offer,
        &envelope,
        consent(),
        backend,
    )
    .unwrap()
}
struct Destination {
    provider: ProviderTarget,
    mcp: McpTarget,
    assets: AssetTarget,
    keys: CredentialTarget,
}
impl Destination {
    fn new(p: &Planned) -> Self {
        Self {
            provider: ProviderTarget::open(&p.f.target_profile).unwrap(),
            mcp: McpTarget::open(&p.f.target_profile).unwrap(),
            assets: AssetTarget::open(&p.f.target_profile).unwrap(),
            keys: CredentialTarget::open(&p.f.target_profile).unwrap(),
        }
    }
    fn targets<'a>(&'a self, backend: &'a Backend) -> BatchTargets<'a> {
        BatchTargets {
            provider: &self.provider,
            mcp: &self.mcp,
            assets: &self.assets,
            history: None,
            credentials: Some(CredentialTargets {
                target: &self.keys,
                backend,
                policy: CredentialStoreMode::File,
            }),
        }
    }
}
fn offers(p: &Planned, backend: &Backend) -> Vec<ReceivedPrivateCredentialBinding> {
    (0..2)
        .map(|index| receive(p, index, selections(p, index), backend))
        .collect()
}
fn claim_exists(p: &Planned, offer: &ReceivedPrivateCredentialBinding) -> bool {
    p.f.target_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("target-{}", offer.offer_id()))
        .join("publication.json")
        .exists()
}
#[test]
fn two_received_entries_publish_one_group_reopen_offline_and_release_only_after_all_refs_undo() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    let baseline = destination.provider.read_settings().unwrap();
    let prepared = p
        .store
        .prepare_received_batch_credentials_bundle(
            &p.job.job_id,
            p.job.sequence,
            &received,
            consent(),
            &targets,
        )
        .unwrap();
    assert_eq!(prepared.credential_plans.len(), 2);
    assert_eq!(prepared.mcp_credential_plans.len(), 2);
    let group = prepared.credential_plans[0]
        .atomic_group_id
        .clone()
        .unwrap();
    assert!(
        prepared
            .credential_plans
            .iter()
            .all(|plan| plan.atomic_group_id.as_deref() == Some(&group))
    );
    assert!(
        prepared
            .mcp_credential_plans
            .iter()
            .all(|plan| plan.atomic_group_id.as_deref() == Some(&group))
    );
    assert!(received.iter().all(|offer| claim_exists(&p, offer)));
    let plan = prepared.batch.as_ref().unwrap().plan_id.as_ref().unwrap();
    let mut reordered = received.clone();
    reordered.reverse();
    let reconciled = p
        .store
        .prepare_received_batch_credentials_bundle(
            &p.job.job_id,
            p.job.sequence,
            &reordered,
            consent(),
            &targets,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&prepared).unwrap(),
        serde_json::to_value(&reconciled).unwrap()
    );
    assert!(
        p.store
            .prepare_received_batch_credentials(
                &p.job.job_id,
                p.job.sequence,
                &received[0],
                consent(),
                &targets
            )
            .is_err()
    );
    std::fs::rename(&p.f.files, p.f.files.with_extension("offline")).unwrap();
    std::fs::rename(
        &p.f.source_profile,
        p.f.source_profile.with_extension("offline"),
    )
    .unwrap();
    let store = MigrationStore::open_existing(&p.f.target_profile).unwrap();
    let done = store
        .run_batch(
            &prepared.job_id,
            plan,
            "bundle-publish",
            prepared.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert!(
        done.credential_plans
            .iter()
            .all(|plan| plan.phase == crate::credentials::CredentialPhase::Published)
    );
    assert!(
        done.mcp_credential_plans
            .iter()
            .all(|plan| plan.phase == crate::credentials::CredentialPhase::Published)
    );
    let native = ImportedCredentialStore::open(&p.f.target_profile).unwrap();
    let receipt = native.group_receipt(&group).unwrap().unwrap();
    assert_eq!(receipt.outcome, CredentialGroupOutcome::Committed);
    assert_eq!(receipt.references.len(), 4);
    let settings = destination.provider.read_settings().unwrap();
    assert!(!settings.to_string().contains("SYNTHETIC_TARGET_MAP"));
    assert_eq!(
        settings["mcp_disabled_servers"],
        json!(["notes-0", "notes-1"])
    );
    for offer in &received {
        assert!(
            store
                .release_received_batch_key(&done.job_id, offer, &destination.keys, &backend)
                .is_err()
        );
    }
    let undone = store
        .run_batch(
            &done.job_id,
            plan,
            "bundle-undo",
            done.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(
        undone.status,
        kcoder_types::migration::MigrationJobStatus::RolledBack
    );
    for reference in &receipt.references {
        assert_eq!(
            native.state(reference, &backend).unwrap(),
            Some(ImportState::Undone)
        );
    }
    assert_eq!(destination.provider.read_settings().unwrap(), baseline);
    // Release remains native-only after ordinary IR and the source disappear.
    std::fs::rename(
        p.f.target_profile
            .join("migrations/source-transfer/incoming"),
        p.f.target_profile.join("ordinary-withheld"),
    )
    .unwrap();
    for offer in &received {
        store
            .release_received_batch_key(&done.job_id, offer, &destination.keys, &backend)
            .unwrap();
    }
    for offer in &received {
        store
            .release_received_batch_key(&done.job_id, offer, &destination.keys, &backend)
            .unwrap();
    }
}
#[test]
fn a_lost_first_claim_reconciles_the_original_complete_set_without_new_key_or_plan_identity() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    MigrationStore::lose_next_received_bundle_claim_reply();
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
    assert_eq!(error.to_string(), "private_credentials_outcome_unknown");
    assert_eq!(
        p.store.read(&p.job.job_id).unwrap().sequence,
        p.job.sequence
    );
    let claimed = received
        .iter()
        .find(|offer| claim_exists(&p, offer))
        .unwrap();
    let claim = claimed.publication_claim(&p.f.target_profile).unwrap();
    assert_eq!(
        received
            .iter()
            .filter(|offer| claim_exists(&p, offer))
            .count(),
        1
    );
    assert!(
        p.store
            .prepare_received_batch_credentials(
                &p.job.job_id,
                p.job.sequence,
                claimed,
                consent(),
                &targets
            )
            .is_err()
    );
    let before = original_files(
        &p.f.target_profile
            .join("migrations/source-transfer/private-credentials"),
    );
    let mut reordered = received.clone();
    reordered.reverse();
    let prepared = p
        .store
        .prepare_received_batch_credentials_bundle(
            &p.job.job_id,
            p.job.sequence,
            &reordered,
            consent(),
            &targets,
        )
        .unwrap();
    assert_eq!(
        prepared.batch.as_ref().unwrap().plan_id.as_deref(),
        Some(claim.plan_id.as_str())
    );
    let after = original_files(
        &p.f.target_profile
            .join("migrations/source-transfer/private-credentials"),
    );
    for (name, bytes) in before {
        if [
            "private-key.bin",
            "private-key.bin.proof.json",
            "key-intent.json",
            "key-intent.json.proof.json",
            "offer.json",
            "offer.json.proof.json",
            "received.json",
            "received.json.proof.json",
            "received-binding.json",
            "received-binding.json.proof.json",
            "publication.json",
            "publication.json.proof.json",
        ]
        .iter()
        .any(|expected| name.file_name().unwrap() == *expected)
        {
            assert_eq!(after.get(&name), Some(&bytes));
        }
    }
}
#[test]
fn overlapping_item_or_changed_target_revision_is_rejected_before_any_publication_claim() {
    let p = planned();
    let backend = Backend::new(false);
    let mut received = offers(&p, &backend);
    received.push(receive(&p, 0, selections(&p, 0), &backend));
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
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
    assert_eq!(error.to_string(), "private_credentials_duplicate_selection");
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
    received.pop();
    let settings = kcoder_config::ProfileSettingsFile::new(
        PrivateDirectory::open_existing(&p.f.target_profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|value| {
            value
                .as_object_mut()
                .unwrap()
                .insert("model".into(), json!("user-later-edit"));
            Ok(())
        })
        .unwrap();
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
    assert_eq!(
        error.to_string(),
        "private_credentials_publication_binding_changed"
    );
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
}
#[test]
fn cancellation_during_bundle_writer_ownership_does_not_report_stopped_or_allow_resume() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let leases = received
        .iter()
        .map(|offer| offer.publication_lease(&p.f.target_profile).unwrap())
        .collect::<Vec<_>>();
    for offer in &received {
        let control = offer.control(&p.f.target_profile).unwrap();
        let cancelled = control.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
        let state = read_target_private_credentials(
            &p.f.target,
            p.f.source.authority(),
            &p.f.request,
            offer.offer_id(),
            &backend,
        )
        .unwrap();
        assert!(state.writer_running && state.control.cancelled);
        assert!(
            control
                .resume(cancelled.sequence, cancelled.cancel_watermark)
                .is_err()
        );
    }
    drop(leases);
    for offer in &received {
        let control = offer.control(&p.f.target_profile).unwrap();
        let cancelled = control.read().unwrap();
        let state = read_target_private_credentials(
            &p.f.target,
            p.f.source.authority(),
            &p.f.request,
            offer.offer_id(),
            &backend,
        )
        .unwrap();
        assert!(!state.writer_running && state.control.cancelled);
        control
            .resume(cancelled.sequence, cancelled.cancel_watermark)
            .unwrap();
    }
}
#[test]
fn a_cancelled_sibling_blocks_the_complete_group_before_the_first_claim() {
    let p = planned();
    let backend = Backend::new(false);
    let received = offers(&p, &backend);
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
    received[1]
        .control(&p.f.target_profile)
        .unwrap()
        .cancel(&uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert!(
        p.store
            .prepare_received_batch_credentials_bundle(
                &p.job.job_id,
                p.job.sequence,
                &received,
                consent(),
                &targets
            )
            .is_err()
    );
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
    assert_eq!(
        p.store.read(&p.job.job_id).unwrap().sequence,
        p.job.sequence
    );
    for offer in &received {
        assert!(
            !read_target_private_credentials(
                &p.f.target,
                p.f.source.authority(),
                &p.f.request,
                offer.offer_id(),
                &backend
            )
            .unwrap()
            .writer_running
        );
    }
}
#[test]
fn the_same_mcp_item_cannot_be_split_across_independently_owned_offers() {
    let p = planned();
    let backend = Backend::new(false);
    let selected = selections(&p, 0)
        .into_iter()
        .filter(|selection| matches!(selection, PrivateCredentialSelection::Mcp { .. }))
        .collect::<Vec<_>>();
    let received = vec![
        receive(&p, 0, selected.clone(), &backend),
        receive(&p, 0, selected, &backend),
    ];
    let destination = Destination::new(&p);
    let targets = destination.targets(&backend);
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
    assert_eq!(error.to_string(), "private_credentials_duplicate_selection");
    assert!(received.iter().all(|offer| !claim_exists(&p, offer)));
}

#[path = "bundle/preparation.rs"]
mod preparation;
