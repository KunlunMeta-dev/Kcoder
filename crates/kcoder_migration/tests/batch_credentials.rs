use kcoder_config::{CredentialBackend, CredentialStoreMode};
use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchPlanPolicy, BatchResolution, BatchSource},
    credentials::{ApiKeySelector, CredentialPhase, CredentialTarget},
    discovery::{ConfigurationBinding, DiscoveryRoots, SourceRegistry},
    mcp::McpTarget,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{BatchTargets, CredentialResolution, CredentialTargets, MigrationJob, MigrationStore},
};
use kcoder_types::migration::{MigrationJobStatus, MigrationSourceKind};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[derive(Default)]
struct Backend {
    keys: Mutex<BTreeMap<String, String>>,
    sets: AtomicUsize,
    deletes: AtomicUsize,
    lose_set_reply: AtomicBool,
    lose_delete_reply: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "owned-memory-backend".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, name: &str) -> anyhow::Result<Option<String>> {
        Ok(self.keys.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> anyhow::Result<()> {
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.keys.lock().unwrap().insert(name.into(), value.into());
        anyhow::ensure!(
            !self.lose_set_reply.swap(false, Ordering::SeqCst),
            "fixture_lost_set_reply"
        );
        Ok(())
    }
    fn delete(&self, name: &str) -> anyhow::Result<()> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.keys.lock().unwrap().remove(name);
        anyhow::ensure!(
            !self.lose_delete_reply.swap(false, Ordering::SeqCst),
            "fixture_lost_delete_reply"
        );
        Ok(())
    }
}

const SOURCE: &str = r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_BATCH_KEY_MUST_STAY_PRIVATE"}}"#;
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    binding: ConfigurationBinding,
    store: MigrationStore,
    provider: ProviderTarget,
    mcp: McpTarget,
    assets: AssetTarget,
    credentials: CredentialTarget,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let directory = root.path().join("source");
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("settings.json");
        std::fs::write(&source, SOURCE).unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.path().into(),
            claude_config_dir: Some(directory),
            codex_home: None,
            project: None,
        });
        let found = registry
            .discover(&[MigrationSourceKind::ClaudeCode], false)
            .0;
        let binding = registry.selected(&found[0].source_id).unwrap();
        Self {
            store: MigrationStore::open_or_create(&profile).unwrap(),
            provider: ProviderTarget::open(&profile).unwrap(),
            mcp: McpTarget::open(&profile).unwrap(),
            assets: AssetTarget::open(&profile).unwrap(),
            credentials: CredentialTarget::open(&profile).unwrap(),
            _root: root,
            profile,
            source,
            binding,
        }
    }
    fn targets<'a>(
        &'a self,
        backend: &'a Backend,
        policy: CredentialStoreMode,
    ) -> BatchTargets<'a> {
        BatchTargets {
            history: None,
            provider: &self.provider,
            mcp: &self.mcp,
            assets: &self.assets,
            credentials: Some(CredentialTargets {
                target: &self.credentials,
                backend,
                policy,
            }),
        }
    }
    fn plan(
        &self,
        targets: &BatchTargets<'_>,
        consent_api_key: bool,
    ) -> anyhow::Result<MigrationJob> {
        self.plan_options(targets, Some(consent_api_key), false)
    }
    fn plan_options(
        &self,
        targets: &BatchTargets<'_>,
        consent: Option<bool>,
        reuse_existing: bool,
    ) -> anyhow::Result<MigrationJob> {
        let job = self
            .store
            .create_batch_scan(vec![BatchSource::Configuration(self.binding.clone())])?;
        let item_id = job.inventory.items[0].preview.id.clone();
        self.store.prepare_batch_with_policy(
            &job.job_id,
            job.sequence,
            &[BatchResolution::Provider(ProviderResolution {
                item_id: item_id.clone(),
                target_name: "Imported".into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 64000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            })],
            targets,
            &BatchPlanPolicy {
                reuse_existing,
                credentials: consent
                    .map(|consent_api_key| {
                        vec![CredentialResolution {
                            item_id,
                            selector: ApiKeySelector::ClaudeConfiguration,
                            consent_api_key,
                        }]
                    })
                    .unwrap_or_default(),
                ..Default::default()
            },
        )
    }
    fn run(&self, job: &MigrationJob, targets: &BatchTargets<'_>, undo: bool) -> MigrationJob {
        self.store
            .run_batch(
                &job.job_id,
                job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                if undo { "undo-batch" } else { "apply-batch" },
                job.sequence,
                undo,
                targets,
            )
            .unwrap()
    }
}

