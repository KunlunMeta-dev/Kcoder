use kcoder_config::{CredentialBackend, CredentialStoreMode};
use kcoder_migration::{
    credentials::{ApiKeySelector, CredentialTarget},
    discovery::{DiscoveryRoots, SourceRegistry},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{CredentialResolution, CredentialTargets, MigrationStore},
};
use std::path::Path;

struct NoKeyring;
impl CredentialBackend for NoKeyring {
    fn describe(&self) -> String {
        "disabled-test-backend".into()
    }
    fn available(&self) -> bool {
        panic!("file mode must not probe a keyring")
    }
    fn get(&self, _: &str) -> anyhow::Result<Option<String>> {
        panic!("file mode must not read a keyring")
    }
    fn set(&self, _: &str, _: &str) -> anyhow::Result<()> {
        panic!("file mode must not write a keyring")
    }
    fn delete(&self, _: &str) -> anyhow::Result<()> {
        panic!("file mode must not delete a keyring")
    }
}

fn saved(
    root: &Path,
    source: &str,
    override_endpoint: Option<&str>,
) -> (
    MigrationStore,
    kcoder_migration::store::MigrationJob,
    std::path::PathBuf,
) {
    let profile = root.join("profile");
    let input = root.join("source");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&input).unwrap();
    std::fs::write(input.join("settings.json"), source).unwrap();
    std::fs::write(
        input.join("auth.json"),
        "NOT_JSON_AUTH_FILE_MUST_NOT_BE_READ",
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.into(),
        claude_config_dir: Some(input),
        codex_home: None,
        project: None,
    });
    let source = registry
        .discover(
            &[kcoder_types::migration::MigrationSourceKind::ClaudeCode],
            false,
        )
        .0
        .into_iter()
        .find(|source| source.scope == "user")
        .unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store
        .create_bound_scan(registry.selected(&source.source_id).unwrap())
        .unwrap();
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
    let target = ProviderTarget::open(&profile).unwrap();
    let job = store
        .prepare_provider(
            &job.job_id,
            job.sequence,
            &target,
            &ProviderResolution {
                item_id: item,
                target_name: "Imported".into(),
                endpoint: override_endpoint.map(str::to_owned),
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 64000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            },
        )
        .unwrap();
    let job = store
        .apply_provider(
            &job.job_id,
            job.sequence,
            job.provider_plans[0].id(),
            &target,
        )
        .unwrap();
    (store, job, profile)
}
const SOURCE: &str = r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_SOURCE_KEY_MUST_STAY_PRIVATE"}}"#;

#[test]
fn explicit_key_import_never_serializes_a_secret_into_plans_and_configuration_undo_waits_for_it() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = saved(root.path(), SOURCE, None);
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let targets = CredentialTargets {
        target: &target,
        backend: &backend,
        policy: CredentialStoreMode::File,
    };
    let item = job.inventory.items[0].preview.id.clone();
    assert!(
        store
            .prepare_credential(
                &job.job_id,
                job.sequence,
                &CredentialResolution {
                    item_id: item.clone(),
                    selector: ApiKeySelector::ClaudeConfiguration,
                    consent_api_key: false
                },
                &targets
            )
            .is_err()
    );
    let planned = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: item,
                selector: ApiKeySelector::ClaudeConfiguration,
                consent_api_key: true,
            },
            &targets,
        )
        .unwrap();
    let plan = planned.credential_plans[0].plan_id.clone();
    let secret = "SYNTHETIC_SOURCE_KEY_MUST_STAY_PRIVATE";
    assert!(!serde_json::to_string(&planned).unwrap().contains(secret));
    assert!(!format!("{planned:?}").contains(secret));
    let applied = store
        .apply_credential(&job.job_id, &plan, planned.sequence, false, &targets)
        .unwrap();
    let sequence = applied.sequence;
    std::fs::rename(
        root.path().join("source/settings.json"),
        root.path().join("source/removed-settings.json"),
    )
    .unwrap();
    // Losing the response must not force a new plan, key write, or journal revision.
    assert_eq!(
        store
            .apply_credential(&job.job_id, &plan, planned.sequence, false, &targets)
            .unwrap()
            .sequence,
        sequence
    );
    assert_eq!(
        kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
            .unwrap()
            .credentials["Imported"],
        secret
    );
    let provider = ProviderTarget::open(&profile).unwrap();
    assert_eq!(
        store
            .rollback_provider(
                &job.job_id,
                applied.sequence,
                job.provider_plans[0].id(),
                &provider
            )
            .unwrap_err()
            .to_string(),
        "migration_provider_credentials_depend_on_import"
    );
    let current = store.read(&job.job_id).unwrap();
    let undone = store
        .apply_credential(&job.job_id, &plan, current.sequence, true, &targets)
        .unwrap();
    assert!(
        !kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
            .unwrap()
            .credentials
            .contains_key("Imported")
    );
    store
        .rollback_provider(
            &job.job_id,
            undone.sequence,
            job.provider_plans[0].id(),
            &provider,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("source/auth.json")).unwrap(),
        "NOT_JSON_AUTH_FILE_MUST_NOT_BE_READ"
    );
    for entry in std::fs::read_dir(profile.join("migrations")).unwrap() {
        let entry = entry.unwrap();
        if entry.path().is_file() {
            assert!(
                !std::fs::read(entry.path())
                    .unwrap()
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes())
            );
        }
    }
}

