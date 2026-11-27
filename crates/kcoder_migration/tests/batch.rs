use kcoder_config::imported_context::ImportedContextScope;
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    discovery::{DiscoveryRoots, SourceRegistry},
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::migration::{
    MigrationCategory as Category, MigrationJobStatus as Status, MigrationSourceKind as Kind,
};
use std::path::Path;

fn inputs(root: &Path) -> Vec<BatchSource> {
    let source = root.join("source");
    std::fs::create_dir_all(source.join("skills/sample")).unwrap();
    std::fs::write(source.join("settings.json"),r#"{"model":"fixture-model","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"},"mcpServers":{"documents":{"command":"never-run-migration-fixture"}}}"#).unwrap();
    std::fs::write(
        source.join("skills/sample/SKILL.md"),
        "---\nname: sample\ndescription: Fixture skill\n---\nUse the source evidence.",
    )
    .unwrap();
    std::fs::write(source.join("CLAUDE.md"), "Preserve original work files.").unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.into(),
        claude_config_dir: Some(source.clone()),
        codex_home: None,
        project: None,
    });
    let discovery = registry.discover(&[Kind::ClaudeCode], false).0;
    let config = discovery
        .iter()
        .find(|source| source.scope == "user")
        .unwrap();
    vec![
        BatchSource::Configuration(registry.selected(&config.source_id).unwrap()),
        BatchSource::Assets(
            AssetBundleBinding::capture(
                &source.join("skills"),
                Kind::ClaudeCode,
                Category::Skill,
                ImportedContextScope::Global,
                true,
            )
            .unwrap(),
        ),
        BatchSource::Assets(
            AssetBundleBinding::capture(
                &source.join("CLAUDE.md"),
                Kind::ClaudeCode,
                Category::Instructions,
                ImportedContextScope::Global,
                false,
            )
            .unwrap(),
        ),
    ]
}

#[test]
fn batch_preserves_settings_revision_chain_assets_and_restart_undo() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_batch_scan(inputs(root.path())).unwrap();
    assert_eq!(job.inventory.items.len(), 4);
    let resolutions = job
        .inventory
        .items
        .iter()
        .map(|item| match item.preview.category {
            Category::Provider => BatchResolution::Provider(ProviderResolution {
                item_id: item.preview.id.clone(),
                target_name: "ImportedProvider".into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 128000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            }),
            Category::Mcp => BatchResolution::Mcp(McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "ImportedDocuments".into(),
                cwd: None,
                enable_after_import: false,
            }),
            _ => BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: if item.asset.as_ref().unwrap().name == "sample" {
                    "imported-sample"
                } else {
                    "Imported instructions"
                }
                .into(),
                enable_after_import: false,
                memory_scope: None,
            }),
        })
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    let targets = BatchTargets {
        history: None,
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
    };
    let job = store
        .prepare_batch(&job.job_id, job.sequence, &resolutions, &targets)
        .unwrap();
    let plan = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        "{}"
    );
    let applied = store
        .run_batch(
            &job.job_id,
            plan,
            "apply-request",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    let asset = job
        .inventory
        .items
        .iter()
        .find(|item| {
            item.asset
                .as_ref()
                .is_some_and(|asset| asset.name == "sample")
        })
        .unwrap();
    std::fs::write(
        root.path().join("source/skills/sample/SKILL.md"),
        "User changed the original source after migration",
    )
    .unwrap();
    assert!(
        store
            .asset_snapshot(&job.job_id, &asset.preview.id)
            .unwrap()
            .unwrap()
            .contains("Use the source evidence.")
    );
    assert_eq!(applied.receipts.len(), 3);
    assert_eq!(
        applied
            .inventory
            .items
            .iter()
            .filter(|item| item.preview.status
                == kcoder_types::migration::MigrationItemStatus::Committed)
            .count(),
        4
    );
    let document = kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap();
    assert!(document["providers"]["ImportedProvider"].is_object());
    assert_eq!(document["mcp_servers"][0]["name"], "ImportedDocuments");
    assert!(profile.join("skills/imported-sample/SKILL.md").is_file());
    let duplicate = store
        .run_batch(
            &job.job_id,
            plan,
            "apply-request",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(duplicate.receipts.len(), 3);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        document
    );
    let store = MigrationStore::open_existing(&profile).unwrap();
    let undone = store
        .run_batch(
            &job.job_id,
            plan,
            "undo-request",
            duplicate.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, Status::RolledBack);
    assert!(!profile.join("skills/imported-sample").exists());
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
    assert!(root.path().join("source/skills/sample/SKILL.md").is_file());
    assert_eq!(store.records(None).unwrap().0[0].job_id, job.job_id);
}

#[test]
fn independent_assets_continue_after_a_source_change_without_replaying_committed_items() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let all = inputs(root.path());
    let job = store
        .create_batch_scan(all.into_iter().skip(1).collect())
        .unwrap();
    let choices = job
        .inventory
        .items
        .iter()
        .map(|item| {
            BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: item.asset.as_ref().unwrap().name.to_lowercase(),
                enable_after_import: false,
                memory_scope: None,
            })
        })
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    let targets = BatchTargets {
        history: None,
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
    };
    let job = store
        .prepare_batch(&job.job_id, job.sequence, &choices, &targets)
        .unwrap();
    let plan = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    std::fs::write(
        root.path().join("source/CLAUDE.md"),
        "Changed source constraints",
    )
    .unwrap();
    let applied = store
        .run_batch(
            &job.job_id,
            plan,
            "apply-request",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(applied.status, Status::CompletedWithIssues);
    assert_eq!(applied.receipts.len(), 1);
    assert!(profile.join("skills/sample/SKILL.md").is_file());
    let retried = store
        .run_batch(
            &job.job_id,
            plan,
            "retry-request",
            applied.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(retried.receipts.len(), 1);
    assert!(
        store
            .run_batch(
                &job.job_id,
                plan,
                "apply-request",
                retried.sequence,
                true,
                &targets
            )
            .is_err()
    );
}

#[test]
fn default_names_are_stable_across_scans_without_hashing_credentials_into_public_names() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let sources = inputs(root.path());
    let first = store.create_batch_scan(sources.clone()).unwrap();
    let second = store.create_batch_scan(sources).unwrap();
    let names = |job: &kcoder_migration::store::MigrationJob| {
        job.inventory
            .items
            .iter()
            .map(|item| {
                (
                    item.preview.source_name.clone(),
                    kcoder_migration::batch::proposed_name(job, item).unwrap(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    assert_eq!(names(&first), names(&second));
    assert_ne!(
        first.inventory.items[0].preview.id,
        second.inventory.items[0].preview.id
    );
    std::fs::write(root.path().join("source/settings.json"),r#"{"model":"fixture-model","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_ROTATED_SECRET"},"mcpServers":{"documents":{"command":"never-run-migration-fixture"}}}"#).unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.path().into(),
        claude_config_dir: Some(root.path().join("source")),
        codex_home: None,
        project: None,
    });
    let sources = registry.discover(&[Kind::ClaudeCode], false).0;
    let source = sources
        .iter()
        .find(|source| source.scope == "user")
        .unwrap();
    let rotated = store
        .create_batch_scan(vec![BatchSource::Configuration(
            registry.selected(&source.source_id).unwrap(),
        )])
        .unwrap();
    for (label, name) in names(&rotated) {
        assert_eq!(names(&first)[&label], name);
        assert!(!name.contains("SYNTHETIC_ROTATED_SECRET"));
    }
}