#[test]
fn one_batch_confirmation_previews_both_parts_and_undo_removes_key_before_connection() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::File);
    assert_eq!(
        fixture.plan(&targets, false).unwrap_err().to_string(),
        "migration_credential_consent_required"
    );
    let job = fixture.plan(&targets, true).unwrap();
    assert!(!fixture.profile.join("settings.json").exists());
    assert!(!fixture.profile.join("credentials.json").exists());
    assert!(
        !serde_json::to_string(&job)
            .unwrap()
            .contains("SYNTHETIC_BATCH_KEY_MUST_STAY_PRIVATE")
    );
    assert_eq!(job.credential_plans.len(), 1);
    assert_eq!(
        fixture
            .store
            .apply_credential(
                &job.job_id,
                &job.credential_plans[0].plan_id,
                job.sequence,
                false,
                targets.credentials.as_ref().unwrap()
            )
            .unwrap_err()
            .to_string(),
        "migration_credential_saved_provider_required"
    );
    let applied = fixture.run(&job, &targets, false);
    assert_eq!(
        applied.credential_plans[0].phase,
        CredentialPhase::Published
    );
    assert_eq!(applied.status, MigrationJobStatus::Completed);
    assert!(
        !applied.inventory.items[0]
            .preview
            .issues
            .iter()
            .any(|issue| issue.code
                == kcoder_types::migration::MigrationIssueCode::CredentialResolutionRequired)
    );
    assert_eq!(
        kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials["Imported"],
        "SYNTHETIC_BATCH_KEY_MUST_STAY_PRIVATE"
    );
    assert!(applied.batch.as_ref().unwrap().atomic_credentials);
    assert!(applied.credential_plans[0].atomic_group_id.is_some());
    assert_eq!(
        fixture
            .store
            .apply_credential(
                &applied.job_id,
                &applied.credential_plans[0].plan_id,
                applied.sequence,
                true,
                targets.credentials.as_ref().unwrap()
            )
            .unwrap_err()
            .to_string(),
        "migration_credential_group_operation_required"
    );
    assert_eq!(fixture.run(&job, &targets, false), applied);
    let undone = fixture.run(&applied, &targets, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(undone.credential_plans[0].phase, CredentialPhase::Undone);
    assert_eq!(
        kcoder_config::read_settings_file(&fixture.profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
    assert!(
        !kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials
            .contains_key("Imported")
    );
    assert_eq!(backend.sets.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_to_string(&fixture.source).unwrap(), SOURCE);
}

#[test]
fn lost_keyring_replies_keep_configuration_inactive_and_resume_only_owned_stages() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::Keyring);
    let job = fixture.plan(&targets, true).unwrap();
    backend.lose_set_reply.store(true, Ordering::SeqCst);
    let uncertain = fixture.run(&job, &targets, false);
    assert_eq!(
        uncertain.credential_plans[0].phase,
        CredentialPhase::Unknown
    );
    assert!(uncertain.has_unconfirmed_credentials());
    assert!(!fixture.profile.join("settings.json").exists());
    assert!(
        kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials
            .is_empty()
    );
    let reopened = MigrationStore::open_existing(&fixture.profile).unwrap();
    let current = reopened.read(&job.job_id).unwrap();
    let applied = fixture.run(&current, &targets, false);
    assert_eq!(
        applied.credential_plans[0].phase,
        CredentialPhase::Published
    );
    assert!(kcoder_config::read_settings_file(&fixture.profile.join("settings.json"))
        .unwrap()["providers"]["Imported"].is_object());
    assert_eq!(backend.sets.load(Ordering::SeqCst), 1);
    backend.lose_delete_reply.store(true, Ordering::SeqCst);
    let undoing = fixture.run(&applied, &targets, true);
    assert_eq!(undoing.status, MigrationJobStatus::RollingBack);
    assert!(undoing.credential_plans[0].undo_requested);
    assert!(undoing.has_unconfirmed_credentials());
    assert_eq!(
        kcoder_config::read_settings_file(&fixture.profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
    assert!(
        kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials
            .is_empty()
    );
    let undone = fixture.run(&undoing, &targets, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(undone.credential_plans[0].phase, CredentialPhase::Undone);
    assert_eq!(backend.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(backend.sets.load(Ordering::SeqCst), 1);
}

#[test]
fn a_changed_source_blocks_both_parts_and_an_unattempted_key_can_be_discarded() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::File);
    let job = fixture.plan(&targets, true).unwrap();
    std::fs::write(&fixture.source, SOURCE.replace("PRIVATE", "ROTATED")).unwrap();
    let failed = fixture.run(&job, &targets, false);
    assert_eq!(failed.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(failed.credential_plans[0].phase, CredentialPhase::Ready);
    assert_eq!(
        failed.batch.as_ref().unwrap().actions[0].error.as_deref(),
        Some("migration_source_changed")
    );
    assert!(!fixture.profile.join("credentials.json").exists());
    let undone = fixture.run(&failed, &targets, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(undone.credential_plans[0].phase, CredentialPhase::Undone);
    assert!(!fixture.profile.join("settings.json").exists());
}

#[test]
fn cancelling_before_publication_cannot_be_bypassed_with_a_credential_request() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::File);
    let job = fixture.plan(&targets, true).unwrap();
    let stopped = fixture.store.cancel(&job.job_id, job.sequence).unwrap();
    assert_eq!(stopped.status, MigrationJobStatus::Cancelled);
    assert_eq!(
        fixture
            .store
            .apply_credential(
                &job.job_id,
                &job.credential_plans[0].plan_id,
                stopped.sequence,
                false,
                targets.credentials.as_ref().unwrap()
            )
            .unwrap_err()
            .to_string(),
        "migration_cancel_pending"
    );
    let undone = fixture.run(&stopped, &targets, true);
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(!fixture.profile.join("credentials.json").exists());
}

#[test]
fn batch_undo_preserves_a_user_replacement_and_the_connection_it_depends_on() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::File);
    let job = fixture.plan(&targets, true).unwrap();
    let applied = fixture.run(&job, &targets, false);
    kcoder_config::CredentialStore::update_file(
        &fixture.profile.join("credentials.json"),
        |store| store.set_api_key("Imported", "SYNTHETIC_USER_REPLACEMENT".into()),
    )
    .unwrap();
    let conflicting = fixture.run(&applied, &targets, true);
    assert_eq!(conflicting.status, MigrationJobStatus::RollbackConflict);
    assert_eq!(
        conflicting.credential_plans[0].phase,
        CredentialPhase::Conflict
    );
    assert!(conflicting.credential_plans[0].undo_requested);
    assert_eq!(
        kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials["Imported"],
        "SYNTHETIC_USER_REPLACEMENT"
    );
    assert!(kcoder_config::read_settings_file(&fixture.profile.join("settings.json")).unwrap()["providers"]["Imported"].is_object());
}

