use super::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};
use serde_json::json;
use tempfile::TempDir;

fn owner() -> IntegrationOwner {
    IntegrationOwner::from(&IntegrationScope {
        account_id: "account-A".into(),
        target_id: "Target-A".into(),
        workspace_id: IntegrationNullable::Value("workspace-A".into()),
        identity_generation: "generation-1".into(),
        target_revision: "revision-1".into(),
        organization_id: None,
    })
}
fn definition() -> OfficeAssistantDefinition {
    serde_json::from_value(json!({
        "schemaVersion":1,"id":"meeting","scope":"personal","title":"会议纪要","description":"来源明确",
        "language":"zh-CN","inputSchema":{"type":"object"},"instructions":"保留缺项与来源",
        "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],
        "acceptanceCriteria":["实际成果可核对"],"externalSend":"ask"
    })).unwrap()
}

#[test]
fn expert_skills_keep_sources_versions_and_other_experts_independent() {
    let (root, store) = setup();
    let first = store
        .save_draft("skill-create", definition(), None, 1)
        .unwrap();
    let mut other = definition();
    other.id = "other-expert".into();
    store.save_draft("skill-other", other, None, 1).unwrap();
    let skill = OfficeAssistantSkill {
        slug: "meeting-notes".into(),
        title: "Meeting notes".into(),
        description: String::new(),
        content: "Only cited facts".into(),
        enabled: false,
        allowed_tools: None,
    };
    let files = vec![
        ("SKILL.md".into(), skill.content.as_bytes().to_vec()),
        ("LICENSE".into(), b"MIT".to_vec()),
    ];
    let sha = "a".repeat(64);
    let imported = store
        .install_expert_skill(
            "skill-import",
            "meeting",
            first.revision,
            OfficeExpertSkillInstallation {
                skill: skill.clone(),
                archive_sha256: &sha,
                files: &files,
            },
            2,
        )
        .unwrap();
    assert_eq!(
        store
            .install_expert_skill(
                "skill-import",
                "meeting",
                first.revision,
                OfficeExpertSkillInstallation {
                    skill: skill.clone(),
                    archive_sha256: &sha,
                    files: &files
                },
                99
            )
            .unwrap(),
        imported
    );
    assert!(
        !imported
            .definition
            .runtime_instructions()
            .contains("Only cited facts")
    );
    assert!(
        store
            .read_draft("other-expert")
            .unwrap()
            .unwrap()
            .definition
            .skills
            .is_empty()
    );
    let old = store
        .save_version("skill-version-before", "meeting", "1", imported.revision, 3)
        .unwrap();
    let mut enabled = imported.definition.clone();
    enabled.skills[0].enabled = true;
    assert!(
        store
            .save_draft(
                "skill-stale-toggle",
                enabled.clone(),
                Some(first.revision),
                4
            )
            .is_err()
    );
    let changed = store
        .save_draft("skill-toggle", enabled, Some(imported.revision), 5)
        .unwrap();
    let current = store
        .save_version("skill-version-after", "meeting", "2", changed.revision, 6)
        .unwrap();
    assert!(
        current
            .definition
            .runtime_instructions()
            .contains("Only cited facts")
    );
    assert!(
        !old.definition
            .runtime_instructions()
            .contains("Only cited facts")
    );
    assert_ne!(old.definition_sha256, current.definition_sha256);
    drop(store);
    let reopened = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .read_expert_file("meeting", "skills/meeting-notes/LICENSE")
            .unwrap(),
        b"MIT"
    );
    assert_eq!(reopened.read_version("meeting", "1").unwrap().unwrap(), old);
    assert!(
        reopened
            .read_draft("meeting")
            .unwrap()
            .unwrap()
            .definition
            .skills[0]
            .enabled
    );
    assert!(
        reopened
            .read_draft("other-expert")
            .unwrap()
            .unwrap()
            .definition
            .skills
            .is_empty()
    );
}
fn setup() -> (TempDir, OfficeStore) {
    let root = tempfile::tempdir().unwrap();
    let store = OfficeStore::create(&root.path().join("office"), owner()).unwrap();
    (root, store)
}

