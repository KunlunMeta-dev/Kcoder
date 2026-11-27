use super::*;
struct Fixture {
    _root: tempfile::TempDir,
    user: PathBuf,
    repo: PathBuf,
    cwd: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user");
        let repo = root.path().join("repo");
        let cwd = repo.join("a/b");
        for directory in [&user, &repo.join(".git"), &cwd] {
            std::fs::create_dir_all(directory).unwrap();
        }
        Self {
            _root: root,
            user,
            repo,
            cwd,
        }
    }
    fn write(&self, directory: &Path, text: &str) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("config.toml"), text).unwrap();
    }
    fn capture(&self) -> CodexLayersBinding {
        CodexLayersBinding::capture(&self.user, &self.repo, &self.cwd, None).unwrap()
    }
}
const BASE: &str = include_str!("../../../fixtures/codex-layers/user/config.toml");
#[test]
fn trusted_hierarchy_nearest_model_wins_but_project_auth_and_profile_are_ignored() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    f.write(&f.repo.join(".codex"), "model='root-model'\nmodel_provider='forged'\n[model_providers.forged]\nbase_url='https://forged.invalid/v1'\n");
    f.write(
        &f.cwd.join(".codex"),
        "model='closest-model'\nprofile='forged'\n",
    );
    let binding = f.capture();
    let inventory = binding.inventory().unwrap();
    assert_eq!(inventory.adapter_revision, CODEX_LAYERS_REVISION);
    let provider = inventory
        .items
        .iter()
        .find_map(|item| item.provider.as_ref())
        .unwrap();
    assert_eq!(provider.model.as_deref(), Some("closest-model"));
    assert_eq!(
        provider.endpoint.as_deref(),
        Some("https://example.invalid/v1")
    );
    assert_eq!(
        provider.credential_environment.as_deref(),
        Some("KCODER_CODEX_LAYER_ENV_FIXTURE")
    );
    let report = binding.report().unwrap();
    assert_eq!(report.present, vec![true, true, false, true]);
    assert!(
        report
            .fields
            .iter()
            .any(|field| field.field.as_deref() == Some("/model_provider") && field.ignored)
    );
    assert_eq!(
        report
            .fields
            .iter()
            .find(|field| field.field.as_deref() == Some("/model"))
            .unwrap()
            .layer,
        3
    );
}
#[test]
fn missing_layers_and_root_markers_are_bound_and_never_created_during_read() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    let binding = f.capture();
    assert!(!f.repo.join(".codex").exists());
    binding.read().unwrap();
    assert!(!f.repo.join(".codex").exists());
    f.write(&f.repo.join("a/.codex"), "model='appeared'\n");
    assert_eq!(
        binding.read().unwrap_err().to_string(),
        "migration_source_changed"
    );
    let binding = f.capture();
    std::fs::create_dir(f.repo.join("a/.git")).unwrap();
    assert_eq!(
        binding.read().unwrap_err().to_string(),
        "migration_source_changed"
    );
}
#[test]
fn empty_markers_load_only_cwd_and_custom_or_unconfirmed_roots_fail_explicitly() {
    let f = Fixture::new();
    f.write(&f.user, &format!("{BASE}\n"));
    // Root-routing fields must be top-level TOML, not under a provider table.
    f.write(&f.user, &format!("project_root_markers=[]\n{BASE}"));
    f.write(&f.repo.join(".codex"), "model='must-not-inherit'\n");
    assert_eq!(f.capture().projects.len(), 1);
    f.write(&f.user, &format!("project_root_markers=['custom']\n{BASE}"));
    assert_eq!(
        CodexLayersBinding::capture(&f.user, &f.repo, &f.cwd, None)
            .unwrap_err()
            .to_string(),
        "migration_codex_root_markers_unsupported"
    );
    f.write(&f.user, BASE);
    std::fs::remove_dir(f.repo.join(".git")).unwrap();
    assert_eq!(
        CodexLayersBinding::capture(&f.user, &f.repo, &f.cwd, None)
            .unwrap_err()
            .to_string(),
        "migration_codex_project_root_unconfirmed"
    );
}
#[test]
fn unknown_fields_and_mcp_do_not_gain_execution_or_public_names() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    f.write(&f.cwd.join(".codex"), "PRIVATE_UNKNOWN_KEY_NAME='PRIVATE_UNKNOWN_VALUE'\n[mcp_servers.private]\ncommand='never-execute'\n");
    let binding = f.capture();
    let inventory = binding.inventory().unwrap();
    assert!(!inventory.items.iter().any(|item| item.mcp.is_some()));
    assert!(inventory.issues.iter().any(|issue| issue.code
        == kcoder_types::migration::MigrationIssueCode::UnsupportedField
        && issue.severity == kcoder_types::migration::MigrationIssueSeverity::Blocking));
    assert!(!format!("{:?}", binding.report().unwrap()).contains("PRIVATE_UNKNOWN_KEY_NAME"));
}

