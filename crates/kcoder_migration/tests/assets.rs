use kcoder_config::imported_context::{ImportedContextScope, ImportedContextStore};
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    discovery::{DiscoveryRoots, SourceRegistry},
    store::MigrationStore,
};
use kcoder_types::migration::{
    MigrationCategory as Category, MigrationItemStatus, MigrationSourceKind as Kind,
};
use std::path::Path;

#[path = "assets/imports.rs"]
mod imports;

fn binding(path: &Path, category: Category, directory: bool) -> AssetBundleBinding {
    AssetBundleBinding::capture(
        path,
        Kind::ClaudeCode,
        category,
        ImportedContextScope::Global,
        directory,
    )
    .unwrap()
}

#[test]
fn recursive_commands_preserve_arguments_without_executing_dynamic_templates() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("commands");
    let profile = root.path().join("profile");
    std::fs::create_dir_all(source.join("review")).unwrap();
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(
        source.join("review/api.md"),
        "---\ndescription: Review an API\nargument-hint: module\n---\nReview $1 and $ARGUMENTS.",
    )
    .unwrap();
    std::fs::write(
        source.join("danger.md"),
        "---\nallowed-tools: Bash\n---\nRun !`touch should-never-exist`",
    )
    .unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store
        .create_asset_scan(binding(&source, Category::Command, true))
        .unwrap();
    assert_eq!(job.inventory.items.len(), 2);
    let blocked = job
        .inventory
        .items
        .iter()
        .find(|item| item.preview.source_name == "danger.md")
        .unwrap();
    assert_eq!(blocked.preview.status, MigrationItemStatus::RequiresAction);
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.preview.source_name == "review/api.md")
        .unwrap();
    let target = AssetTarget::open(&profile).unwrap();
    let id = item.preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let job = store
        .prepare_asset(
            &job.job_id,
            job.sequence,
            &target,
            &AssetResolution {
                agent_adaptation: None,
                item_id: id,
                target_name: "review-api".into(),
                enable_after_import: false,
                memory_scope: None,
            },
        )
        .unwrap();
    store
        .apply_asset(&job.job_id, job.sequence, job.asset_plans[0].id(), &target)
        .unwrap();
    let skill =
        kcoder_skills::parse_skill_file(&profile.join("skills/review-api/SKILL.md")).unwrap();
    assert!(
        skill
            .with_arguments(&["payments".into()])
            .contains("Review payments and payments.")
    );
    assert!(!root.path().join("should-never-exist").exists());
}

#[test]
fn source_packages_reject_private_entries_and_hard_links_and_frozen_assets_detect_edits() {
    let root = tempfile::tempdir().unwrap();
    let skill = root.path().join("sample");
    std::fs::create_dir(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: sample\n---\nFixture").unwrap();
    std::fs::write(skill.join(".env.local"), "SYNTHETIC_PRIVATE_FILE_CANARY").unwrap();
    let inventory = binding(root.path(), Category::Skill, true)
        .inventory()
        .unwrap();
    assert!(inventory.items[0].asset.is_none());
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_FILE_CANARY")
    );
    std::fs::remove_file(skill.join(".env.local")).unwrap();
    let (frozen, _) = binding(root.path(), Category::Skill, true)
        .freeze()
        .unwrap();
    std::fs::write(skill.join("SKILL.md"), "Changed").unwrap();
    assert!(frozen.read("sample").is_err());
    std::fs::hard_link(skill.join("SKILL.md"), skill.join("linked.md")).unwrap();
    assert!(
        binding(root.path(), Category::Skill, true)
            .read("sample")
            .is_err()
    );
}

#[test]
fn native_agents_are_referenced_once_and_override_semantics_are_not_flattened() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let profile = root.path().join("profile");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&profile).unwrap();
    let source = project.join("AGENTS.md");
    std::fs::write(&source, "Native constraints").unwrap();
    let bound = || {
        AssetBundleBinding::capture(
            &source,
            Kind::Codex,
            Category::Instructions,
            ImportedContextScope::Project {
                root: project.clone(),
            },
            false,
        )
        .unwrap()
    };
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_asset_scan(bound()).unwrap();
    let id = job.inventory.items[0].preview.id.clone();
    let target = AssetTarget::open(&profile).unwrap();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let job = store
        .prepare_asset(
            &job.job_id,
            job.sequence,
            &target,
            &AssetResolution {
                agent_adaptation: None,
                item_id: id,
                target_name: "AGENTS".into(),
                enable_after_import: false,
                memory_scope: None,
            },
        )
        .unwrap();
    let plan = job.asset_plans[0].id();
    assert!(job.asset_plans[0].native_reference());
    let committed = store
        .apply_asset(&job.job_id, job.sequence, plan, &target)
        .unwrap();
    assert!(
        ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    store
        .rollback_asset(&job.job_id, committed.sequence, plan, &target)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&source).unwrap(),
        "Native constraints"
    );
    std::fs::write(project.join("AGENTS.override.md"), "Different constraints").unwrap();
    assert_eq!(
        bound().inventory().unwrap().items[0].preview.status,
        MigrationItemStatus::RequiresAction
    );
}

#[test]
fn discovery_covers_modern_legacy_skills_and_scoped_instructions_without_auth_reads() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    for directory in [
        ".claude/skills/small",
        ".agents/skills/modern",
        ".codex/skills/legacy",
        "project/.claude/commands",
    ] {
        std::fs::create_dir_all(root.path().join(directory)).unwrap();
    }
    for entry in [
        ".claude/skills/small/SKILL.md",
        ".agents/skills/modern/SKILL.md",
        ".codex/skills/legacy/SKILL.md",
    ] {
        std::fs::write(
            root.path().join(entry),
            "---\nname: fixture\n---\nInstructions",
        )
        .unwrap();
    }
    std::fs::write(root.path().join(".claude/CLAUDE.md"), "Global constraints").unwrap();
    std::fs::write(project.join("CLAUDE.md"), "Project constraints").unwrap();
    std::fs::write(
        root.path().join(".codex/auth.json"),
        "NOT_JSON_DO_NOT_PARSE",
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.path().into(),
        claude_config_dir: None,
        codex_home: None,
        project: Some(project),
    });
    let (sources, problems) = registry.discover(&[], true);
    assert!(problems.is_empty());
    for scope in [
        "user-skills",
        "user-legacy-skills",
        "user-instructions",
        "project-instructions",
    ] {
        assert!(sources.iter().any(|source| source.scope == scope));
    }
    let selected = sources
        .iter()
        .find(|source| source.kind == Kind::ClaudeCode && source.scope == "project-instructions")
        .unwrap();
    let binding = registry.selected_asset(&selected.source_id).unwrap();
    assert!(matches!(
        binding.scope,
        ImportedContextScope::Project { .. }
    ));
}