#[test]
fn expert_assets_commit_with_draft_and_survive_reopen_and_deletion() {
    let (root, store) = setup();
    let bytes = b"Expert instructions".to_vec();
    let package = OfficeExpertPackage {
        source: "skillhub".into(),
        slug: "sample".into(),
        package_sha256: "a".repeat(64),
        skill_slugs: vec!["sample".into()],
        files: vec![OfficeExpertFile {
            path: "SOUL.md".into(),
            sha256: digest(&bytes),
            bytes: bytes.len() as u64,
        }],
    };
    let files = vec![("SOUL.md".into(), bytes.clone())];
    let draft = store
        .install_expert("install", definition(), package.clone(), &files, 1)
        .unwrap();
    assert_eq!(draft.revision, 1);
    assert_eq!(
        store
            .install_expert("install", definition(), package.clone(), &files, 5)
            .unwrap(),
        draft
    );
    assert!(store.read_expert_file("meeting", "../SOUL.md").is_err());
    assert!(
        store
            .delete_assistant_draft("bad-delete", "meeting", 2)
            .is_err()
    );
    drop(store);
    let store = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(store.read_expert_file("meeting", "SOUL.md").unwrap(), bytes);
    assert_eq!(store.read_expert_package("meeting").unwrap(), Some(package));
    store.save_version("version", "meeting", "1", 1, 2).unwrap();
    store
        .delete_assistant_draft("delete", "meeting", 1)
        .unwrap();
    assert!(store.read_draft("meeting").unwrap().is_none());
    assert!(
        store
            .read_version("meeting", "1")
            .unwrap()
            .unwrap()
            .archived
    );
    assert!(store.delete_assistant_draft("delete", "meeting", 1).is_ok());
}

#[test]
fn legacy_office_snapshot_loads_without_expert_manifest_field() {
    let (root, store) = setup();
    store
        .save_draft("legacy-save", definition(), None, 1)
        .unwrap();
    drop(store);
    let path = root.path().join("office").join(SNAPSHOT_NAME);
    let mut snapshot: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    snapshot.as_object_mut().unwrap().remove("expertPackages");
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let store = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert!(store.read_draft("meeting").unwrap().is_some());
    assert!(store.read_expert_package("meeting").unwrap().is_none());
}

#[test]
fn assistant_revisions_idempotence_and_immutable_versions_survive_reopen() {
    let (root, store) = setup();
    let draft = store.save_draft("save-1", definition(), None, 1).unwrap();
    assert_eq!(draft.revision, 1);
    assert_eq!(
        store.save_draft("save-1", definition(), None, 99).unwrap(),
        draft
    );
    let saved = store
        .save_version("version-1", "meeting", "1.0.0", 1, 2)
        .unwrap();
    let mut updated = definition();
    updated.title = "修改标题".into();
    assert!(
        store
            .save_draft("save-1", updated.clone(), None, 3)
            .is_err()
    );
    assert!(
        store
            .save_draft("save-stale", updated.clone(), None, 3)
            .is_err()
    );
    store.save_draft("save-2", updated, Some(1), 3).unwrap();
    assert!(
        store
            .save_version("version-2", "meeting", "1.0.0", 2, 4)
            .is_err()
    );
    drop(store);
    let reopened = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.read_version("meeting", "1.0.0").unwrap(),
        Some(saved)
    );
    assert!(reopened.read_operation("save-1").unwrap().is_some());
}

#[test]
fn reads_do_not_create_a_store_and_missing_committed_state_is_not_reinitialized() {
    let (root, store) = setup();
    assert!(
        OfficeStore::open_existing(&root.path().join("absent"), owner())
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join("absent").exists());
    store.save_draft("save-1", definition(), None, 1).unwrap();
    std::fs::remove_file(root.path().join("office").join(SNAPSHOT_NAME)).unwrap();
    assert!(store.read_draft("meeting").is_err());
    assert!(OfficeStore::open_existing(&root.path().join("office"), owner()).is_err());
    assert!(OfficeStore::create(&root.path().join("office"), owner()).is_err());
    assert!(!root.path().join("office").join(SNAPSHOT_NAME).exists());
}

