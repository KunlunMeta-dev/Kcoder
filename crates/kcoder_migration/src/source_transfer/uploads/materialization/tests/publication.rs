use super::*;
use crate::{
    assets::{AssetResolution, AssetTarget},
    batch::{
        BatchResolution, BatchSource,
        history::{HistoryBatchResolution, HistoryBatchSource},
    },
    history_jobs::HistoryJobStore,
    mcp::McpTarget,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::{
    external_history::HistoryImportStage,
    migration::{MigrationCategory, MigrationJobStatus},
};

const CONFIG: &[u8] = b"model='uploaded-model'\nmodel_provider='uploaded'\n[model_providers.uploaded]\nname='Uploaded'\nbase_url='https://fixture.invalid/v1'\nwire_api='responses'\nrequires_openai_auth=false\n";
const SKILL: &[u8] = b"---\nname: uploaded-office\ndescription: Synthetic office material\n---\nKeep the explicitly supplied original body.\n";
const HISTORY_PATH: &str =
    "archived_sessions/rollout-2026-10-17T00-00-00-10000000-0000-4000-8000-000000000001.jsonl";
const HISTORY: &[u8] = br#"{"timestamp":"2026-10-17T00:00:00Z","type":"session_meta","payload":{"id":"10000000-0000-4000-8000-000000000001","cwd":"/recorded/source","timestamp":"2026-10-17T00:00:00Z"}}
{"timestamp":"2026-10-17T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A user-supplied historical question"}]}}
{"timestamp":"2026-10-17T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"A recorded response, never a queued tool"}]}}
"#;

fn materialized() -> (tempfile::TempDir, SourceUploads, String, String) {
    let f = upload(&[
        ("config.toml", CONFIG),
        ("skills/uploaded-office/SKILL.md", SKILL),
        (HISTORY_PATH, HISTORY),
    ]);
    let (_, worker) = f.1.prepare_materialization(&f.2, &f.3).unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    f
}

#[test]
fn uploaded_configuration_skill_and_history_use_normal_explicit_batch_publish_reopen_and_undo() {
    let (profile, uploads, id, digest) = materialized();
    let baseline = serde_json::json!({"credential_store":"file","active_provider":"existing","mcp_servers":[],
        "providers":{"existing":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:9/v1",
        "default_model":"existing","authentication":{"mode":"none"},"context_window_tokens":128000,
        "max_output_tokens":2048,"output_headroom_tokens":4096}}});
    std::fs::write(
        profile.path().join("settings.json"),
        serde_json::to_vec(&baseline).unwrap(),
    )
    .unwrap();
    let mut registry = uploads.product_registry(&id, &digest).unwrap();
    let (found, problems) = registry.discover(&[MigrationSourceKind::Codex], false);
    assert!(problems.is_empty(), "{problems:?}");
    let mut inputs = Vec::new();
    for item in found {
        if item.categories.contains(&MigrationCategory::Provider) {
            inputs.push(BatchSource::Configuration(
                registry.selected(&item.source_id).unwrap(),
            ));
        } else if item.categories == vec![MigrationCategory::Skill] {
            inputs.push(BatchSource::Assets(
                registry.selected_asset(&item.source_id).unwrap(),
            ));
        }
    }
    let catalog = registry
        .discover_history(MigrationSourceKind::Codex, |_| true)
        .unwrap();
    assert_eq!(catalog.items.len(), 1);
    assert_eq!(catalog.items[0].modified_at_ms, None);
    let reread = registry
        .history_page(&catalog.catalog_id, None, |_| true)
        .unwrap();
    assert_eq!(reread.items[0].modified_at_ms, None);
    let history_selection = registry
        .history_selection(&catalog.catalog_id, &catalog.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap();
    let pinned = serde_json::to_value(&history_selection).unwrap();
    assert_eq!(
        pinned["entry"]["summary"].get("modifiedAtMs"),
        Some(&serde_json::Value::Null)
    );
    assert_eq!(
        pinned["entry"]["selected"].get("modified_at_ms"),
        Some(&serde_json::Value::Null)
    );
    let captured = history_selection.capture(&mut |_, _| true).unwrap();
    assert_eq!(
        captured.snapshot().source_sha256,
        format!("{:x}", Sha256::digest(HISTORY))
    );
    assert!(
        captured
            .snapshot()
            .origin
            .source_instance
            .starts_with("user-upload:")
    );
    inputs.push(BatchSource::History(Box::new(
        HistoryBatchSource::new(history_selection).unwrap(),
    )));
    assert_eq!(inputs.len(), 3);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let scan = store.create_batch_scan(inputs).unwrap();
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| match item.preview.category {
            MigrationCategory::Provider => Some(BatchResolution::Provider(ProviderResolution {
                item_id: item.preview.id.clone(),
                target_name: "UploadedOffice".into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 128000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            })),
            MigrationCategory::Skill => Some(BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: "uploaded-office".into(),
                enable_after_import: false,
                memory_scope: None,
            })),
            MigrationCategory::History => Some(BatchResolution::History(HistoryBatchResolution {
                item_id: item.preview.id.clone(),
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(choices.len(), 3);
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    // The normal Host batch scan explicitly prepares its target history service.
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let plan = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(profile.path().join("settings.json")).unwrap()
        )
        .unwrap(),
        baseline
    );
    assert!(!profile.path().join("skills/uploaded-office").exists());
    let plan_id = plan.batch.as_ref().unwrap().plan_id.clone().unwrap();
    let done = store
        .run_batch(
            &plan.job_id,
            &plan_id,
            "explicit-uploaded-import",
            plan.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        done.inventory
            .items
            .iter()
            .filter(|item| item.preview.status
                == kcoder_types::migration::MigrationItemStatus::Committed)
            .count(),
        3
    );
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(
        settings["providers"]["UploadedOffice"]["default_model"],
        "uploaded-model"
    );
    assert_eq!(settings["active_provider"], "existing");
    let text =
        std::fs::read_to_string(profile.path().join("skills/uploaded-office/SKILL.md")).unwrap();
    assert!(text.contains("default_enabled: false"));
    assert!(text.ends_with("Keep the explicitly supplied original body.\n"));
    let child_id = done
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .find_map(|action| match &action.action {
            crate::batch::BatchActionKind::History { plan } => Some(plan.history_job_id.clone()),
            _ => None,
        })
        .unwrap();
    let child = history.read(&child_id).unwrap();
    assert_eq!(child.stage, HistoryImportStage::Normalized);
    let archive = history.archive_reader(&child_id).unwrap();
    assert!(archive.origin().source_instance.starts_with("user-upload:"));
    assert_eq!(
        archive.receipt().unwrap().unwrap().source_sha256,
        format!("{:x}", Sha256::digest(HISTORY))
    );
    drop(archive);
    drop(store);
    let reopened = MigrationStore::open_existing(profile.path()).unwrap();
    let observed = reopened.read(&done.job_id).unwrap();
    assert_eq!(observed.status, MigrationJobStatus::CompletedWithIssues);
    let undone = reopened
        .run_batch(
            &observed.job_id,
            &plan_id,
            "explicit-uploaded-undo",
            observed.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(!profile.path().join("skills/uploaded-office").exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(profile.path().join("settings.json")).unwrap()
        )
        .unwrap(),
        baseline
    );
    assert_eq!(uploads.read(&id).unwrap().stage, SourceUploadStage::Ready);
}

#[test]
fn same_inode_mutations_cannot_be_recaptured_as_uploaded_configuration_assets_or_history() {
    for relative in [
        "config.toml",
        "skills/uploaded-office/SKILL.md",
        HISTORY_PATH,
    ] {
        let (_profile, uploads, id, digest) = materialized();
        let mut registry = uploads.product_registry(&id, &digest).unwrap();
        let (found, problems) = registry.discover(&[MigrationSourceKind::Codex], false);
        assert!(problems.is_empty());
        let catalog = registry
            .discover_history(MigrationSourceKind::Codex, |_| true)
            .unwrap();
        let (_, directory, _) = uploads.selected_product(&id, &digest).unwrap();
        let root = directory.open_child(OsStr::new(PRODUCT), false).unwrap();
        let (parent, leaf) = open_parent(&root, relative).unwrap();
        let before = parent.portable_regular_identity(OsStr::new(&leaf)).unwrap();
        let mut data = std::fs::read(
            _profile
                .path()
                .join("migrations/source-transfer/browser-products")
                .join(&id)
                .join(PRODUCT)
                .join(relative),
        )
        .unwrap();
        let offset = data.len() - 2;
        data[offset] ^= 1;
        let mut file = parent
            .open_read_write_file(OsStr::new(&leaf), false)
            .unwrap();
        std::io::Write::write_all(&mut file, &data).unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(
            parent.portable_regular_identity(OsStr::new(&leaf)).unwrap(),
            before
        );
        if relative == HISTORY_PATH {
            let selection = registry
                .history_selection(&catalog.catalog_id, &catalog.items[0].source_handle)
                .unwrap();
            assert!(selection.capture(&mut |_, _| true).is_err());
        } else {
            let mut fresh = uploads.product_registry(&id, &digest).unwrap();
            let (changed, problems) = fresh.discover(&[MigrationSourceKind::Codex], false);
            let category = if relative == "config.toml" {
                MigrationCategory::Provider
            } else {
                MigrationCategory::Skill
            };
            if category == MigrationCategory::Provider {
                assert!(!problems.is_empty());
                assert!(
                    !changed
                        .iter()
                        .any(|entry| entry.categories.contains(&category))
                );
            } else {
                // The existing asset scanner retains a blocked row instead of
                // pretending a known skill vanished. It must contain no trusted asset.
                let row = changed
                    .iter()
                    .find(|entry| entry.categories.contains(&category))
                    .unwrap();
                let blocked = fresh.selected_asset(&row.source_id).unwrap();
                assert_eq!(
                    blocked.read("uploaded-office").err().unwrap().to_string(),
                    "source_upload_product_content_changed"
                );
                let inventory = blocked.inventory().unwrap();
                assert!(inventory.items.iter().all(|item| {
                    item.asset.is_none()
                        && item
                            .preview
                            .issues
                            .iter()
                            .any(|issue| issue.blocks_import())
                }));
            }
            assert!(
                found
                    .iter()
                    .any(|entry| entry.categories.contains(&category))
            );
        }
    }
}

#[test]
fn transferred_uploaded_provenance_survives_source_removal_and_three_receiving_bindings_reopen() {
    use crate::source_transfer::{
        ExportSelection, IncomingTransfers, SourceTransfers, TransferContent,
    };
    let (profile, uploads, id, digest) = materialized();
    let mut registry = uploads.product_registry(&id, &digest).unwrap();
    let (found, problems) = registry.discover(&[MigrationSourceKind::Codex], false);
    assert!(problems.is_empty());
    let config = found
        .iter()
        .find(|item| item.categories.contains(&MigrationCategory::Provider))
        .unwrap();
    let asset = found
        .iter()
        .find(|item| item.categories == vec![MigrationCategory::Skill])
        .unwrap();
    let catalog = registry
        .discover_history(MigrationSourceKind::Codex, |_| true)
        .unwrap();
    let captured = registry
        .selected_history(
            &catalog.catalog_id,
            &catalog.items[0].source_handle,
            &mut |_, _| true,
        )
        .unwrap();
    let source = SourceTransfers::open(profile.path()).unwrap();
    let target_profile = tempfile::tempdir().unwrap();
    let target = IncomingTransfers::open(target_profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let destination = target
        .issue_destination(&request, source.authority())
        .unwrap();
    source
        .prepare(
            &request,
            &destination,
            vec![
                ExportSelection::Configuration(registry.selected(&config.source_id).unwrap()),
                ExportSelection::Asset {
                    binding: registry.selected_asset(&asset.source_id).unwrap(),
                    key: "uploaded-office".into(),
                },
                ExportSelection::CapturedHistory(captured),
            ],
        )
        .unwrap();
    let manifest = source.capture(&request, &destination, |_| true).unwrap();
    let expected = kcoder_types::migration_source_upload::SourceUploadProvenance {
        operation_id: id,
        manifest_sha256: digest,
    };
    assert_eq!(manifest.entries.len(), 3);
    for entry in &manifest.entries {
        assert_eq!(entry.content.uploaded_source(), Some(&expected));
    }
    let mut forged = serde_json::to_value(&manifest).unwrap();
    forged["entries"][0]["content"]["uploadedSource"]["account"] =
        serde_json::json!("forged-os-account");
    assert!(serde_json::from_value::<crate::source_transfer::TransferManifest>(forged).is_err());
    target.begin(&manifest, source.authority()).unwrap();
    let manifest_sha = manifest.digest().unwrap();
    for entry in &manifest.entries {
        for part in 0..entry
            .bytes
            .div_ceil(crate::source_transfer::TRANSFER_CHUNK_BYTES as u64)
            as u32
        {
            let chunk = source
                .chunk(&request, &destination, &manifest_sha, &entry.id, part)
                .unwrap();
            target.write_part(source.authority(), &chunk).unwrap();
        }
    }
    let receipt = target
        .finish(&request, source.authority(), |_| true)
        .unwrap();
    let parent = tempfile::tempdir().unwrap();
    std::fs::rename(profile.path(), parent.path().join("owned-source-offline")).unwrap();
    for entry in &manifest.entries {
        match &entry.content {
            TransferContent::ProjectInventory { .. } => {
                panic!("this uploaded fixture did not select a project registry")
            }
            TransferContent::InstructionBundle { .. } => {
                panic!("this uploaded product fixture did not grant a scoped instruction graph")
            }
            TransferContent::PluginPackage { .. } => {
                panic!("uploaded products do not grant plugin packages")
            }
            TransferContent::ConfigurationInventory { .. } => {
                let binding = target
                    .configuration_binding(&request, source.authority(), &entry.id, &receipt)
                    .unwrap();
                let encoded = serde_json::to_vec(&binding).unwrap();
                let reopened: crate::source_transfer::TransferredConfigurationBinding =
                    serde_json::from_slice(&encoded).unwrap();
                assert_eq!(reopened.uploaded_source().unwrap(), Some(expected.clone()));
            }
            TransferContent::WorkAsset { .. } => {
                let binding = target
                    .received_asset_binding(&request, &manifest_sha, &entry.id, None)
                    .unwrap();
                let encoded = serde_json::to_vec(&binding).unwrap();
                let reopened: crate::asset_sources::AssetBundleBinding =
                    serde_json::from_slice(&encoded).unwrap();
                assert_eq!(reopened.uploaded_source().unwrap(), Some(expected.clone()));
            }
            TransferContent::History { .. } => {
                let binding = target
                    .history_binding(&request, source.authority(), &entry.id, &receipt, |_| true)
                    .unwrap();
                let encoded = serde_json::to_vec(&binding).unwrap();
                let reopened: crate::history_sources::HistorySourceBinding =
                    serde_json::from_slice(&encoded).unwrap();
                assert_eq!(reopened.uploaded_source(), Some(&expected));
                assert!(
                    reopened
                        .snapshot()
                        .origin
                        .source_instance
                        .starts_with("user-upload:received:")
                );
            }
        }
    }
    assert!(!target_profile.path().join("settings.json").exists());
    assert!(!target_profile.path().join("skills").exists());
}
