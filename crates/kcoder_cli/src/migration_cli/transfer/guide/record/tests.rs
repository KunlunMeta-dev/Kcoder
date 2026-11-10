use super::*;
use kcoder_app_protocol::MigrationSourceSessionPurpose as Purpose;

pub(in crate::migration_cli::transfer::guide) fn draft() -> Draft {
    let session = |purpose, target: &str| MigrationSourceSessionParams {
        session_id: uuid::Uuid::new_v4().to_string(),
        purpose,
        target_id: target.into(),
        workspace_path: None,
    };
    Draft {
        version: 1,
        gateway: "https://gateway.invalid/".into(),
        source_scope: "a".repeat(64),
        target_scope: "b".repeat(64),
        source_principal: None,
        target_principal: None,
        include_project: false,
        include_history: false,
        source_kind: kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        source: session(Purpose::Source, "source"),
        target: session(Purpose::Target, "target"),
        recovery: session(Purpose::TargetRecovery, "target"),
        request_id: uuid::Uuid::new_v4().to_string(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
        adoption_id: uuid::Uuid::new_v4().to_string(),
        selections: Vec::new(),
        source_views: None,
        instruction_capture: None,
        instruction_mappings: Vec::new(),
        resource_increases: Default::default(),
        private_credentials: None,
        copy_prepared: false,
        resume: None,
        cancel_command_id: None,
        target_finish_attempt: None,
        target_cancel_id: None,
        target_resume: None,
        manifest_sha256: None,
        adoption_selections: None,
        adoption_prepared: false,
        adoption_resume: None,
        adoption_cancel_id: None,
        selected_job: None,
        batch_operations: Default::default(),
    }
}

#[test]
fn a_private_draft_keeps_exact_ids_across_reopen_and_excludes_a_concurrent_owner() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("cache");
    PrivateDirectory::open_or_create(&directory).unwrap();
    let path = directory.join("draft.json");
    let (mut store, old) = Store::open(&path, None).unwrap();
    assert!(old.is_none());
    let value = draft();
    store.save(&value).unwrap();
    assert!(Store::open(&path, None).is_err());
    drop(store);
    let (_, restored) = Store::open(&path, None).unwrap();
    let restored = restored.unwrap();
    assert_eq!(restored.request_id, value.request_id);
    assert_eq!(restored.attempt_id, value.attempt_id);
    assert_eq!(restored.adoption_id, value.adoption_id);
    assert!(
        !directory.join("migrations").exists(),
        "a client draft is not another Native migration job store"
    );
}

#[test]
fn invalid_or_edited_drafts_are_never_overwritten_or_replaced_with_a_new_request() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("cache");
    PrivateDirectory::open_or_create(&directory).unwrap();
    let path = directory.join("draft.json");
    let (mut store, _) = Store::open(&path, None).unwrap();
    let mut value = draft();
    store.save(&value).unwrap();
    let original = std::fs::read(&path).unwrap();
    value.copy_prepared = true;
    assert!(store.save(&value).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    value.copy_prepared = false;
    std::fs::write(&path, b"INVALID_PRIVATE_DRAFT_CANARY").unwrap();
    assert!(store.save(&value).is_err());
    drop(store);
    let error = match Store::open(&path, None) {
        Ok(_) => panic!("invalid draft cannot become an empty new draft"),
        Err(error) => error,
    };
    assert!(!error.to_string().contains("INVALID_PRIVATE_DRAFT_CANARY"));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"INVALID_PRIVATE_DRAFT_CANARY"
    );
}

#[cfg(unix)]
#[test]
fn replacing_the_owned_lock_fails_closed_without_repairing_the_name_or_cache() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("cache");
    PrivateDirectory::open_or_create(&directory).unwrap();
    let path = directory.join("draft.json");
    let (mut store, _) = Store::open(&path, None).unwrap();
    let value = draft();
    store.save(&value).unwrap();
    let original = std::fs::read(&path).unwrap();
    let lock = directory.join(".draft.json.lock");
    std::fs::rename(&lock, directory.join("held-original.lock")).unwrap();
    std::fs::write(&lock, b"user replacement").unwrap();
    assert!(store.save(&value).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(std::fs::read(&lock).unwrap(), b"user replacement");
}

