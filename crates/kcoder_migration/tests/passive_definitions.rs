//! Synthetic static definitions are copied as inert assets, never installed into an executable store.
use kcoder_config::{PrivateDirectory, imported_context::ImportedContextScope};
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    discovery::SourceRegistry,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::{
    migration::{
        MigrationCategory as Category, MigrationJobStatus as Status, MigrationSourceKind as Kind,
    },
    migration_definitions::*,
};
use serde_json::json;
use std::{fs, path::Path};

fn targets<'a>(
    provider: &'a ProviderTarget,
    mcp: &'a McpTarget,
    assets: &'a AssetTarget,
) -> BatchTargets<'a> {
    BatchTargets {
        provider,
        mcp,
        assets,
        credentials: None,
        history: None,
    }
}
fn seed(product: &Path, kind: Kind) {
    fs::create_dir_all(product.join("agents")).unwrap();
    match kind {
        Kind::ClaudeCode => {
            fs::write(product.join("agents/reviewer.md"), "---\nname: reviewer\ndescription: Static fixture\ntools: Bash\npermissionMode: bypassPermissions\nSYNTHETIC_PRIVATE_FIELD: never-show-in-report\n---\nNever execute $(touch forbidden).\n").unwrap();
            fs::write(product.join("settings.json"), json!({"env":{"ANTHROPIC_API_KEY":"SYNTHETIC_NONHOOK_SECRET"},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"never-execute --fixture"}]}]}}).to_string()).unwrap();
            fs::write(product.join("agents/ignore.toml"), "name='not-claude'\n").unwrap();
        }
        Kind::Codex => {
            fs::write(product.join("agents/reviewer.toml"), "name='reviewer'\ndescription='Static fixture'\ndeveloper_instructions='Never execute source commands.'\nmodel='not-a-native-provider'\nSYNTHETIC_PRIVATE_FIELD='never-show-in-report'\n").unwrap();
            fs::write(product.join("config.toml"), "[hooks]\n").unwrap();
            fs::write(product.join("hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"never-run"}]}]}}"#).unwrap();
            fs::write(product.join("agents/ignore.md"), "Not a Codex definition").unwrap();
        }
    }
    fs::write(
        product.join(
            "agents/broken".to_string()
                + if kind == Kind::ClaudeCode {
                    ".md"
                } else {
                    ".toml"
                },
        ),
        [0xff, 0x00, 0xfe],
    )
    .unwrap();
}

