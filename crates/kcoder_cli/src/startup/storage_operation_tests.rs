use super::*;
use kcoder_config::{
    PrivateDirectory,
    storage::{StorageInstance, StorageResolveInput, resolve_storage_paths, storage_location_file},
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLocationRecord, StorageMigrationComponent,
    StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
};
use std::{fs, time::Duration};

#[test]
fn handoff_stop_timeout_defers_the_original_id_without_ending_other_writers() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let input = || StorageResolveInput {
        home: Some(home.to_owned()),
        ..Default::default()
    };
    let from = resolve_storage_paths(&input())?;
    fs::create_dir_all(&from.data_root)?;
    let business = from.data_root.join("original-business");
    fs::write(&business, b"original business bytes")?;
    let writer = StorageInstance::open(input())?;
    let id = "handoff-stop-timeout";
    let data = home.join("ChosenData");
    let cache = home.join("ChosenCache");
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: from.data_root.clone(),
            destination: data.clone(),
            source_identity: PrivateDirectory::open_existing(&from.data_root)?
                .directory_identity()?,
            estimated_bytes: 0,
        }],
        from: from.clone(),
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: data.clone(),
            cache_root: cache.clone(),
            operation_id: Some(id.into()),
        },
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(home)?;
    coordinator.begin(plan.clone())?;
    let stopped = coordinator
        .wait_for_stopped(id, Duration::from_millis(50))
        .map(|_| ());
    assert_eq!(
        settle_handoff_stop(&mut coordinator, id, stopped)
            .unwrap_err()
            .to_string(),
        "STORAGE_STOP_TIMEOUT"
    );
    let deferred = coordinator.current()?.context("original receipt")?;
    assert_eq!(deferred.plan, plan);
    assert_eq!(deferred.phase, Phase::Stopping);
    assert_eq!(deferred.disposition, Disposition::Deferred);
    assert_eq!(deferred.error_code.as_deref(), Some("STORAGE_STOP_TIMEOUT"));
    assert!(deferred.owner_receipts.is_empty());
    assert_eq!(writer.paths(), &from);
    assert_eq!(fs::read(&business)?, b"original business bytes");
    assert!(!data.exists() && !cache.exists() && !storage_location_file(home).exists());
    drop(coordinator);
    let still_original = StorageInstance::open(input())?;
    assert_eq!(still_original.paths(), &from);
    drop(still_original);
    drop(writer);
    let mut coordinator = StorageCoordinator::acquire(home)?;
    let deferred = coordinator.current()?.context("original receipt")?;
    assert_eq!(deferred.disposition, Disposition::Deferred);
    assert_eq!(deferred.plan.operation_id, id);
    coordinator.retry_deferred(id)?;
    let stopped = coordinator
        .wait_for_stopped(id, Duration::from_secs(1))
        .map(|_| ());
    settle_handoff_stop(&mut coordinator, id, stopped)?;
    assert_eq!(
        coordinator.current()?.context("original receipt")?.phase,
        Phase::Stopped
    );
    assert!(!data.exists() && !cache.exists());
    assert_eq!(fs::read(business)?, b"original business bytes");
    Ok(())
}
