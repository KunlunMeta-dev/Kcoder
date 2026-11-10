use super::*;
use std::fs;

const BASE: &str = r#"
model = 'base-model'
model_provider = 'Custom'
model_context_window = 128000
[model_providers.Custom]
base_url = 'https://example.invalid/v1'
wire_api = 'responses'
env_key = 'MIGRATION_PROFILE_FIXTURE_KEY'
[mcp_servers.documents]
command = 'never-execute-this-profile-fixture'
args = ['base']
"#;

fn registry(root: &Path) -> SourceRegistry {
    SourceRegistry::new(DiscoveryRoots {
        home: root.into(),
        claude_config_dir: None,
        codex_home: Some(root.into()),
        project: None,
    })
}
fn provider(binding: &ConfigurationBinding) -> crate::ProviderCandidate {
    binding
        .inventory()
        .unwrap()
        .items
        .into_iter()
        .find_map(|item| item.provider)
        .unwrap()
}

#[test]
fn current_profile_files_inherit_only_their_base_and_keep_distinct_source_identities() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.toml"), BASE).unwrap();
    fs::write(
        root.path().join("analysis.config.toml"),
        "model='analysis-model'\n[mcp_servers.documents]\nargs=['analysis']",
    )
    .unwrap();
    fs::write(
        root.path().join("writing.config.toml"),
        "model='writing-model'",
    )
    .unwrap();
    fs::write(
        root.path().join("auth.json"),
        "invalid authentication file; never read",
    )
    .unwrap();
    let before = fs::read(root.path().join("config.toml")).unwrap();
    let mut registry = registry(root.path());
    let (found, problems) =
        registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(found.len(), 3);
    let mut identities = std::collections::BTreeSet::new();
    for (label, model, arguments) in [
        ("Codex", "base-model", "base"),
        ("Codex · analysis.config.toml", "analysis-model", "analysis"),
        ("Codex · writing.config.toml", "writing-model", "base"),
    ] {
        let source = found
            .iter()
            .find(|source| source.display_name == label)
            .unwrap();
        let binding = registry.selected(&source.source_id).unwrap();
        assert!(identities.insert(binding.logical_identity()));
        let parsed = binding.inventory().unwrap();
        let connection = provider(&binding);
        assert_eq!(connection.model.as_deref(), Some(model));
        assert_eq!(
            connection.endpoint.as_deref(),
            Some("https://example.invalid/v1")
        );
        assert_eq!(connection.context_window_tokens, Some(128000));
        let mcp = parsed
            .items
            .iter()
            .find_map(|item| item.mcp.as_ref())
            .unwrap();
        assert_eq!(mcp.config.command, "never-execute-this-profile-fixture");
        assert_eq!(mcp.config.args, [arguments]);
        if label != "Codex" {
            assert_eq!(source.format_revision, "codex-profile-file/v1");
            assert!(
                parsed
                    .items
                    .iter()
                    .any(|item| item.preview.issues.iter().any(|issue| {
                        issue.field.as_deref() == Some("session_template")
                            && issue.phase == MigrationIssuePhase::Activation
                    }))
            );
        }
    }
    assert_eq!(fs::read(root.path().join("config.toml")).unwrap(), before);
}

#[test]
fn legacy_and_current_profiles_never_alias_or_silently_select_the_legacy_default() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("config.toml"),
        format!("profile='review'\n{BASE}\n[profiles.review]\nmodel='legacy-model'"),
    )
    .unwrap();
    fs::write(
        root.path().join("review.config.toml"),
        "model='current-model'",
    )
    .unwrap();
    let mut registry = registry(root.path());
    let (found, problems) =
        registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(found.len(), 3);
    let mut identities = std::collections::BTreeSet::new();
    for (label, model) in [
        ("Codex", "base-model"),
        ("Codex · profiles.review", "legacy-model"),
        ("Codex · review.config.toml", "current-model"),
    ] {
        let source = found
            .iter()
            .find(|source| source.display_name == label)
            .unwrap();
        let binding = registry.selected(&source.source_id).unwrap();
        assert!(identities.insert(binding.logical_identity()));
        assert_eq!(provider(&binding).model.as_deref(), Some(model));
        let persisted = serde_json::to_vec(&binding).unwrap();
        let reopened: ConfigurationBinding = serde_json::from_slice(&persisted).unwrap();
        assert_eq!(reopened, binding);
        assert_eq!(provider(&reopened), provider(&binding));
        assert_eq!(provider(&reopened.refreshed().unwrap()), provider(&binding));
        if label.contains("profiles.") {
            assert_eq!(source.format_revision, "codex-profile-table/v1");
        }
    }
}

#[test]
fn every_contributing_file_and_even_base_absence_are_bound_to_the_preview() {
    for change in [
        "base_changed",
        "base_removed",
        "base_created",
        "profile_changed",
    ] {
        let root = tempfile::tempdir().unwrap();
        if change != "base_created" {
            fs::write(root.path().join("config.toml"), BASE).unwrap();
        }
        let path = root.path().join("review.config.toml");
        fs::write(&path, "model='profile-model'").unwrap();
        let binding =
            ConfigurationBinding::capture_selected(&path, MigrationSourceKind::Codex).unwrap();
        assert_eq!(provider(&binding).model.as_deref(), Some("profile-model"));
        match change {
            "base_removed" => fs::remove_file(root.path().join("config.toml")).unwrap(),
            "profile_changed" => fs::write(path, "model='changed'").unwrap(),
            _ => fs::write(
                root.path().join("config.toml"),
                format!("# changed\n{BASE}"),
            )
            .unwrap(),
        }
        assert!(binding.read().is_err(), "{change}");
        let reopened: ConfigurationBinding =
            serde_json::from_slice(&serde_json::to_vec(&binding).unwrap()).unwrap();
        assert!(reopened.inventory().is_err(), "{change}");
    }
}

