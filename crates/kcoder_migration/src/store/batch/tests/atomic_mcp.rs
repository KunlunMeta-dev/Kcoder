use super::*;
use crate::{
    batch::{BatchPlanPolicy, McpCredentialChoice},
    credentials::{ApiKeySelector, CredentialPhase as Phase, CredentialTarget},
    discovery::ConfigurationBinding,
    mcp_credentials::{McpCredentialTarget, MigrationMcpPrivateField as Field},
    providers::{ModelLimits, ProviderResolution},
};
use kcoder_config::{
    CredentialBackend, CredentialStoreMode, imported_credentials::ImportedCredentialStore,
};
use std::collections::BTreeMap;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

const SOURCE: &str = r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_PROVIDER_KEY"},"mcpServers":{"docs":{"command":"MUST_NOT_RUN","env":{"TOKEN":"SYNTHETIC_MCP_TOKEN","EXTRA":"SYNTHETIC_UNSELECTED_VALUE"}},"remote":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer SYNTHETIC_HEADER_TOKEN"}}}}"#;

#[derive(Default)]
struct Backend {
    values: Mutex<BTreeMap<String, String>>,
    writes: AtomicUsize,
    lose_set: AtomicBool,
    lose_delete: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "owned-batch-mcp-fixture".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.values.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.values
            .lock()
            .unwrap()
            .insert(name.into(), value.into());
        self.writes.fetch_add(1, Ordering::SeqCst);
        ensure!(
            !self.lose_set.swap(false, Ordering::SeqCst),
            "fixture_lost_reply"
        );
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.values.lock().unwrap().remove(name);
        ensure!(
            !self.lose_delete.swap(false, Ordering::SeqCst),
            "fixture_lost_reply"
        );
        Ok(())
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    profile: std::path::PathBuf,
    source: std::path::PathBuf,
    store: MigrationStore,
    scanned: MigrationJob,
    provider: ProviderTarget,
    mcp: McpTarget,
    assets: AssetTarget,
    keys: CredentialTarget,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let input = root.path().join("input");
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&input).unwrap();
        let source = input.join("settings.json");
        std::fs::write(&source, SOURCE).unwrap();
        let binding = ConfigurationBinding::capture_selected(&source, Kind::ClaudeCode).unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let scanned = store
            .create_batch_scan(vec![BatchSource::Configuration(binding)])
            .unwrap();
        Self {
            provider: ProviderTarget::open(&profile).unwrap(),
            mcp: McpTarget::open(&profile).unwrap(),
            assets: AssetTarget::open(&profile).unwrap(),
            keys: CredentialTarget::open(&profile).unwrap(),
            _root: root,
            profile,
            source,
            store,
            scanned,
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
                target: &self.keys,
                backend,
                policy,
            }),
        }
    }
    fn choices(&self, enable: bool) -> Vec<BatchResolution> {
        self.choices_for(&self.scanned, enable)
    }
    fn choices_for(&self, job: &MigrationJob, enable: bool) -> Vec<BatchResolution> {
        job.inventory
            .items
            .iter()
            .filter_map(|item| {
                if item.provider.is_some() {
                    Some(BatchResolution::Provider(ProviderResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "Imported".into(),
                        endpoint: None,
                        model: None,
                        limits: Some(ModelLimits {
                            context_window_tokens: 64000,
                            output_headroom_tokens: 8192,
                            max_output_tokens: 8192,
                        }),
                    }))
                } else {
                    item.mcp.as_ref().map(|mcp| {
                        BatchResolution::Mcp(McpResolution {
                            item_id: item.preview.id.clone(),
                            target_name: mcp.config.name.clone(),
                            cwd: None,
                            enable_after_import: enable,
                        })
                    })
                }
            })
            .collect()
    }
    fn policy(&self, all_fields: bool) -> BatchPlanPolicy {
        let mut policy = BatchPlanPolicy::default();
        for item in &self.scanned.inventory.items {
            if let Some(mcp) = &item.mcp {
                let fields = if mcp.config.transport == "stdio" {
                    let mut fields = vec![Field::Environment("TOKEN".into())];
                    if all_fields {
                        fields.push(Field::Environment("EXTRA".into()));
                    }
                    fields
                } else {
                    vec![Field::Header("Authorization".into())]
                };
                policy.mcp_credentials.push(McpCredentialChoice {
                    item_id: item.preview.id.clone(),
                    fields,
                    consent_private_values: true,
                });
            } else if item.provider.is_some() {
                policy.credentials.push(CredentialResolution {
                    item_id: item.preview.id.clone(),
                    selector: ApiKeySelector::ClaudeConfiguration,
                    consent_api_key: true,
                });
            }
        }
        policy
    }
    fn plan(
        &self,
        targets: &BatchTargets<'_>,
        enable: bool,
        policy: &BatchPlanPolicy,
    ) -> Result<MigrationJob> {
        self.store.prepare_batch_with_policy(
            &self.scanned.job_id,
            self.scanned.sequence,
            &self.choices(enable),
            targets,
            policy,
        )
    }
    fn run(
        &self,
        job: &MigrationJob,
        targets: &BatchTargets<'_>,
        undo: bool,
    ) -> Result<MigrationJob> {
        self.store.run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            if undo { "undo" } else { "apply" },
            job.sequence,
            undo,
            targets,
        )
    }
}

