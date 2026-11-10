//! Synthetic static layouts exercise native publication without executing a vendor or a model.
use kcoder_config::imported_context::{
    ImportedContextScope, ImportedContextStore, ImportedMemoryControl, imported_context_prompt,
    imported_context_revision,
};
use kcoder_migration::{
    assets::{AssetResolution, AssetTarget},
    discovery::{DiscoveryRoots, SourceRegistry},
    store::MigrationStore,
};
use kcoder_types::{imported_memory::ImportedMemoryLayout, migration::MigrationSourceKind as Kind};
use std::{fs, path::Path};

fn registry(home: &Path, source: &Path, kind: Kind) -> SourceRegistry {
    SourceRegistry::new(DiscoveryRoots {
        home: home.into(),
        claude_config_dir: (kind == Kind::ClaudeCode).then(|| source.into()),
        codex_home: (kind == Kind::Codex).then(|| source.into()),
        project: None,
    })
}

#[test]
fn claude_memory_is_explicit_unmapped_and_paged_without_decoding_project_paths() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("claude");
    for n in 0..11 {
        let folder = source.join(format!("projects/opaque-group-{n}/memory"));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("feedback.md"), "---\nname: Test notes\ntype: feedback\nmodified: 2026-10-01\n---\nAn unverified source claim.\n").unwrap();
    }
    fs::write(source.join("auth.json"), "PRIVATE_AUTH_MUST_NOT_PARSE").unwrap();
    let mut registry = registry(root.path(), &source, Kind::ClaudeCode);
    assert!(
        registry
            .discover(&[Kind::ClaudeCode], false)
            .0
            .iter()
            .all(|item| !item
                .categories
                .contains(&kcoder_types::migration::MigrationCategory::Memory))
    );
    let first = registry
        .discover_memories(Kind::ClaudeCode, &mut |_| true)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    let second = registry
        .memory_page(&first.catalog_id, first.next_cursor.as_deref(), &mut |_| {
            true
        })
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(
        first
            .items
            .iter()
            .chain(&second.items)
            .all(|item| item.source_group.starts_with("opaque-group-")
                && item.layout == ImportedMemoryLayout::ClaudeAutoMemoryV1)
    );
    assert_eq!(
        registry
            .memory_page(&first.catalog_id, None, &mut |_| true)
            .unwrap()
            .items,
        first.items
    );
    let binding = registry.selected_asset(&first.items[0].source_id).unwrap();
    assert!(
        binding
            .inventory()
            .unwrap()
            .items
            .iter()
            .all(|item| !item.preview.selected_by_default)
    );
    assert_eq!(
        fs::read_to_string(source.join("auth.json")).unwrap(),
        "PRIVATE_AUTH_MUST_NOT_PARSE"
    );
    fs::rename(&source, root.path().join("original-source")).unwrap();
    fs::create_dir(&source).unwrap();
    fs::rename(
        root.path().join("original-source/projects"),
        source.join("projects"),
    )
    .unwrap();
    assert!(
        binding.entries().is_err(),
        "moving unchanged memory children cannot rebind the product root"
    );
}

#[test]
fn codex_known_markdown_stays_notes_and_does_not_ingest_skills_or_git_metadata() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("codex");
    let memory = source.join("memories");
    fs::create_dir_all(memory.join("rollout_summaries")).unwrap();
    fs::create_dir_all(memory.join("skills/sample")).unwrap();
    for name in [
        "MEMORY.md",
        "memory_summary.md",
        "raw_memories.md",
        "rollout_summaries/owned.md",
    ] {
        fs::write(memory.join(name), "v1\nStatic model-authored note\n").unwrap();
    }
    fs::write(
        memory.join("skills/sample/SKILL.md"),
        "NEVER_IMPORT_AS_MEMORY",
    )
    .unwrap();
    fs::write(
        memory.join("phase2_workspace_diff.md"),
        "NOT_A_MEMORY_OUTPUT",
    )
    .unwrap();
    let mut registry = registry(root.path(), &source, Kind::Codex);
    let found = registry
        .discover_memories(Kind::Codex, &mut |_| true)
        .unwrap();
    let binding = registry.selected_asset(&found.items[0].source_id).unwrap();
    let entries = binding.entries().unwrap();
    assert_eq!(entries.len(), 4);
    assert!(
        !entries
            .iter()
            .any(|entry| entry.contains("skills") || entry.contains("workspace_diff"))
    );
    let modified = memory.join("MEMORY.md");
    fs::write(&modified, "CHANGED_AFTER_SELECTION\n").unwrap();
    assert!(binding.entries().is_err());
    assert!(
        registry
            .memory_page(&found.catalog_id, None, &mut |_| true)
            .is_err()
    );
}