#[test]
fn missing_and_replaced_lock_fail_for_live_and_reopened_writers() {
    let (root, store) = setup();
    store.save_draft("save-1", definition(), None, 1).unwrap();
    let lock = root.path().join("office").join(LOCK_NAME);
    std::fs::rename(&lock, root.path().join("held-lock")).unwrap();
    assert!(store.read_draft("meeting").is_err());
    assert!(OfficeStore::open_existing(&root.path().join("office"), owner()).is_err());
    assert!(!lock.exists());
    std::fs::copy(root.path().join("held-lock"), &lock).unwrap();
    assert!(
        store
            .save_draft("save-2", definition(), Some(1), 2)
            .is_err()
    );
    assert!(OfficeStore::open_existing(&root.path().join("office"), owner()).is_err());
}

#[test]
fn immutable_datasets_and_real_artifact_bytes_keep_owner_and_revision() {
    let (root, store) = setup();
    let dataset = OfficeDataset {
        schema_version: 1,
        id: "../opaque-id".into(),
        revision: 1,
        owner: owner(),
        task: None,
        columns: vec![OfficeColumn {
            key: "amount".into(),
            title: "金额".into(),
            kind: OfficeColumnType::Number,
            unit: Some("元".into()),
        }],
        rows: vec![vec![json!(1234.56)], vec![Value::Null]],
        source_refs: vec![],
    };
    let reference = store.create_dataset("dataset-1", dataset.clone()).unwrap();
    assert_eq!(
        store.read_dataset(&reference).unwrap(),
        Some(dataset.clone())
    );
    let mut changed = dataset;
    changed.rows[0][0] = json!(1);
    assert!(store.create_dataset("dataset-2", changed).is_err());
    let bytes = br#"{"report":"1234.56"}"#;
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: "artifact-A".into(),
        revision: 1,
        owner: owner(),
        task: OfficeTaskRef {
            thread_id: "thread-A".into(),
            turn_id: "turn-A".into(),
            run_id: None,
        },
        kind: OfficeArtifactKind::Document,
        title: "核对结果".into(),
        format: OfficeFileFormat::Json,
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
        source_refs: vec![],
        verification: OfficeVerification {
            status: OfficeVerificationStatus::Partial,
            completed_checks: vec!["内容身份".into()],
            pending_checks: vec!["业务核对".into()],
            reader_status: OfficeVerificationStatus::Pending,
            formula_calculation: "not_applicable".into(),
        },
        dataset: Some(reference),
        created_at_ms: 1,
        presentation: None,
    };
    store
        .publish_artifact("publish-1", manifest.clone(), bytes)
        .unwrap();
    let (read, total) = store
        .read_artifact_chunk(
            &OfficeArtifactRef {
                id: manifest.id,
                revision: 1,
            },
            0,
            100,
        )
        .unwrap();
    assert_eq!(read, bytes);
    assert_eq!(total, bytes.len() as u64);
    let mut other = owner();
    other.account_id = "other".into();
    assert!(OfficeStore::open_existing(&root.path().join("office"), other).is_err());
}

#[test]
fn accepted_input_receipt_cannot_be_downgraded_or_moved_to_another_id() {
    let (_root, store) = setup();
    let metadata = OfficeInputMetadata {
        filename: "材料.txt".into(),
        media_type: "text/plain".into(),
        expected_bytes: 3,
        expected_sha256: digest(b"abc"),
    };
    let pending = store
        .begin_input("input-1", "opaque-input", metadata.clone())
        .unwrap();
    assert_eq!(pending.receipt.status, "pending");
    assert!(
        store
            .begin_input("input-1", "another-id", metadata)
            .is_err()
    );
    let native = OfficeNativeInput {
        path: "/host-owned/staged".into(),
        stage_ref: None,
        connection_id: "native-1".into(),
    };
    let accepted = store
        .complete_input("input-1", "opaque-input", 3, &digest(b"abc"), native)
        .unwrap();
    assert_eq!(accepted.status, "accepted");
    assert_eq!(
        store.fail_input("input-1", "opaque-input").unwrap(),
        accepted
    );
    assert_eq!(
        store.read_operation("input-1").unwrap().unwrap()["status"],
        "accepted"
    );
    assert!(store.save_draft("input-1", definition(), None, 1).is_err());
}