#[test]
fn private_mcp_reuse_keeps_existing_payloads_and_protects_the_origin_without_new_ownership() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new();
        let backend = Backend::default();
        let targets = f.targets(&backend, mode);
        let planned = f.plan(&targets, false, &f.policy(false)).unwrap();
        let saved = f.run(&planned, &targets, false).unwrap();
        let before = std::fs::read(f.profile.join("settings.json")).unwrap();
        let private_before = std::fs::read(f.profile.join("credentials.json")).unwrap();
        let scan = f
            .store
            .create_batch_scan(f.scanned.batch.as_ref().unwrap().sources.clone())
            .unwrap();
        let reuse = f
            .store
            .prepare_batch_with_policy(
                &scan.job_id,
                scan.sequence,
                &f.choices_for(&scan, false),
                &targets,
                &BatchPlanPolicy {
                    reuse_existing: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(reuse.mcp_credential_plans.is_empty());
        assert!(reuse.credential_plans.is_empty());
        assert!(
            reuse
                .batch
                .as_ref()
                .unwrap()
                .actions
                .iter()
                .all(|action| matches!(action.action, crate::batch::BatchActionKind::Reuse { .. }))
        );
        let reused = f.run(&reuse, &targets, false).unwrap();
        assert_eq!(
            backend.writes.load(Ordering::SeqCst),
            if mode == CredentialStoreMode::Keyring {
                3
            } else {
                0
            }
        );
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read(f.profile.join("credentials.json")).unwrap(),
            private_before
        );
        for item in reused
            .inventory
            .items
            .iter()
            .filter(|item| item.mcp.is_some())
        {
            let (_, config) = f
                .store
                .reused_settings(&reused.job_id, &item.preview.id)
                .unwrap();
            assert!(config.unwrap().policy.credential_ref.is_some());
        }
        let protected = f.run(&saved, &targets, true).unwrap();
        assert_eq!(protected.status, JobStatus::RollbackConflict);
        assert_eq!(
            std::fs::read(f.profile.join("credentials.json")).unwrap(),
            private_before
        );
        let released = f.run(&reused, &targets, true).unwrap();
        assert_eq!(released.status, JobStatus::RolledBack);
        assert_eq!(
            std::fs::read(f.profile.join("credentials.json")).unwrap(),
            private_before
        );
        let undone = f.run(&protected, &targets, true).unwrap();
        assert_eq!(undone.status, JobStatus::RolledBack);
        assert!(backend.values.lock().unwrap().is_empty());
    }
}

