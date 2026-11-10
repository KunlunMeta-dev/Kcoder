use super::*;
use crate::{
    discovery::ConfigurationBinding,
    mcp::{McpResolution, McpTarget},
};
use kcoder_config::imported_credentials::ImportedCredentialStore;
use kcoder_types::migration::MigrationSourceKind;
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

const SECRET: &str = "SYNTHETIC_SELECTED_MCP_PRIVATE_VALUE";
const UNSELECTED: &str = "SYNTHETIC_UNSELECTED_MCP_PRIVATE_VALUE";

#[test]
fn native_private_extension_reads_only_new_source_fields_and_restores_the_old_binding() {
    let f = Fixture::new(false, true);
    let backend = Backend::default();
    let first = f.prepare(&backend, CredentialStoreMode::File);
    let first = f.execute(&first, false, &backend).unwrap();
    let original = &first.mcp_credential_plans[0];
    let item = first
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let target = McpCredentialTarget::open(&f.profile).unwrap();
    let crate::source_transfer::private_credentials::CredentialSourceBinding::Local(binding) =
        &original.source
    else {
        panic!("local fixture must retain its original local source binding");
    };
    let next = target
        .prepare(
            item,
            binding,
            &original.config,
            &[MigrationMcpPrivateField::Environment("OTHER".into())],
            true,
            CredentialStoreMode::File,
            &backend,
        )
        .unwrap();
    assert_eq!(next.remaining_fields(), 0);
    let encoded = serde_json::to_string(&next).unwrap();
    assert!(!encoded.contains(SECRET) && !encoded.contains(UNSELECTED));
    target
        .publish(&next, CredentialStoreMode::File, &backend)
        .unwrap();
    let native = ImportedCredentialStore::open(&f.profile).unwrap();
    let values = native.resolve_mcp(&next.config, &backend).unwrap();
    assert_eq!(values.env.get("TOKEN").map(String::as_str), Some(SECRET));
    assert_eq!(
        values.env.get("OTHER").map(String::as_str),
        Some(UNSELECTED)
    );
    drop(values);
    target
        .undo(&next, CredentialStoreMode::File, &backend)
        .unwrap();
    assert_eq!(
        native
            .resolve_mcp(&original.config, &backend)
            .unwrap()
            .env
            .len(),
        1
    );
    assert_eq!(
        native.state(&original.reference, &backend).unwrap(),
        Some(kcoder_config::imported_credentials::ImportState::Published)
    );
}
#[derive(Default)]
struct Backend {
    values: Mutex<std::collections::BTreeMap<String, String>>,
    writes: AtomicUsize,
    lose_delete: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "owned-memory".into()
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
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.values.lock().unwrap().remove(name);
        ensure!(!self.lose_delete.swap(false, Ordering::SeqCst), "{SECRET}");
        Ok(())
    }
}
struct Fixture {
    root: tempfile::TempDir,
    profile: std::path::PathBuf,
    source: std::path::PathBuf,
    store: MigrationStore,
    job: MigrationJob,
    fields: Vec<MigrationMcpPrivateField>,
}
impl Fixture {
    fn new(http: bool, extra: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let input = root.path().join("source");
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&input).unwrap();
        std::fs::write(
            profile.join("settings.json"),
            r#"{"credential_store":"auto","mcp_servers":[],"mcp_disabled_servers":["previous"]}"#,
        )
        .unwrap();
        let (file, kind, text, fields) = if http {
            ("settings.json",MigrationSourceKind::ClaudeCode,json!({"mcpServers":{"docs":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":format!("Bearer {SECRET}")}}}}).to_string(),vec![MigrationMcpPrivateField::Header("Authorization".into())])
        } else {
            (
                "config.toml",
                MigrationSourceKind::Codex,
                format!(
                    "[mcp_servers.docs]\ncommand='MUST_NOT_RUN'\n[mcp_servers.docs.env]\nTOKEN='{SECRET}'\n{}",
                    if extra {
                        format!("OTHER='{UNSELECTED}'\n")
                    } else {
                        String::new()
                    }
                ),
                vec![MigrationMcpPrivateField::Environment("TOKEN".into())],
            )
        };
        let source = input.join(file);
        std::fs::write(&source, text).unwrap();
        std::fs::write(input.join("auth.json"), "UNRELATED_AUTH_MUST_NOT_BE_READ").unwrap();
        let binding = ConfigurationBinding::capture_selected(&source, kind).unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let job = store.create_bound_scan(binding).unwrap();
        let item_id = job
            .inventory
            .items
            .iter()
            .find(|item| item.mcp.is_some())
            .unwrap()
            .preview
            .id
            .clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&item_id))
            .unwrap();
        let mcp = McpTarget::open(&profile).unwrap();
        let job = store
            .prepare_mcp(
                &job.job_id,
                job.sequence,
                &mcp,
                &McpResolution {
                    item_id,
                    target_name: "ImportedDocs".into(),
                    cwd: None,
                    enable_after_import: false,
                },
            )
            .unwrap();
        let job = store
            .apply_mcp(&job.job_id, job.sequence, job.mcp_plans[0].id(), &mcp)
            .unwrap();
        Self {
            root,
            profile,
            source,
            store,
            job,
            fields,
        }
    }
    fn prepare(&self, backend: &Backend, mode: CredentialStoreMode) -> MigrationJob {
        self.store
            .prepare_mcp_credentials(
                &self.job.job_id,
                self.job.sequence,
                &self
                    .job
                    .inventory
                    .items
                    .iter()
                    .find(|item| item.mcp.is_some())
                    .unwrap()
                    .preview
                    .id,
                &self.fields,
                true,
                &McpCredentialTarget::open(&self.profile).unwrap(),
                mode,
                backend,
            )
            .unwrap()
    }
    fn execute(&self, job: &MigrationJob, undo: bool, backend: &Backend) -> Result<MigrationJob> {
        self.store.apply_mcp_credentials(
            &job.job_id,
            &job.mcp_credential_plans[0].plan_id,
            job.sequence,
            undo,
            &McpCredentialTarget::open(&self.profile)?,
            job.mcp_credential_plans[0].policy,
            backend,
        )
    }
}

fn reuse_fixture(f: &Fixture, backend: &Backend, mode: CredentialStoreMode) -> MigrationJob {
    reuse_fixture_with_fields(f, backend, mode, &[])
}
fn reuse_fixture_with_fields(
    f: &Fixture,
    backend: &Backend,
    mode: CredentialStoreMode,
    fields: &[MigrationMcpPrivateField],
) -> MigrationJob {
    let job = f
        .store
        .create_batch_scan(vec![crate::batch::BatchSource::Configuration(
            f.job.source_binding.clone().unwrap(),
        )])
        .unwrap();
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let provider = crate::providers::ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = crate::assets::AssetTarget::open(&f.profile).unwrap();
    let keys = crate::credentials::CredentialTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        history: None,
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: Some(CredentialTargets {
            target: &keys,
            backend,
            policy: mode,
        }),
    };
    let planned = f
        .store
        .prepare_batch_with_policy(
            &job.job_id,
            job.sequence,
            &[crate::batch::BatchResolution::Mcp(McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "ImportedDocs".into(),
                cwd: None,
                enable_after_import: false,
            })],
            &targets,
            &crate::batch::BatchPlanPolicy {
                reuse_existing: true,
                mcp_credentials: if fields.is_empty() {
                    vec![]
                } else {
                    vec![crate::batch::McpCredentialChoice {
                        item_id: item.preview.id.clone(),
                        fields: fields.to_vec(),
                        consent_private_values: true,
                    }]
                },
                ..Default::default()
            },
        )
        .unwrap();
    f.store
        .run_batch(
            &job.job_id,
            planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "reuse",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap()
}
fn release_fixture(f: &Fixture, job: &MigrationJob, backend: &Backend, mode: CredentialStoreMode) {
    let provider = crate::providers::ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = crate::assets::AssetTarget::open(&f.profile).unwrap();
    let keys = crate::credentials::CredentialTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        history: None,
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: Some(CredentialTargets {
            target: &keys,
            backend,
            policy: mode,
        }),
    };
    let undone = f
        .store
        .run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "release",
            job.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, JobStatus::RolledBack);
}

