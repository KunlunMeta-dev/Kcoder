//! Synthetic owned files verify the Native Store path without invoking Codex or a model.
use kcoder_migration::{
    discovery::ConfigurationBinding,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::MigrationStore,
};
use kcoder_types::migration::MigrationSourceKind;
use std::{fs, path::PathBuf};
struct Fixture {
    _root: tempfile::TempDir,
    user: PathBuf,
    repo: PathBuf,
    cwd: PathBuf,
    profile: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user");
        let repo = root.path().join("repo");
        let cwd = repo.join("src/nested");
        let profile = root.path().join("profile");
        for directory in [&user, &repo.join(".git"), &cwd.join(".codex"), &profile] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(user.join("config.toml"), "model='base-model'\nmodel_provider='office'\n[model_providers.office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='KCODER_CODEX_LAYER_ENV_FIXTURE'\n").unwrap();
        fs::write(cwd.join(".codex/config.toml"), "model='nearest-model'\nmodel_provider='forged'\n[model_providers.forged]\nbase_url='https://forged.invalid/v1'\nenv_key='MUST_NOT_READ_PROJECT_ENV'\n").unwrap();
        fs::write(
            profile.join("settings.json"),
            r#"{"credential_store":"file","providers":{}}"#,
        )
        .unwrap();
        Self {
            _root: root,
            user,
            repo,
            cwd,
            profile,
        }
    }
    fn binding(&self) -> ConfigurationBinding {
        ConfigurationBinding::capture_codex_layers(&self.user, &self.repo, &self.cwd, None).unwrap()
    }
    fn plan(
        &self,
        store: &MigrationStore,
        binding: ConfigurationBinding,
    ) -> kcoder_migration::store::MigrationJob {
        let job = store.create_bound_scan(binding).unwrap();
        let id = job
            .inventory
            .items
            .iter()
            .find(|item| item.provider.is_some())
            .unwrap()
            .preview
            .id
            .clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        store
            .prepare_provider(
                &job.job_id,
                job.sequence,
                &ProviderTarget::open(&self.profile).unwrap(),
                &ProviderResolution {
                    item_id: id,
                    target_name: "CodexLayers".into(),
                    endpoint: None,
                    model: None,
                    limits: Some(ModelLimits {
                        context_window_tokens: 64000,
                        output_headroom_tokens: 8192,
                        max_output_tokens: 4096,
                    }),
                },
            )
            .unwrap()
    }
}
#[test]
fn native_layered_provider_publish_reopen_retry_and_undo_keep_original_sources() {
    let f = Fixture::new();
    let before = fs::read(f.profile.join("settings.json")).unwrap();
    let source = fs::read(f.user.join("config.toml")).unwrap();
    let project = fs::read(f.cwd.join(".codex/config.toml")).unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let source_binding = f.binding();
    let report = source_binding
        .codex_layer_snapshot_report()
        .unwrap()
        .unwrap();
    let planned = f.plan(&store, source_binding);
    let plan = planned.provider_plans[0].id().to_owned();
    let target = ProviderTarget::open(&f.profile).unwrap();
    let applied = store
        .apply_provider(&planned.job_id, planned.sequence, &plan, &target)
        .unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        saved["providers"]["CodexLayers"]["default_model"],
        "nearest-model"
    );
    assert_eq!(
        saved["providers"]["CodexLayers"]["endpoint"],
        "https://example.invalid/v1"
    );
    assert_eq!(fs::read(f.user.join("config.toml")).unwrap(), source);
    assert_eq!(fs::read(f.cwd.join(".codex/config.toml")).unwrap(), project);
    fs::rename(&f.user, f._root.path().join("withheld-user")).unwrap();
    fs::rename(&f.repo, f._root.path().join("withheld-repo")).unwrap();
    drop(store);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    assert_eq!(
        store
            .read(&planned.job_id)
            .unwrap()
            .source_binding
            .unwrap()
            .codex_layer_snapshot_report()
            .unwrap()
            .unwrap(),
        report
    );
    assert_eq!(
        store
            .apply_provider(&planned.job_id, planned.sequence, &plan, &target)
            .unwrap()
            .sequence,
        applied.sequence
    );
    store
        .rollback_provider(&planned.job_id, applied.sequence, &plan, &target)
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(f.profile.join("settings.json")).unwrap()
        )
        .unwrap(),
        serde_json::from_slice::<serde_json::Value>(&before).unwrap()
    );
}
#[test]
fn absent_layer_appearance_blocks_persisted_plan_instead_of_silently_rebasing() {
    let f = Fixture::new();
    let before = fs::read(f.profile.join("settings.json")).unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let planned = f.plan(&store, f.binding());
    fs::create_dir(f.repo.join(".codex")).unwrap();
    fs::write(f.repo.join(".codex/config.toml"), "model='appeared'\n").unwrap();
    assert!(
        store
            .apply_provider(
                &planned.job_id,
                planned.sequence,
                planned.provider_plans[0].id(),
                &ProviderTarget::open(&f.profile).unwrap()
            )
            .is_err()
    );
    assert_eq!(fs::read(f.profile.join("settings.json")).unwrap(), before);
}
#[test]
fn existing_single_file_and_named_profiles_keep_their_serialized_bindings() {
    let f = Fixture::new();
    fs::write(f.user.join("review.config.toml"), "model='named-model'\n").unwrap();
    for name in ["config.toml", "review.config.toml"] {
        let binding =
            ConfigurationBinding::capture_selected(&f.user.join(name), MigrationSourceKind::Codex)
                .unwrap();
        let old = serde_json::to_value(&binding).unwrap();
        assert!(old.get("codexLayers").is_none());
        let restored: ConfigurationBinding = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), old);
    }
    let profile = ConfigurationBinding::capture_selected(
        &f.user.join("review.config.toml"),
        MigrationSourceKind::Codex,
    )
    .unwrap();
    let binding =
        ConfigurationBinding::capture_codex_layers(&f.user, &f.repo, &f.cwd, Some(profile))
            .unwrap();
    let provider = binding
        .inventory()
        .unwrap()
        .items
        .into_iter()
        .find_map(|item| item.provider)
        .unwrap();
    assert_eq!(provider.model.as_deref(), Some("nearest-model"));
    assert_eq!(
        provider.endpoint.as_deref(),
        Some("https://example.invalid/v1")
    );
}