#[test]
fn private_reuse_validates_real_backing_values_and_current_storage_policy_without_overwriting_them()
{
    for changed_policy in [false, true] {
        let f = Fixture::new();
        let backend = Backend::default();
        let targets = f.targets(&backend, CredentialStoreMode::Keyring);
        let planned = f.plan(&targets, false, &f.policy(false)).unwrap();
        f.run(&planned, &targets, false).unwrap();
        if !changed_policy {
            let mut values = backend.values.lock().unwrap();
            let value = values
                .values_mut()
                .find(|value| value.contains("SYNTHETIC_MCP_TOKEN"))
                .unwrap();
            *value = "USER_CHANGED_PRIVATE_PAYLOAD".into();
        }
        let changed = f.targets(
            &backend,
            if changed_policy {
                CredentialStoreMode::File
            } else {
                CredentialStoreMode::Keyring
            },
        );
        let before = std::fs::read(f.profile.join("settings.json")).unwrap();
        let scan = f
            .store
            .create_batch_scan(f.scanned.batch.as_ref().unwrap().sources.clone())
            .unwrap();
        let error = f
            .store
            .prepare_batch_with_policy(
                &scan.job_id,
                scan.sequence,
                &f.choices_for(&scan, false),
                &changed,
                &BatchPlanPolicy {
                    reuse_existing: true,
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(error.to_string().starts_with("migration_"));
        assert!(!error.to_string().contains("SYNTHETIC_"));
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            before
        );
        assert_eq!(backend.writes.load(Ordering::SeqCst), 3);
        assert!(
            f.store
                .read(&scan.job_id)
                .unwrap()
                .batch
                .as_ref()
                .unwrap()
                .plan_id
                .is_none()
        );
    }
}

#[test]
fn private_reuse_preserves_later_activation_preferences_and_unrelated_target_settings() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::File);
    let planned = f.plan(&targets, false, &f.policy(false)).unwrap();
    f.run(&planned, &targets, false).unwrap();
    let path = f.profile.join("settings.json");
    let mut settings = kcoder_config::read_settings_file(&path).unwrap();
    settings["mcp_disabled_servers"] = serde_json::json!(["remote"]);
    settings["max_turns"] = 11.into();
    std::fs::write(&path, settings.to_string()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let scan = f
        .store
        .create_batch_scan(f.scanned.batch.as_ref().unwrap().sources.clone())
        .unwrap();
    let reuse = f
        .store
        .prepare_batch_with_policy(
            &scan.job_id,
            scan.sequence,
            &f.choices_for(&scan, false),
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(reuse.batch.as_ref().unwrap().actions.iter().any(|action|
        matches!(&action.action, crate::batch::BatchActionKind::Reuse { proof } if proof.target_name=="docs" && proof.enabled)));
    let reused = f.run(&reuse, &targets, false).unwrap();
    let released = f.run(&reused, &targets, true).unwrap();
    assert_eq!(released.status, JobStatus::RolledBack);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn an_interrupted_private_reference_reconciles_after_source_removal_without_new_payload_writes() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::Keyring);
    let planned = f.plan(&targets, false, &f.policy(false)).unwrap();
    let saved = f.run(&planned, &targets, false).unwrap();
    let scanned = f
        .store
        .create_batch_scan(f.scanned.batch.as_ref().unwrap().sources.clone())
        .unwrap();
    let choices = f
        .choices_for(&scanned, false)
        .into_iter()
        .filter(|choice| matches!(choice, BatchResolution::Mcp(mcp) if mcp.target_name=="docs"))
        .collect::<Vec<_>>();
    let planned = f
        .store
        .prepare_batch_with_policy(
            &scanned.job_id,
            scanned.sequence,
            &choices,
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap();
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(f.run(&planned, &targets, false).is_err());
    let pending = f.store.read(&planned.job_id).unwrap();
    assert!(pending.receipts.is_empty());
    std::fs::remove_file(&f.source).unwrap();
    let protected = f.run(&saved, &targets, true).unwrap();
    assert_eq!(protected.status, JobStatus::RollbackConflict);
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    let settled = reopened
        .run_batch(
            &pending.job_id,
            pending.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "apply",
            pending.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(
        settled.batch.as_ref().unwrap().actions[0].status,
        ItemStatus::Skipped
    );
    assert!(!settled.receipts[0].ownership_confirmed);
    assert_eq!(backend.writes.load(Ordering::SeqCst), 3);
    f.run(&settled, &targets, true).unwrap();
    assert_eq!(
        f.run(&protected, &targets, true).unwrap().status,
        JobStatus::RolledBack
    );
}

#[test]
fn provider_and_multiple_mcp_payloads_publish_as_one_group_without_leaking_unselected_values() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new();
        let backend = Backend::default();
        let targets = f.targets(&backend, mode);
        let planned = f.plan(&targets, false, &f.policy(false)).unwrap();
        assert!(!f.profile.join("settings.json").exists());
        assert!(!f.profile.join("credentials.json").exists());
        assert!(backend.values.lock().unwrap().is_empty());
        assert!(
            !serde_json::to_string(&planned)
                .unwrap()
                .contains("SYNTHETIC_")
        );
        assert_eq!(planned.batch.as_ref().unwrap().credential_plan_ids.len(), 3);
        let action = &planned.batch.as_ref().unwrap().actions[0];
        assert!(
            planned
                .mcp_credential_plans
                .iter()
                .all(|plan| plan.atomic_group_id.as_deref() == Some(&action.action_id))
        );
        let saved = f.run(&planned, &targets, false).unwrap();
        assert!(
            saved
                .mcp_credential_plans
                .iter()
                .all(|plan| plan.phase == Phase::Published)
        );
        assert!(
            saved
                .credential_plans
                .iter()
                .all(|plan| plan.phase == Phase::Published)
        );
        let public = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
        assert!(!public.to_string().contains("SYNTHETIC_"));
        assert_eq!(public["mcp_disabled_servers"].as_array().unwrap().len(), 2);
        let native = ImportedCredentialStore::open(&f.profile).unwrap();
        for plan in &saved.mcp_credential_plans {
            let values = native
                .resolve_mcp_with_mode(&plan.config, mode, &backend)
                .unwrap();
            assert!(!values.env.contains_key("EXTRA"));
            assert_eq!(values.env.len() + values.headers.len(), 1);
        }
        assert!(
            !std::fs::read_to_string(f.profile.join("credentials.json"))
                .unwrap()
                .contains("SYNTHETIC_UNSELECTED_VALUE")
        );
        let undone = f.run(&saved, &targets, true).unwrap();
        assert_eq!(undone.status, JobStatus::RolledBack);
        assert!(
            undone
                .mcp_credential_plans
                .iter()
                .all(|plan| plan.phase == Phase::Undone)
        );
        assert_eq!(
            kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
            serde_json::json!({})
        );
        assert!(backend.values.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&f.source).unwrap(), SOURCE);
    }
}