#[test]
fn an_endpoint_override_cannot_redirect_the_source_api_key() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = saved(root.path(), SOURCE, Some("https://another.invalid"));
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let error = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
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
    assert_eq!(
        error.to_string(),
        "migration_credential_destination_mismatch"
    );
    assert!(!profile.join("credentials.json").exists());
}

#[test]
fn changed_provider_or_source_after_preview_is_preserved_and_never_receives_an_old_key() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = saved(root.path(), SOURCE, None);
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let targets = CredentialTargets {
        target: &target,
        backend: &backend,
        policy: CredentialStoreMode::File,
    };
    let planned = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
                selector: ApiKeySelector::ClaudeConfiguration,
                consent_api_key: true,
            },
            &targets,
        )
        .unwrap();
    std::fs::write(
        root.path().join("source/settings.json"),
        SOURCE.replace("MUST_STAY_PRIVATE", "ROTATED"),
    )
    .unwrap();
    assert!(
        store
            .apply_credential(
                &job.job_id,
                &planned.credential_plans[0].plan_id,
                planned.sequence,
                false,
                &targets
            )
            .is_err()
    );
    assert!(!profile.join("credentials.json").exists());
}

#[test]
fn authentication_helpers_are_not_executed_or_reinterpreted_as_api_keys() {
    let root = tempfile::tempdir().unwrap();
    let source = SOURCE.replacen("{", r#"{"apiKeyHelper":"never-run-helper","#, 1);
    let (store, job, profile) = saved(root.path(), &source, None);
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let error = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
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
    assert_eq!(
        error.to_string(),
        "migration_credential_authentication_unsupported"
    );
    assert!(!profile.join("credentials.json").exists());
}

#[test]
fn direct_anthropic_api_keys_can_use_the_documented_default_endpoint() {
    let root = tempfile::tempdir().unwrap();
    let source = r#"{"model":"fixture","env":{"ANTHROPIC_API_KEY":"SYNTHETIC_DIRECT_API_KEY"}}"#;
    let (store, job, profile) = saved(root.path(), source, Some("https://api.anthropic.com"));
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let planned = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
                selector: ApiKeySelector::ClaudeConfiguration,
                consent_api_key: true,
            },
            &CredentialTargets {
                target: &target,
                backend: &backend,
                policy: CredentialStoreMode::File,
            },
        )
        .unwrap();
    assert_eq!(
        planned.credential_plans[0].endpoint,
        "https://api.anthropic.com"
    );
}

#[test]
fn destination_changes_between_preview_and_apply_never_receive_the_source_key() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = saved(root.path(), SOURCE, None);
    let target = CredentialTarget::open(&profile).unwrap();
    let backend = NoKeyring;
    let targets = CredentialTargets {
        target: &target,
        backend: &backend,
        policy: CredentialStoreMode::File,
    };
    let planned = store
        .prepare_credential(
            &job.job_id,
            job.sequence,
            &CredentialResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
                selector: ApiKeySelector::ClaudeConfiguration,
                consent_api_key: true,
            },
            &targets,
        )
        .unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|document| {
            document["providers"]["Imported"]["endpoint"] =
                serde_json::json!("https://user-edited.invalid");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .apply_credential(
                &job.job_id,
                &planned.credential_plans[0].plan_id,
                planned.sequence,
                false,
                &targets
            )
            .unwrap_err()
            .to_string(),
        "migration_credential_destination_changed"
    );
    assert!(!profile.join("credentials.json").exists());
    assert_eq!(
        settings.read().unwrap()["providers"]["Imported"]["endpoint"],
        "https://user-edited.invalid"
    );
}
