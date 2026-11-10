use super::*;
use crate::discovery::{ConfigurationBinding, SourceRegistry};
use kcoder_types::migration::MigrationCategory;
use std::{fs, time::Duration};

fn codex(root: &Path) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("config.toml"), "model = 'fixture-model'\nmodel_provider = 'fixture'\n[model_providers.fixture]\nname = 'Fixture'\nbase_url = 'http://127.0.0.1:1/v1'\nwire_api = 'responses'\n").unwrap();
    fs::write(root.join("auth.json"), "AUTHENTICATION_MUST_NOT_BE_PARSED").unwrap();
}

fn selected_config(registry: &mut SourceRegistry) -> ConfigurationBinding {
    let (found, problems) = registry.discover_with_assets(&[], true, false);
    assert!(problems.is_empty(), "{problems:?}");
    let selected = found.iter().find(|item| item.scope == "user").unwrap();
    registry.selected(&selected.source_id).unwrap()
}

#[test]
fn explicit_product_directory_never_discovers_default_or_other_product_roots() {
    let home = tempfile::tempdir().unwrap();
    let selected = home.path().join("selected");
    codex(&selected);
    codex(&selected.join(".codex"));
    fs::create_dir_all(selected.join(".claude")).unwrap();
    fs::write(
        selected.join(".claude/settings.json"),
        "{\"env\":{\"ANTHROPIC_MODEL\":\"OUTSIDE_SCOPE\"}}",
    )
    .unwrap();
    fs::create_dir_all(selected.join(".agents/skills/outside-product-layout")).unwrap();
    fs::write(
        selected.join(".agents/skills/outside-product-layout/SKILL.md"),
        "---\nname: outside\ndescription: outside\n---\nOutside product layout",
    )
    .unwrap();
    let mut registry =
        SourceRegistry::from_selected_product_directory(&selected, MigrationSourceKind::Codex)
            .unwrap();
    let (found, problems) = registry.discover(&[], true);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, MigrationSourceKind::Codex);
    assert_eq!(found[0].scope, "user");
    let wrong_kind = registry.discover(&[MigrationSourceKind::ClaudeCode], true);
    assert!(wrong_kind.0.is_empty());
    assert_eq!(
        wrong_kind.1[0].code,
        "migration_selected_root_scope_changed"
    );
    assert!(
        registry
            .discover_history(MigrationSourceKind::ClaudeCode, |_| true)
            .is_err()
    );
    let document = registry
        .selected(&found[0].source_id)
        .unwrap()
        .read()
        .unwrap();
    assert!(document.text().contains("fixture-model"));
    assert_eq!(
        fs::read_to_string(selected.join("auth.json")).unwrap(),
        "AUTHENTICATION_MUST_NOT_BE_PARSED"
    );
}

#[test]
fn missing_relative_and_linked_selected_roots_fail_without_fallback() {
    let home = tempfile::tempdir().unwrap();
    codex(&home.path().join(".codex"));
    for path in [
        PathBuf::from("relative"),
        home.path().join("missing"),
        home.path().join(".codex/../.codex"),
    ] {
        assert!(
            SourceRegistry::from_selected_product_directory(&path, MigrationSourceKind::Codex)
                .is_err()
        );
    }
    #[cfg(unix)]
    {
        let link = home.path().join("linked");
        std::os::unix::fs::symlink(home.path().join(".codex"), &link).unwrap();
        assert!(
            SourceRegistry::from_selected_product_directory(&link, MigrationSourceKind::Codex)
                .is_err()
        );
    }
}

#[test]
fn durable_configuration_authority_survives_serialization_but_rejects_root_replacement() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("selected");
    codex(&root);
    let mut registry =
        SourceRegistry::from_selected_product_directory(&root, MigrationSourceKind::Codex).unwrap();
    let binding = selected_config(&mut registry).refreshed().unwrap();
    let encoded = serde_json::to_vec(&binding).unwrap();
    let restored: ConfigurationBinding = serde_json::from_slice(&encoded).unwrap();
    assert!(restored.read().is_ok());
    let moved = home.path().join("previous");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    fs::rename(moved.join("config.toml"), root.join("config.toml")).unwrap();
    assert!(restored.read().is_err());
    assert!(restored.refreshed().is_err());
    let (found, problems) = registry.discover(&[], false);
    assert!(found.is_empty());
    assert_eq!(problems[0].code, "migration_selected_root_unavailable");
}

