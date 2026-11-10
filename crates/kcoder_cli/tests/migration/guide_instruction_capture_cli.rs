//! Reauthorization retains the original intent and already written immutable recipe.
use super::*;
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    batch::BatchSource,
    instruction_sources::{
        InstructionDestination, InstructionSourceGrant, InstructionSourcePolicy,
        ScopedInstructionDestination,
    },
    store::{BatchCaptureInput, BatchCreateIntent, BatchCreationStage as Stage, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn original(f: &Fixture) -> (PathBuf, String, String) {
    let root = f.root.path().join("original-instruction-source");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(
        root.join("AGENTS.md"),
        "Original partial-capture scope guide.",
    )
    .unwrap();
    let workspace = f.root.path().join("workspace");
    std::fs::create_dir_all(workspace.join("mapped")).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        json!({"trusted":[root,workspace],"never":[]}).to_string(),
    )
    .unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let snapshot = Arc::new(
        InstructionSourceGrant::capture(&f.profile, &root, &root, MigrationSourceKind::Codex)
            .unwrap()
            .capture_sources(&InstructionSourcePolicy::default(), |_| true)
            .unwrap()
            .for_creation(&request)
            .unwrap(),
    );
    let destination = InstructionDestination::capture(&f.profile, &workspace).unwrap();
    let mapped = ScopedInstructionDestination::capture(&destination, "mapped").unwrap();
    let source_id = snapshot.summaries()[0].id.clone();
    let proof = format!("{:x}", Sha256::digest(serde_json::to_vec(&mapped).unwrap()));
    let intent=BatchCreateIntent::new(&request,&json!({
        "kind":"terminal-scoped-instructions/2","profile":f.profile,"source":"codex","root":root,"cwd":root,"includeDescendants":false,
        "parserRevision":snapshot.semantic_revision().unwrap(),"selection":[["AGENTS.md","mapped",proof]],
        "targetWorkspace":workspace,"staticSubsetConfirmed":false,"resourceLimits":kcoder_types::migration_resource::MigrationResourceLimits::default()
    })).unwrap();
    let binding = AssetBundleBinding::capture_mapped_instructions(
        &f.profile,
        &workspace,
        snapshot,
        &[(source_id, mapped)],
        false,
    )
    .unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let failed = store.create_batch_scan_idempotent(
        &intent,
        |_| {
            Ok(BatchCaptureInput {
                sources: vec![BatchSource::Assets(binding)],
                resource_limits: Default::default(),
                project: None,
            })
        },
        &mut |stage, _| stage != Stage::Capturing || artifact_count(f) == 0,
    );
    assert!(
        failed.is_err(),
        "stop after a real immutable recipe is written, before prepared publication"
    );
    let pending = store.read_batch_creation(&request).unwrap();
    assert_eq!(pending.stage, Stage::Capturing);
    assert_eq!(artifact_count(f), 1);
    (root, request, pending.job_id)
}
fn artifact_count(f: &Fixture) -> usize {
    std::fs::read_dir(f.profile.join("migrations"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".plans"))
        .map(|entry| {
            std::fs::read_dir(entry.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|file| {
                    file.file_name()
                        .to_string_lossy()
                        .starts_with("instructions-")
                })
                .count()
        })
        .sum()
}
fn reauthorize(f: &Fixture, root: &std::path::Path, request: &str, target: &str) -> Dialog {
    reauthorize_format(f, root, request, target, "legacy-v1")
}
fn reauthorize_format(
    f: &Fixture,
    root: &std::path::Path,
    request: &str,
    target: &str,
    format: &str,
) -> Dialog {
    let mut d = Dialog::start(f, "", None);
    let p = d.prompt("entry");
    d.answer(&p, "instructions");
    let p = d.prompt("instruction_request_id");
    d.answer(&p, request);
    let p = d.prompt("instruction_revalidate");
    d.answer(&p, "yes");
    let p = d.prompt("instruction_format");
    d.answer(&p, format);
    let p = d.prompt("instruction_source");
    d.answer(&p, "codex");
    let p = d.prompt("instruction_root");
    d.answer(&p, root.to_str().unwrap());
    let p = d.prompt("instruction_cwd");
    d.answer(&p, "");
    let p = d.prompt("instruction_source_consent");
    d.answer(&p, "yes");
    let p = d.prompt("instruction_descendants");
    d.answer(&p, "no");
    if format == "static-v2" {
        let p = d.prompt("instruction_static_subset");
        d.answer(&p, "yes");
    }
    let p = d.prompt("instruction_selection");
    d.answer(&p, "toggle 1");
    let p = d.prompt("instruction_target_scope");
    d.answer(&p, target);
    let p = d.prompt("instruction_selection");
    d.answer(&p, "done");
    let p = d.prompt("instruction_capture_confirm");
    d.answer(&p, "CAPTURE");
    d
}