#[test]
fn grouped_mcp_private_mutations_cannot_bypass_batch_authority_or_storage_policy() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::File);
    let mut policy = f.policy(false);
    policy.credentials.clear();
    let job = f.plan(&targets, false, &policy).unwrap();
    let target = McpCredentialTarget::open(&f.profile).unwrap();
    for undo in [false, true] {
        assert_eq!(
            f.store
                .apply_mcp_credentials(
                    &job.job_id,
                    &job.mcp_credential_plans[0].plan_id,
                    job.sequence,
                    undo,
                    &target,
                    CredentialStoreMode::File,
                    &backend
                )
                .unwrap_err()
                .to_string(),
            "migration_credential_group_operation_required"
        );
        assert_eq!(f.store.read(&job.job_id).unwrap(), job);
    }
    let changed = f.targets(&backend, CredentialStoreMode::Keyring);
    assert_eq!(
        f.run(&job, &changed, false).unwrap_err().to_string(),
        "migration_credential_storage_policy_changed"
    );
    assert!(backend.values.lock().unwrap().is_empty());
}

#[test]
fn only_complete_selected_fields_allow_explicit_mcp_activation_without_executing_it() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::File);
    assert!(f.plan(&targets, true, &f.policy(false)).is_err());
    let job = f.plan(&targets, true, &f.policy(true)).unwrap();
    let saved = f.run(&job, &targets, false).unwrap();
    assert!(
        saved
            .mcp_credential_plans
            .iter()
            .all(|plan| plan.phase == Phase::Published)
    );
    let public = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
    assert!(
        public["mcp_disabled_servers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(saved.status, JobStatus::Completed);
}

#[test]
fn batch_mcp_private_choices_require_consent_exact_fields_and_a_selected_server() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::File);
    let mut policy = f.policy(false);
    policy.mcp_credentials[0].consent_private_values = false;
    assert_eq!(
        f.plan(&targets, false, &policy).unwrap_err().to_string(),
        "migration_mcp_private_consent_required"
    );
    policy.mcp_credentials[0].consent_private_values = true;
    policy.mcp_credentials[0]
        .fields
        .push(Field::Environment("NOT_DECLARED".into()));
    assert!(f.plan(&targets, false, &policy).is_err());
    let policy = f.policy(false);
    let choices = f
        .choices(false)
        .into_iter()
        .filter(|choice| choice.item_id() != policy.mcp_credentials[0].item_id)
        .collect::<Vec<_>>();
    assert_eq!(
        f.store
            .prepare_batch_with_policy(
                &f.scanned.job_id,
                f.scanned.sequence,
                &choices,
                &targets,
                &policy
            )
            .unwrap_err()
            .to_string(),
        "migration_mcp_private_server_not_selected"
    );
    assert_eq!(f.store.read(&f.scanned.job_id).unwrap(), f.scanned);
    assert!(!f.profile.join("credentials.json").exists());
    assert!(backend.values.lock().unwrap().is_empty());
}

