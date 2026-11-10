use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchPlanPolicy, BatchResolution, BatchSource, default_resolution},
    discovery::{DiscoveryRoots, SourceRegistry},
    mcp::McpTarget,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::migration::{
    MigrationCategory, MigrationItemStatus as ItemStatus, MigrationJobStatus,
};
use std::path::Path;

fn sources(root: &Path, initialize: bool) -> Vec<BatchSource> {
    let source = root.join("source");
    if initialize {
        std::fs::create_dir_all(source.join("skills/report")).unwrap();
        std::fs::write(source.join("settings.json"),r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"},"mcpServers":{"documents":{"command":"never-run"}}}"#).unwrap();
        std::fs::write(source.join("CLAUDE.md"), "Keep the source evidence.").unwrap();
        std::fs::write(
            source.join("skills/report/SKILL.md"),
            "---\nname: report\ndescription: Source report\n---\nReview the evidence.",
        )
        .unwrap();
    }
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.into(),
        claude_config_dir: Some(source),
        codex_home: None,
        project: None,
    });
    registry
        .discover(
            &[kcoder_types::migration::MigrationSourceKind::ClaudeCode],
            false,
        )
        .0
        .into_iter()
        .map(|source| match registry.selected_asset(&source.source_id) {
            Ok(binding) => BatchSource::Assets(binding),
            Err(_) => BatchSource::Configuration(registry.selected(&source.source_id).unwrap()),
        })
        .collect()
}
fn prepare(root: &Path, store: &MigrationStore, profile: &Path, initialize: bool) -> MigrationJob {
    prepare_result(root, store, profile, initialize).unwrap()
}
fn prepare_result(
    root: &Path,
    store: &MigrationStore,
    profile: &Path,
    initialize: bool,
) -> anyhow::Result<MigrationJob> {
    let job = store.create_batch_scan(sources(root, initialize))?;
    let choices = job
        .inventory
        .items
        .iter()
        .map(|item| {
            if item.preview.category == MigrationCategory::Provider {
                BatchResolution::Provider(ProviderResolution {
                    item_id: item.preview.id.clone(),
                    target_name: kcoder_migration::batch::proposed_name(&job, item).unwrap(),
                    endpoint: None,
                    model: None,
                    limits: Some(ModelLimits {
                        context_window_tokens: 64000,
                        output_headroom_tokens: 8192,
                        max_output_tokens: 8192,
                    }),
                })
            } else {
                default_resolution(&job, item).unwrap()
            }
        })
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(profile).unwrap();
    let mcp = McpTarget::open(profile).unwrap();
    let assets = AssetTarget::open(profile).unwrap();
    store.prepare_batch_with_policy(
        &job.job_id,
        job.sequence,
        &choices,
        &BatchTargets {
            history: None,
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
        },
        &BatchPlanPolicy {
            reuse_existing: true,
            ..Default::default()
        },
    )
}
fn run(store: &MigrationStore, profile: &Path, job: &MigrationJob, rollback: bool) -> MigrationJob {
    let provider = ProviderTarget::open(profile).unwrap();
    let mcp = McpTarget::open(profile).unwrap();
    let assets = AssetTarget::open(profile).unwrap();
    store
        .run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            if rollback { "undo" } else { "apply" },
            job.sequence,
            rollback,
            &BatchTargets {
                history: None,
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                credentials: None,
            },
        )
        .unwrap()
}

