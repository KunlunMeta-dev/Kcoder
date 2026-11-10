//! Generic ordinary creation resolves sources only before a durable capture exists.
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    batch::BatchSource,
    discovery::ConfigurationBinding,
    store::{
        BatchCaptureInput, BatchCreateIntent, BatchCreationStage as Stage,
        BatchCreationWorkerState as Worker, MigrationStore,
    },
};
use kcoder_types::migration::{MigrationJobStatus as Status, MigrationSourceKind as Kind};
use std::{fs, path::PathBuf};
const REQUEST: &str = "272abcf1-154c-4366-949e-fb81ed21f5f0";
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::write(profile.join("settings.json"), "{}").unwrap();
        let source = root.path().join("settings.json");
        fs::write(
            &source,
            r#"{"mcpServers":{"docs":{"command":"NEVER_RUN_BATCH_CREATION_FIXTURE"}}}"#,
        )
        .unwrap();
        Self {
            _root: root,
            profile,
            source,
        }
    }
    fn store(&self) -> MigrationStore {
        MigrationStore::open_or_create(&self.profile).unwrap()
    }
    fn intent(&self) -> BatchCreateIntent {
        BatchCreateIntent::new(REQUEST,&serde_json::json!({"sourceIds":["original-opaque-reference"],"destination":"user","initialLimits":null})).unwrap()
    }
    fn resolve(&self) -> BatchCaptureInput {
        BatchCaptureInput {
            sources: vec![BatchSource::Configuration(
                ConfigurationBinding::capture_selected(&self.source, Kind::ClaudeCode).unwrap(),
            )],
            resource_limits: Default::default(),
            project: None,
        }
    }
}
#[test]
fn lost_create_reply_returns_current_original_job_before_expired_source_resolution() {
    let f = Fixture::new();
    let store = f.store();
    let mut resolved = 0;
    let initial = store
        .create_batch_scan_idempotent(
            &f.intent(),
            |_| {
                resolved += 1;
                Ok(f.resolve())
            },
            &mut |_, _| true,
        )
        .unwrap();
    assert_eq!(resolved, 1);
    assert_eq!(
        (initial.stage, initial.worker_state),
        (Stage::Published, Worker::Stopped)
    );
    let job = initial.job.unwrap();
    let updated = store.cancel(&job.job_id, job.sequence).unwrap();
    assert_eq!(updated.status, Status::Cancelled);
    fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    drop(store);
    let store = MigrationStore::open_existing(&f.profile).unwrap();
    assert_eq!(store.batch_creation_intent(REQUEST).unwrap(), f.intent());
    let replay = store
        .create_batch_scan_idempotent(
            &f.intent(),
            |_| panic!("expired registry/source must never be queried"),
            &mut |_, _| panic!("replay does not start a worker"),
        )
        .unwrap();
    assert_eq!(replay.job.unwrap(), updated);
    assert_eq!(
        store
            .lookup_batch_creation(&f.intent())
            .unwrap()
            .unwrap()
            .job_id,
        job.job_id
    );
    let changed=BatchCreateIntent::new(REQUEST,&serde_json::json!({"sourceIds":["original-opaque-reference"],"destination":"project","initialLimits":null})).unwrap();
    let error = store
        .create_batch_scan_idempotent(
            &changed,
            |_| panic!("conflicting request cannot resolve sources"),
            &mut |_, _| true,
        )
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("migration_batch_create_intent_conflict")
    );
    assert_eq!(store.read(&job.job_id).unwrap(), updated);
}

