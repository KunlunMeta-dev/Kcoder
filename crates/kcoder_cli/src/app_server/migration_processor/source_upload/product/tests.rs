use super::*;
use kcoder_types::{
    migration::MigrationSourceKind,
    migration_source_upload::{SourceUploadFile, SourceUploadManifest},
};
use sha2::{Digest, Sha256};

fn fixture() -> (
    tempfile::TempDir,
    SourceUploads,
    MigrationSourceProductParams,
) {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let manifest_sha256 = store
        .prepare(
            &operation_id,
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
        .unwrap()
        .manifest_sha256;
    store.part(&operation_id, 0, 0, 0, b"body").unwrap();
    store.finish(&operation_id, 0, |_, _| true).unwrap();
    (
        root,
        store,
        MigrationSourceProductParams {
            operation_id,
            manifest_sha256,
        },
    )
}

#[test]
fn failed_explicit_uploaded_choice_blocks_default_discovery_and_other_selections() {
    let (_root, store, params) = fixture();
    let processor = MigrationProcessor::new();
    assert!(select(&processor, &store, params.clone()).is_err());
    assert!(processor.registry.lock().unwrap().is_none());
    assert_eq!(
        processor.uploaded_choice.lock().unwrap().as_ref(),
        Some(&params)
    );
    let other = MigrationSourceProductParams {
        operation_id: uuid::Uuid::new_v4().to_string(),
        ..params.clone()
    };
    assert!(select(&processor, &store, other).is_err());
    let (_, worker) = store
        .prepare_materialization(&params.operation_id, &params.manifest_sha256)
        .unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let result = select(&processor, &store, params.clone()).unwrap();
    assert_eq!(result["operationId"], params.operation_id);
    assert_eq!(result["origin"], "user_supplied");
    let repeated = select(&processor, &store, params).unwrap();
    assert!(repeated["remainingMs"].as_u64().unwrap() <= result["remainingMs"].as_u64().unwrap());
    assert!(super::super::super::source_directory::execute(&processor, serde_json::json!({
        "selectionId":uuid::Uuid::new_v4().to_string(),"source":"codex","directory":_root.path()
    })).is_err());
}

#[tokio::test]
async fn product_controls_are_independent_and_stale_run_cannot_cross_resume() {
    let (_root, store, params) = fixture();
    let (_, held) = store
        .prepare_materialization(&params.operation_id, &params.manifest_sha256)
        .unwrap();
    let cancelled = store
        .cancel_materialization(
            &params.operation_id,
            &params.manifest_sha256,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    drop(held);
    let resumed = store
        .resume_materialization(
            &params.operation_id,
            &params.manifest_sha256,
            cancelled.sequence,
            cancelled.cancel_watermark,
        )
        .unwrap();
    let workers = UploadWorkers::new(CancellationToken::new());
    assert!(
        workers
            .start_product(
                &store,
                MigrationSourceProductRunParams {
                    operation_id: params.operation_id.clone(),
                    manifest_sha256: params.manifest_sha256.clone(),
                    expected_sequence: 0,
                    cancel_watermark: 0
                }
            )
            .is_err()
    );
    assert_eq!(workers.activity(), 0);
    assert_eq!(
        store.read(&params.operation_id).unwrap().cancel_watermark,
        0
    );
    assert_eq!(
        store.read(&params.operation_id).unwrap().stage,
        SourceUploadStage::Ready
    );
    workers
        .start_product(
            &store,
            MigrationSourceProductRunParams {
                operation_id: params.operation_id.clone(),
                manifest_sha256: params.manifest_sha256.clone(),
                expected_sequence: resumed.sequence,
                cancel_watermark: resumed.cancel_watermark,
            },
        )
        .unwrap();
    workers.shutdown().await;
    assert_eq!(
        store
            .read_materialization(&params.operation_id, &params.manifest_sha256)
            .unwrap()
            .worker_state,
        SourceUploadWorkerState::Stopped
    );
}