#[test]
fn reuse_of_single_item_private_imports_retains_the_binding_and_blocks_its_owner_until_release() {
    for http in [false, true] {
        for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
            let f = Fixture::new(http, false);
            let backend = Backend::default();
            let planned = f.prepare(&backend, mode);
            let saved = f.execute(&planned, false, &backend).unwrap();
            let original = std::fs::read(f.profile.join("credentials.json")).unwrap();
            let reused = reuse_fixture(&f, &backend, mode);
            assert!(reused.mcp_credential_plans.is_empty());
            assert!(
                reused
                    .batch
                    .as_ref()
                    .unwrap()
                    .actions
                    .iter()
                    .all(|action| action.status == ItemStatus::Skipped)
            );
            assert!(!reused.inventory.items.iter().find(|item|item.mcp.is_some()).unwrap().preview.issues.iter().any(|issue|
                issue.code == kcoder_types::migration::MigrationIssueCode::CredentialResolutionRequired));
            assert_eq!(
                std::fs::read(f.profile.join("credentials.json")).unwrap(),
                original
            );
            assert_eq!(
                f.execute(&saved, true, &backend).unwrap_err().to_string(),
                "migration_result_referenced"
            );
            release_fixture(&f, &reused, &backend, mode);
            assert_eq!(
                std::fs::read(f.profile.join("credentials.json")).unwrap(),
                original
            );
            let undone = f.execute(&saved, true, &backend).unwrap();
            assert_eq!(undone.mcp_credential_plans[0].phase, Phase::Undone);
        }
    }
}

