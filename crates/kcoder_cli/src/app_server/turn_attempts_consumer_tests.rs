use super::turn_attempts::{begin_with_retained_input, request_fingerprint, store};
use kcoder_types::{TurnAttemptIdentity, TurnRetainedInputV1};
use serde_json::json;

#[test]
fn retained_acceptance_rejects_wrong_request_before_store_io() {
    let temp = tempfile::tempdir().unwrap();
    let engine = super::tests::catalog_list_test_engine(temp.path());
    let identity = TurnAttemptIdentity {
        thread_id: "thread".into(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    let params: kcoder_app_protocol::TurnStartParams = serde_json::from_value(json!({
        "threadId":"thread", "clientMessageId":"original-message", "input":[]
    }))
    .unwrap();
    let binding: TurnRetainedInputV1 = serde_json::from_value(json!({
        "version":1,"scopeId":"a".repeat(64),"clientMessageId":"other-message",
        "artifacts":[{
            "retentionId":"r1.root.1.0123456789abcdef0123456789abcdef",
            "expectedReceiptRevision":1,"rootNamespace":"root","epoch":1,
            "ownerId":"owner","entryId":"entry","entryRevision":1,
            "artifactName":"entry.bytes",
            "artifactParentIdentity": kcoder_types::PrivateFileIdentityV1 {
                version:1,kind:kcoder_types::PrivateFileKind::Directory,
                native:kcoder_types::PrivateNativeFileIdentity::Linux { device:1,inode:2 }
            },
            "artifactIdentity": kcoder_types::PrivateFileIdentityV1 {
                version:1,kind:kcoder_types::PrivateFileKind::RegularFile,
                native:kcoder_types::PrivateNativeFileIdentity::Linux { device:1,inode:3 }
            },
            "artifactSha256":"b".repeat(64),"artifactSize":0
        }]
    }))
    .unwrap();
    let attempts = engine
        .session_storage_dir_for("thread")
        .join("turn-attempts");
    assert!(!attempts.exists());
    let error = begin_with_retained_input(
        &engine,
        &identity,
        false,
        "c".repeat(64),
        &params,
        binding.clone(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("client message differs"));
    assert!(!attempts.exists());
    let mut binding = binding;
    binding.client_message_id = "original-message".into();
    let mut foreign = params.clone();
    foreign.thread_id = "foreign-thread".into();
    let error = begin_with_retained_input(
        &engine,
        &identity,
        false,
        "c".repeat(64),
        &foreign,
        binding.clone(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("thread differs"));
    assert!(!attempts.exists());
    begin_with_retained_input(
        &engine,
        &identity,
        false,
        "c".repeat(64),
        &params,
        binding.clone(),
    )
    .unwrap();
    let record = store(&engine, "thread")
        .unwrap()
        .load(&identity)
        .unwrap()
        .unwrap();
    assert_eq!(
        record.request_fingerprint,
        Some(request_fingerprint(&params).unwrap())
    );
    assert_eq!(record.retained_input, Some(binding));
}