#[test]
fn a_second_migration_reuses_results_preserves_preferences_and_never_owns_the_originals() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let first = prepare(root.path(), &store, &profile, true);
    let first = run(&store, &profile, &first, false);
    let original = kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap();
    let mut changed = original.clone();
    changed["mcp_disabled_servers"] = serde_json::json!([]);
    std::fs::write(
        profile.join("settings.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    let contexts = kcoder_config::imported_context::ImportedContextStore::open(&profile).unwrap();
    let note = contexts.list().unwrap().remove(0);
    contexts
        .set_enabled(&note.id, &note.operation_id, true)
        .unwrap();
    let provider_name = changed["providers"]
        .as_object()
        .unwrap()
        .keys()
        .find(|name| name.starts_with("imported-"))
        .unwrap();
    let credential =
        serde_json::json!({(provider_name):{"type":"api","key":"SYNTHETIC_USER_CREDENTIAL"}});
    std::fs::write(profile.join("credentials.json"), credential.to_string()).unwrap();
    let second = prepare(root.path(), &store, &profile, false);
    assert_eq!(second.batch.as_ref().unwrap().actions.len(), 4);
    let reused = run(&store, &profile, &second, false);
    assert!(
        reused
            .inventory
            .items
            .iter()
            .all(|item| item.preview.status == ItemStatus::Skipped)
    );
    assert!(
        reused
            .receipts
            .iter()
            .all(|receipt| !receipt.ownership_confirmed)
    );
    assert_eq!(contexts.list().unwrap().len(), 1);
    assert!(contexts.list().unwrap()[0].enabled);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        changed
    );
    let undone = run(&store, &profile, &reused, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(contexts.list().unwrap().len(), 1);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        changed
    );
    assert_eq!(
        std::fs::read_to_string(profile.join("credentials.json")).unwrap(),
        credential.to_string()
    );
    assert!(
        first
            .receipts
            .iter()
            .any(|receipt| receipt.ownership_confirmed)
    );
}

#[test]
fn original_results_cannot_be_removed_until_later_reuse_references_are_undone() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let first = prepare(root.path(), &store, &profile, true);
    let first = run(&store, &profile, &first, false);
    let second = prepare(root.path(), &store, &profile, false);
    let second = run(&store, &profile, &second, false);
    std::fs::write(
        profile.join("migrations/.reuse-index.json"),
        "{\"jobs\":{}}",
    )
    .unwrap();
    let blocked = run(&store, &profile, &first, true);
    assert_eq!(blocked.status, MigrationJobStatus::RollbackConflict);
    assert!(
        blocked
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .all(|action| action.error.as_deref() == Some("migration_result_referenced"))
    );
    run(&store, &profile, &second, true);
    let undone = run(&store, &profile, &blocked, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
}

#[test]
fn target_edits_after_planning_prevent_reuse_without_any_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let first = prepare(root.path(), &store, &profile, true);
    run(&store, &profile, &first, false);
    let second = prepare(root.path(), &store, &profile, false);
    let item = second
        .inventory
        .items
        .iter()
        .find(|item| item.preview.category == MigrationCategory::Skill)
        .unwrap();
    let name = kcoder_migration::batch::proposed_name(&second, item).unwrap();
    let path = profile.join("skills").join(name).join("SKILL.md");
    let edited = format!(
        "{}\nUSER_EDIT_MUST_SURVIVE",
        std::fs::read_to_string(&path).unwrap()
    );
    std::fs::write(&path, &edited).unwrap();
    let observed = run(&store, &profile, &second, false);
    assert_eq!(observed.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        observed
            .inventory
            .items
            .iter()
            .filter(|item| item.preview.status == ItemStatus::Skipped)
            .count(),
        3
    );
    assert!(
        observed
            .inventory
            .items
            .iter()
            .any(|item| item.preview.status == ItemStatus::Failed)
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
}

#[test]
fn changed_source_is_reported_as_an_update_instead_of_silently_reusing_old_content() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let first = prepare(root.path(), &store, &profile, true);
    let first = run(&store, &profile, &first, false);
    let item = first
        .inventory
        .items
        .iter()
        .find(|item| item.preview.category == MigrationCategory::Skill)
        .unwrap();
    let target = profile
        .join("skills")
        .join(kcoder_migration::batch::proposed_name(&first, item).unwrap())
        .join("SKILL.md");
    let original = std::fs::read_to_string(&target).unwrap();
    std::fs::write(
        root.path().join("source/skills/report/SKILL.md"),
        "---\nname: report\n---\nNew source version",
    )
    .unwrap();
    let error = prepare_result(root.path(), &store, &profile, false).unwrap_err();
    assert_eq!(error.to_string(), "migration_source_updated");
    assert_eq!(std::fs::read_to_string(target).unwrap(), original);
}
