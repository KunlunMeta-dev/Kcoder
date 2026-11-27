//! Source capture identities reconcile observations without refreshing changed inputs.
use super::*;
use kcoder_types::migration::MigrationSourceKind;
use std::fs;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let source = root.path().join("source");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    fs::create_dir_all(source.join(".git")).unwrap();
    fs::write(source.join("AGENTS.md"), "Original finite instructions.").unwrap();
    fs::write(
        profile.join("trusted-folders.json"),
        serde_json::json!({"trusted":[source],"never":[]}).to_string(),
    )
    .unwrap();
    (root, profile, source)
}
const CAPTURE: &str = "bdaeb662-a7fe-4412-974c-18c4f9e78005";
#[test]
fn lost_capture_reply_reconciles_original_bytes_and_rejects_new_intent() {
    let (_owner, profile, source) = fixture();
    let mut catalog = InstructionSourceCatalog::default();
    let first = catalog
        .capture(
            &profile,
            CAPTURE,
            InstructionCaptureRequest {
                source: MigrationSourceKind::Codex,
                root: &source,
                cwd: &source,
                include_descendants: false,
            },
            |_| true,
        )
        .unwrap();
    let item = first.snapshot.summaries()[0].id.clone();
    fs::write(source.join("AGENTS.md"), "Changed after capture.").unwrap();
    let again = catalog
        .capture(
            &profile,
            CAPTURE,
            InstructionCaptureRequest {
                source: MigrationSourceKind::Codex,
                root: &source,
                cwd: &source,
                include_descendants: false,
            },
            |_| true,
        )
        .unwrap();
    assert_eq!(
        *again.snapshot.original_bytes(&item).unwrap(),
        b"Original finite instructions."
    );
    assert!(again.snapshot.verify_source(|_| true).is_err());
    assert!(
        catalog
            .capture(
                &profile,
                CAPTURE,
                InstructionCaptureRequest {
                    source: MigrationSourceKind::ClaudeCode,
                    root: &source,
                    cwd: &source,
                    include_descendants: false
                },
                |_| true
            )
            .is_err()
    );
    fs::rename(&source, source.with_extension("withheld")).unwrap();
    assert!(catalog.read(&profile, CAPTURE).is_ok());
    assert_eq!(
        first.snapshot.semantic_revision().unwrap(),
        again.snapshot.semantic_revision().unwrap()
    );
}
#[test]
fn expired_capture_identity_is_never_rebound_and_active_memory_is_bounded() {
    let (_owner, profile, source) = fixture();
    let mut catalog = InstructionSourceCatalog::default();
    for id in [CAPTURE, "fa4943ad-c28b-452f-bb7e-f3be1bdbff69"] {
        catalog
            .capture(
                &profile,
                id,
                InstructionCaptureRequest {
                    source: MigrationSourceKind::Codex,
                    root: &source,
                    cwd: &source,
                    include_descendants: false,
                },
                |_| true,
            )
            .unwrap();
    }
    let third = "9dd607da-4d02-4320-9428-233535b45514";
    assert!(
        catalog
            .capture(
                &profile,
                third,
                InstructionCaptureRequest {
                    source: MigrationSourceKind::Codex,
                    root: &source,
                    cwd: &source,
                    include_descendants: false
                },
                |_| true
            )
            .is_err()
    );
    catalog.records.get_mut(CAPTURE).unwrap().created = Instant::now() - LIFETIME;
    assert!(
        catalog
            .capture(
                &profile,
                CAPTURE,
                InstructionCaptureRequest {
                    source: MigrationSourceKind::Codex,
                    root: &source,
                    cwd: &source,
                    include_descendants: false
                },
                |_| true
            )
            .is_err()
    );
    catalog
        .capture(
            &profile,
            third,
            InstructionCaptureRequest {
                source: MigrationSourceKind::Codex,
                root: &source,
                cwd: &source,
                include_descendants: false,
            },
            |_| true,
        )
        .unwrap();
    assert!(catalog.records[CAPTURE].snapshot.is_none());
}
#[test]
fn product_directory_does_not_grant_instruction_workspace_or_another_profile() {
    let (_owner, profile, source) = fixture();
    let mut catalog = InstructionSourceCatalog::default();
    fs::write(profile.join("trusted-folders.json"), "{}").unwrap();
    assert!(
        catalog
            .capture(
                &profile,
                CAPTURE,
                InstructionCaptureRequest {
                    source: MigrationSourceKind::Codex,
                    root: &source,
                    cwd: &source,
                    include_descendants: false
                },
                |_| true
            )
            .is_err()
    );
    fs::write(
        profile.join("trusted-folders.json"),
        serde_json::json!({"trusted":[source],"never":[]}).to_string(),
    )
    .unwrap();
    catalog
        .capture(
            &profile,
            CAPTURE,
            InstructionCaptureRequest {
                source: MigrationSourceKind::Codex,
                root: &source,
                cwd: &source,
                include_descendants: false,
            },
            |_| true,
        )
        .unwrap();
    let foreign = profile.with_extension("foreign");
    kcoder_config::PrivateDirectory::open_or_create(&foreign).unwrap();
    assert!(catalog.read(&foreign, CAPTURE).is_err());
}
