use super::*;
use crate::credentials::ApiKeySelector;
use crate::source_transfer::private_credentials::*;
use kcoder_config::{CredentialBackend, CredentialStoreMode};
use kcoder_types::migration::MigrationMcpPrivateField as Field;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

pub(super) const API: &str = "SYNTHETIC_CROSS_HOST_PROVIDER_PRIVATE";
pub(super) const TOKEN: &str = "SYNTHETIC_CROSS_HOST_MCP_PRIVATE";
const OAUTH: &str = "SYNTHETIC_IGNORED_SUBSCRIPTION_TOKEN";

pub(super) struct Backend {
    available: bool,
    values: Mutex<std::collections::BTreeMap<String, String>>,
    sets: AtomicUsize,
    gets: AtomicUsize,
    deletes: AtomicUsize,
    lose_delete: AtomicBool,
}
impl Backend {
    pub(super) fn new(available: bool) -> Self {
        Self {
            available,
            values: Mutex::new(Default::default()),
            sets: AtomicUsize::new(0),
            gets: AtomicUsize::new(0),
            deletes: AtomicUsize::new(0),
            lose_delete: AtomicBool::new(false),
        }
    }
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "synthetic-native-private-channel".into()
    }
    fn available(&self) -> bool {
        self.available
    }
    fn get(&self, name: &str) -> anyhow::Result<Option<String>> {
        assert!(name.starts_with("migration-private-") || name.starts_with("import-"));
        self.gets.fetch_add(1, Ordering::SeqCst);
        Ok(self.values.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> anyhow::Result<()> {
        assert!(name.starts_with("migration-private-") || name.starts_with("import-"));
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.values
            .lock()
            .unwrap()
            .insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> anyhow::Result<()> {
        assert!(account.starts_with("migration-private-") || account.starts_with("import-"));
        self.values.lock().unwrap().remove(account);
        self.deletes.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(
            !self.lose_delete.swap(false, Ordering::SeqCst),
            "synthetic_delete_reply_lost"
        );
        Ok(())
    }
}
pub(super) fn consent() -> PrivateCredentialConsent {
    PrivateCredentialConsent {
        api_keys: true,
        mcp_private_fields: true,
    }
}

pub(super) fn source(
    f: &Fixture,
    mode: CredentialStoreMode,
) -> (
    TransferManifest,
    TransferReceipt,
    Vec<PrivateCredentialSelection>,
) {
    std::fs::write(
        f.target_profile.join("settings.json"),
        serde_json::to_vec(
            &serde_json::json!({"credential_store":mode,"providers":{},"mcp_servers":[]}),
        )
        .unwrap(),
    )
    .unwrap();
    let body = serde_json::json!({"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid/v1","ANTHROPIC_API_KEY":API},"mcpServers":{"notes":{"command":"must-not-run","env":{"TOKEN":TOKEN}}}});
    std::fs::write(f.files.join("settings.json"), body.to_string()).unwrap();
    std::fs::write(f.files.join("auth.json"), OAUTH).unwrap();
    let binding =
        ConfigurationBinding::capture_selected(&f.files.join("settings.json"), Kind::ClaudeCode)
            .unwrap();
    let inventory = binding.inventory().unwrap();
    let provider = inventory
        .items
        .iter()
        .find(|v| v.provider.is_some())
        .unwrap();
    let mcp = inventory.items.iter().find(|v| v.mcp.is_some()).unwrap();
    let selections = vec![
        PrivateCredentialSelection::Provider {
            source_name: provider.preview.source_name.clone(),
            selector: ApiKeySelector::ClaudeConfiguration,
            target_name: "ImportedProvider".into(),
            endpoint: "https://example.invalid/v1".into(),
            api_format: provider.provider.as_ref().unwrap().api_format.clone(),
        },
        PrivateCredentialSelection::Mcp {
            source_name: mcp.preview.source_name.clone(),
            target_name: "imported-notes".into(),
            fields: vec![Field::Environment("TOKEN".into())],
            definition_sha256: super::super::model::digest(&mcp.mcp.as_ref().unwrap().config)
                .unwrap(),
        },
    ];
    let manifest = f.export(ExportSelection::Configuration(binding));
    let receipt = f.copy(&manifest);
    (manifest, receipt, selections)
}
pub(super) fn offer(
    f: &Fixture,
    m: &TransferManifest,
    r: &TransferReceipt,
    s: Vec<PrivateCredentialSelection>,
    mode: CredentialStoreMode,
    b: &Backend,
) -> PrivateCredentialOffer {
    prepare_private_credential_offer(
        &f.target,
        PrivateCredentialOfferInput {
            request: &f.request,
            authenticated_source: f.source.authority(),
            receipt: r,
            entry: &m.entries[0].id,
            offer_id: &uuid::Uuid::new_v4().to_string(),
            selections: s,
            consent: consent(),
            policy: mode,
        },
        b,
    )
    .unwrap()
}

#[test]
fn private_values_use_an_independent_ciphertext_channel_and_reopen_with_source_offline() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    for value in [
        serde_json::to_string(&m).unwrap(),
        serde_json::to_string(&o).unwrap(),
        serde_json::to_string(&e).unwrap(),
    ] {
        for private in [API, TOKEN, OAUTH] {
            assert!(!value.contains(private));
        }
    }
    let received = accept_private_credential_envelope(
        &f.target,
        f.source.authority(),
        &r,
        &o,
        &e,
        consent(),
        &b,
    )
    .unwrap();
    received.verify_material(&f.target_profile, &b).unwrap();
    let serialized = serde_json::to_vec(&received).unwrap();
    assert!(!String::from_utf8_lossy(&serialized).contains(API));
    std::fs::rename(&f.files, f._root.path().join("source-files-withheld")).unwrap();
    let repeated =
        seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    assert_eq!(repeated, e);
    std::fs::rename(
        &f.source_profile,
        f._root.path().join("source-runtime-withheld"),
    )
    .unwrap();
    let reopened: ReceivedPrivateCredentialBinding = serde_json::from_slice(&serialized).unwrap();
    reopened.verify_material(&f.target_profile, &b).unwrap();
    assert_eq!(b.sets.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read_to_string(f._root.path().join("source-files-withheld/auth.json")).unwrap(),
        OAUTH
    );
}