#[test]
fn guided_partial_capture_cannot_upgrade_original_parser_under_the_same_request() {
    let f = Fixture::new("codex");
    let (root, request, job) = original(&f);
    let before = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read_batch_creation(&request)
        .unwrap();
    let mut d = reauthorize_format(&f, &root, &request, "mapped", "static-v2");
    let p = d.prompt("creation_control");
    assert!(
        d.transcript
            .contains("migration_batch_create_intent_conflict")
    );
    d.answer(&p, "back");
    d.finish();
    let after = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read_batch_creation(&request)
        .unwrap();
    assert_eq!(after.job_id, job);
    assert_eq!(after.stage, Stage::Capturing);
    assert_eq!(after.control_revision, before.control_revision);
    assert_eq!(artifact_count(&f), 1);
    let mut d = reauthorize(&f, &root, &request, "mapped");
    let p = d.prompt("menu");
    assert_eq!(d.state["job"]["jobId"], job);
    d.answer(&p, "quit");
    d.finish();
    assert_eq!(artifact_count(&f), 1);
}
#[test]
fn guided_partial_capture_reauthorizes_original_intent_without_duplicating_the_written_recipe() {
    let f = Fixture::new("codex");
    let (root, request, job) = original(&f);
    let mut d = reauthorize(&f, &root, &request, "mapped");
    let p = d.prompt("menu");
    assert_eq!(d.state["job"]["jobId"], job);
    assert_eq!(d.state["job"]["status"], "ready");
    d.answer(&p, "quit");
    d.finish();
    assert_eq!(
        artifact_count(&f),
        1,
        "same source and original request reuse the identical private recipe bytes"
    );
    assert_eq!(
        MigrationStore::open_existing(&f.profile)
            .unwrap()
            .records(None)
            .unwrap()
            .0
            .len(),
        1
    );
    assert!(
        kcoder_config::imported_context::ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn guided_partial_capture_cannot_rebind_the_original_target_or_changed_source() {
    let f = Fixture::new("codex");
    let (root, request, job) = original(&f);
    for target in [".", "mapped"] {
        if target == "mapped" {
            std::fs::write(
                root.join("AGENTS.md"),
                "New source must not replace original intent.",
            )
            .unwrap();
        }
        let mut d = reauthorize(&f, &root, &request, target);
        let p = d.prompt("creation_control");
        assert!(
            d.transcript
                .contains("migration_batch_create_intent_conflict")
        );
        d.answer(&p, "back");
        d.finish();
        let observation = MigrationStore::open_existing(&f.profile)
            .unwrap()
            .read_batch_creation(&request)
            .unwrap();
        assert_eq!(observation.stage, Stage::Capturing);
        assert_eq!(observation.job_id, job);
        assert_eq!(artifact_count(&f), 1);
    }
    assert!(
        kcoder_config::imported_context::ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn guided_partial_capture_rejects_replaced_target_directory_at_the_same_relative_path() {
    let f = Fixture::new("codex");
    let (root, request, job) = original(&f);
    let workspace = f.root.path().join("workspace");
    std::fs::rename(workspace.join("mapped"), workspace.join("original-mapped")).unwrap();
    std::fs::create_dir(workspace.join("mapped")).unwrap();
    let mut d = reauthorize(&f, &root, &request, "mapped");
    let p = d.prompt("creation_control");
    assert!(
        d.transcript
            .contains("migration_batch_create_intent_conflict")
    );
    d.answer(&p, "cancel");
    let p = d.prompt("creation_control_id");
    d.answer(&p, "");
    let p = d.prompt("creation_confirm");
    d.answer(&p, "CANCEL");
    let p = d.prompt("creation_control");
    d.answer(&p, "back");
    d.finish();
    let observation = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read_batch_creation(&request)
        .unwrap();
    assert_eq!(observation.stage, Stage::Capturing);
    assert_eq!(observation.job_id, job);
    assert_eq!(observation.cancel_requested, Some(true));
    assert_eq!(artifact_count(&f), 1);
}
