use super::*;

#[test]
fn transferred_configuration_binding_survives_source_removal_and_checks_target_owner() {
    let f = Fixture::new();
    let source = f.config(Kind::Codex);
    let manifest = f.export(ExportSelection::Configuration(source));
    let receipt = f.copy(&manifest);
    let binding = f
        .target
        .configuration_binding(
            &f.request,
            f.source.authority(),
            &manifest.entries[0].id,
            &receipt,
        )
        .unwrap();
    let expected = serde_json::to_value(binding.inventory().unwrap()).unwrap();
    let identity = binding.logical_identity().unwrap();
    assert_eq!(binding.source().unwrap(), Kind::Codex);
    assert_eq!(binding.source_scope().unwrap(), "user");
    binding.verify_consumer(&f.target_profile).unwrap();
    assert!(binding.verify_consumer(&f.source_profile).is_err());
    let bytes = serde_json::to_vec(&binding).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("SYNTHETIC_PRIVATE"));
    std::fs::rename(&f.files, f._root.path().join("source-withheld")).unwrap();
    std::fs::rename(
        &f.source_profile,
        f._root.path().join("source-profile-withheld"),
    )
    .unwrap();
    let reopened: TransferredConfigurationBinding = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        serde_json::to_value(reopened.inventory().unwrap()).unwrap(),
        expected
    );
    assert_eq!(reopened.logical_identity().unwrap(), identity);
    let mut changed = serde_json::to_value(&reopened).unwrap();
    changed["entry"]["sha256"] = serde_json::Value::String("0".repeat(64));
    let changed: TransferredConfigurationBinding = serde_json::from_value(changed).unwrap();
    assert!(changed.inventory().is_err());
}

#[test]
fn transferred_binding_does_not_recreate_a_missing_native_identity_or_receiving_directory() {
    for missing_identity in [true, false] {
        let f = Fixture::new();
        let manifest = f.export(ExportSelection::Configuration(f.config(Kind::ClaudeCode)));
        let receipt = f.copy(&manifest);
        let binding = f
            .target
            .configuration_binding(
                &f.request,
                f.source.authority(),
                &manifest.entries[0].id,
                &receipt,
            )
            .unwrap();
        let namespace = f.target_profile.join("migrations/source-transfer");
        let removed = namespace.join(if missing_identity {
            "native.json"
        } else {
            "incoming"
        });
        std::fs::rename(&removed, f._root.path().join("owned-withheld")).unwrap();
        assert!(binding.inventory().is_err());
        assert!(!removed.exists());
    }
}

#[test]
fn transferred_configuration_enters_native_batch_and_undo_without_source_or_receiving_payload() {
    use crate::{
        assets::AssetTarget,
        batch::{BatchResolution, BatchSource},
        mcp::{McpResolution, McpTarget},
        providers::ProviderTarget,
        store::{BatchTargets, MigrationStore},
    };
    use kcoder_types::migration::MigrationJobStatus;
    let f = Fixture::new();
    let path = f.files.join("settings.json");
    std::fs::write(
        &path,
        r#"{"mcpServers":{"remote-docs":{"type":"http","url":"https://fixture.invalid/mcp"}}}"#,
    )
    .unwrap();
    let source = ConfigurationBinding::capture_selected(&path, Kind::ClaudeCode).unwrap();
    let manifest = f.export(ExportSelection::Configuration(source));
    let receipt = f.copy(&manifest);
    let binding = f
        .target
        .configuration_binding(
            &f.request,
            f.source.authority(),
            &manifest.entries[0].id,
            &receipt,
        )
        .unwrap();
    let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
    let peer = MigrationStore::open_or_create(&f.source_profile).unwrap();
    assert!(
        peer.create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
            binding.clone()
        ))])
        .is_err()
    );
    let scan = store
        .create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
            binding,
        ))])
        .unwrap();
    // Copying a private journal cannot transfer receiving-account authority.
    std::fs::copy(
        f.target_profile
            .join("migrations")
            .join(format!("{}.json", scan.job_id)),
        f.source_profile
            .join("migrations")
            .join(format!("{}.json", scan.job_id)),
    )
    .unwrap();
    assert!(peer.read(&scan.job_id).is_err());
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let item = scan
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let planned = store
        .prepare_batch(
            &scan.job_id,
            scan.sequence,
            &[BatchResolution::Mcp(McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "transferred-docs".into(),
                cwd: None,
                enable_after_import: false,
            })],
            &targets,
        )
        .unwrap();
    std::fs::rename(&f.files, f._root.path().join("originals-withheld")).unwrap();
    std::fs::rename(
        &f.source_profile,
        f._root.path().join("source-account-withheld"),
    )
    .unwrap();
    let plan_id = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let done = store
        .run_batch(
            &planned.job_id,
            plan_id,
            "owned-transfer-apply",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    // Publication is complete, but the imported MCP still requires activation review.
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    let issues = &done
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap()
        .preview
        .issues;
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].code,
        kcoder_types::migration::MigrationIssueCode::RequiresReview
    );
    assert_eq!(
        issues[0].phase,
        kcoder_types::migration::MigrationIssuePhase::Activation
    );
    assert_eq!(issues[0].field.as_deref(), Some("activation"));
    assert_eq!(done.receipts.len(), 1);
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.target_profile.join("settings.json")).unwrap())
            .unwrap();
    let installed = settings["mcp_servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "transferred-docs")
        .unwrap();
    assert_eq!(
        settings["mcp_disabled_servers"],
        serde_json::json!(["transferred-docs"])
    );
    assert_eq!(installed["url"], "https://fixture.invalid/mcp");
    std::fs::rename(
        f.target_profile.join("migrations/source-transfer/incoming"),
        f._root.path().join("received-bytes-withheld"),
    )
    .unwrap();
    let undone = store
        .run_batch(
            &done.job_id,
            plan_id,
            "owned-transfer-undo",
            done.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(store.read(&done.job_id).is_ok());
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.target_profile.join("settings.json")).unwrap())
            .unwrap();
    assert!(
        settings["mcp_servers"]
            .as_array()
            .is_none_or(|items| items.iter().all(|item| item["name"] != "transferred-docs"))
    );
}