#[cfg(unix)]
#[test]
fn hardlink_and_symlink_replacement_are_rejected() {
    let (root, store) = setup();
    let directory = root.path().join("office");
    std::fs::hard_link(
        directory.join(SNAPSHOT_NAME),
        root.path().join("snapshot-alias"),
    )
    .unwrap();
    assert!(store.read_draft("meeting").is_err());
    std::fs::remove_file(root.path().join("snapshot-alias")).unwrap();
    std::fs::rename(directory.join(LOCK_NAME), root.path().join("old-lock")).unwrap();
    std::os::unix::fs::symlink(root.path().join("old-lock"), directory.join(LOCK_NAME)).unwrap();
    assert!(OfficeStore::open_existing(&directory, owner()).is_err());
}

#[test]
fn adoption_snapshot_does_not_change_after_draft_edit_or_archive() {
    let (_root, store) = setup();
    store.save_draft("d1", definition(), None, 1).unwrap();
    let version = store.save_version("v1", "meeting", "1", 1, 1).unwrap();
    let scope = IntegrationScope {
        account_id: "account-A".into(),
        target_id: "Target-A".into(),
        workspace_id: IntegrationNullable::Value("workspace-A".into()),
        identity_generation: "generation-1".into(),
        target_revision: "revision-1".into(),
        organization_id: None,
    };
    let adoption = store
        .adopt(
            "adopt-1",
            scope,
            "meeting",
            "1",
            json!({"materials":["x"]}),
            1,
        )
        .unwrap();
    store.archive_version("archive-1", "meeting", "1").unwrap();
    assert_eq!(adoption.assistant, version);
    assert_eq!(store.adoption("adopt-1").unwrap(), Some(adoption));
}

#[test]
fn action_receipts_reserve_once_and_reconcile_without_replaying() {
    let (root, store) = setup();
    let (fresh, first) = store
        .begin_action("generate-1", "office.generate", &json!({"title":"report"}))
        .unwrap();
    assert!(fresh);
    assert_eq!(first.phase, "pending");
    assert!(
        !store
            .begin_action("generate-1", "office.generate", &json!({"title":"report"}))
            .unwrap()
            .0
    );
    assert!(
        store
            .begin_action("generate-1", "office.generate", &json!({"title":"changed"}))
            .is_err()
    );
    assert!(
        store
            .save_draft("generate-1", definition(), None, 1)
            .is_err()
    );
    store
        .complete_action("generate-1", &json!({"reference":{"id":"A","revision":1}}))
        .unwrap();
    drop(store);
    let reopened = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.read_action("generate-1").unwrap().unwrap().phase,
        "completed"
    );
    assert!(
        reopened
            .complete_action("generate-1", &json!({"different":true}))
            .is_err()
    );
}

#[test]
fn immutable_context_projection_survives_reopen_and_keeps_original_identity() {
    let (root, store) = setup();
    let projection = OfficeContextProjection {
        schema_version: 1,
        id: "P".into(),
        revision: 1,
        owner: owner(),
        artifact_refs: vec![],
        dataset_refs: vec![OfficeArtifactRef {
            id: "D".into(),
            revision: 1,
        }],
        source_refs: vec![],
        summary: "Original exact facts; 5000 rows omitted".into(),
        columns: vec![],
        preview_rows: vec![],
        total_rows: 5000,
        omitted_rows: 5000,
        query_sha256: None,
        content_sha256: "a".repeat(64),
    };
    store
        .save_projection("projection-save", projection.clone())
        .unwrap();
    drop(store);
    let reopened = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .read_projection(&OfficeArtifactRef {
                id: "P".into(),
                revision: 1
            })
            .unwrap(),
        Some(projection.clone())
    );
    let mut changed = projection;
    changed.summary = "Replacement facts".into();
    assert!(reopened.save_projection("projection-2", changed).is_err());
}