#[test]
fn complete_capture_can_explicitly_resume_without_original_files_or_a_new_request() {
    let f = Fixture::new();
    let store = f.store();
    assert!(
        store
            .create_batch_scan_idempotent(&f.intent(), |_| Ok(f.resolve()), &mut |stage, _| stage
                != Stage::Prepared)
            .is_err()
    );
    let pending = store.read_batch_creation(REQUEST).unwrap();
    assert_eq!(
        (
            pending.stage,
            pending.worker_state,
            pending.cancel_requested
        ),
        (Stage::Prepared, Worker::Stopped, Some(true))
    );
    assert!(pending.job.is_none());
    assert!(store.read(&pending.job_id).is_err());
    fs::remove_file(&f.source).unwrap();
    let retry = store
        .create_batch_scan_idempotent(
            &f.intent(),
            |_| panic!("same create only observes its captured checkpoint"),
            &mut |_, _| true,
        )
        .unwrap();
    assert_eq!(retry.stage, Stage::Prepared);
    assert!(
        store
            .continue_batch_creation(
                &f.intent(),
                pending.control_revision.unwrap(),
                |_| panic!("resume consent is absent"),
                &mut |_, _| true
            )
            .is_err()
    );
    let resume_id = uuid::Uuid::new_v4().to_string();
    let resumed = store
        .resume_batch_creation(&f.intent(), &resume_id, pending.control_revision.unwrap())
        .unwrap();
    assert_eq!(resumed.job_id, pending.job_id);
    assert_eq!(resumed.cancel_requested, Some(false));
    let receipt_retry = store
        .resume_batch_creation(&f.intent(), &resume_id, pending.control_revision.unwrap())
        .unwrap();
    assert_eq!(receipt_retry.control_revision, resumed.control_revision);
    drop(store);
    let store = MigrationStore::open_existing(&f.profile).unwrap();
    let original = store.batch_creation_intent(REQUEST).unwrap();
    assert_eq!(original, f.intent());
    let published = store
        .continue_batch_creation(
            &original,
            resumed.control_revision.unwrap(),
            |_| panic!("captured Native data is sufficient"),
            &mut |_, _| true,
        )
        .unwrap();
    assert_eq!(
        (published.stage, published.worker_state),
        (Stage::Published, Worker::Stopped)
    );
    let job = published.job.unwrap();
    assert_eq!(
        (job.job_id.as_str(), job.sequence, job.status),
        (pending.job_id.as_str(), 1, Status::Ready)
    );
    assert_eq!(job.inventory.items.len(), 1);
    assert!(f.profile.join("settings.json").is_file());
    assert_eq!(
        fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
}

#[test]
fn a_peer_can_cancel_the_original_active_capture_and_only_explicit_resume_restarts_it() {
    let f = Fixture::new();
    let store = f.store();
    let peer = MigrationStore::open_existing(&f.profile).unwrap();
    let cancel_id = uuid::Uuid::new_v4().to_string();
    let mut sent = false;
    let result = store.create_batch_scan_idempotent(
        &f.intent(),
        |check| {
            let input = f.resolve();
            assert!(check(1));
            assert!(!check(2));
            Ok(input)
        },
        &mut |_, units| {
            if units == 1 && !sent {
                sent = true;
                assert!(
                    peer.batch_creation_intent(REQUEST).is_err(),
                    "unsealed original intent must not be available to a new resolver"
                );
                let view = peer
                    .cancel_batch_creation_request(REQUEST, &cancel_id, 1)
                    .unwrap();
                assert_eq!(view.worker_state, Worker::Running);
                assert_eq!(view.cancel_requested, Some(true));
            }
            true
        },
    );
    assert!(sent && result.is_err());
    let stopped = peer.read_batch_creation(REQUEST).unwrap();
    assert_eq!(
        (
            stopped.worker_state,
            stopped.cancel_requested,
            stopped.control_revision
        ),
        (Worker::Stopped, Some(true), Some(2))
    );
    let same = peer
        .cancel_batch_creation(&f.intent(), &cancel_id, 1)
        .unwrap();
    assert_eq!(same.control_revision, Some(2));
    assert!(
        peer.cancel_batch_creation(&f.intent(), &cancel_id, 2)
            .is_err()
    );
    let resumed = peer
        .resume_batch_creation(&f.intent(), &uuid::Uuid::new_v4().to_string(), 2)
        .unwrap();
    assert!(
        peer.continue_batch_creation(&f.intent(), 2, |_| Ok(f.resolve()), &mut |_, _| true)
            .is_err()
    );
    let done = peer
        .continue_batch_creation(
            &f.intent(),
            resumed.control_revision.unwrap(),
            |_| Ok(f.resolve()),
            &mut |_, _| true,
        )
        .unwrap();
    assert_eq!(done.stage, Stage::Published);
}

#[test]
fn legacy_random_jobs_keep_their_wire_and_do_not_gain_a_creation_binding() {
    let f = Fixture::new();
    let store = f.store();
    let original = store.create_batch_scan(f.resolve().sources).unwrap();
    let encoded = serde_json::to_value(&original).unwrap();
    assert!(encoded["batch"].get("creation").is_none());
    assert_eq!(store.read(&original.job_id).unwrap(), original);
    let created = store
        .create_batch_scan_idempotent(&f.intent(), |_| Ok(f.resolve()), &mut |_, _| true)
        .unwrap();
    assert_ne!(created.job_id, original.job_id);
    assert_eq!(store.read(&original.job_id).unwrap(), original);
    let encoded = serde_json::to_value(created.job.unwrap()).unwrap();
    assert!(encoded["batch"]["creation"].is_object());
}

#[test]
fn ordinary_job_read_and_mutation_cannot_bypass_a_missing_original_creation_lease() {
    let f = Fixture::new();
    let store = f.store();
    let ready = store
        .create_batch_scan_idempotent(&f.intent(), |_| Ok(f.resolve()), &mut |_, _| true)
        .unwrap()
        .job
        .unwrap();
    let lease = f
        .profile
        .join("migrations")
        .join(format!("{}.plans", ready.job_id))
        .join("create.lock");
    fs::remove_file(&lease).unwrap();
    assert!(store.read_batch_creation(REQUEST).is_err());
    assert!(
        store.read(&ready.job_id).is_err(),
        "ordinary job routing must not bypass original creation ownership"
    );
    assert!(store.cancel(&ready.job_id, ready.sequence).is_err());
    assert!(
        !lease.exists(),
        "observation/mutation cannot repair a missing authority"
    );
}
