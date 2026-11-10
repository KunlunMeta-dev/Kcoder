use super::*;
use crate::{
    assets::AssetTarget,
    batch::{BatchResolution, BatchSource},
    discovery::ConfigurationBinding,
    mcp::McpTarget,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    templates::TemplateResolution,
};
use kcoder_config::settings_templates::SettingsTemplateStore;
use kcoder_types::migration::MigrationSourceKind;
use std::{fs, path::PathBuf};
#[path = "reuse_tests.rs"]
mod reuse;

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    store: MigrationStore,
    provider: ProviderTarget,
    mcp: McpTarget,
    assets: AssetTarget,
}
impl Fixture {
    fn new(extra: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source");
        fs::create_dir(&profile).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(
            profile.join("settings.json"),
            r#"{"credential_store":"file"}"#,
        )
        .unwrap();
        fs::write(source.join("config.toml"), "model='base-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n").unwrap();
        fs::write(
            source.join("review.config.toml"),
            format!("model='review-model'\nmodel_reasoning_effort='high'\n{extra}"),
        )
        .unwrap();
        let templates = SettingsTemplateStore::open(&profile).unwrap();
        templates
            .save(
                &kcoder_types::settings_templates::SettingsTemplateSaveParams {
                    id: Some("existing".into()),
                    name: "Existing user template".into(),
                    description: None,
                    content: r#"{"max_retries":2}"#.into(),
                },
            )
            .unwrap();
        templates.set_default(Some("existing")).unwrap();
        Self {
            store: MigrationStore::open_or_create(&profile).unwrap(),
            provider: ProviderTarget::open(&profile).unwrap(),
            mcp: McpTarget::open(&profile).unwrap(),
            assets: AssetTarget::open(&profile).unwrap(),
            _root: root,
            profile,
            source,
        }
    }
    fn targets(&self) -> BatchTargets<'_> {
        BatchTargets {
            history: None,
            provider: &self.provider,
            mcp: &self.mcp,
            assets: &self.assets,
            credentials: None,
        }
    }
    fn scan(&self) -> MigrationJob {
        self.store
            .create_batch_scan(vec![BatchSource::Configuration(
                ConfigurationBinding::capture_selected(
                    &self.source.join("review.config.toml"),
                    MigrationSourceKind::Codex,
                )
                .unwrap(),
            )])
            .unwrap()
    }
    fn choices(job: &MigrationJob) -> Vec<BatchResolution> {
        let provider = job
            .inventory
            .items
            .iter()
            .find(|item| item.provider.is_some())
            .unwrap();
        let template = job
            .inventory
            .items
            .iter()
            .find(|item| item.template.is_some())
            .unwrap();
        vec![
            BatchResolution::Template(TemplateResolution {
                item_id: template.preview.id.clone(),
                target_name: "imported-review".into(),
                provider_item_id: provider.preview.id.clone(),
            }),
            BatchResolution::Provider(ProviderResolution {
                item_id: provider.preview.id.clone(),
                target_name: "ImportedOffice".into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 128000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            }),
        ]
    }
    fn plan(&self) -> MigrationJob {
        let job = self.scan();
        self.store
            .prepare_batch(
                &job.job_id,
                job.sequence,
                &Self::choices(&job),
                &self.targets(),
            )
            .unwrap()
    }
    fn run(&self, job: &MigrationJob, rollback: bool) -> Result<MigrationJob> {
        self.store.run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            if rollback { "undo" } else { "apply" },
            job.sequence,
            rollback,
            &self.targets(),
        )
    }
}

#[test]
fn template_batch_defers_dependency_publication_preserves_defaults_and_undoes_after_source_removal()
{
    let f = Fixture::new("");
    let original = fs::read(f.profile.join("settings.json")).unwrap();
    let planned = f.plan();
    assert_eq!(fs::read(f.profile.join("settings.json")).unwrap(), original);
    assert!(!f.profile.join("templates/imported-review.jsonc").exists());
    let applied = f.run(&planned, false).unwrap();
    assert_eq!(applied.receipts.len(), 2);
    let native = SettingsTemplateStore::open(&f.profile).unwrap();
    assert_eq!(
        native.list().unwrap().default_id.as_deref(),
        Some("existing")
    );
    let selected = kcoder_config::SettingsLoader::new(&f.source)
        .with_config_dir(&f.profile)
        .with_executable_dir(f.source.join("unused-executable"))
        .with_overlay_files([native.template_path("imported-review").unwrap()])
        .load()
        .unwrap();
    assert_eq!(
        selected.settings.active_provider.as_deref(),
        Some("ImportedOffice")
    );
    assert_eq!(selected.settings.model, "review-model");
    assert_eq!(
        selected
            .settings
            .model_reasoning_effort
            .as_ref()
            .unwrap()
            .as_str(),
        "high"
    );
    assert_eq!(selected.settings.max_tokens, Some(8192));
    let persisted = fs::read_to_string(f.profile.join("templates/imported-review.jsonc")).unwrap();
    assert!(!persisted.contains("api_key"));
    fs::remove_dir_all(&f.source).unwrap();
    let undone = f.run(&applied, true).unwrap();
    assert_eq!(undone.status, JobStatus::RolledBack);
    assert!(!f.profile.join("templates/imported-review.jsonc").exists());
    assert_eq!(
        native.list().unwrap().default_id.as_deref(),
        Some("existing")
    );
    assert_eq!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&original).unwrap()
    );
}

