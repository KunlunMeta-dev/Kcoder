use super::*;
use crate::{
    batch::BatchPlanPolicy,
    credentials::{ApiKeySelector, CredentialPhase, CredentialTarget},
    providers::{ModelLimits, ProviderResolution},
};
use kcoder_config::{CredentialBackend, CredentialStoreMode};

struct NoKeyring;
impl CredentialBackend for NoKeyring {
    fn describe(&self) -> String {
        "no-keyring".into()
    }
    fn available(&self) -> bool {
        false
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        panic!("file mode must not use keyring")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        panic!("file mode must not use keyring")
    }
    fn delete(&self, _: &str) -> Result<()> {
        panic!("file mode must not use keyring")
    }
}

#[test]
fn native_group_receipt_restores_lost_migration_receipts_and_authorizes_safe_undo() {
    for rollback_directly in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source");
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&source).unwrap();
        let source_file = source.join("settings.json");
        std::fs::write(&source_file, r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_ATOMIC_TEST_KEY"}}"#).unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.path().into(),
            claude_config_dir: Some(source),
            codex_home: None,
            project: None,
        });
        let sources = registry.discover(&[Kind::ClaudeCode], false).0;
        let binding = registry.selected(&sources[0].source_id).unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let scanned = store
            .create_batch_scan(vec![BatchSource::Configuration(binding)])
            .unwrap();
        let item_id = scanned.inventory.items[0].preview.id.clone();
        let provider = ProviderTarget::open(&profile).unwrap();
        let mcp = McpTarget::open(&profile).unwrap();
        let assets = AssetTarget::open(&profile).unwrap();
        let key = CredentialTarget::open(&profile).unwrap();
        let backend = NoKeyring;
        let targets = BatchTargets {
            history: None,
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: Some(CredentialTargets {
                target: &key,
                backend: &backend,
                policy: CredentialStoreMode::File,
            }),
        };
        let job = store
            .prepare_batch_with_policy(
                &scanned.job_id,
                scanned.sequence,
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
                &targets,
                &BatchPlanPolicy {
                    credentials: vec![CredentialResolution {
                        item_id,
                        selector: ApiKeySelector::ClaudeConfiguration,
                        consent_api_key: true,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
        let plan_id = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
        assert!(
            store
                .run_batch(&job.job_id, plan_id, "apply", job.sequence, false, &targets)
                .is_err()
        );
        let pending = store.read(&job.job_id).unwrap();
        assert!(pending.receipts.is_empty());
        assert_eq!(
            pending.credential_plans[0].phase,
            CredentialPhase::Published
        );
        // Recovery needs only authoritative receipts, never the original secret source.
        std::fs::remove_file(source_file).unwrap();
        let reopened = MigrationStore::open_existing(&profile).unwrap();
        let current = if rollback_directly {
            pending
        } else {
            let recovered = reopened
                .run_batch(
                    &job.job_id,
                    plan_id,
                    "apply",
                    pending.sequence,
                    false,
                    &targets,
                )
                .unwrap();
            assert!(recovered.receipts[0].ownership_confirmed);
            recovered
        };
        let undone = reopened
            .run_batch(
                &job.job_id,
                plan_id,
                "undo",
                current.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(undone.status, JobStatus::RolledBack);
        assert_eq!(undone.credential_plans[0].phase, CredentialPhase::Undone);
        assert_eq!(
            kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
            serde_json::json!({})
        );
        assert!(
            kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                .unwrap()
                .credentials
                .is_empty()
        );
    }
}
