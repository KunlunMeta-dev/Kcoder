//! Synthetic selected-layer snapshots exercise Native publication, never a source CLI or helper.
use kcoder_config::{CredentialBackend, CredentialStore, CredentialStoreMode};
use kcoder_migration::{
    credentials::{ApiKeySelector, CredentialTarget},
    discovery::{ConfigurationBinding, DiscoveryRoots, SourceRegistry},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{CredentialResolution, CredentialTargets, MigrationJob, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
use std::{fs, path::PathBuf};

struct NoKeyring;
impl CredentialBackend for NoKeyring {
    fn describe(&self) -> String {
        "fixture-file-only".into()
    }
    fn available(&self) -> bool {
        panic!("file policy must not probe a keyring")
    }
    fn get(&self, _: &str) -> anyhow::Result<Option<String>> {
        panic!("no keyring access")
    }
    fn set(&self, _: &str, _: &str) -> anyhow::Result<()> {
        panic!("no keyring access")
    }
    fn delete(&self, _: &str) -> anyhow::Result<()> {
        panic!("no keyring access")
    }
}
const LOWER: &str = "SYNTHETIC_LAYERED_LOWER_API_KEY";
const WINNER: &str = "SYNTHETIC_LAYERED_LOCAL_API_KEY";
struct Fixture {
    _root: tempfile::TempDir,
    user: PathBuf,
    project: PathBuf,
    profile: PathBuf,
}
impl Fixture {
    fn new(local: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("source");
        let project = root.path().join("project");
        let profile = root.path().join("profile");
        for path in [&user, &profile, &project.join(".claude")] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            user.join("settings.json"),
            include_bytes!("fixtures/configuration-layers/user/settings.json"),
        )
        .unwrap();
        fs::write(
            project.join(".claude/settings.json"),
            include_bytes!("fixtures/configuration-layers/project/settings.json"),
        )
        .unwrap();
        if local {
            fs::write(
                project.join(".claude/settings.local.json"),
                include_bytes!("fixtures/configuration-layers/local/settings.local.json"),
            )
            .unwrap();
        }
        fs::write(
            user.join("auth.json"),
            "MALFORMED_AUTH_FILE_MUST_NOT_BE_READ",
        )
        .unwrap();
        fs::write(
            profile.join("settings.json"),
            r#"{"credential_store":"file","providers":{}}"#,
        )
        .unwrap();
        Self {
            _root: root,
            user,
            project,
            profile,
        }
    }
    fn scan(&self) -> (MigrationStore, MigrationJob) {
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: self._root.path().into(),
            claude_config_dir: Some(self.user.clone()),
            codex_home: None,
            project: Some(self.project.clone()),
        });
        let (views, errors) =
            registry.discover_with_assets(&[MigrationSourceKind::ClaudeCode], true, false);
        assert!(errors.is_empty());
        let selected = views
            .iter()
            .find(|source| source.scope == "project-effective")
            .unwrap();
        assert_eq!(selected.format_revision, "claude-settings-layers/v1");
        let binding = registry.selected(&selected.source_id).unwrap();
        let public = serde_json::to_string(&binding.layer_report().unwrap()).unwrap();
        assert!(!public.contains(WINNER) && !public.contains(LOWER));
        let store = MigrationStore::open_or_create(&self.profile).unwrap();
        let job = store.create_bound_scan(binding).unwrap();
        (store, job)
    }
    fn plan(&self, store: &MigrationStore, job: &MigrationJob) -> MigrationJob {
        let item = job
            .inventory
            .items
            .iter()
            .find(|item| item.provider.is_some())
            .unwrap()
            .preview
            .id
            .clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&item))
            .unwrap();
        store
            .prepare_provider(
                &job.job_id,
                job.sequence,
                &ProviderTarget::open(&self.profile).unwrap(),
                &ProviderResolution {
                    item_id: item,
                    target_name: "Layered".into(),
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
fn effective_provider_and_original_winning_api_key_publish_reopen_reconcile_and_undo() {
    let f = Fixture::new(true);
    let original = fs::read(f.profile.join("settings.json")).unwrap();
    let unchanged = [
        f.user.join("settings.json"),
        f.project.join(".claude/settings.json"),
        f.project.join(".claude/settings.local.json"),
        f.user.join("auth.json"),
    ]
    .map(|path| {
        let bytes = fs::read(&path).unwrap();
        (path, bytes)
    });
    let (store, job) = f.scan();
    let planned = f.plan(&store, &job);
    let provider_id = planned.provider_plans[0].id().to_owned();
    let target = ProviderTarget::open(&f.profile).unwrap();
    let job = store
        .apply_provider(&job.job_id, planned.sequence, &provider_id, &target)
        .unwrap();
    let published: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        published["providers"]["Layered"]["default_model"],
        "local-model"
    );
    assert_eq!(published["providers"].as_object().unwrap().len(), 1);
    let native = CredentialTarget::open(&f.profile).unwrap();
    let backend = NoKeyring;
    let targets = CredentialTargets {
        target: &native,
        backend: &backend,
        policy: CredentialStoreMode::File,
    };
    let choice = CredentialResolution {
        item_id: job
            .inventory
            .items
            .iter()
            .find(|item| item.provider.is_some())
            .unwrap()
            .preview
            .id
            .clone(),
        selector: ApiKeySelector::ClaudeConfiguration,
        consent_api_key: true,
    };
    let planned = store
        .prepare_credential(&job.job_id, job.sequence, &choice, &targets)
        .unwrap();
    let plan_id = planned.credential_plans[0].plan_id.clone();
    assert!(!serde_json::to_string(&planned).unwrap().contains(WINNER));
    assert!(!format!("{planned:?}").contains(LOWER));
    let applied = store
        .apply_credential(&job.job_id, &plan_id, planned.sequence, false, &targets)
        .unwrap();
    assert_eq!(
        CredentialStore::load_from(&f.profile.join("credentials.json"))
            .unwrap()
            .credentials["Layered"],
        WINNER
    );
    for (path, bytes) in &unchanged {
        assert_eq!(fs::read(path).unwrap(), *bytes);
    }
    fs::rename(&f.user, f._root.path().join("withheld-user")).unwrap();
    fs::rename(&f.project, f._root.path().join("withheld-project")).unwrap();
    drop(store);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    assert_eq!(
        store
            .apply_credential(&job.job_id, &plan_id, planned.sequence, false, &targets)
            .unwrap()
            .sequence,
        applied.sequence
    );
    assert!(
        store
            .rollback_provider(&job.job_id, applied.sequence, &provider_id, &target)
            .is_err()
    );
    let current = store.read(&job.job_id).unwrap();
    let undone = store
        .apply_credential(&job.job_id, &plan_id, current.sequence, true, &targets)
        .unwrap();
    store
        .rollback_provider(&job.job_id, undone.sequence, &provider_id, &target)
        .unwrap();
    let restored: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        restored,
        serde_json::from_slice::<serde_json::Value>(&original).unwrap()
    );
    assert!(
        !CredentialStore::load_from(&f.profile.join("credentials.json"))
            .unwrap()
            .credentials
            .contains_key("Layered")
    );
}