#[test]
fn lost_template_receipts_reconcile_from_native_ownership_without_replaying_or_rereading_sources() {
    let f = Fixture::new("");
    let planned = f.plan();
    super::super::batch::FAIL_AFTER_TEMPLATE_PUBLICATION.with(|fail| fail.set(true));
    assert!(
        f.run(&planned, false)
            .unwrap_err()
            .to_string()
            .contains("injected_lost_template_receipt")
    );
    let before = fs::read(f.profile.join("templates/imported-review.jsonc")).unwrap();
    let metadata = fs::metadata(f.profile.join("templates/imported-review.jsonc"))
        .unwrap()
        .modified()
        .unwrap();
    fs::remove_dir_all(&f.source).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    let recovered = reopened
        .run_batch(
            &planned.job_id,
            planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "apply",
            planned.sequence,
            false,
            &f.targets(),
        )
        .unwrap();
    assert_eq!(recovered.receipts.len(), 2);
    assert!(
        recovered
            .receipts
            .iter()
            .all(|receipt| receipt.ownership_confirmed)
    );
    assert_eq!(
        fs::read(f.profile.join("templates/imported-review.jsonc")).unwrap(),
        before
    );
    assert_eq!(
        fs::metadata(f.profile.join("templates/imported-review.jsonc"))
            .unwrap()
            .modified()
            .unwrap(),
        metadata
    );
    assert_eq!(
        f.run(&recovered, true).unwrap().status,
        JobStatus::RolledBack
    );
}

#[test]
fn native_template_ownership_allows_direct_undo_after_a_lost_migration_receipt() {
    let f = Fixture::new("");
    let planned = f.plan();
    super::super::batch::FAIL_AFTER_TEMPLATE_PUBLICATION.with(|fail| fail.set(true));
    assert!(f.run(&planned, false).is_err());
    let interrupted = f.store.read(&planned.job_id).unwrap();
    assert_eq!(interrupted.receipts.len(), 1);
    fs::remove_dir_all(&f.source).unwrap();
    assert_eq!(
        f.run(&interrupted, true).unwrap().status,
        JobStatus::RolledBack
    );
    assert!(!f.profile.join("templates/imported-review.jsonc").exists());
    assert!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json"))
            .unwrap()
            .get("providers")
            .is_none()
    );
}

#[test]
fn edited_default_and_frozen_templates_preserve_their_connection_during_rollback() {
    for state in ["edited", "default", "frozen"] {
        let f = Fixture::new("");
        let applied = f.run(&f.plan(), false).unwrap();
        let native = SettingsTemplateStore::open(&f.profile).unwrap();
        match state {
            "edited" => {
                let saved = native.read("imported-review").unwrap();
                native
                    .save(
                        &kcoder_types::settings_templates::SettingsTemplateSaveParams {
                            id: Some("imported-review".into()),
                            name: "User renamed report".into(),
                            description: None,
                            content: saved.content,
                        },
                    )
                    .unwrap();
            }
            "default" => {
                native.set_default(Some("imported-review")).unwrap();
            }
            _ => {
                native.freeze_for_session("imported-review").unwrap();
            }
        }
        let undone = f.run(&applied, true).unwrap();
        assert_eq!(undone.status, JobStatus::RollbackConflict, "{state}");
        let target = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
        assert!(target["providers"]["ImportedOffice"].is_object(), "{state}");
        if state != "frozen" {
            assert!(native.read("imported-review").is_ok());
        }
    }
}

#[test]
fn missing_or_wrong_source_dependencies_and_unsupported_policies_never_publish() {
    for failure in ["missing", "wrong", "policy"] {
        let f = Fixture::new(if failure == "policy" {
            "sandbox_mode='danger-full-access'"
        } else {
            ""
        });
        let scanned = f.scan();
        let mut choices = Fixture::choices(&scanned);
        if failure == "missing" {
            choices.pop();
        }
        if failure == "wrong"
            && let BatchResolution::Template(choice) = &mut choices[0]
        {
            choice.provider_item_id = "foreign-item".into();
        }
        assert!(
            f.store
                .prepare_batch(&scanned.job_id, scanned.sequence, &choices, &f.targets())
                .is_err(),
            "{failure}"
        );
        assert!(!f.profile.join("templates/imported-review.jsonc").exists());
        assert!(
            kcoder_config::read_settings_file(&f.profile.join("settings.json"))
                .unwrap()
                .get("providers")
                .is_none()
        );
    }
}
