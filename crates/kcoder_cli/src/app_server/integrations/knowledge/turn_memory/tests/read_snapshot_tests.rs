use super::*;
use crate::app_server::integrations::knowledge::{
    NativeMemorySnapshotReadError as Failure, read_thread_memory_snapshot,
};

async fn frozen(f: &Fixture) -> Result<(TurnAttemptIdentity, String, MemoryTaskSnapshot)> {
    let identity = accepted(f)?;
    let (id, snapshot) = f
        .engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .context("missing native prepared snapshot")?;
            Ok::<_, anyhow::Error>((
                prepared.snapshot_id().to_string(),
                prepared.snapshot().clone(),
            ))
        })
        .await?;
    Ok((identity, id, snapshot))
}
fn data_path(f: &Fixture) -> Result<PathBuf> {
    Ok(f.native
        .profile_path()?
        .join(f.source.guard.namespace_id())
        .join("data/memory-review.json"))
}
fn read(f: &Fixture, id: &str) -> std::result::Result<MemoryTaskSnapshot, Failure> {
    read_thread_memory_snapshot(&f.native, &f.engine, id, Some(f.source.as_ref()))
}

#[tokio::test]
async fn canonical_read_of_completed_actual_turn_preserves_original_snapshot_after_current_review_edit()
-> Result<()> {
    let f = fixture(true, None)?;
    let confirmed = seed(&f)?;
    let (identity, id, snapshot) = frozen(&f).await?;
    crate::app_server::turn_attempts::finish(
        &f.engine,
        &identity,
        "completed",
        None,
        None,
        &crate::app_server::turn_attempts::PartialOutput::default(),
    )?;
    f.source.store.edit(
        "edit-current-before-audit",
        &confirmed.id,
        confirmed.revision,
        "Current memory is newer than this task.".into(),
        600,
    )?;
    f.engine
        .settings
        .write()
        .unwrap()
        .integrations
        .knowledge
        .memory_center_enabled = false;
    let before = std::fs::read(data_path(&f)?)?;
    let restored = read(&f, &id)?;
    assert_eq!(restored, snapshot);
    assert_eq!(
        restored.memories[0].proposal.content,
        "Frozen reviewed revision one."
    );
    assert_eq!(std::fs::read(data_path(&f)?)?, before);
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn an_existing_snapshot_and_a_valid_looking_id_without_private_native_acceptance_are_not_authority()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, real_id, _) = frozen(&f).await?;
    let fake = TurnAttemptIdentity {
        thread_id: f.engine.session_id(),
        turn_id: "turn-payload-claims".into(),
        attempt_id: "user-supplied-attempt".into(),
    };
    let fake_id = snapshot_key(&f.native, &fake)?;
    f.source.store.capture_task_snapshot(
        &fake_id,
        u64::try_from(chrono::Utc::now().timestamp_millis())?,
    )?;
    let before = std::fs::read(data_path(&f)?)?;
    assert_eq!(read(&f, &fake_id).unwrap_err(), Failure::NotFound);
    assert_eq!(
        read(&f, &format!("{real_id}-wrong")).unwrap_err(),
        Failure::NotFound
    );
    assert_eq!(read(&f, "").unwrap_err(), Failure::InvalidRequest);
    assert_eq!(std::fs::read(data_path(&f)?)?, before);
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn snapshot_read_rejects_wrong_native_owner_before_returning_cached_body() -> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id, _) = frozen(&f).await?;
    let other = fixture(true, None)?;
    let result =
        read_thread_memory_snapshot(&other.native, &f.engine, &id, Some(f.source.as_ref()));
    assert_eq!(result.unwrap_err(), Failure::Denied);
    Ok(())
}

#[tokio::test]
async fn current_policy_unknown_and_real_identity_revocation_refuse_the_original_body() -> Result<()>
{
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id, _) = frozen(&f).await?;
    f.source.allowed.store(false, Ordering::SeqCst);
    assert_eq!(read(&f, &id).unwrap_err(), Failure::Unavailable);
    f.source.allowed.store(true, Ordering::SeqCst);
    let mut global = f.native.scope().clone();
    global.workspace_id = IntegrationNullable::Null;
    let authority = crate::app_server::integrations::core::NativeIdentity::observe(
        f.native.profile()?,
        &global,
    )?
    .unwrap();
    authority.disable(f.native.profile()?, "revoke-snapshot-audit", 1, 700)?;
    assert_eq!(read(&f, &id).unwrap_err(), Failure::Denied);
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn committed_source_namespace_loss_is_unavailable_without_initialization_or_empty_success()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id, _) = frozen(&f).await?;
    let namespace = f.source.guard.namespace_id();
    std::fs::rename(
        f.native.profile_path()?.join(namespace),
        f.native.profile_path()?.join("held-source-for-audit"),
    )?;
    f.native
        .profile()?
        .create_private_child(OsStr::new(namespace))?;
    assert_eq!(read(&f, &id).unwrap_err(), Failure::Unavailable);
    assert!(
        !f.native
            .profile_path()?
            .join(namespace)
            .join("data")
            .exists()
    );
    assert_eq!(
        read_thread_memory_snapshot(&f.native, &f.engine, &id, None).unwrap_err(),
        Failure::Unavailable
    );
    Ok(())
}

#[tokio::test]
async fn missing_original_private_receipt_cannot_be_replaced_by_an_opaque_key_or_existing_data()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id, _) = frozen(&f).await?;
    let directory = f.engine.session_storage_dir_for(&f.engine.session_id());
    std::fs::rename(
        directory.join("turn-attempts"),
        directory.join("held-original-turn-attempts"),
    )?;
    assert_eq!(read(&f, &id).unwrap_err(), Failure::Unavailable);
    assert!(!directory.join("turn-attempts").exists());
    assert!(f.source.store.read_task_snapshot(&id)?.is_some());
    Ok(())
}

struct DenyAfterFirstRead {
    source: Arc<Source>,
    calls: AtomicUsize,
}
impl NativeReviewedMemorySource for DenyAfterFirstRead {
    fn verified_store(&self, native: &NativeIntegrationContext) -> Result<&MemoryReviewStore> {
        ensure!(
            self.calls.fetch_add(1, Ordering::SeqCst) == 0,
            "native-memory-read-policy-revoked"
        );
        self.source.verified_store(native)
    }
}
#[tokio::test]
async fn source_authorization_lost_during_audit_does_not_release_the_previously_read_snapshot()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id, _) = frozen(&f).await?;
    let source = DenyAfterFirstRead {
        source: f.source.clone(),
        calls: AtomicUsize::new(0),
    };
    let before = std::fs::read(data_path(&f)?)?;
    let result = read_thread_memory_snapshot(&f.native, &f.engine, &id, Some(&source));
    assert_eq!(result.unwrap_err(), Failure::Unavailable);
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    assert_eq!(std::fs::read(data_path(&f)?)?, before);
    Ok(())
}

#[test]
fn public_error_metadata_is_finite_and_never_a_completed_null_snapshot() {
    for failure in [
        Failure::InvalidRequest,
        Failure::Denied,
        Failure::NotFound,
        Failure::Unavailable,
    ] {
        assert!(failure.code().starts_with("MEMORY_TASK_SNAPSHOT_"));
        assert_ne!(
            failure.status(),
            kcoder_types::integrations::core::IntegrationStatus::Completed
        );
    }
    assert_eq!(
        Failure::Denied.recovery(),
        kcoder_types::integrations::core::IntegrationRecovery::RequestAuthorization
    );
}