#[test]
fn independent_explicit_consents_and_actual_target_peer_are_required() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    for c in [
        PrivateCredentialConsent {
            api_keys: false,
            mcp_private_fields: true,
        },
        PrivateCredentialConsent {
            api_keys: true,
            mcp_private_fields: false,
        },
    ] {
        assert!(
            prepare_private_credential_offer(
                &f.target,
                PrivateCredentialOfferInput {
                    request: &f.request,
                    authenticated_source: f.source.authority(),
                    receipt: &r,
                    entry: &m.entries[0].id,
                    offer_id: &uuid::Uuid::new_v4().to_string(),
                    selections: s.clone(),
                    consent: c,
                    policy: CredentialStoreMode::File
                },
                &b
            )
            .is_err()
        );
    }
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    assert!(seal_private_credentials(&f.source, f.source.authority(), &o, consent()).is_err());
    assert!(
        seal_private_credentials(
            &f.source,
            f.target.authority(),
            &o,
            PrivateCredentialConsent {
                api_keys: false,
                mcp_private_fields: true
            }
        )
        .is_err()
    );
    assert_eq!(b.sets.load(Ordering::SeqCst), 0);
}

#[test]
fn existing_key_or_ciphertext_loss_never_creates_another_key_or_envelope() {
    for remove_key in [true, false] {
        let f = Fixture::new();
        let (m, r, s) = source(&f, CredentialStoreMode::File);
        let b = Backend::new(false);
        let o = offer(&f, &m, &r, s.clone(), CredentialStoreMode::File, &b);
        let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
        let base = if remove_key {
            &f.target_profile
        } else {
            &f.source_profile
        };
        let role = if remove_key { "target" } else { "source" };
        let leaf = if remove_key {
            "private-key.bin"
        } else {
            "envelope.json"
        };
        let path = base
            .join("migrations/source-transfer/private-credentials")
            .join(format!("{role}-{}", o.context.offer_id))
            .join(leaf);
        std::fs::remove_file(&path).unwrap();
        if remove_key {
            assert!(
                prepare_private_credential_offer(
                    &f.target,
                    PrivateCredentialOfferInput {
                        request: &f.request,
                        authenticated_source: f.source.authority(),
                        receipt: &r,
                        entry: &m.entries[0].id,
                        offer_id: &o.context.offer_id,
                        selections: s,
                        consent: consent(),
                        policy: CredentialStoreMode::File
                    },
                    &b
                )
                .is_err()
            );
            assert!(
                accept_private_credential_envelope(
                    &f.target,
                    f.source.authority(),
                    &r,
                    &o,
                    &e,
                    consent(),
                    &b
                )
                .is_err()
            );
        } else {
            assert!(
                seal_private_credentials(&f.source, f.target.authority(), &o, consent()).is_err()
            );
        }
        assert!(!path.exists());
        assert_eq!(b.sets.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn forced_keyring_keeps_the_original_key_and_never_falls_back_or_touches_a_foreign_profile() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::Keyring);
    let b = Backend::new(true);
    let o = offer(&f, &m, &r, s.clone(), CredentialStoreMode::Keyring, &b);
    assert_eq!(b.sets.load(Ordering::SeqCst), 1);
    let same = prepare_private_credential_offer(
        &f.target,
        PrivateCredentialOfferInput {
            request: &f.request,
            authenticated_source: f.source.authority(),
            receipt: &r,
            entry: &m.entries[0].id,
            offer_id: &o.context.offer_id,
            selections: s,
            consent: consent(),
            policy: CredentialStoreMode::Keyring,
        },
        &b,
    )
    .unwrap();
    assert_eq!(same, o);
    assert_eq!(b.sets.load(Ordering::SeqCst), 1);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    let binding = accept_private_credential_envelope(
        &f.target,
        f.source.authority(),
        &r,
        &o,
        &e,
        consent(),
        &b,
    )
    .unwrap();
    let gets = b.gets.load(Ordering::SeqCst);
    assert!(binding.verify_material(&f.source_profile, &b).is_err());
    assert_eq!(gets, b.gets.load(Ordering::SeqCst));
    b.values.lock().unwrap().clear();
    assert!(binding.verify_material(&f.target_profile, &b).is_err());
    assert_eq!(b.sets.load(Ordering::SeqCst), 1);
    assert!(
        !f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .join(format!("target-{}", o.context.offer_id))
            .join("private-key.bin")
            .exists()
    );
}

#[test]
fn encrypted_inputs_enter_the_original_batch_group_and_undo_after_source_removal() {
    use crate::{
        assets::AssetTarget,
        batch::{BatchResolution, BatchSource},
        credentials::CredentialTarget,
        mcp::{McpResolution, McpTarget},
        providers::{ModelLimits, ProviderResolution, ProviderTarget},
        store::{BatchTargets, CredentialTargets, MigrationStore},
    };
    use kcoder_config::imported_credentials::{
        CredentialGroupOutcome, ImportState, ImportedCredentialStore,
    };
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new();
        let (m, r, s) = source(&f, mode);
        let baseline =
            kcoder_config::read_settings_file(&f.target_profile.join("settings.json")).unwrap();
        let b = Backend::new(mode == CredentialStoreMode::Keyring);
        let o = offer(&f, &m, &r, s, mode, &b);
        let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
        let received = accept_private_credential_envelope(
            &f.target,
            f.source.authority(),
            &r,
            &o,
            &e,
            consent(),
            &b,
        )
        .unwrap();
        let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
        let public = received.configuration_binding().unwrap();
        let scan = store
            .create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
                public,
            ))])
            .unwrap();
        let provider = ProviderTarget::open(&f.target_profile).unwrap();
        let mcp = McpTarget::open(&f.target_profile).unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let keys = CredentialTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: Some(CredentialTargets {
                target: &keys,
                backend: &b,
                policy: mode,
            }),
            history: None,
        };
        let choices = scan
            .inventory
            .items
            .iter()
            .filter_map(|item| {
                if item.provider.is_some() {
                    Some(BatchResolution::Provider(ProviderResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "ImportedProvider".into(),
                        endpoint: None,
                        model: None,
                        limits: Some(ModelLimits {
                            context_window_tokens: 64000,
                            output_headroom_tokens: 8192,
                            max_output_tokens: 8192,
                        }),
                    }))
                } else if item.mcp.is_some() {
                    Some(BatchResolution::Mcp(McpResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "imported-notes".into(),
                        cwd: None,
                        enable_after_import: false,
                    }))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let planned = store
            .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
            .unwrap();
        let old_plan = planned.batch.as_ref().unwrap().plan_id.clone();
        let private = store
            .prepare_received_batch_credentials(
                &scan.job_id,
                planned.sequence,
                &received,
                consent(),
                &targets,
            )
            .unwrap();
        assert_ne!(private.batch.as_ref().unwrap().plan_id, old_plan);
        assert!(private.batch.as_ref().unwrap().atomic_credentials);
        assert_eq!(private.credential_plans.len(), 1);
        assert_eq!(private.mcp_credential_plans.len(), 1);
        let retried = store
            .prepare_received_batch_credentials(
                &scan.job_id,
                planned.sequence,
                &received,
                consent(),
                &targets,
            )
            .unwrap();
        assert_eq!(retried.sequence, private.sequence);
        for p in [&f.files, &f.source_profile] {
            std::fs::rename(
                p,
                f._root.path().join(format!(
                    "withheld-{}",
                    p.file_name().unwrap().to_string_lossy()
                )),
            )
            .unwrap();
        }
        let plan = private.batch.as_ref().unwrap().plan_id.as_ref().unwrap();
        let done = store
            .run_batch(
                &private.job_id,
                plan,
                "owned-private-publish",
                private.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert!(
            done.credential_plans
                .iter()
                .all(|v| v.phase == crate::credentials::CredentialPhase::Published)
        );
        assert!(
            done.mcp_credential_plans
                .iter()
                .all(|v| v.phase == crate::credentials::CredentialPhase::Published)
        );
        let native = ImportedCredentialStore::open(&f.target_profile).unwrap();
        let group = done.credential_plans[0].atomic_group_id.as_deref().unwrap();
        assert_eq!(
            native.group_receipt(group).unwrap().unwrap().outcome,
            CredentialGroupOutcome::Committed
        );
        let settings =
            kcoder_config::read_settings_file(&f.target_profile.join("settings.json")).unwrap();
        assert!(!settings.to_string().contains(API));
        assert!(!settings.to_string().contains(TOKEN));
        assert_eq!(
            settings["mcp_disabled_servers"],
            serde_json::json!(["imported-notes"])
        );
        drop(store);
        let store = MigrationStore::open_existing(&f.target_profile).unwrap();
        let repeated = store
            .run_batch(
                &done.job_id,
                plan,
                "owned-private-publish",
                private.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(repeated.sequence, done.sequence);
        assert!(
            store
                .release_received_batch_key(&done.job_id, &received, &keys, &b)
                .is_err()
        );
        let undone = store
            .run_batch(
                &done.job_id,
                plan,
                "owned-private-undo",
                done.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(
            undone.status,
            kcoder_types::migration::MigrationJobStatus::RolledBack
        );
        assert_eq!(
            native.group_receipt(group).unwrap().unwrap().outcome,
            CredentialGroupOutcome::Undone
        );
        for reference in [
            done.credential_plans[0].reference.clone(),
            done.mcp_credential_plans[0].reference.clone(),
        ] {
            assert_eq!(
                native.state(&reference, &b).unwrap(),
                Some(ImportState::Undone)
            );
        }
        assert_eq!(
            kcoder_config::read_settings_file(&f.target_profile.join("settings.json")).unwrap(),
            baseline
        );
        std::fs::rename(
            f.target_profile.join("migrations/source-transfer/incoming"),
            f._root.path().join("ordinary-received-withheld"),
        )
        .unwrap();
        store
            .release_received_batch_key(&done.job_id, &received, &keys, &b)
            .unwrap();
        store
            .release_received_batch_key(&done.job_id, &received, &keys, &b)
            .unwrap();
        assert!(b.values.lock().unwrap().is_empty());
    }
}

#[test]
fn private_cancel_is_available_during_the_owned_writer_and_cannot_clear_another_domain() {
    use std::ffi::OsStr;
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    let received = accept_private_credential_envelope(
        &f.target,
        f.source.authority(),
        &r,
        &o,
        &e,
        consent(),
        &b,
    )
    .unwrap();
    let control = source_private_credential_control(&f.source, f.target.authority(), &o).unwrap();
    let target = received.control(&f.target_profile).unwrap();
    let path = f
        .source_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("source-{}", o.context.offer_id));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let identity = directory
        .portable_regular_identity(OsStr::new("writer.lock"))
        .unwrap();
    let writer = directory
        .try_existing_portable_lock(
            OsStr::new("writer.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    let cancelled = control.cancel(&command).unwrap();
    assert!(cancelled.cancelled && cancelled.ready);
    assert_eq!(control.cancel(&command).unwrap(), cancelled);
    assert!(!target.read().unwrap().cancelled);
    assert!(
        control
            .resume(cancelled.sequence, cancelled.cancel_watermark)
            .is_err()
    );
    drop(writer);
    let latest = control.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(
        control
            .resume(cancelled.sequence, cancelled.cancel_watermark)
            .is_err()
    );
    assert!(
        !control
            .resume(latest.sequence, latest.cancel_watermark)
            .unwrap()
            .cancelled
    );
    f.source
        .cancel(
            &f.request,
            &f.destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(seal_private_credentials(&f.source, f.target.authority(), &o, consent()).is_err());
    assert!(!control.read().unwrap().cancelled);
    received.verify_material(&f.target_profile, &b).unwrap();
}

#[test]
fn unpublished_key_deletion_reconciles_only_the_original_account_after_a_lost_reply() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::Keyring);
    let b = Backend::new(true);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::Keyring, &b);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    let binding = accept_private_credential_envelope(
        &f.target,
        f.source.authority(),
        &r,
        &o,
        &e,
        consent(),
        &b,
    )
    .unwrap();
    let account = format!(
        "migration-private-{}",
        uuid::Uuid::parse_str(&o.context.offer_id).unwrap().simple()
    );
    let original = b.values.lock().unwrap().get(&account).unwrap().clone();
    b.values
        .lock()
        .unwrap()
        .insert(account.clone(), "SYNTHETIC_FOREIGN_REPLACEMENT".into());
    assert!(
        binding
            .release_unpublished_key(&f.target_profile, &b)
            .is_err()
    );
    assert_eq!(b.deletes.load(Ordering::SeqCst), 0);
    b.values.lock().unwrap().insert(account, original);
    b.lose_delete.store(true, Ordering::SeqCst);
    binding
        .release_unpublished_key(&f.target_profile, &b)
        .unwrap();
    binding
        .release_unpublished_key(&f.target_profile, &b)
        .unwrap();
    assert_eq!(b.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(b.sets.load(Ordering::SeqCst), 1);
    assert!(b.values.lock().unwrap().is_empty());
    assert!(binding.verify_material(&f.target_profile, &b).is_err());
}

#[test]
fn native_catalog_or_same_bytes_key_replacement_is_unknown_and_is_never_repaired() {
    for name in ["private-key.bin", "writer.lock", "catalog.lock"] {
        let f = Fixture::new();
        let (m, r, s) = source(&f, CredentialStoreMode::File);
        let b = Backend::new(false);
        let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
        let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
        let binding = accept_private_credential_envelope(
            &f.target,
            f.source.authority(),
            &r,
            &o,
            &e,
            consent(),
            &b,
        )
        .unwrap();
        let root = f
            .target_profile
            .join("migrations/source-transfer/private-credentials");
        let path = if name == "catalog.lock" {
            root.join(name)
        } else {
            root.join(format!("target-{}", o.context.offer_id))
                .join(name)
        };
        let bytes = std::fs::read(&path).unwrap();
        std::fs::rename(&path, path.with_extension("owned-withheld")).unwrap();
        std::fs::write(&path, bytes).unwrap();
        assert!(binding.verify_material(&f.target_profile, &b).is_err());
        assert!(
            binding
                .release_unpublished_key(&f.target_profile, &b)
                .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        assert!(binding.verify_material(&f.target_profile, &b).is_err());
        assert!(!path.exists());
    }
}

#[test]
fn changed_source_does_not_reseal_and_an_unused_offer_can_be_cancelled_then_released() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    std::fs::write(
        f.files.join("settings.json"),
        "{\"env\":{\"ANTHROPIC_API_KEY\":\"SYNTHETIC_CHANGED\"}}",
    )
    .unwrap();
    assert!(seal_private_credentials(&f.source, f.target.authority(), &o, consent()).is_err());
    assert!(seal_private_credentials(&f.source, f.target.authority(), &o, consent()).is_err());
    let control =
        target_private_credential_control(&f.target, f.source.authority(), &r, &o).unwrap();
    assert!(!control.read().unwrap().ready);
    assert!(
        control
            .cancel(&uuid::Uuid::new_v4().to_string())
            .unwrap()
            .cancelled
    );
    release_private_credential_offer_key(&f.target, f.source.authority(), &r, &o, &b).unwrap();
    release_private_credential_offer_key(&f.target, f.source.authority(), &r, &o, &b).unwrap();
    let path = f
        .target_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("target-{}", o.context.offer_id))
        .join("private-key.bin");
    assert!(!path.exists());
    assert_eq!(b.sets.load(Ordering::SeqCst), 0);
}

#[test]
fn local_credential_plan_source_keeps_the_exact_existing_json_shape() {
    let f = Fixture::new();
    let _ = source(&f, CredentialStoreMode::File);
    let binding =
        ConfigurationBinding::capture_selected(&f.files.join("settings.json"), Kind::ClaudeCode)
            .unwrap();
    let old = serde_json::to_value(&binding).unwrap();
    let new = CredentialSourceBinding::Local(Box::new(binding.clone()));
    assert!(serde_json::to_value(&new).unwrap() == old);
    let restored: CredentialSourceBinding = serde_json::from_value(old).unwrap();
    let CredentialSourceBinding::Local(restored) = restored else {
        panic!("old local binding changed its source class");
    };
    assert!(restored.as_ref() == &binding);
}

#[test]
fn cancelling_a_prepared_private_batch_releases_never_staged_material_after_formal_rollback() {
    use crate::{
        assets::AssetTarget,
        batch::{BatchResolution, BatchSource},
        credentials::CredentialTarget,
        mcp::{McpResolution, McpTarget},
        providers::{ModelLimits, ProviderResolution, ProviderTarget},
        store::{BatchTargets, CredentialTargets, MigrationStore},
    };
    use kcoder_config::imported_credentials::ImportedCredentialStore;
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new();
        let (m, r, s) = source(&f, mode);
        let b = Backend::new(mode == CredentialStoreMode::Keyring);
        let o = offer(&f, &m, &r, s, mode, &b);
        let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
        let received = accept_private_credential_envelope(
            &f.target,
            f.source.authority(),
            &r,
            &o,
            &e,
            consent(),
            &b,
        )
        .unwrap();
        let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
        let scan = store
            .create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
                received.configuration_binding().unwrap(),
            ))])
            .unwrap();
        let provider = ProviderTarget::open(&f.target_profile).unwrap();
        let mcp = McpTarget::open(&f.target_profile).unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let keys = CredentialTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: Some(CredentialTargets {
                target: &keys,
                backend: &b,
                policy: mode,
            }),
            history: None,
        };
        let choices = scan
            .inventory
            .items
            .iter()
            .filter_map(|item| {
                if item.provider.is_some() {
                    Some(BatchResolution::Provider(ProviderResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "ImportedProvider".into(),
                        endpoint: None,
                        model: None,
                        limits: Some(ModelLimits {
                            context_window_tokens: 64000,
                            output_headroom_tokens: 8192,
                            max_output_tokens: 8192,
                        }),
                    }))
                } else if item.mcp.is_some() {
                    Some(BatchResolution::Mcp(McpResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "imported-notes".into(),
                        cwd: None,
                        enable_after_import: false,
                    }))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let public = store
            .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
            .unwrap();
        let ready = store
            .prepare_received_batch_credentials(
                &scan.job_id,
                public.sequence,
                &received,
                consent(),
                &targets,
            )
            .unwrap();
        let cancelled = store.cancel(&ready.job_id, ready.sequence).unwrap();
        let undone = store
            .run_batch(
                &ready.job_id,
                ready.batch.as_ref().unwrap().plan_id.as_ref().unwrap(),
                "owned-abandon-unstarted",
                cancelled.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(
            undone.status,
            kcoder_types::migration::MigrationJobStatus::RolledBack
        );
        let native = ImportedCredentialStore::open(&f.target_profile).unwrap();
        let group = undone.credential_plans[0]
            .atomic_group_id
            .as_deref()
            .unwrap();
        assert!(native.group_receipt(group).unwrap().is_none());
        for reference in [
            &undone.credential_plans[0].reference,
            &undone.mcp_credential_plans[0].reference,
        ] {
            assert!(native.state(reference, &b).unwrap().is_none());
        }
        // An accepted execution request makes absent native receipts unknown.
        let job_path = f
            .target_profile
            .join("migrations")
            .join(format!("{}.json", ready.job_id));
        let original = std::fs::read(&job_path).unwrap();
        let mut attempted: serde_json::Value = serde_json::from_slice(&original).unwrap();
        attempted["batch"]["requestKinds"]["owned-unconfirmed-apply"] = "apply".into();
        std::fs::write(&job_path, serde_json::to_vec(&attempted).unwrap()).unwrap();
        assert_eq!(
            store
                .release_received_batch_key(&ready.job_id, &received, &keys, &b)
                .unwrap_err()
                .to_string(),
            "private_credentials_publication_unsettled"
        );
        std::fs::write(&job_path, original).unwrap();
        store
            .release_received_batch_key(&ready.job_id, &received, &keys, &b)
            .unwrap();
        assert!(b.values.lock().unwrap().is_empty());
        assert!(b.sets.load(Ordering::SeqCst) <= 1);
    }
}
