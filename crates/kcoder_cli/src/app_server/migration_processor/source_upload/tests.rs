use super::*;
use kcoder_types::{
    migration::MigrationSourceKind,
    migration_source_upload::{SourceUploadFile, SourceUploadManifest},
};
use sha2::{Digest, Sha256};

fn fixture() -> (tempfile::TempDir, SourceUploads, String) {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(
            &id,
            SourceUploadManifest {
                version: 1,
                source: MigrationSourceKind::Codex,
                files: vec![SourceUploadFile {
                    relative_path: "AGENTS.md".into(),
                    bytes: 4,
                    sha256: format!("{:x}", Sha256::digest(b"body")),
                }],
            },
        )
        .unwrap();
    store.part(&id, 0, 0, 0, b"body").unwrap();
    (root, store, id)
}

#[tokio::test]
async fn verification_is_owned_before_acceptance_and_shutdown_settles_only_its_work() {
    let (_root, store, id) = fixture();
    let token = CancellationToken::new();
    let workers = UploadWorkers::new(token);
    let accepted = workers
        .start(
            &store,
            MigrationSourceUploadRunParams {
                operation_id: id.clone(),
                expected_sequence: 0,
                cancel_watermark: 0,
            },
        )
        .unwrap();
    assert_eq!(accepted.worker_state, SourceUploadWorkerState::Running);
    workers.shutdown().await;
    assert_eq!(workers.activity(), 0);
    let settled = store.read(&id).unwrap();
    assert_eq!(settled.worker_state, SourceUploadWorkerState::Stopped);
    assert_eq!(settled.received_bytes, 4);
    assert!(matches!(
        settled.stage,
        SourceUploadStage::Ready | SourceUploadStage::Failed
    ));
    let other_workers = UploadWorkers::new(CancellationToken::new());
    if settled.stage != SourceUploadStage::Ready {
        other_workers
            .start(
                &store,
                MigrationSourceUploadRunParams {
                    operation_id: id.clone(),
                    expected_sequence: settled.sequence,
                    cancel_watermark: settled.cancel_watermark,
                },
            )
            .unwrap();
        for _ in 0..200 {
            if other_workers.activity() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
    assert_eq!(store.read(&id).unwrap().stage, SourceUploadStage::Ready);
    other_workers.shutdown().await;
}

#[tokio::test]
async fn cancelled_and_stale_commands_do_not_start_a_verifier() {
    let (_root, store, id) = fixture();
    let workers = UploadWorkers::new(CancellationToken::new());
    let cancelled = store
        .cancel(&id, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    for sequence in [0, cancelled.sequence] {
        assert!(
            workers
                .start(
                    &store,
                    MigrationSourceUploadRunParams {
                        operation_id: id.clone(),
                        expected_sequence: sequence,
                        cancel_watermark: 0,
                    }
                )
                .is_err()
        );
    }
    assert_eq!(workers.activity(), 0);
    assert_eq!(store.read(&id).unwrap(), cancelled);
    workers.shutdown().await;
}

#[test]
fn source_upload_controls_have_independent_lanes_and_errors_never_echo_paths() {
    assert!(MigrationProcessor::history_control(
        method::MIGRATION_SOURCE_UPLOAD_CANCEL
    ));
    assert!(MigrationProcessor::history_control(
        method::MIGRATION_SOURCE_UPLOAD_FINISH
    ));
    assert!(MigrationProcessor::history_observation(
        method::MIGRATION_SOURCE_UPLOAD_READ
    ));
    assert!(MigrationProcessor::history_observation(
        method::MIGRATION_SOURCE_UPLOAD_FILES
    ));
    assert!(!MigrationProcessor::history_control(
        method::MIGRATION_SOURCE_UPLOAD_PART
    ));
    assert_eq!(
        safe_error(&anyhow::anyhow!("source_upload_bad_file /private/data")),
        "migration_operation_failed"
    );
    assert_eq!(
        safe_error(&anyhow::anyhow!("source_upload_invalid_part")),
        "source_upload_invalid_part"
    );
}