#[test]
fn both_vendors_save_reviewable_and_opaque_definitions_in_one_batch_without_runtime_activation() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let root = tempfile::tempdir().unwrap();
        let product = root.path().join("source");
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::write(profile.join("settings.json"), "{}").unwrap();
        seed(&product, kind);
        let mut registry = SourceRegistry::from_selected_product_directory(&product, kind).unwrap();
        let normal = registry.discover(&[kind], false).0;
        assert!(
            normal
                .iter()
                .all(|row| !row.categories.iter().any(|c| matches!(c, Category::Agent)))
        );
        let (sources, problems) = registry.discover_definitions(&[kind], false);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(
            sources
                .iter()
                .filter(|row| row.scope == "user-agents")
                .count(),
            1
        );
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let inputs = sources
            .iter()
            .map(|row| BatchSource::Assets(registry.selected_asset(&row.source_id).unwrap()))
            .collect();
        let job = store.create_batch_scan(inputs).unwrap();
        assert!(
            job.inventory
                .items
                .iter()
                .all(|item| !item.preview.selected_by_default && item.asset.is_some())
        );
        let raw_inventory = serde_json::to_string(&job.inventory).unwrap();
        assert!(!raw_inventory.contains("SYNTHETIC_NONHOOK_SECRET"));
        let provider = ProviderTarget::open(&profile).unwrap();
        let mcp = McpTarget::open(&profile).unwrap();
        let assets = AssetTarget::open(&profile).unwrap();
        let resolutions = job
            .inventory
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                BatchResolution::Asset(AssetResolution {
                    agent_adaptation: None,
                    item_id: item.preview.id.clone(),
                    target_name: format!("pending-{index}"),
                    enable_after_import: false,
                    memory_scope: None,
                })
            })
            .collect::<Vec<_>>();
        let planned = store
            .prepare_batch(
                &job.job_id,
                job.sequence,
                &resolutions,
                &targets(&provider, &mcp, &assets),
            )
            .unwrap();
        assert!(!profile.join("skills").exists());
        let mut snapshots = Vec::new();
        for item in &planned.inventory.items {
            let snapshot = store
                .definition_snapshot(&job.job_id, &item.preview.id)
                .unwrap();
            assert!(!snapshot.report.execution_allowed && snapshot.report.requires_review);
            let report = serde_json::to_string(&snapshot.report).unwrap();
            assert!(
                !report.contains("SYNTHETIC_PRIVATE_FIELD")
                    && !report.contains("never-show-in-report")
                    && !report.contains("SYNTHETIC_NONHOOK_SECRET")
            );
            if item.preview.category == Category::Hook {
                assert!(
                    !std::str::from_utf8(&snapshot.bytes)
                        .unwrap()
                        .contains("SYNTHETIC_NONHOOK_SECRET")
                );
            }
            snapshots.push((
                item.preview.id.clone(),
                snapshot.bytes.to_vec(),
                snapshot.report,
            ));
        }
        assert!(snapshots.iter().any(|(_,_,report)| report.parse_status == MigrationDefinitionParseStatus::Opaque));
        assert!(snapshots.iter().any(|(_, _, report)| report.parse_status
            == MigrationDefinitionParseStatus::Parsed
            && report.unknown_fields.unwrap_or_default() > 0));
        let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
        let applied = store
            .run_batch(
                &job.job_id,
                plan,
                "save-pending",
                planned.sequence,
                false,
                &targets(&provider, &mcp, &assets),
            )
            .unwrap();
        assert!(matches!(
            applied.status,
            Status::CompletedWithIssues | Status::Completed
        ));
        assert_eq!(applied.receipts.len(), planned.inventory.items.len());
        assert!(
            applied
                .inventory
                .items
                .iter()
                .all(|item| item.preview.status
                    == kcoder_types::migration::MigrationItemStatus::Committed)
        );
        assert_eq!(
            fs::read_to_string(profile.join("settings.json")).unwrap(),
            "{}"
        );
        assert!(!profile.join("skills").exists());
        assert!(!profile.join("imported-context.json").exists());
        assert!(!root.path().join("forbidden").exists());
        fs::rename(&product, root.path().join("source-withheld")).unwrap();
        let store = MigrationStore::open_existing(&profile).unwrap();
        for (id, bytes, report) in &snapshots {
            let snapshot = store.definition_snapshot(&job.job_id, id).unwrap();
            assert_eq!(&*snapshot.bytes, bytes);
            assert_eq!(&snapshot.report, report);
        }
        let replay = store
            .run_batch(
                &job.job_id,
                plan,
                "save-pending",
                planned.sequence,
                false,
                &targets(&provider, &mcp, &assets),
            )
            .unwrap();
        assert_eq!(replay.receipts, applied.receipts);
        let undone = store
            .run_batch(
                &job.job_id,
                plan,
                "undo-pending",
                replay.sequence,
                true,
                &targets(&provider, &mcp, &assets),
            )
            .unwrap();
        assert_eq!(undone.status, Status::RolledBack);
        let saved: serde_json::Value = serde_json::from_slice(
            &fs::read(
                profile.join("migrations/pending-definitions/migration-pending-definitions.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(saved["records"], json!({}));
        assert!(
            saved["receipts"]
                .as_object()
                .unwrap()
                .values()
                .all(|r| r["undone"] == true)
        );
        for (id, bytes, _) in snapshots {
            assert_eq!(
                &*store.definition_snapshot(&job.job_id, &id).unwrap().bytes,
                &bytes
            );
        }
    }
}

#[test]
fn activation_is_rejected_and_source_changed_before_initial_publish_is_not_copied() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let source = root.path().join("agent.toml");
    PrivateDirectory::open_or_create(&profile).unwrap();
    fs::write(
        &source,
        "name='agent'\ndescription='fixture'\ndeveloper_instructions='Inert'\n",
    )
    .unwrap();
    let binding = AssetBundleBinding::capture(
        &source,
        Kind::Codex,
        Category::Agent,
        ImportedContextScope::Global,
        false,
    )
    .unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_asset_scan(binding).unwrap();
    let item = &job.inventory.items[0];
    let id = item.preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = AssetTarget::open(&profile).unwrap();
    let mut resolution = AssetResolution {
        agent_adaptation: None,
        item_id: id,
        target_name: "fixture".into(),
        enable_after_import: true,
        memory_scope: None,
    };
    assert!(
        store
            .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
            .unwrap_err()
            .to_string()
            .contains("cannot_activate")
    );
    resolution.enable_after_import = false;
    let planned = store
        .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
        .unwrap();
    fs::write(&source, "changed source").unwrap();
    assert!(
        store
            .apply_asset(
                &job.job_id,
                planned.sequence,
                planned.asset_plans[0].id(),
                &target
            )
            .unwrap_err()
            .to_string()
            .contains("source_changed")
    );
    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(
            profile.join("migrations/pending-definitions/migration-pending-definitions.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["records"], json!({}));
}

#[test]
fn default_home_project_definitions_bind_fresh_authority_but_saved_bytes_do_not_reconnect_source() {
    use kcoder_migration::discovery::DiscoveryRoots;
    for replace in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let home = root.path().join("home");
        let project = root.path().join("project");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(project.join(".claude/agents")).unwrap();
        fs::write(
            profile.join("trusted-folders.json"),
            json!({"trusted":[project],"never":[]}).to_string(),
        )
        .unwrap();
        let bytes = "---\nname: project\ndescription: fixture\n---\nProject definition only.\n";
        fs::write(project.join(".claude/agents/fixture.md"), bytes).unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home,
            claude_config_dir: None,
            codex_home: None,
            project: Some(project.clone()),
        });
        assert!(
            registry
                .definition_page(&[Kind::ClaudeCode], true, None, 0)
                .is_err()
        );
        registry
            .authorize_definition_project(&profile, Some(&project))
            .unwrap();
        let page = registry
            .definition_page(&[Kind::ClaudeCode], true, None, 0)
            .unwrap();
        let selected = page
            .sources
            .iter()
            .find(|row| row.scope == "project-agents")
            .unwrap();
        let binding = registry.selected_asset(&selected.source_id).unwrap();
        let wire = serde_json::to_value(&binding).unwrap();
        assert!(wire["definitionProject"].is_object());
        assert!(wire.get("selectedRoot").is_none());
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let job = store.create_asset_scan(binding.clone()).unwrap();
        let id = job.inventory.items[0].preview.id.clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        let target = AssetTarget::open(&profile).unwrap();
        let planned = store
            .prepare_asset(
                &job.job_id,
                job.sequence,
                &target,
                &AssetResolution {
                    agent_adaptation: None,
                    item_id: id.clone(),
                    target_name: "pending-project".into(),
                    enable_after_import: false,
                    memory_scope: None,
                },
            )
            .unwrap();
        let published = store
            .apply_asset(
                &job.job_id,
                planned.sequence,
                planned.asset_plans[0].id(),
                &target,
            )
            .unwrap();
        if replace {
            let saved = project.with_extension("original");
            fs::rename(&project, &saved).unwrap();
            fs::create_dir(&project).unwrap();
            for entry in fs::read_dir(saved).unwrap() {
                let entry = entry.unwrap();
                fs::rename(entry.path(), project.join(entry.file_name())).unwrap();
            }
        } else {
            kcoder_config::FolderTrustStore::load(&profile)
                .revoke(&project)
                .unwrap();
        }
        assert!(binding.read("fixture.md").is_err());
        assert!(
            registry
                .definition_page(&[Kind::ClaudeCode], true, Some(&page.catalog_id), 0)
                .is_err()
        );
        assert_eq!(serde_json::to_value(&binding).unwrap(), wire);
        assert_eq!(
            &*store.definition_snapshot(&job.job_id, &id).unwrap().bytes,
            bytes.as_bytes()
        );
        store
            .rollback_asset(
                &job.job_id,
                published.sequence,
                planned.asset_plans[0].id(),
                &target,
            )
            .unwrap();
        assert_eq!(
            &*store.definition_snapshot(&job.job_id, &id).unwrap().bytes,
            bytes.as_bytes()
        );
        assert!(store.create_asset_scan(binding).is_err());
    }
}
