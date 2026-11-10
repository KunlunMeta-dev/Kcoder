use super::*;

fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("project");
    let profile = root.path().join("profile");
    std::fs::create_dir_all(source.join("docs/nested")).unwrap();
    std::fs::create_dir(&profile).unwrap();
    (root, source, profile)
}

fn selected(source: &Path) -> AssetBundleBinding {
    AssetBundleBinding::capture(
        &source.join("CLAUDE.md"),
        Kind::ClaudeCode,
        Category::Instructions,
        ImportedContextScope::Project {
            root: source.into(),
        },
        false,
    )
    .unwrap()
}

#[test]
fn static_instruction_imports_publish_as_one_owned_scoped_context_and_undo_without_sources() {
    let (_root, source, profile) = setup();
    std::fs::write(source.join("CLAUDE.md"), "Before\n@docs/style.md\nAfter").unwrap();
    std::fs::write(source.join("docs/style.md"), "Use Rust.\n@nested/checks.md").unwrap();
    std::fs::write(source.join("docs/nested/checks.md"), "Run offline checks.").unwrap();
    let (binding, inventory) = selected(&source).freeze().unwrap();
    assert_eq!(inventory.items.len(), 1);
    let item = &inventory.items[0];
    assert!(item.preview.issues.is_empty());
    assert_eq!(item.asset.as_ref().unwrap().files, 3);
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_asset_scan(binding).unwrap();
    let id = job.inventory.items[0].preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = AssetTarget::open(&profile).unwrap();
    let job = store
        .prepare_asset(
            &job.job_id,
            job.sequence,
            &target,
            &AssetResolution {
                agent_adaptation: None,
                item_id: id,
                target_name: "project-guidance".into(),
                enable_after_import: false,
                memory_scope: None,
            },
        )
        .unwrap();
    let plan_id = job.asset_plans[0].id().to_owned();
    let original = store
        .asset_snapshot(&job.job_id, &job.inventory.items[0].preview.id)
        .unwrap()
        .unwrap();
    assert!(original.contains("@docs/style.md"));
    assert!(original.contains("@nested/checks.md"));
    assert!(original.contains("Run offline checks."));
    let job = store
        .apply_asset(&job.job_id, job.sequence, &plan_id, &target)
        .unwrap();
    drop(store);
    let records = ImportedContextStore::open(&profile)
        .unwrap()
        .list()
        .unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert!(!record.enabled);
    assert_eq!(
        record.scope,
        ImportedContextScope::Project {
            root: source.clone()
        }
    );
    let content = &record.content;
    assert!(content.find("Before").unwrap() < content.find("Use Rust.").unwrap());
    assert!(content.find("Use Rust.").unwrap() < content.find("Run offline checks.").unwrap());
    assert!(content.find("Run offline checks.").unwrap() < content.find("After").unwrap());
    assert!(content.contains("source: docs/style.md"));
    assert!(!content.contains("@docs/"));
    std::fs::remove_dir_all(&source).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    assert_eq!(
        store
            .asset_snapshot(&job.job_id, &job.inventory.items[0].preview.id)
            .unwrap()
            .unwrap(),
        original
    );
    store
        .rollback_asset(&job.job_id, job.sequence, &plan_id, &target)
        .unwrap();
    assert!(
        ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn imported_dependencies_are_frozen_including_changed_missing_and_new_transitive_imports() {
    let (_root, source, _profile) = setup();
    std::fs::write(source.join("CLAUDE.md"), "@docs/style.md").unwrap();
    std::fs::write(source.join("docs/style.md"), "Original instructions").unwrap();
    let (binding, _) = selected(&source).freeze().unwrap();
    std::fs::write(source.join("docs/style.md"), "Changed instructions").unwrap();
    assert!(binding.read("CLAUDE.md").is_err());
    std::fs::write(source.join("docs/style.md"), "@nested/checks.md").unwrap();
    std::fs::write(source.join("docs/nested/checks.md"), "New dependency").unwrap();
    assert!(binding.read("CLAUDE.md").is_err());
    std::fs::remove_file(source.join("docs/style.md")).unwrap();
    assert!(binding.read("CLAUDE.md").is_err());
}

#[test]
fn changed_import_after_prepare_blocks_publication_without_touching_source_or_target() {
    let (_root, source, profile) = setup();
    let original = "@docs/style.md";
    std::fs::write(source.join("CLAUDE.md"), original).unwrap();
    std::fs::write(source.join("docs/style.md"), "Original guidance").unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_asset_scan(selected(&source)).unwrap();
    let id = job.inventory.items[0].preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = AssetTarget::open(&profile).unwrap();
    let job = store
        .prepare_asset(
            &job.job_id,
            job.sequence,
            &target,
            &AssetResolution {
                agent_adaptation: None,
                item_id: id,
                target_name: "frozen-guidance".into(),
                enable_after_import: false,
                memory_scope: None,
            },
        )
        .unwrap();
    std::fs::write(source.join("docs/style.md"), "New guidance").unwrap();
    let error = store
        .apply_asset(&job.job_id, job.sequence, job.asset_plans[0].id(), &target)
        .unwrap_err();
    assert!(error.to_string().contains("migration_source_changed"));
    assert!(
        ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(source.join("CLAUDE.md")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read_to_string(source.join("docs/style.md")).unwrap(),
        "New guidance"
    );
}

#[test]
fn unsafe_dynamic_conditional_cyclic_and_unmapped_imports_do_not_become_compatible() {
    let (_root, source, _profile) = setup();
    std::fs::write(source.join("docs/style.md"), "Simple guidance").unwrap();
    for text in [
        "@../outside.md",
        "@/outside.md",
        "@~/.claude/notes.md",
        "@C:/notes.md",
        "@docs/missing.md",
        "@docs/style.md extra",
        "See @docs/style.md",
        "@docs/a\\ b.md",
        "@docs/style.md\n@CLAUDE.md",
        "@.private/notes.md",
        "@docs/../auth.md",
        "@docs/settings.json",
    ] {
        std::fs::write(source.join("CLAUDE.md"), text).unwrap();
        let inventory = selected(&source).inventory().unwrap();
        assert_eq!(
            inventory.items[0].preview.status,
            MigrationItemStatus::RequiresAction,
            "{text}"
        );
        assert!(!inventory.items[0].preview.selected_by_default);
    }
    std::fs::write(source.join("CLAUDE.md"), "@docs/style.md").unwrap();
    std::fs::write(
        source.join("docs/style.md"),
        "---\npaths: ['src/**']\n---\nScoped only.",
    )
    .unwrap();
    assert_eq!(
        selected(&source).inventory().unwrap().items[0]
            .preview
            .status,
        MigrationItemStatus::RequiresAction
    );
    std::fs::write(
        source.join("CLAUDE.md"),
        "---\npaths: ['src/**']\n---\n@missing.md",
    )
    .unwrap();
    let inventory = selected(&source).inventory().unwrap();
    assert!(inventory.items[0].asset.is_some());
    assert_eq!(
        inventory.items[0].preview.status,
        MigrationItemStatus::RequiresAction
    );
}

#[test]
fn literal_import_examples_in_markdown_code_stay_literal() {
    let (_root, source, _profile) = setup();
    let text = "Literal `@does-not-exist.md` and mail@example.invalid.\n\n```md\n@missing.md\n```\n\n    @indented-code.md\n";
    std::fs::write(source.join("CLAUDE.md"), text).unwrap();
    let (binding, inventory) = selected(&source).freeze().unwrap();
    assert!(inventory.items[0].preview.issues.is_empty());
    assert_eq!(binding.read("CLAUDE.md").unwrap().files.len(), 1);
}

#[test]
fn utf8_bom_crlf_unicode_and_contained_parent_paths_keep_the_same_dependency() {
    let (_root, source, _profile) = setup();
    std::fs::write(source.join("CLAUDE.md"), "\u{feff}@./docs/规范.md\r\n").unwrap();
    std::fs::write(source.join("docs/规范.md"), "@../docs/style.md\r\n").unwrap();
    std::fs::write(source.join("docs/style.md"), "Unicode guidance").unwrap();
    let (binding, inventory) = selected(&source).freeze().unwrap();
    assert!(inventory.items[0].preview.issues.is_empty());
    assert_eq!(binding.read("CLAUDE.md").unwrap().files.len(), 3);
}

#[test]
fn a_shared_dependency_is_rechecked_when_reached_at_a_stricter_depth() {
    let (_root, source, _profile) = setup();
    std::fs::write(source.join("CLAUDE.md"), "@docs/shared.md\n@docs/chain.md").unwrap();
    std::fs::write(source.join("docs/shared.md"), "@leaf.md").unwrap();
    std::fs::write(source.join("docs/leaf.md"), "Shared leaf").unwrap();
    std::fs::write(source.join("docs/chain.md"), "@nested/chain.md").unwrap();
    std::fs::write(source.join("docs/nested/chain.md"), "@more.md").unwrap();
    std::fs::write(source.join("docs/nested/more.md"), "@../shared.md").unwrap();
    assert_eq!(
        selected(&source).inventory().unwrap().items[0]
            .preview
            .status,
        MigrationItemStatus::RequiresAction
    );
}

#[test]
fn import_depth_and_unique_source_bytes_are_bounded() {
    let (_root, source, _profile) = setup();
    std::fs::write(source.join("CLAUDE.md"), "@docs/0.md").unwrap();
    for index in 0..4 {
        let text = if index == 3 {
            "Depth four accepted".into()
        } else {
            format!("@{}.md", index + 1)
        };
        std::fs::write(source.join(format!("docs/{index}.md")), text).unwrap();
    }
    assert!(
        selected(&source).inventory().unwrap().items[0]
            .preview
            .issues
            .is_empty()
    );
    std::fs::write(source.join("docs/3.md"), "@4.md").unwrap();
    std::fs::write(source.join("docs/4.md"), "Too deep").unwrap();
    assert_eq!(
        selected(&source).inventory().unwrap().items[0]
            .preview
            .status,
        MigrationItemStatus::RequiresAction
    );
    std::fs::write(source.join("CLAUDE.md"), "@docs/0.md\n@docs/1.md").unwrap();
    std::fs::write(source.join("docs/0.md"), "a".repeat(2 * 1024 * 1024)).unwrap();
    std::fs::write(source.join("docs/1.md"), "b".repeat(2 * 1024 * 1024)).unwrap();
    assert_eq!(
        selected(&source).inventory().unwrap().items[0]
            .preview
            .status,
        MigrationItemStatus::RequiresAction
    );
}

#[test]
#[cfg(unix)]
fn imports_refuse_symlinks_hardlinks_and_linked_parent_directories() {
    use std::os::unix::fs::symlink;
    let (root, source, _profile) = setup();
    let outside = root.path().join("outside.md");
    std::fs::write(&outside, "SYNTHETIC_PRIVATE_IMPORT_CANARY").unwrap();
    std::fs::write(source.join("CLAUDE.md"), "@docs/style.md").unwrap();
    symlink(&outside, source.join("docs/style.md")).unwrap();
    let inventory = selected(&source).inventory().unwrap();
    assert_eq!(
        inventory.items[0].preview.status,
        MigrationItemStatus::RequiresAction
    );
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_IMPORT_CANARY")
    );
    std::fs::remove_file(source.join("docs/style.md")).unwrap();
    std::fs::hard_link(&outside, source.join("docs/style.md")).unwrap();
    assert!(
        selected(&source).inventory().unwrap().items[0]
            .asset
            .is_none()
    );
    std::fs::remove_dir_all(source.join("docs")).unwrap();
    symlink(root.path(), source.join("docs")).unwrap();
    std::fs::write(source.join("CLAUDE.md"), "@docs/outside.md").unwrap();
    assert!(
        selected(&source).inventory().unwrap().items[0]
            .asset
            .is_none()
    );
}