#[test]
fn a_prepared_snapshot_cannot_publish_after_an_absent_local_layer_appears() {
    let f = Fixture::new(false);
    let (store, job) = f.scan();
    let planned = f.plan(&store, &job);
    fs::write(
        f.project.join(".claude/settings.local.json"),
        r#"{"model":"late-model"}"#,
    )
    .unwrap();
    assert_eq!(
        store
            .apply_provider(
                &job.job_id,
                planned.sequence,
                planned.provider_plans[0].id(),
                &ProviderTarget::open(&f.profile).unwrap()
            )
            .unwrap_err()
            .to_string(),
        "migration_source_changed"
    );
    let current: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(current["providers"], json!({}));
}

#[test]
fn old_single_file_bindings_keep_their_wire_identity_and_layered_undo_respects_edits() {
    let f = Fixture::new(true);
    let old = ConfigurationBinding::capture_selected(
        &f.user.join("settings.json"),
        MigrationSourceKind::ClaudeCode,
    )
    .unwrap();
    let bytes = serde_json::to_vec(&old).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("configurationLayers"));
    assert_eq!(
        serde_json::to_vec(&serde_json::from_slice::<ConfigurationBinding>(&bytes).unwrap())
            .unwrap(),
        bytes
    );
    let (store, job) = f.scan();
    let planned = f.plan(&store, &job);
    let target = ProviderTarget::open(&f.profile).unwrap();
    let applied = store
        .apply_provider(
            &job.job_id,
            planned.sequence,
            planned.provider_plans[0].id(),
            &target,
        )
        .unwrap();
    let repeated = ProviderResolution {
        item_id: job.inventory.items[0].preview.id.clone(),
        target_name: "Layered".into(),
        endpoint: None,
        model: None,
        limits: Some(ModelLimits {
            context_window_tokens: 64000,
            output_headroom_tokens: 8192,
            max_output_tokens: 4096,
        }),
    };
    assert!(target.prepare(&job.inventory.items[0], &repeated).is_err());
    let mut settings: serde_json::Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    settings["providers"]["Layered"]["default_model"] = json!("user-edit");
    fs::write(
        f.profile.join("settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
    assert!(
        store
            .rollback_provider(
                &job.job_id,
                applied.sequence,
                planned.provider_plans[0].id(),
                &target
            )
            .is_err()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(f.profile.join("settings.json")).unwrap()
        )
        .unwrap()["providers"]["Layered"]["default_model"],
        "user-edit"
    );
}

#[test]
fn credential_preparation_cannot_rebase_a_fixed_snapshot_onto_a_new_local_winner() {
    for existing_local in [false, true] {
        let f = Fixture::new(existing_local);
        let (store, job) = f.scan();
        let planned = f.plan(&store, &job);
        let provider = ProviderTarget::open(&f.profile).unwrap();
        let saved = store
            .apply_provider(
                &job.job_id,
                planned.sequence,
                planned.provider_plans[0].id(),
                &provider,
            )
            .unwrap();
        let mut changed = json!({"env":{"ANTHROPIC_API_KEY":"SYNTHETIC_CHANGED_AFTER_REPORT"}});
        if existing_local {
            changed["model"] = json!("local-model");
        }
        fs::write(
            f.project.join(".claude/settings.local.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        let native = CredentialTarget::open(&f.profile).unwrap();
        let backend = NoKeyring;
        let targets = CredentialTargets {
            target: &native,
            backend: &backend,
            policy: CredentialStoreMode::File,
        };
        let resolution = CredentialResolution {
            item_id: saved.inventory.items[0].preview.id.clone(),
            selector: ApiKeySelector::ClaudeConfiguration,
            consent_api_key: true,
        };
        assert_eq!(
            store
                .prepare_credential(&job.job_id, saved.sequence, &resolution, &targets)
                .unwrap_err()
                .to_string(),
            "migration_source_changed"
        );
        assert!(!f.profile.join("credentials.json").exists());
    }
}