#[test]
fn source_untrusted_project_is_rejected_before_reading_any_project_configuration() {
    let f = Fixture::new();
    f.write(
        &f.user,
        &format!(
            "{BASE}\n[projects.{}]\ntrust_level='untrusted'\n",
            serde_json::to_string(f.repo.to_str().unwrap()).unwrap()
        ),
    );
    f.write(&f.cwd.join(".codex"), "THIS IS INTENTIONALLY INVALID TOML");
    assert_eq!(
        CodexLayersBinding::capture(&f.user, &f.repo, &f.cwd, None)
            .unwrap_err()
            .to_string(),
        "migration_codex_project_untrusted"
    );
}
#[test]
fn named_profile_and_project_reasoning_share_existing_template_semantics_and_leaf_origins() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    std::fs::write(f.user.join("review.config.toml"), "model='profile-model'\nmodel_reasoning_effort='high'\n[model_providers.office]\nbase_url='https://profile.invalid/v1'\n").unwrap();
    f.write(&f.cwd.join(".codex"), "model_reasoning_effort='low'\n");
    let profile = ConfigurationBinding::capture_selected(
        &f.user.join("review.config.toml"),
        MigrationSourceKind::Codex,
    )
    .unwrap();
    let binding = CodexLayersBinding::capture(&f.user, &f.repo, &f.cwd, Some(profile)).unwrap();
    let inventory = binding.inventory().unwrap();
    let provider = inventory
        .items
        .iter()
        .find_map(|item| item.provider.as_ref())
        .unwrap();
    assert_eq!(provider.model.as_deref(), Some("profile-model"));
    assert_eq!(
        provider.endpoint.as_deref(),
        Some("https://profile.invalid/v1")
    );
    assert_eq!(
        provider.credential_environment.as_deref(),
        Some("KCODER_CODEX_LAYER_ENV_FIXTURE")
    );
    let template = inventory
        .items
        .iter()
        .find_map(|item| item.template.as_ref())
        .unwrap();
    assert_eq!(template.reasoning_effort.as_deref(), Some("low"));
    let report = binding.report().unwrap();
    assert_eq!(
        report
            .fields
            .iter()
            .find(|field| field.field.as_deref() == Some("/model_providers/env_key"))
            .unwrap()
            .layer,
        0
    );
    assert_eq!(
        report
            .fields
            .iter()
            .find(|field| field.field.as_deref() == Some("/model_providers/base_url"))
            .unwrap()
            .layer,
        1
    );
}
#[test]
fn ignored_project_secret_cannot_be_laundered_into_the_selected_model() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    f.write(&f.cwd.join(".codex"), "model='SYNTHETIC_IGNORED_BEARER_PRIVATE'\n[model_providers.forged]\nexperimental_bearer_token='SYNTHETIC_IGNORED_BEARER_PRIVATE'\n");
    let binding = f.capture();
    let inventory = binding.inventory().unwrap();
    assert!(
        inventory
            .items
            .iter()
            .find_map(|item| item.provider.as_ref())
            .unwrap()
            .model
            .is_none()
    );
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains("SYNTHETIC_IGNORED_BEARER_PRIVATE")
    );
}

#[test]
fn combined_byte_budget_stops_before_capturing_a_later_unsafe_slot() {
    let f = Fixture::new();
    f.write(&f.user, BASE);
    let huge = format!("model='{}'\n", "x".repeat(4 * 1024 * 1024 + 100));
    f.write(&f.repo.join(".codex"), &huge);
    f.write(&f.repo.join("a/.codex"), &huge);
    // A later directory-shaped config would fail a file read if capture continued past the budget.
    std::fs::create_dir_all(f.cwd.join(".codex/config.toml")).unwrap();
    assert_eq!(
        CodexLayersBinding::capture(&f.user, &f.repo, &f.cwd, None)
            .unwrap_err()
            .to_string(),
        "migration_source_budget_exceeded"
    );
}