#[test]
fn declared_user_environment_credential_keeps_exact_layer_binding_and_receipts() {
    const FLAG: &str = "KCODER_CODEX_LAYER_CHILD_FIXTURE";
    const PRIVATE: &str = "SYNTHETIC_CODEX_LAYER_ENV_PRIVATE";
    if std::env::var(FLAG).as_deref() != Ok("1") {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "declared_user_environment_credential_keeps_exact_layer_binding_and_receipts",
                "--nocapture",
            ])
            .env(FLAG, "1")
            .env("KCODER_CODEX_LAYER_ENV_FIXTURE", PRIVATE)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use kcoder_config::{CredentialBackend, CredentialStore, CredentialStoreMode};
    use kcoder_migration::{
        credentials::{ApiKeySelector, CredentialTarget},
        store::{CredentialResolution, CredentialTargets},
    };
    struct NoKeyring;
    impl CredentialBackend for NoKeyring {
        fn describe(&self) -> String {
            "owned-file-only".into()
        }
        fn available(&self) -> bool {
            panic!("no keyring")
        }
        fn get(&self, _: &str) -> anyhow::Result<Option<String>> {
            panic!("no keyring")
        }
        fn set(&self, _: &str, _: &str) -> anyhow::Result<()> {
            panic!("no keyring")
        }
        fn delete(&self, _: &str) -> anyhow::Result<()> {
            panic!("no keyring")
        }
    }
    let f = Fixture::new();
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let planned = f.plan(&store, f.binding());
    let provider_id = planned.provider_plans[0].id().to_owned();
    let target = ProviderTarget::open(&f.profile).unwrap();
    let saved = store
        .apply_provider(&planned.job_id, planned.sequence, &provider_id, &target)
        .unwrap();
    let credentials = CredentialTarget::open(&f.profile).unwrap();
    let backend = NoKeyring;
    let targets = CredentialTargets {
        target: &credentials,
        backend: &backend,
        policy: CredentialStoreMode::File,
    };
    let item_id = saved
        .inventory
        .items
        .iter()
        .find(|item| item.provider.is_some())
        .unwrap()
        .preview
        .id
        .clone();
    let choice = CredentialResolution {
        item_id,
        selector: ApiKeySelector::Environment("KCODER_CODEX_LAYER_ENV_FIXTURE".into()),
        consent_api_key: true,
    };
    let planned = store
        .prepare_credential(&saved.job_id, saved.sequence, &choice, &targets)
        .unwrap();
    let credential_id = planned.credential_plans[0].plan_id.clone();
    assert!(!serde_json::to_string(&planned).unwrap().contains(PRIVATE));
    let applied = store
        .apply_credential(
            &saved.job_id,
            &credential_id,
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(
        CredentialStore::load_from(&f.profile.join("credentials.json"))
            .unwrap()
            .credentials["CodexLayers"],
        PRIVATE
    );
    fs::rename(&f.user, f._root.path().join("credential-source-withheld")).unwrap();
    fs::rename(&f.repo, f._root.path().join("credential-project-withheld")).unwrap();
    drop(store);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    assert_eq!(
        store
            .apply_credential(
                &saved.job_id,
                &credential_id,
                planned.sequence,
                false,
                &targets
            )
            .unwrap()
            .sequence,
        applied.sequence
    );
    let undone = store
        .apply_credential(
            &saved.job_id,
            &credential_id,
            applied.sequence,
            true,
            &targets,
        )
        .unwrap();
    store
        .rollback_provider(&saved.job_id, undone.sequence, &provider_id, &target)
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(f.profile.join("settings.json")).unwrap()
        )
        .unwrap(),
        original
    );
}