#[test]
fn lost_group_receipt_recovers_or_undoes_mixed_payloads_without_original_source() {
    for undo_directly in [false, true] {
        let f = Fixture::new();
        let backend = Backend::default();
        let targets = f.targets(&backend, CredentialStoreMode::Keyring);
        let job = f.plan(&targets, false, &f.policy(false)).unwrap();
        FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
        assert!(f.run(&job, &targets, false).is_err());
        let pending = f.store.read(&job.job_id).unwrap();
        assert!(pending.receipts.is_empty());
        assert!(
            pending
                .mcp_credential_plans
                .iter()
                .all(|plan| plan.phase == Phase::Published)
        );
        std::fs::remove_file(&f.source).unwrap();
        let writes = backend.writes.load(Ordering::SeqCst);
        let reopened = MigrationStore::open_existing(&f.profile).unwrap();
        let current = if undo_directly {
            pending
        } else {
            reopened
                .run_batch(
                    &job.job_id,
                    job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                    "apply",
                    pending.sequence,
                    false,
                    &targets,
                )
                .unwrap()
        };
        assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
        let undone = reopened
            .run_batch(
                &job.job_id,
                job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "undo",
                current.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(undone.status, JobStatus::RolledBack);
        assert!(backend.values.lock().unwrap().is_empty());
    }
}

#[test]
fn cancellation_and_lost_backend_replies_never_activate_partial_mcp_groups() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::Keyring);
    let mut policy = f.policy(false);
    policy.credentials.clear();
    let job = f.plan(&targets, false, &policy).unwrap();
    backend.lose_set.store(true, Ordering::SeqCst);
    let pending = f.run(&job, &targets, false).unwrap();
    assert!(pending.has_unconfirmed_credentials());
    assert!(!f.profile.join("settings.json").exists());
    let saved = f.run(&pending, &targets, false).unwrap();
    assert!(
        saved
            .mcp_credential_plans
            .iter()
            .all(|plan| plan.phase == Phase::Published)
    );
    backend.lose_delete.store(true, Ordering::SeqCst);
    let pending = f.run(&saved, &targets, true).unwrap();
    assert_eq!(pending.status, JobStatus::RollingBack);
    assert_eq!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
    let undone = f.run(&pending, &targets, true).unwrap();
    assert_eq!(undone.status, JobStatus::RolledBack);
    assert!(backend.values.lock().unwrap().is_empty());

    let f = Fixture::new();
    let targets = f.targets(&backend, CredentialStoreMode::Keyring);
    let job = f.plan(&targets, false, &f.policy(false)).unwrap();
    let cancelled = f.store.cancel(&job.job_id, job.sequence).unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert_eq!(
        f.run(&cancelled, &targets, false).unwrap_err().to_string(),
        "migration_invalid_transition"
    );
    let settled = f.run(&cancelled, &targets, true).unwrap();
    assert_eq!(settled.status, JobStatus::RolledBack);
    assert!(backend.values.lock().unwrap().is_empty());
    assert!(!f.profile.join("settings.json").exists());
}