#[test]
fn project_directories_do_not_grant_user_profile_routing() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir_all(project.join(".codex")).unwrap();
    fs::write(
        project.join(".codex/config.toml"),
        format!("{BASE}\n[profiles.review]\nmodel='legacy'"),
    )
    .unwrap();
    fs::write(
        project.join(".codex/review.config.toml"),
        "model='must-not-load'",
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.path().into(),
        claude_config_dir: None,
        codex_home: None,
        project: Some(project),
    });
    let (found, problems) =
        registry.discover_with_assets(&[MigrationSourceKind::Codex], true, false);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(found.len(), 1);
    let inventory = registry
        .selected(&found[0].source_id)
        .unwrap()
        .inventory()
        .unwrap();
    for item in inventory
        .items
        .iter()
        .filter(|item| item.provider.is_some())
    {
        assert!(
            item.preview
                .issues
                .iter()
                .any(
                    |issue| issue.field.as_deref() == Some("project_provider_scope")
                        && issue.blocks_import()
                )
        );
    }
}

#[test]
fn unsupported_profile_names_and_secret_labels_never_enter_public_inventory() {
    const CANARY: &str = "SYNTHETIC_PRIVATE_PROFILE_CANARY";
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("config.toml"),
        format!("{BASE}\n[profiles.{CANARY}]\nexperimental_bearer_token='{CANARY}'"),
    )
    .unwrap();
    fs::write(
        root.path().join(format!("{CANARY}.config.toml")),
        format!("model='fixture'\nexperimental_bearer_token='{CANARY}'"),
    )
    .unwrap();
    for name in [".config.toml", "bad.name.config.toml"] {
        let path = root.path().join(name);
        fs::write(&path, "model='fixture'").unwrap();
        assert!(SourceDocument::read_selected_configuration(&path).is_err());
    }
    let mut registry = registry(root.path());
    let (found, problems) =
        registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
    assert_eq!(found.len(), 1);
    assert!(!problems.is_empty());
    assert!(!format!("{found:?} {problems:?}").contains(CANARY));
    let inventory = registry
        .selected(&found[0].source_id)
        .unwrap()
        .inventory()
        .unwrap();
    assert!(!serde_json::to_string(&inventory).unwrap().contains(CANARY));
}

#[cfg(unix)]
#[test]
fn linked_profiles_or_base_layers_are_rejected_without_losing_safe_sources() {
    for link_base in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("source"), BASE).unwrap();
        fs::write(root.path().join("review.config.toml"), "model='review'").unwrap();
        let linked = if link_base {
            "config.toml"
        } else {
            "linked.config.toml"
        };
        std::os::unix::fs::symlink(external.path().join("source"), root.path().join(linked))
            .unwrap();
        let mut registry = registry(root.path());
        let (found, problems) =
            registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
        assert!(!problems.is_empty());
        assert_eq!(found.len(), usize::from(!link_base));
        assert_eq!(
            fs::read_to_string(external.path().join("source")).unwrap(),
            BASE
        );
    }
}

#[test]
fn secrets_from_overridden_or_removed_fields_still_redact_the_public_projection() {
    const CANARY: &str = "SYNTHETIC_OVERRIDDEN_SOURCE_SECRET";
    for legacy in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let base = format!(
            "model='{CANARY}'\nmodel_provider='Office'\nexperimental_bearer_token='{CANARY}'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n[mcp_servers.docs]\ncommand='{CANARY}'\n"
        );
        if legacy {
            fs::write(
                root.path().join("config.toml"),
                format!("{base}\n[profiles.review]\nexperimental_bearer_token=''\n"),
            )
            .unwrap();
        } else {
            fs::write(root.path().join("config.toml"), base).unwrap();
            fs::write(
                root.path().join("review.config.toml"),
                "experimental_bearer_token=''\n",
            )
            .unwrap();
        }
        let mut registry = registry(root.path());
        let (found, problems) =
            registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
        assert!(problems.is_empty(), "{problems:?}");
        for source in found {
            let binding = registry.selected(&source.source_id).unwrap();
            let inventory = binding.inventory().unwrap();
            assert!(!serde_json::to_string(&inventory).unwrap().contains(CANARY));
            assert!(provider(&binding).model.is_none());
            assert!(
                inventory
                    .issues
                    .iter()
                    .any(|issue| issue.code == MigrationIssueCode::SecretExcluded)
            );
        }
    }
}

#[test]
fn excessive_profile_files_are_reported_without_returning_a_truncated_named_catalog() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.toml"), BASE).unwrap();
    for ordinal in 0..=MAX_PROFILES {
        fs::write(
            root.path().join(format!("profile{ordinal}.config.toml")),
            "model='fixture'",
        )
        .unwrap();
    }
    let mut registry = registry(root.path());
    let (found, problems) =
        registry.discover_with_assets(&[MigrationSourceKind::Codex], false, false);
    assert_eq!(found.len(), 1);
    assert!(
        problems
            .iter()
            .any(|problem| problem.code == "migration_profile_discovery_incomplete")
    );
}