#[test]
fn verification_observations_append_without_rewriting_the_original_publication() {
    let (root, store) = setup();
    let bytes = b"{\"source\":1}";
    let reference = OfficeArtifactRef {
        id: "observation-artifact".into(),
        revision: 1,
    };
    let initial = OfficeVerification {
        status: OfficeVerificationStatus::Partial,
        completed_checks: vec!["content_identity".into()],
        pending_checks: vec!["reader".into()],
        reader_status: OfficeVerificationStatus::Pending,
        formula_calculation: "not_applicable".into(),
    };
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: reference.id.clone(),
        revision: 1,
        owner: owner(),
        task: OfficeTaskRef {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            run_id: None,
        },
        kind: OfficeArtifactKind::Document,
        title: "Original publication".into(),
        format: OfficeFileFormat::Json,
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
        source_refs: vec![],
        verification: initial.clone(),
        dataset: None,
        created_at_ms: 1,
        presentation: None,
    };
    store
        .publish_artifact("publish-observed", manifest.clone(), bytes)
        .unwrap();
    let verified = OfficeVerification {
        status: OfficeVerificationStatus::Passed,
        completed_checks: vec!["fixture_independent_check".into()],
        pending_checks: vec![],
        reader_status: OfficeVerificationStatus::Passed,
        formula_calculation: "not_applicable".into(),
    };
    let observed = store
        .save_verification(
            "verify-observed",
            &reference,
            &manifest.sha256,
            verified.clone(),
            2,
        )
        .unwrap();
    assert_eq!(observed.revision, 1);
    assert_eq!(
        store
            .save_verification(
                "verify-observed",
                &reference,
                &manifest.sha256,
                verified,
                999
            )
            .unwrap(),
        observed
    );
    assert_eq!(
        store
            .read_artifact(&reference)
            .unwrap()
            .unwrap()
            .verification,
        initial
    );
    assert!(
        store
            .save_verification(
                "verify-bad",
                &reference,
                &"f".repeat(64),
                initial.clone(),
                3
            )
            .is_err()
    );
    drop(store);
    let reopened = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.read_verification(&reference).unwrap(),
        Some(observed)
    );
    assert_eq!(
        reopened
            .read_artifact(&reference)
            .unwrap()
            .unwrap()
            .verification,
        initial
    );
}

#[test]
fn actual_store_writer_waits_for_original_shared_reader_and_commits_once() {
    let (root, store) = setup();
    let reader = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    let lease = reader.lock(false).unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(lease);
    });
    let draft = store
        .save_draft("writer-after-reader", definition(), None, 1)
        .unwrap();
    release.join().unwrap();
    assert_eq!(draft.revision, 1);
    let repeated = store
        .save_draft("writer-after-reader", definition(), None, 99)
        .unwrap();
    assert_eq!(repeated, draft);
    assert_eq!(store.read_draft("meeting").unwrap().unwrap().revision, 1);
}
#[test]
fn actual_store_reader_waits_for_original_writer_without_replaying_write() {
    let (root, store) = setup();
    let saved = store
        .save_draft("one-real-write", definition(), None, 1)
        .unwrap();
    let writer = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    let lease = writer.lock(true).unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(lease);
    });
    assert_eq!(store.read_draft("meeting").unwrap(), Some(saved));
    release.join().unwrap();
}
#[test]
fn permanent_original_store_reader_bounds_writer_acquisition_and_never_mutates() {
    let (root, store) = setup();
    let reader = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    let lease = reader.lock(false).unwrap();
    let before = std::fs::read(root.path().join("office").join(SNAPSHOT_NAME)).unwrap();
    let started = Instant::now();
    assert_eq!(
        store
            .save_draft("not-written", definition(), None, 1)
            .unwrap_err()
            .to_string(),
        "OFFICE_STORE_BUSY"
    );
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        std::fs::read(root.path().join("office").join(SNAPSHOT_NAME)).unwrap(),
        before
    );
    drop(lease);
    assert!(store.read_draft("meeting").unwrap().is_none());
}
#[test]
fn replaced_pinned_lock_during_wait_is_never_reobserved_or_used_for_write() {
    let (root, store) = setup();
    let reader = OfficeStore::open_existing(&root.path().join("office"), owner())
        .unwrap()
        .unwrap();
    let lease = reader.lock(false).unwrap();
    let path = root.path().join("office").join(LOCK_NAME);
    std::fs::rename(&path, path.with_extension("held-original")).unwrap();
    std::fs::write(&path, b"untrusted replacement").unwrap();
    let started = Instant::now();
    assert!(
        store
            .save_draft("not-written", definition(), None, 1)
            .is_err()
    );
    assert!(started.elapsed() < Duration::from_millis(200));
    drop(lease);
}