#[test]
fn changed_source_or_destination_never_publishes_or_removes_unowned_state() {
    let f = Fixture::new();
    let backend = Backend::default();
    let targets = f.targets(&backend, CredentialStoreMode::Keyring);
    let job = f.plan(&targets, false, &f.policy(false)).unwrap();
    std::fs::write(
        &f.source,
        SOURCE.replace("SYNTHETIC_MCP_TOKEN", "SYNTHETIC_CHANGED_TOKEN"),
    )
    .unwrap();
    let blocked = f.run(&job, &targets, false).unwrap();
    assert_eq!(blocked.status, JobStatus::CompletedWithIssues);
    assert!(backend.values.lock().unwrap().is_empty());
    assert!(!f.profile.join("settings.json").exists());

    let f = Fixture::new();
    let targets = f.targets(&backend, CredentialStoreMode::Keyring);
    let job = f.plan(&targets, false, &f.policy(false)).unwrap();
    let saved = f.run(&job, &targets, false).unwrap();
    let path = f.profile.join("settings.json");
    let mut changed = kcoder_config::read_settings_file(&path).unwrap();
    changed["mcp_servers"][0]["command"] = "USER_CHANGED_COMMAND".into();
    std::fs::write(&path, changed.to_string()).unwrap();
    let blocked = f.run(&saved, &targets, true).unwrap();
    assert_eq!(blocked.status, JobStatus::RollbackConflict);
    assert_eq!(kcoder_config::read_settings_file(&path).unwrap(), changed);
    assert_eq!(backend.values.lock().unwrap().len(), 3);
}

#[test]
fn interrupted_partial_staging_resumes_only_owned_receipts_and_unstarted_fields() {
    for cancel in [false, true] {
        let f = Fixture::new();
        let backend = Backend::default();
        let targets = f.targets(&backend, CredentialStoreMode::Keyring);
        let job = f.plan(&targets, false, &f.policy(false)).unwrap();
        crate::store::atomic_credentials::INTERRUPT_AFTER_STAGE.with(|flag| flag.set(true));
        let pending = f.run(&job, &targets, false).unwrap();
        assert!(pending.has_unconfirmed_credentials());
        assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
        assert!(!f.profile.join("settings.json").exists());
        let reopened = MigrationStore::open_existing(&f.profile).unwrap();
        let job = reopened.read(&job.job_id).unwrap();
        let current = if cancel {
            reopened.cancel(&job.job_id, job.sequence).unwrap()
        } else {
            job
        };
        let settled = reopened
            .run_batch(
                &current.job_id,
                current.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                if cancel { "undo" } else { "apply" },
                current.sequence,
                cancel,
                &targets,
            )
            .unwrap();
        if cancel {
            assert_eq!(settled.status, JobStatus::RolledBack);
            assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
            assert!(backend.values.lock().unwrap().is_empty());
        } else {
            assert!(
                settled
                    .mcp_credential_plans
                    .iter()
                    .all(|plan| plan.phase == Phase::Published)
            );
            assert_eq!(backend.writes.load(Ordering::SeqCst), 3);
            assert!(settled.receipts[0].ownership_confirmed);
        }
    }
}