#[test]
fn legacy_drafts_keep_their_wire_and_directory_grants_retain_the_original_connection() {
    let mut value = draft();
    let old = serde_json::to_value(&value).unwrap();
    assert!(old.get("sourceViews").is_none());
    assert!(old.get("instructionCapture").is_none());
    assert!(old.get("instructionMappings").is_none());
    assert!(old.get("resourceIncreases").is_none());
    assert!(old.get("privateCredentials").is_none());
    let decoded: Draft = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), old);
    let id = value.source.session_id.clone();
    value.source_views = Some(SourceViews {
        session_id: id.clone(),
        directory_decided: true,
        ..Default::default()
    });
    value.validate().unwrap();
    value.source.session_id = uuid::Uuid::new_v4().to_string();
    assert!(
        value.validate().is_err(),
        "live source grants cannot be silently retargeted"
    );
    value
        .selections
        .push(MigrationSourceSelectionV1::Configuration {
            source_id: "opaque-original".into(),
        });
    value.copy_prepared = true;
    value.validate().unwrap();
    assert_eq!(
        value.source_views.as_ref().unwrap().session_id,
        id,
        "prepared Native snapshots preserve the old source-grant identity during reconnect"
    );
}

#[test]
fn an_unacknowledged_instruction_capture_keeps_its_source_child_and_original_parameters() {
    let mut value = draft();
    value.instruction_capture = Some(super::super::instructions::Capture {
        session_id: value.source.session_id.clone(),
        params: kcoder_app_protocol::MigrationInstructionCaptureParams {
            capture_id: uuid::Uuid::new_v4().to_string(),
            source: value.source_kind,
            format: kcoder_app_protocol::InstructionCaptureFormat::StaticV2,
            source_root: "/owned/source".into(),
            source_cwd: "/owned/source".into(),
            include_descendants: true,
            confirm_static_subset: true,
        },
        dispatched: true,
    });
    value.validate().unwrap();
    let restored: Draft = serde_json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        restored.instruction_capture.as_ref().unwrap().params,
        value.instruction_capture.as_ref().unwrap().params
    );
    value.source.session_id = uuid::Uuid::new_v4().to_string();
    assert!(
        value.validate().is_err(),
        "a live capture cannot be moved into a new source child"
    );
    value
        .selections
        .push(MigrationSourceSelectionV1::Instructions {
            capture_id: value
                .instruction_capture
                .as_ref()
                .unwrap()
                .params
                .capture_id
                .clone(),
        });
    value.copy_prepared = true;
    value.validate().unwrap();
    value
        .instruction_capture
        .as_mut()
        .unwrap()
        .params
        .confirm_static_subset = false;
    assert!(value.validate().is_err());
}

#[test]
fn instruction_scope_choices_require_the_original_selected_entry_and_explicit_workspace() {
    use kcoder_app_protocol::{
        MigrationInstructionScopeChoice, MigrationSourceInstructionMapping,
        MigrationSourceProjectMapping,
    };
    let mut value = draft();
    value.instruction_mappings = vec![MigrationSourceInstructionMapping {
        entry_id: "e0000-0000".into(),
        items: vec![MigrationInstructionScopeChoice {
            item_id: "instruction-owned".into(),
            target_relative_scope: "docs".into(),
        }],
        archive_incomplete_chain: false,
    }];
    assert!(
        value.validate().is_err(),
        "an orphan mapping cannot borrow a target"
    );
    value.adoption_selections = Some(vec![MigrationSourceAdoptionSelection {
        entry_id: "e0000-0000".into(),
        project_mapping: None,
    }]);
    assert!(value.validate().is_err());
    value.adoption_selections.as_mut().unwrap()[0].project_mapping =
        Some(MigrationSourceProjectMapping::CurrentWorkspace);
    value.validate().unwrap();
    let second = value.instruction_mappings[0].clone();
    value.instruction_mappings.push(second);
    assert!(
        value.validate().is_err(),
        "the same receipt entry cannot have conflicting target scopes"
    );
    value.instruction_mappings.pop();
    value.instruction_mappings[0].items[0].target_relative_scope = "../outside".into();
    assert!(value.validate().is_err());
}

#[test]
fn pending_directory_identity_survives_reopen_and_cannot_claim_a_different_vendor_or_default() {
    let mut value = draft();
    let params = kcoder_app_protocol::MigrationSourceDirectorySelectParams {
        selection_id: uuid::Uuid::new_v4().to_string(),
        source: value.source_kind,
        directory: "/owned/private-product".into(),
    };
    value.source_views = Some(SourceViews {
        session_id: value.source.session_id.clone(),
        requested_directory: Some(params.directory.clone()),
        directory: Some(DirectoryChoice {
            params: params.clone(),
            confirmed: false,
        }),
        directory_decided: true,
        ..Default::default()
    });
    value.validate().unwrap();
    let restored: Draft = serde_json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        restored.source_views.unwrap().directory.unwrap().params,
        params
    );
    value.source_views.as_mut().unwrap().directory = None;
    assert!(
        value.validate().is_err(),
        "an unsuccessful explicit directory never turns into default-home permission"
    );
}
