use super::*;

struct Fixture {
    _root: tempfile::TempDir,
    scope: IntegrationScope,
    store: AutomationStore,
    run: AutomationRun,
    manifest: IntegrationEntityRef,
    bytes: Vec<u8>,
    hash: String,
}
fn fixture() -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope =
        serde_json::from_value(json!({"accountId":"claim-owner","targetId":"claim-target",
        "workspaceId":null,"identityGeneration":"1","targetRevision":"1"}))?;
    let store = AutomationStore::create(&root.path().join("automation"), &scope)?;
    let draft = AutomationSubscriptionDraft {
        id: "sub".into(),
        title: "Claim test".into(),
        workflow_id: "flow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 1 }),
        event_source: None,
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 30,
        delivery: AutomationDestination::Studio,
    };
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&scope, "consent", &draft)?;
    store.save_subscription("save", 0, draft, &consent, Some(1000), 1)?;
    let run = store.prepare_run("sub", 1, "trigger", json!({}), Some(2000), 1000)?;
    store.record_native_acceptance(&run.id, "native-thread", Some("native-turn"), 1000)?;
    let manifest = IntegrationEntityRef {
        kind: IntegrationEntityKind::Artifact,
        id: "artifact-1".into(),
        revision: Some("7".into()),
    };
    store.record_artifact_manifests(&run.id, vec![manifest.clone()])?;
    let run = store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        None,
        vec![manifest.id.clone()],
        1100,
    )?;
    let path = root.path().join("actual-artifact.txt");
    std::fs::write(&path, b"Actual synthetic exported bytes\n")?;
    let bytes = std::fs::read(path)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(Fixture {
        _root: root,
        scope,
        store,
        run,
        manifest,
        bytes,
        hash,
    })
}
fn proof(f: &Fixture) -> Result<ApprovedAutomationArtifactClaim> {
    ApprovedAutomationArtifactClaim::from_verified_native_transfer(
        &f.scope,
        &f.run,
        f.manifest.clone(),
        "native-export-1",
        f.bytes.len() as u64,
        f.bytes.len() as u64,
        &f.hash,
        &f.hash,
        true,
        false,
        1200,
    )
}
#[test]
fn actual_full_byte_observation_binds_frozen_manifest_and_survives_ack_loss_reopen() -> Result<()> {
    let f = fixture()?;
    let proof = proof(&f)?;
    f.store
        .ack_loss
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        f.store
            .record_verified_artifact_claim("claim-export-1", &proof)
            .unwrap_err()
            .to_string()
            .contains("UNCONFIRMED")
    );
    let reopened = AutomationStore::open(&f._root.path().join("automation"), &f.scope)?;
    let claimed = reopened.read_artifact_claims(&f.run.id, None)?;
    assert_eq!(claimed.items.len(), 1);
    assert_eq!(claimed.items[0].sha256, f.hash);
    assert_eq!(claimed.items[0].manifest_ref.revision.as_deref(), Some("7"));
    assert_eq!(
        reopened.record_verified_artifact_claim("claim-export-1", &proof)?,
        claimed.items[0]
    );
    assert_eq!(
        reopened.read_artifact_claims(&f.run.id, None)?.items.len(),
        1
    );
    assert_eq!(
        reopened.read_run(&f.run.id)?.delivery_status,
        AutomationDeliveryStatus::StudioAvailable
    );
    Ok(())
}
#[test]
fn partial_cancelled_hash_mismatch_or_wrong_owner_cannot_acknowledge_a_claim() -> Result<()> {
    let f = fixture()?;
    for (bytes, hash, complete, cancelled) in [
        (f.bytes.len() as u64 - 1, f.hash.as_str(), true, false),
        (f.bytes.len() as u64, f.hash.as_str(), false, false),
        (f.bytes.len() as u64, f.hash.as_str(), true, true),
        (
            f.bytes.len() as u64,
            "0000000000000000000000000000000000000000000000000000000000000000",
            true,
            false,
        ),
    ] {
        assert!(
            ApprovedAutomationArtifactClaim::from_verified_native_transfer(
                &f.scope,
                &f.run,
                f.manifest.clone(),
                "export",
                f.bytes.len() as u64,
                bytes,
                &f.hash,
                hash,
                complete,
                cancelled,
                1200
            )
            .is_err()
        );
    }
    let mut foreign = f.scope.clone();
    foreign.account_id = "other-owner".into();
    assert!(
        ApprovedAutomationArtifactClaim::from_verified_native_transfer(
            &foreign,
            &f.run,
            f.manifest.clone(),
            "export",
            1,
            1,
            &f.hash,
            &f.hash,
            true,
            false,
            1200
        )
        .is_err()
    );
    assert!(
        f.store
            .read_artifact_claims(&f.run.id, None)?
            .items
            .is_empty()
    );
    Ok(())
}
#[test]
fn wrong_native_operation_or_manifest_revision_is_rejected_without_changing_any_claim() -> Result<()>
{
    let f = fixture()?;
    let mut changed = f.run.clone();
    changed.native_operation_id = "another-operation".into();
    let proof = ApprovedAutomationArtifactClaim::from_verified_native_transfer(
        &f.scope,
        &changed,
        f.manifest.clone(),
        "export",
        1,
        1,
        &f.hash,
        &f.hash,
        true,
        false,
        1200,
    )?;
    assert!(
        f.store
            .record_verified_artifact_claim("wrong-operation", &proof)
            .is_err()
    );
    let mut manifest = f.manifest.clone();
    manifest.revision = Some("8".into());
    let proof = ApprovedAutomationArtifactClaim::from_verified_native_transfer(
        &f.scope, &f.run, manifest, "export", 1, 1, &f.hash, &f.hash, true, false, 1200,
    )?;
    assert!(
        f.store
            .record_verified_artifact_claim("wrong-revision", &proof)
            .is_err()
    );
    assert!(
        f.store
            .read_artifact_claims(&f.run.id, None)?
            .items
            .is_empty()
    );
    Ok(())
}