#[test]
fn a_ready_private_plan_cannot_change_a_definition_borrowed_after_its_preview() {
    let f = Fixture::new(false, false);
    let backend = Backend::default();
    let planned = f.prepare(&backend, CredentialStoreMode::Keyring);
    let borrowed = reuse_fixture(&f, &backend, CredentialStoreMode::Keyring);
    assert_eq!(
        f.execute(&planned, false, &backend)
            .unwrap_err()
            .to_string(),
        "migration_result_referenced"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.store.read(&planned.job_id).unwrap().mcp_credential_plans[0].phase,
        Phase::Ready
    );
    release_fixture(&f, &borrowed, &backend, CredentialStoreMode::Keyring);
    let saved = f.execute(&planned, false, &backend).unwrap();
    assert_eq!(saved.mcp_credential_plans[0].phase, Phase::Published);
}

#[test]
fn literal_stdio_and_http_fields_publish_privately_with_undo_and_profile_boundaries() {
    for http in [false, true] {
        for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
            let f = Fixture::new(http, false);
            let backend = Backend::default();
            let source = std::fs::read(&f.source).unwrap();
            let before =
                kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
            let planned = f.prepare(&backend, mode);
            assert!(!f.profile.join("credentials.json").exists());
            let journal = std::fs::read_to_string(
                f.profile
                    .join("migrations")
                    .join(format!("{}.json", planned.job_id)),
            )
            .unwrap();
            assert!(!journal.contains(SECRET));
            assert!(!format!("{planned:?}").contains(SECRET));
            assert_eq!(
                kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
                before
            );
            let published = f.execute(&planned, false, &backend).unwrap();
            let plan = &published.mcp_credential_plans[0];
            assert_eq!(plan.phase, Phase::Published);
            let public =
                kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
            assert!(!public.to_string().contains(SECRET));
            assert_eq!(
                public["mcp_disabled_servers"],
                before["mcp_disabled_servers"]
            );
            let loaded = ImportedCredentialStore::open(&f.profile)
                .unwrap()
                .resolve_mcp_with_mode(&plan.config, mode, &backend)
                .unwrap();
            assert!(
                loaded
                    .env
                    .values()
                    .chain(loaded.headers.values())
                    .any(|value| value.contains(SECRET))
            );
            assert!(
                f.store
                    .rollback_mcp(
                        &published.job_id,
                        published.sequence,
                        published.mcp_plans[0].id(),
                        &McpTarget::open(&f.profile).unwrap()
                    )
                    .unwrap_err()
                    .to_string()
                    .contains("values_depend_on_import")
            );
            assert_eq!(f.execute(&published, false, &backend).unwrap(), published);
            let undone = f.execute(&published, true, &backend).unwrap();
            assert_eq!(undone.mcp_credential_plans[0].phase, Phase::Undone);
            assert_eq!(
                kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
                before
            );
            assert!(backend.values.lock().unwrap().is_empty());
            assert_eq!(std::fs::read(&f.source).unwrap(), source);
        }
    }
}