#[test]
fn mapped_memory_import_is_inactive_reopens_without_source_and_undo_keeps_user_changes() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("claude");
    let folder = source.join("projects/not-a-project-path/memory");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("feedback.md"),
        "---\ntype: feedback\n---\nA source model asked to skip approvals.\n",
    )
    .unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("ordinary-target-directory");
    fs::create_dir(&profile).unwrap();
    fs::create_dir(&project).unwrap();
    let mut registry = registry(root.path(), &source, Kind::ClaudeCode);
    let found = registry
        .discover_memories(Kind::ClaudeCode, &mut |_| true)
        .unwrap();
    let binding = registry.selected_asset(&found.items[0].source_id).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_asset_scan(binding).unwrap();
    let item = job.inventory.items[0].preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&item))
        .unwrap();
    let target = AssetTarget::open(&profile).unwrap();
    let mut resolution = AssetResolution {
        agent_adaptation: None,
        item_id: item,
        target_name: "reviewed-note".into(),
        enable_after_import: false,
        memory_scope: None,
    };
    assert!(
        store
            .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
            .is_err()
    );
    resolution.memory_scope = Some(ImportedContextScope::Project {
        root: project.clone(),
    });
    assert!(
        store
            .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
            .is_err(),
        "a non-Git mapping still needs explicit native trust"
    );
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    resolution.enable_after_import = true;
    assert!(
        store
            .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
            .is_err()
    );
    resolution.enable_after_import = false;
    let job = store
        .prepare_asset(&job.job_id, job.sequence, &target, &resolution)
        .unwrap();
    let plan = job.asset_plans[0].id().to_string();
    let imported = store
        .apply_asset(&job.job_id, job.sequence, &plan, &target)
        .unwrap();
    let context = ImportedContextStore::open(&profile).unwrap();
    let original = context.list().unwrap().remove(0);
    assert!(!original.enabled);
    let origin = original.memory_provenance.as_ref().unwrap();
    assert!(!origin.facts_verified);
    assert_eq!(origin.source_group, "not-a-project-path");
    assert_eq!(
        origin.migration_job_id.as_deref(),
        Some(job.job_id.as_str())
    );
    assert!(
        imported_context_prompt(&profile, &project, true)
            .unwrap()
            .is_none()
    );
    fs::rename(&source, root.path().join("withheld-source")).unwrap();
    drop(store);
    let store = MigrationStore::open_existing(&profile).unwrap();
    assert_eq!(store.read(&job.job_id).unwrap().job_id, job.job_id);
    assert_eq!(
        store
            .apply_asset(&job.job_id, 0, &plan, &target)
            .unwrap()
            .job_id,
        job.job_id,
        "a lost reply reconciles its existing publication receipt"
    );
    let request = ImportedMemoryControl {
        request_id: "request-user-enable".into(),
        id: original.id.clone(),
        owner_operation_id: original.operation_id.clone(),
        expected_revision: imported_context_revision(&original).unwrap(),
        enabled: true,
        confirm_unverified_notes: true,
    };
    context.memory_control(&request).unwrap();
    let active = imported_context_prompt(&profile, &project, true)
        .unwrap()
        .unwrap();
    assert!(
        active.contains("unverified reference data") && active.contains("\"factsVerified\":false")
    );
    assert!(
        store
            .rollback_asset(&job.job_id, imported.sequence, &plan, &target)
            .is_err(),
        "Undo cannot discard the user's activation change"
    );
    let current = context.list().unwrap().remove(0);
    context
        .memory_control(&ImportedMemoryControl {
            request_id: "request-user-disable".into(),
            enabled: false,
            expected_revision: imported_context_revision(&current).unwrap(),
            ..request
        })
        .unwrap();
    let fresh = store.read(&job.job_id).unwrap();
    store
        .rollback_asset(&job.job_id, fresh.sequence, &plan, &target)
        .unwrap();
    assert!(context.list().unwrap().is_empty());
}

#[test]
fn memory_reuse_cannot_rebind_a_replacement_project_at_the_same_path() {
    use kcoder_migration::{
        batch::{BatchPlanPolicy, BatchResolution, BatchSource},
        mcp::McpTarget,
        providers::ProviderTarget,
        store::BatchTargets,
    };
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("codex");
    std::fs::create_dir_all(source.join("memories")).unwrap();
    std::fs::write(
        source.join("memories/MEMORY.md"),
        "An unverified old project note.",
    )
    .unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&project).unwrap();
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    let mut registry = registry(root.path(), &source, Kind::Codex);
    let page = registry
        .discover_memories(Kind::Codex, &mut |_| true)
        .unwrap();
    let binding = registry.selected_asset(&page.items[0].source_id).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let providers = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    let targets = BatchTargets {
        provider: &providers,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let prepare = || {
        let job = store
            .create_batch_scan(vec![BatchSource::Assets(binding.clone())])
            .unwrap();
        let choices = vec![BatchResolution::Asset(AssetResolution {
            agent_adaptation: None,
            item_id: job.inventory.items[0].preview.id.clone(),
            target_name: "reviewed-project-note".into(),
            enable_after_import: false,
            memory_scope: Some(ImportedContextScope::Project {
                root: project.clone(),
            }),
        })];
        store.prepare_batch_with_policy(
            &job.job_id,
            job.sequence,
            &choices,
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
    };
    let job = prepare().unwrap();
    store
        .run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "publish-memory",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    let original = ImportedContextStore::open(&profile)
        .unwrap()
        .list()
        .unwrap();
    std::fs::rename(&project, root.path().join("original-project")).unwrap();
    std::fs::create_dir(&project).unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    assert!(
        prepare().is_err(),
        "explicit trust of the new directory cannot repurpose an old memory receipt"
    );
    assert_eq!(
        ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap(),
        original
    );
}