#[test]
fn a_reused_connection_can_receive_its_first_key_without_transferring_configuration_ownership() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::File);
    let initial = fixture.plan_options(&targets, None, false).unwrap();
    let original = fixture.run(&initial, &targets, false);
    let staged = fixture.plan_options(&targets, Some(true), true).unwrap();
    let reused = fixture.run(&staged, &targets, false);
    assert_eq!(reused.credential_plans[0].phase, CredentialPhase::Published);
    let released = fixture.run(&reused, &targets, true);
    assert_eq!(released.status, MigrationJobStatus::RolledBack);
    assert!(kcoder_config::read_settings_file(&fixture.profile.join("settings.json")).unwrap()["providers"]["Imported"].is_object());
    assert!(
        !kcoder_config::CredentialStore::load_from(&fixture.profile.join("credentials.json"))
            .unwrap()
            .credentials
            .contains_key("Imported")
    );
    assert_eq!(
        fixture.run(&original, &targets, true).status,
        MigrationJobStatus::RolledBack
    );
}

#[test]
fn group_undo_preserves_a_replaced_keyring_account_and_its_connection() {
    let fixture = Fixture::new();
    let backend = Backend::default();
    let targets = fixture.targets(&backend, CredentialStoreMode::Keyring);
    let job = fixture.plan(&targets, true).unwrap();
    let applied = fixture.run(&job, &targets, false);
    *backend.keys.lock().unwrap().values_mut().next().unwrap() =
        "SYNTHETIC_USER_REPLACEMENT".into();
    let conflict = fixture.run(&applied, &targets, true);
    assert_eq!(conflict.status, MigrationJobStatus::RollbackConflict);
    assert_eq!(
        conflict.credential_plans[0].phase,
        CredentialPhase::Conflict
    );
    assert_eq!(backend.deletes.load(Ordering::SeqCst), 0);
    assert!(kcoder_config::read_settings_file(&fixture.profile.join("settings.json"))
        .unwrap()["providers"]["Imported"].is_object());
    assert_eq!(
        backend.keys.lock().unwrap().values().next().unwrap(),
        "SYNTHETIC_USER_REPLACEMENT"
    );
}