#[test]
fn no_consent_undeclared_slots_or_other_profiles_cannot_read_or_redirect_source_values() {
    let f = Fixture::new(false, false);
    let backend = Backend::default();
    let target = McpCredentialTarget::open(&f.profile).unwrap();
    let item = &f.job.mcp_plans[0].item().preview.id;
    assert!(
        f.store
            .prepare_mcp_credentials(
                &f.job.job_id,
                f.job.sequence,
                item,
                &[MigrationMcpPrivateField::Environment(
                    "UNRELATED_ENV".into()
                )],
                true,
                &target,
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    let other = f.root.path().join("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::copy(f.profile.join("settings.json"), other.join("settings.json")).unwrap();
    assert!(
        f.store
            .prepare_mcp_credentials(
                &f.job.job_id,
                f.job.sequence,
                item,
                &f.fields,
                true,
                &McpCredentialTarget::open(&other).unwrap(),
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    std::fs::remove_file(&f.source).unwrap();
    assert_eq!(
        f.store
            .prepare_mcp_credentials(
                &f.job.job_id,
                f.job.sequence,
                item,
                &f.fields,
                false,
                &target,
                CredentialStoreMode::File,
                &backend
            )
            .unwrap_err()
            .to_string(),
        "migration_mcp_private_consent_required"
    );
    assert!(!f.profile.join("credentials.json").exists());
    assert!(backend.values.lock().unwrap().is_empty());
}

#[test]
fn a_subset_copies_only_selected_literals_and_leaves_other_required_fields_blocked() {
    let f = Fixture::new(false, true);
    let backend = Backend::default();
    let job = f.prepare(&backend, CredentialStoreMode::File);
    let job = f.execute(&job, false, &backend).unwrap();
    let text = std::fs::read_to_string(f.profile.join("credentials.json")).unwrap();
    assert!(text.contains(SECRET));
    assert!(!text.contains(UNSELECTED));
    let values = ImportedCredentialStore::open(&f.profile)
        .unwrap()
        .resolve_mcp(&job.mcp_credential_plans[0].config, &backend)
        .unwrap();
    assert!(!values.env.contains_key("OTHER"));
    assert!(
        job.mcp_credential_plans[0]
            .config
            .policy
            .required_env
            .contains(&"OTHER".into())
    );
}

#[test]
fn source_and_target_edits_block_publication_and_ready_plans_can_be_explicitly_discarded() {
    for source_edit in [false, true] {
        let f = Fixture::new(false, false);
        let backend = Backend::default();
        let job = f.prepare(&backend, CredentialStoreMode::File);
        if source_edit {
            std::fs::write(&f.source, "[mcp_servers.docs]\ncommand='other'\n").unwrap();
        } else {
            kcoder_config::ProfileSettingsFile::new(
                kcoder_config::PrivateDirectory::open_existing(&f.profile).unwrap(),
            )
            .unwrap()
            .update(|document| {
                document["max_tokens"] = 1024.into();
                Ok(())
            })
            .unwrap();
        }
        assert!(f.execute(&job, false, &backend).is_err());
        let current = f.store.read(&job.job_id).unwrap();
        assert_eq!(current.mcp_credential_plans[0].phase, Phase::Conflict);
        assert!(f.execute(&current, true, &backend).is_ok());
    }
}

#[test]
fn publication_and_undo_receipts_reconcile_after_source_disappears_without_reinstalling() {
    let f = Fixture::new(true, false);
    let backend = Backend::default();
    let job = f.prepare(&backend, CredentialStoreMode::Keyring);
    LOSE_ACTION_RECEIPT.with(|flag| flag.set(true));
    assert!(f.execute(&job, false, &backend).is_err());
    let pending = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(&job.job_id)
        .unwrap();
    assert!(pending.has_unconfirmed_credentials());
    std::fs::remove_file(&f.source).unwrap();
    let published = f.execute(&pending, false, &backend).unwrap();
    assert_eq!(published.mcp_credential_plans[0].phase, Phase::Published);
    let writes = backend.writes.load(Ordering::SeqCst);
    backend.lose_delete.store(true, Ordering::SeqCst);
    assert!(f.execute(&published, true, &backend).is_err());
    let pending = f.store.read(&job.job_id).unwrap();
    assert_eq!(pending.mcp_credential_plans[0].phase, Phase::Undoing);
    LOSE_ACTION_RECEIPT.with(|flag| flag.set(true));
    assert!(f.execute(&pending, true, &backend).is_err());
    let pending = f.store.read(&job.job_id).unwrap();
    let undone = f.execute(&pending, true, &backend).unwrap();
    assert_eq!(undone.mcp_credential_plans[0].phase, Phase::Undone);
    assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
    assert!(backend.values.lock().unwrap().is_empty());
}

#[test]
fn private_slots_attach_to_an_owned_batch_result_and_must_be_undone_before_batch_removal() {
    use crate::{
        assets::AssetTarget,
        batch::{BatchResolution, BatchSource},
        providers::ProviderTarget,
        store::BatchTargets,
    };
    let mut f = Fixture::new(false, false);
    let backend = Backend::default();
    f.store
        .rollback_mcp(
            &f.job.job_id,
            f.job.sequence,
            f.job.mcp_plans[0].id(),
            &McpTarget::open(&f.profile).unwrap(),
        )
        .unwrap();
    let job = f
        .store
        .create_batch_scan(vec![BatchSource::Configuration(
            f.job.source_binding.clone().unwrap(),
        )])
        .unwrap();
    let item_id = job
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap()
        .preview
        .id
        .clone();
    let provider = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        history: None,
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
    };
    let planned = f
        .store
        .prepare_batch(
            &job.job_id,
            job.sequence,
            &[BatchResolution::Mcp(McpResolution {
                item_id,
                target_name: "BatchDocs".into(),
                cwd: None,
                enable_after_import: false,
            })],
            &targets,
        )
        .unwrap();
    let id = planned.batch.as_ref().unwrap().plan_id.clone().unwrap();
    f.job = f
        .store
        .run_batch(
            &planned.job_id,
            &id,
            "save",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    let planned = f.prepare(&backend, CredentialStoreMode::File);
    let saved = f.execute(&planned, false, &backend).unwrap();
    assert!(
        f.store
            .run_batch(&saved.job_id, &id, "remove", saved.sequence, true, &targets)
            .unwrap_err()
            .to_string()
            .contains("values_depend_on_import")
    );
    let undone = f.execute(&saved, true, &backend).unwrap();
    let removed = f
        .store
        .run_batch(
            &undone.job_id,
            &id,
            "remove",
            undone.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(removed.status, JobStatus::RolledBack);
}

#[test]
fn provider_and_mcp_steps_share_the_same_persistent_plan_budget() {
    use crate::{
        credentials::{ApiKeySelector, CredentialTarget},
        store::{CredentialResolution, CredentialTargets},
    };
    let f = Fixture::new(false, false);
    let backend = Backend::default();
    let job = f.prepare(&backend, CredentialStoreMode::File);
    let job = f
        .store
        .update(&job.job_id, job.sequence, |job| {
            let mut metadata = job.mcp_credential_plans[0].clone();
            metadata.phase = Phase::Undone;
            job.mcp_credential_plans = vec![metadata; 128];
            Ok(true)
        })
        .unwrap();
    let target = CredentialTarget::open(&f.profile).unwrap();
    let error = f
        .store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: "unselected-provider".into(),
                selector: ApiKeySelector::ClaudeConfiguration,
                consent_api_key: true,
            },
            &CredentialTargets {
                target: &target,
                backend: &backend,
                policy: CredentialStoreMode::File,
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "migration_credential_budget_exceeded");
    assert!(!f.profile.join("credentials.json").exists());
}

#[test]
fn a_reused_mcp_can_add_private_fields_in_the_same_batch_and_undo_only_that_amendment() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new(false, true);
        let backend = Backend::default();
        let planned = f.prepare(&backend, mode);
        let original = f.execute(&planned, false, &backend).unwrap();
        let original_settings = std::fs::read(f.profile.join("settings.json")).unwrap();
        let updated = reuse_fixture_with_fields(
            &f,
            &backend,
            mode,
            &[MigrationMcpPrivateField::Environment("OTHER".into())],
        );
        assert!(
            updated
                .batch
                .as_ref()
                .unwrap()
                .actions
                .iter()
                .all(|action| action.status == ItemStatus::Committed),
            "{:?}",
            updated
                .batch
                .as_ref()
                .unwrap()
                .actions
                .iter()
                .map(|action| (action.status, &action.error))
                .collect::<Vec<_>>()
        );
        assert_eq!(updated.mcp_credential_plans[0].phase, Phase::Published);
        assert_eq!(updated.mcp_credential_plans[0].remaining_fields(), 0);
        let native = ImportedCredentialStore::open(&f.profile).unwrap();
        let values = native
            .resolve_mcp(&updated.mcp_credential_plans[0].config, &backend)
            .unwrap();
        assert_eq!(values.env.get("TOKEN").map(String::as_str), Some(SECRET));
        assert_eq!(
            values.env.get("OTHER").map(String::as_str),
            Some(UNSELECTED)
        );
        drop(values);
        assert!(f.execute(&original, true, &backend).is_err());
        // A later pure reuse protects the amendment itself, then releases only its reference.
        let third = reuse_fixture(&f, &backend, mode);
        release_fixture(&f, &third, &backend, mode);
        std::fs::rename(&f.source, f.source.with_extension("removed")).unwrap();
        release_fixture(&f, &updated, &backend, mode);
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original_settings
        );
        assert_eq!(
            native
                .resolve_mcp(&original.mcp_credential_plans[0].config, &backend)
                .unwrap()
                .env
                .len(),
            1
        );
        f.execute(&original, true, &backend).unwrap();
    }
}

#[test]
fn a_reused_public_mcp_can_receive_its_first_private_binding_without_recreating_the_server() {
    let f = Fixture::new(false, true);
    let backend = Backend::default();
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let updated = reuse_fixture_with_fields(
        &f,
        &backend,
        CredentialStoreMode::File,
        &[MigrationMcpPrivateField::Environment("TOKEN".into())],
    );
    assert_eq!(updated.mcp_credential_plans[0].phase, Phase::Published);
    assert!(
        updated.mcp_credential_plans[0]
            .reference
            .predecessor
            .is_none()
    );
    let native = ImportedCredentialStore::open(&f.profile).unwrap();
    assert_eq!(
        native
            .resolve_mcp(&updated.mcp_credential_plans[0].config, &backend)
            .unwrap()
            .env
            .len(),
        1
    );
    let attempt = f.store.rollback_mcp(
        &f.job.job_id,
        f.job.sequence,
        f.job.mcp_plans[0].id(),
        &McpTarget::open(&f.profile).unwrap(),
    );
    assert!(attempt.is_err());
    release_fixture(&f, &updated, &backend, CredentialStoreMode::File);
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
}

#[test]
fn adding_private_fields_preserves_a_user_enabled_reused_server() {
    let f = Fixture::new(false, false);
    let backend = Backend::default();
    let path = f.profile.join("settings.json");
    let mut before: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    before["mcp_disabled_servers"]
        .as_array_mut()
        .unwrap()
        .retain(|name| name.as_str() != Some("ImportedDocs"));
    std::fs::write(&path, serde_json::to_vec(&before).unwrap()).unwrap();
    let updated = reuse_fixture_with_fields(
        &f,
        &backend,
        CredentialStoreMode::File,
        &[MigrationMcpPrivateField::Environment("TOKEN".into())],
    );
    assert_eq!(updated.mcp_credential_plans[0].phase, Phase::Published);
    let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        after["mcp_disabled_servers"],
        before["mcp_disabled_servers"]
    );
    let reused_again = reuse_fixture(&f, &backend, CredentialStoreMode::File);
    release_fixture(&f, &reused_again, &backend, CredentialStoreMode::File);
    release_fixture(&f, &updated, &backend, CredentialStoreMode::File);
    let restored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(restored, before);
}