#[test]
fn durable_asset_cannot_follow_unchanged_child_into_a_replaced_selected_root() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("selected");
    codex(&root);
    fs::create_dir_all(root.join("skills/sample")).unwrap();
    fs::write(
        root.join("skills/sample/SKILL.md"),
        "---\nname: sample\ndescription: Synthetic sample\n---\nKeep this original body.",
    )
    .unwrap();
    let mut registry =
        SourceRegistry::from_selected_product_directory(&root, MigrationSourceKind::Codex).unwrap();
    let (found, problems) = registry.discover(&[], false);
    assert!(problems.is_empty(), "{problems:?}");
    let row = found
        .iter()
        .find(|item| item.categories.contains(&MigrationCategory::Skill))
        .unwrap();
    let binding = registry.selected_asset(&row.source_id).unwrap();
    let restored: crate::asset_sources::AssetBundleBinding =
        serde_json::from_slice(&serde_json::to_vec(&binding).unwrap()).unwrap();
    assert!(restored.read("sample").is_ok());
    let moved = home.path().join("previous");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    fs::rename(moved.join("skills"), root.join("skills")).unwrap();
    assert!(restored.read("sample").is_err());
    assert!(registry.selected_asset(&row.source_id).is_err());
}

#[test]
fn selected_history_uses_the_exact_product_root_and_preserves_its_identity() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("backup-claude");
    let id = "11111111-1111-4111-8111-111111111111";
    let path = root.join(format!("projects/synthetic/{id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("{{\"type\":\"user\",\"uuid\":\"message-1\",\"sessionId\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":\"Synthetic history\"}}}}\n")).unwrap();
    let mut registry =
        SourceRegistry::from_selected_product_directory(&root, MigrationSourceKind::ClaudeCode)
            .unwrap();
    let page = registry
        .discover_history(MigrationSourceKind::ClaudeCode, |_| true)
        .unwrap();
    assert_eq!(page.items.len(), 1);
    let grant = registry
        .history_selection(&page.catalog_id, &page.items[0].source_handle)
        .unwrap();
    assert!(grant.capture(&mut |_, _| true).is_ok());
    let moved = home.path().join("previous");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    fs::rename(moved.join("projects"), root.join("projects")).unwrap();
    assert!(grant.capture(&mut |_, _| true).is_err());
    assert!(
        registry
            .history_page(&page.catalog_id, None, |_| true)
            .is_err()
    );
}

#[test]
fn expired_selection_cannot_renew_itself_by_discovery_or_reopen_other_sources() {
    let root = tempfile::tempdir().unwrap();
    codex(root.path());
    let mut registry =
        SourceRegistry::from_selected_product_directory(root.path(), MigrationSourceKind::Codex)
            .unwrap();
    let binding = selected_config(&mut registry);
    registry.selected_root.as_mut().unwrap().created = Instant::now() - Duration::from_secs(601);
    assert!(registry.discover(&[], true).0.is_empty());
    assert!(
        registry
            .discover_history(MigrationSourceKind::Codex, |_| true)
            .is_err()
    );
    // An already accepted private binding remains usable by its original durable job.
    assert!(binding.read().is_ok());
}

#[test]
fn existing_binding_shape_stays_unchanged_without_an_explicit_directory_grant() {
    let root = tempfile::tempdir().unwrap();
    codex(root.path());
    let binding = ConfigurationBinding::capture_selected(
        &root.path().join("config.toml"),
        MigrationSourceKind::Codex,
    )
    .unwrap();
    let value = serde_json::to_value(&binding).unwrap();
    assert!(value.get("selectedRoot").is_none());
    let restored: ConfigurationBinding = serde_json::from_value(value).unwrap();
    assert!(restored.read().is_ok());
}

#[test]
fn explicitly_authorized_project_layers_keep_the_original_user_directory_grant() {
    let home = tempfile::tempdir().unwrap();
    let user = home.path().join("selected-codex");
    codex(&user);
    let project = home.path().join("separately-authorized-project");
    fs::create_dir_all(project.join(".codex")).unwrap();
    fs::create_dir(project.join(".git")).unwrap();
    fs::write(
        project.join(".codex/config.toml"),
        "model = 'project-model'\n",
    )
    .unwrap();
    let mut registry =
        SourceRegistry::from_selected_product_directory(&user, MigrationSourceKind::Codex).unwrap();
    let (found, _) = registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
    let derived = registry
        .select_codex_layers(&found[0].source_id, &project, &project)
        .unwrap();
    let binding = registry
        .selected(&derived.source.source_id)
        .unwrap()
        .refreshed()
        .unwrap();
    assert!(binding.read().unwrap().text().contains("project-model"));
    assert!(
        serde_json::to_value(&binding)
            .unwrap()
            .get("selectedRoot")
            .is_some()
    );
    let saved = binding.codex_layer_snapshot_report().unwrap();
    assert!(saved.is_some());
    let moved = home.path().join("previous");
    fs::rename(&user, &moved).unwrap();
    fs::create_dir(&user).unwrap();
    fs::rename(moved.join("config.toml"), user.join("config.toml")).unwrap();
    assert!(binding.read().is_err());
    assert!(binding.refreshed().is_err());
    assert!(binding.codex_layer_report().is_err());
    assert_eq!(binding.codex_layer_snapshot_report().unwrap(), saved);
}
